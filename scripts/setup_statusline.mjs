#!/usr/bin/env node
/**
 * kimi-stats-bar plugin: status_line auto-setup, run by the SessionStart hook.
 *
 * The plugin manifest cannot declare a [status_line] command, so this hook
 * merges one into <KIMI_CODE_HOME>/tui.toml, delimited by marker comments:
 *
 *   # >>> kimi-stats-bar
 *   [status_line]
 *   command = "node \"<plugin-root>/statusline.mjs\""
 *   # <<< kimi-stats-bar
 *
 * - idempotent: the managed block is created once and refreshed in place
 * - conservative: a [status_line].command the user already owns is left
 *   alone unless it is recognizably ours (path contains kimi-stats-bar)
 * - silent + fail-open: prints nothing, exits 0 on any error
 *
 * `node setup_statusline.mjs --remove` removes the managed block (called by
 * statusline.mjs itself when the plugin has been disabled or removed).
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MARK_BEGIN = '# >>> kimi-stats-bar';
const MARK_END = '# <<< kimi-stats-bar';
const KIMI_HOME = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
const TUI_TOML = join(KIMI_HOME, 'tui.toml');
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COMMAND = `command = "node \\"${join(PLUGIN_ROOT, 'statusline.mjs')}\\""`;

const SECTION_RE = /^\s*\[\s*"?status_line"?\s*\]\s*(#.*)?$/m;
const ANY_SECTION_RE = /^\s*\[[^\]]*\]\s*(#.*)?$/;

function block() {
  return `${MARK_BEGIN}\n[status_line]\n${COMMAND}\n${MARK_END}`;
}

// crude TOML sanity: every non-comment line that starts with '[' closes it,
// and no duplicated table headers
function looksValidToml(s) {
  const seen = new Set();
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const m = line.match(/^\[\s*"?([\w.-]+)"?\s*\]/);
      if (!m) return false;
      if (seen.has(m[1])) return false;
      seen.add(m[1]);
    }
  }
  return true;
}

function install() {
  let s = '';
  try { s = readFileSync(TUI_TOML, 'utf8'); } catch { /* file may not exist yet */ }

  if (s.includes(MARK_BEGIN)) {
    // refresh existing managed block in place
    const re = new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}`);
    const next = s.replace(re, block());
    if (next !== s && looksValidToml(next)) writeFileSync(TUI_TOML, next);
    return;
  }

  const sec = s.match(SECTION_RE);
  if (sec) {
    // find section body until the next table header
    const start = sec.index + sec[0].length;
    const rest = s.slice(start);
    const lines = rest.split('\n');
    let end = start + rest.length;
    let off = start;
    const bodyLines = [];
    for (const line of lines) {
      if (ANY_SECTION_RE.test(line)) { end = off; break; }
      bodyLines.push(line);
      off += line.length + 1;
    }
    const body = bodyLines.join('\n');
    const cmdMatch = body.match(/^\s*command\s*=\s*(.+)$/m);
    if (cmdMatch && !cmdMatch[1].includes('kimi-stats-bar')) {
      return; // user owns a different status_line command — do not override
    }
    // section is ours-adoptable or command-less: replace whole section
    const next = s.slice(0, sec.index) + block() + '\n' + s.slice(end).replace(/^\n+/, '');
    if (looksValidToml(next)) writeFileSync(TUI_TOML, next);
    return;
  }

  const next = (s.endsWith('\n') || s === '' ? s : s + '\n') + '\n' + block() + '\n';
  if (looksValidToml(next)) writeFileSync(TUI_TOML, next);
}

function remove() {
  let s;
  try { s = readFileSync(TUI_TOML, 'utf8'); } catch { return; }
  if (!s.includes(MARK_BEGIN)) return;
  const re = new RegExp(`\\n?${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`);
  const next = s.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
  if (looksValidToml(next)) {
    try { copyFileSync(TUI_TOML, TUI_TOML + '.kimi-stats-bar.bak'); } catch { /* best-effort */ }
    writeFileSync(TUI_TOML, next);
  }
}

try {
  if (process.argv.includes('--remove')) remove();
  else install();
} catch { /* fail-open */ }
process.exit(0);
