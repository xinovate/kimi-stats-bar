#!/usr/bin/env node
/**
 * kimi-stats-bar statusline for Kimi Code CLI TUI.
 *
 * Reads the JSON snapshot the TUI pipes to stdin (status_line.command contract,
 * 300ms ceiling) and prints ONE line, e.g.:
 *
 *   5h 25% · 7d 41% · 20轮·267步 · LLM 32m10s · TTFT 6.8s · 42 tok/s · cache 96% · ↑5.5M ↓31K Σ5.5M
 *
 * Data sources:
 *   - session stats: incremental scan of ~/.kimi-code/sessions/.../agents/main/wire.jsonl
 *     (offset cache in ~/.kimi-code/statusline-cache/)
 *   - 5h/7d quota:   GET http://127.0.0.1:<port>/api/v1/oauth/usage (kimi web server,
 *     port from ~/.kimi-code/server/instances/*.json, token ~/.kimi-code/server.token),
 *     cached 60s; omitted when unreachable.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOME = homedir();
const KIMI_DIR = process.env.KIMI_CODE_HOME || join(HOME, '.kimi-code');
const CACHE_DIR = join(KIMI_DIR, 'statusline-cache');
const QUOTA_TTL_MS = 60_000;

// debug: `touch ~/.kimi-code/kimi-stats-debug` → trace goes to
// ~/.kimi-code/statusline-cache/debug.log (delete the toggle file to stop)
const DEBUG = existsSync(join(KIMI_DIR, 'kimi-stats-debug'));
function dbg(msg) {
  if (!DEBUG) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    appendFileSync(join(CACHE_DIR, 'debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* best-effort */ }
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// ---------- formatting ----------
function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

// ---------- session wire.jsonl incremental scan ----------
function emptyAgg() {
  return { offset: 0, size: 0, path: '', turns: 0, steps: 0, inOther: 0, inCR: 0, inCC: 0, out: 0, ttftSum: 0, ttftN: 0, streamSum: 0, llmMs: 0, effort: '' };
}

function findWire(sessionId) {
  if (!sessionId) return null;
  // payload sessionId may be "session_<uuid>" or bare "<uuid>" depending on
  // how the session was started — match either form.
  const dirName = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
  try {
    for (const wd of readdirSync(join(KIMI_DIR, 'sessions'))) {
      const p = join(KIMI_DIR, 'sessions', wd, dirName, 'agents', 'main', 'wire.jsonl');
      if (existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

function scanSession(sessionId) {
  const cachePath = join(CACHE_DIR, `session-${sessionId}.json`);
  let agg = emptyAgg();
  try { agg = { ...agg, ...JSON.parse(readFileSync(cachePath, 'utf8')) }; } catch { /* first run */ }

  const wire = (agg.path && existsSync(agg.path)) ? agg.path : findWire(sessionId);
  if (!wire) return null;
  agg.path = wire;

  let size = 0;
  try { size = statSync(wire).size; } catch { return null; }
  if (size < agg.offset) agg = { ...emptyAgg(), path: wire }; // file rotated/truncated
  if (size === agg.offset) return agg;

  let fd;
  try {
    fd = openSync(wire, 'r');
    const len = size - agg.offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, agg.offset);
    closeSync(fd); fd = undefined;
    const chunk = buf.toString('utf8');
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) return agg; // no complete line yet
    const complete = chunk.slice(0, lastNl);
    agg.offset += Buffer.byteLength(complete) + 1;
    agg.size = size;

    for (const line of complete.split('\n')) {
      if (line.includes('"thinkingEffort":"')) {
        const m = line.match(/"thinkingEffort":"([a-z]+)"/);
        if (m) agg.effort = m[1]; // latest wins (follows /model switches)
      }
      if (line.includes('"type":"turn.prompt"')) {
        agg.turns++;
      } else if (line.includes('"type":"step.end"')) {
        let ev;
        try { ev = JSON.parse(line).event; } catch { continue; }
        if (!ev || ev.type !== 'step.end') continue;
        agg.steps++;
        const u = ev.usage;
        if (u) {
          agg.inOther += u.inputOther || 0;
          agg.inCR += u.inputCacheRead || 0;
          agg.inCC += u.inputCacheCreation || 0;
          agg.out += u.output || 0;
        }
        if (typeof ev.llmFirstTokenLatencyMs === 'number') {
          agg.ttftSum += ev.llmFirstTokenLatencyMs;
          agg.ttftN++;
          agg.llmMs += ev.llmFirstTokenLatencyMs;
        }
        if (typeof ev.llmStreamDurationMs === 'number') {
          agg.streamSum += ev.llmStreamDurationMs;
          agg.llmMs += ev.llmStreamDurationMs;
        }
      }
    }
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify(agg));
    } catch { /* cache write best-effort */ }
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  return agg;
}

// ---------- quota (5h / 7d) ----------
async function fetchQuota() {
  const cachePath = join(CACHE_DIR, 'quota.json');
  let cached = null;
  try {
    cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (Date.now() - cached.ts < QUOTA_TTL_MS) return cached.data;
  } catch { /* missing */ }

  let data = null;
  try {
    const instDir = join(KIMI_DIR, 'server', 'instances');
    let port = null, newest = 0;
    for (const f of readdirSync(instDir)) {
      if (!f.endsWith('.json')) continue;
      const j = JSON.parse(readFileSync(join(instDir, f), 'utf8'));
      const hb = j.heartbeat_at || j.heartbeatAt || 0;
      if (j.port && hb > newest) { newest = hb; port = j.port; }
    }
    const token = readFileSync(join(KIMI_DIR, 'server.token'), 'utf8').trim();
    if (port && token) {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/oauth/usage`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(200),
      });
      const body = await res.json();
      const d = body.data || body;
      const seven = d.summary;
      const five = (d.limits || []).find((l) => l.window && l.window.unit === 'hour' && l.window.duration === 5);
      const pct = (w) => (w && w.limit ? Math.round((w.used / w.limit) * 100) : null);
      data = { fiveH: five ? pct(five) : null, sevenD: seven ? pct(seven) : null };
    }
  } catch { /* server not running → omit */ }

  if (data) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), data }));
    } catch { /* best-effort */ }
    return data;
  }
  // Fetch failed (server down or >200ms cold): keep showing the last known
  // quota rather than dropping the segment.
  return cached ? cached.data : null;
}

// ---------- colors ----------
// Palette = Kimi Code TUI 官方色板（apps/kimi-code/src/tui/theme/colors.ts），
// 属性 → 颜色的映射集中在这里，改颜色只动这张表。
const NO_COLOR = !!(process.env.NO_COLOR || process.env.KIMI_STATS_NO_COLOR);
const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
const KIMI = { // dark palette（与 TUI theme = "dark" 一致）
  primary: '#4FA8FF',   // 蓝：品牌/选中/plan 徽标
  accent: '#5BC0BE',    // 青：次级高亮
  text: '#E0E0E0',      // 正文（内置 footer 模型名用这个）
  textMuted: '#6B6B6B', // 最弱文本
  success: '#4EC87E',   // 绿：成功/diff 新增
  warning: '#E8A838',   // 金：auto/yolo 徽标
  error: '#E85454',     // 红：错误/diff 删除
  roleUser: '#FFCB6B',  // 黄：用户角色
  shellMode: '#BD93F9', // 紫：shell 模式
  white: '#FFFFFF',
};
// 属性组配色（按 TUI 语义选色，可自由改）：
const ATTR_COLORS = {
  project: KIMI.primary,    // 项目名 — 蓝
  branch: KIMI.shellMode,   // git 分支 — 紫
  mode: KIMI.warning,       // 权限模式 — 金（TUI 里 auto/yolo 徽标的颜色）
  modePlan: KIMI.primary,   // plan 模式 — 蓝（TUI 里 plan 徽标的颜色）
  model: KIMI.text,         // 模型·思考档 — 正文灰白（与内置 footer 一致）
  pace: KIMI.accent,        // 轮·步 / LLM / TTFT / tok/s — 青
  tokIn: KIMI.success,      // ↑ 输入 — 绿（diff 新增语义）
  tokOut: KIMI.error,       // ↓ 输出 — 红（diff 删除语义）
  tokSum: KIMI.roleUser,    // Σ 总量 — 黄
  quota: KIMI.white,        // 5h/7d 配额 — 白
  sep: KIMI.textMuted,      // 分隔符 — 暗灰
  cacheGood: KIMI.success,  // cache ≥95% — 绿
  cacheMid: KIMI.warning,   // cache 85~95% — 金
  cacheBad: KIMI.error,     // cache <85% — 红
};
const C = Object.fromEntries(Object.entries(ATTR_COLORS).map(([k, v]) => [k, hex(v)]));
C.reset = '\x1b[0m';
// cache hit-rate health gradient: low red → high green
function cacheColor(pct) {
  if (pct >= 95) return C.cacheGood;
  if (pct >= 85) return C.cacheMid;
  return C.cacheBad;
}
const paint = (color, s) => (NO_COLOR ? s : color + s + C.reset);
const SEP = NO_COLOR ? ' · ' : paint(C.sep, '·');
const GROUP = NO_COLOR ? ' | ' : ' ' + paint(C.sep, '|') + ' ';

// ---------- right-align helpers ----------
// Width of the terminal the TUI runs in. stdout is a pipe and the TUI spawns
// us detached (setsid → no controlling terminal, /dev/tty gives ENXIO), so
// walk the ancestor chain and query the tty the TUI itself sits on.
// Null when undetectable.
// Note: node's tty.ReadStream(fd).columns is undefined for an opened-by-fd
// tty, so ask stty instead (-f macOS / -F Linux).
function colsOf(dev) {
  for (const flag of ['-f', '-F']) {
    try {
      const out = execFileSync('stty', [flag, dev, 'size'], { encoding: 'utf8', timeout: 150, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const cols = parseInt(out.split(/\s+/)[1], 10);
      if (Number.isFinite(cols) && cols > 0) return cols;
    } catch { /* try next flag */ }
  }
  return null;
}

function termWidth() {
  let w = colsOf('/dev/tty');
  if (w) { dbg(`width via /dev/tty: ${w}`); return w; }
  let pid = process.pid;
  const seen = new Set();
  for (let i = 0; i < 10 && pid > 1 && !seen.has(pid); i++) {
    seen.add(pid);
    let out;
    try {
      out = execFileSync('ps', ['-o', 'ppid=,tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 150, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/);
    } catch (e) { dbg(`ps failed for pid ${pid}: ${e.message}`); break; }
    if (out.length < 2) { dbg(`ps parse failed for pid ${pid}: [${out}]`); break; }
    dbg(`walk pid=${pid} ppid=${out[0]} tty=${out[1]}`);
    const ttyName = out[1];
    if (ttyName && ttyName !== '??') {
      w = colsOf('/dev/' + ttyName.replace(/^.*\//, ''));
      dbg(`width via /dev/${ttyName}: ${w}`);
      if (w) return w;
      break;
    }
    pid = parseInt(out[0], 10);
    if (!Number.isFinite(pid)) break;
  }
  const envCols = parseInt(process.env.COLUMNS || '', 10);
  const result = Number.isFinite(envCols) && envCols > 0 ? envCols : null;
  dbg(`width result: ${result}`);
  return result;
}

// visible cell width: strip ANSI, CJK chars count as 2 columns
function visWidth(s) {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    )) ? 2 : 1;
  }
  return w;
}

// ---------- plugin self-policing ----------
// When this copy runs from plugins/managed (installed via `/plugins install`)
// and the plugin record is gone (removed) or disabled, take our block out of
// tui.toml and exit nonzero so the TUI falls back to the built-in footer —
// exactly what a disabled plugin should leave. Dev checkouts never police
// themselves; an unreadable installed.json fails open.
function pluginDisabled() {
  const here = fileURLToPath(import.meta.url);
  if (!here.includes(join('plugins', 'managed'))) return false;
  try {
    const records = JSON.parse(readFileSync(join(KIMI_DIR, 'plugins', 'installed.json'), 'utf8')).plugins;
    if (!Array.isArray(records)) return false;
    for (const rec of records) {
      if (rec && rec.id === 'kimi-stats-bar') return rec.enabled === false;
    }
    return true; // no record left: plugin was removed
  } catch {
    return false;
  }
}

// ---------- main ----------
async function main() {
  if (pluginDisabled()) {
    try {
      execFileSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'setup_statusline.mjs'), '--remove'], { timeout: 2000, stdio: 'ignore' });
    } catch { /* best-effort */ }
    process.exit(1);
  }
  let p = {};
  try { p = JSON.parse(readStdin()); } catch { /* ignore */ }
  dbg(`payload keys: ${Object.keys(p).join(',')} sessionId=${p.sessionId} model=${p.model} version=${p.version}`);

  const [quota, agg] = await Promise.all([
    fetchQuota(),
    Promise.resolve(scanSession(p.sessionId)),
  ]);

  // group 1: identity — project name, git branch, mode (payload carries all)
  const proj = p.cwd ? p.cwd.replace(/\/+$/, '').split('/').pop() : '';
  const mode = p.planMode ? 'plan' : (p.permissionMode || '');
  const gIdent = [
    proj && paint(C.project, proj),
    p.gitBranch && paint(C.branch, ` ${p.gitBranch}`),
    mode && paint(p.planMode ? C.modePlan : C.mode, mode),
  ].filter(Boolean).join(' ');

  // group 2: model + thinking effort (model from payload, effort from wire)
  const gModel = [];
  if (p.model) gModel.push(p.effort || (agg && agg.effort) ? `${p.model}·${p.effort || agg.effort}` : p.model);

  // group 3: session pace — turns/steps, LLM time, TTFT, speed
  const gPace = [];
  if (agg) {
    gPace.push(`${agg.turns}轮·${agg.steps}步`);
    if (agg.llmMs > 0) gPace.push(`LLM ${fmtDur(agg.llmMs)}`);
    if (agg.ttftN > 0) gPace.push(`TTFT ${(agg.ttftSum / agg.ttftN / 1000).toFixed(1)}s`);
    if (agg.streamSum > 0 && agg.out > 0) gPace.push(`${Math.round((agg.out / agg.streamSum) * 1000)} tok/s`);
  } else {
    gPace.push('0轮·0步'); // fresh session, no wire file yet
  }

  // group 4: tokens — cache hit-rate, in/out/total
  const gTok = [];
  const inAll = agg ? agg.inOther + agg.inCR + agg.inCC : 0;
  const out = agg ? agg.out : 0;
  if (inAll > 0) {
    const pct = Math.round((agg.inCR / inAll) * 100);
    gTok.push(paint(cacheColor(pct), `cache ${pct}%`));
  }
  gTok.push(paint(C.tokIn, `↑${fmtTok(inAll)}`) + ' ' + paint(C.tokOut, `↓${fmtTok(out)}`) + ' ' + paint(C.tokSum, `Σ${fmtTok(inAll + out)}`));

  // group 5 (right-aligned): subscription quota, white
  const gQuota = [];
  if (quota) {
    if (quota.fiveH != null) gQuota.push(paint(C.quota, `5h ${quota.fiveH}%`));
    if (quota.sevenD != null) gQuota.push(paint(C.quota, `7d ${quota.sevenD}%`));
  }

  const left = [gIdent, gModel.map((s) => paint(C.model, s)).join(''), gPace.map((s) => paint(C.pace, s)).join(SEP), gTok.join(SEP)]
    .filter((g) => g.length > 0)
    .join(GROUP);
  if (left.length === 0 && gQuota.length === 0) return; // nothing useful → TUI falls back

  const right = gQuota.join(SEP);
  if (right.length === 0) {
    process.stdout.write(left + '\n');
    return;
  }
  // right-align quota against the footer edge (same column the built-in
  // `context:` figure sits at). The TUI wraps the footer in
  // GutterContainer(CHROME_GUTTER=1, 1) and truncates line 1 to that inner
  // width, so target terminal width minus the 2 gutter columns; fall back to
  // a group separator when the width is unknown or the line would overflow.
  const w = termWidth();
  const pad = w === null ? -1 : w - 2 - visWidth(left) - visWidth(right);
  dbg(`left=${visWidth(left)} right=${visWidth(right)} width=${w} pad=${pad}`);
  process.stdout.write(pad >= 2 ? left + ' '.repeat(pad) + right + '\n' : left + GROUP + right + '\n');
}

// A closed stdout (consumer gone) must not turn into a nonzero exit —
// the TUI treats that as command failure and drops the line.
process.stdout.on('error', () => process.exit(0));

main().catch(() => process.exit(1));
