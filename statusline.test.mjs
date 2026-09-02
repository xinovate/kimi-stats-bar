import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { compactBranch, latestSpeedSample, parseQuota, visWidth } from './statusline.mjs';

test('compacts a conventional branch around its low-value middle', () => {
  const branch = 'feature/wx/20260901-教师端错题本改造';
  assert.equal(compactBranch(branch), 'feature/wx/…教师端错题本改造');
  assert.ok(visWidth(compactBranch(branch)) <= 28);
  assert.equal(compactBranch('main'), 'main');
});

test('uses the latest real stream instead of synthetic 1ms steps', () => {
  assert.equal(latestSpeedSample({ llmStreamDurationMs: 1 }, { output: 851 }), null);
  assert.equal(Math.round(latestSpeedSample({ llmStreamDurationMs: 7587 }, { output: 472 })), 62);
});

test('parses the normalized local-server quota shape', () => {
  assert.deepEqual(parseQuota({
    data: {
      kind: 'ok',
      summary: { used: 76, limit: 100 },
      limits: [{ window: { duration: 5, unit: 'hour' }, used: 14, limit: 100 }],
    },
  }), { fiveH: 14, sevenD: 76 });
});

test('parses the managed API shape and derives used from remaining', () => {
  assert.deepEqual(parseQuota({
    usage: { used: '100', limit: '100' },
    limits: [{
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { remaining: '100', limit: '100' },
    }],
  }), { fiveH: 0, sevenD: 100 });
});

test('renders the compact branch and latest valid step speed end to end', () => {
  const home = mkdtempSync(join(tmpdir(), 'kimi-stats-bar-'));
  try {
    const sessionId = 'session_test';
    const wireDir = join(home, 'sessions', 'wd_test', sessionId, 'agents', 'main');
    mkdirSync(wireDir, { recursive: true });
    const events = [
      { type: 'turn.prompt' },
      { type: 'step.end', event: { type: 'step.end', usage: { output: 472 }, llmStreamDurationMs: 7587 } },
      { type: 'step.end', event: { type: 'step.end', usage: { output: 851 }, llmStreamDurationMs: 1 } },
    ];
    writeFileSync(join(wireDir, 'wire.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    mkdirSync(join(home, 'statusline-cache'), { recursive: true });
    writeFileSync(join(home, 'statusline-cache', 'quota.json'), JSON.stringify({
      ts: Date.now(),
      data: { fiveH: 0, sevenD: 100 },
    }));

    const script = fileURLToPath(new URL('./statusline.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], {
      input: JSON.stringify({
        cwd: '/tmp/hrdt-cloud',
        gitBranch: 'feature/wx/20260901-教师端错题本改造',
        permissionMode: 'auto',
        model: 'GLM-5.3',
        sessionId,
      }),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', KIMI_CODE_HOME: home, COLUMNS: '200' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /feature\/wx\/…教师端错题本改造/);
    assert.match(run.stdout, /62 tok\/s/);
    assert.match(run.stdout, /5h 0% · 7d 100%/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('renders a quota placeholder while a stale cache is refreshing', () => {
  const home = mkdtempSync(join(tmpdir(), 'kimi-stats-bar-'));
  try {
    const cacheDir = join(home, 'statusline-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'quota.json'), JSON.stringify({
      ts: Date.now() - 10 * 60_000,
      attemptTs: Date.now() - 10 * 60_000,
      data: { fiveH: 14, sevenD: 76 },
    }));
    // Simulate the detached refresher holding the lock so the test does not
    // launch a real background process.
    writeFileSync(join(cacheDir, 'quota-refresh.lock'), '');

    const script = fileURLToPath(new URL('./statusline.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ cwd: '/tmp/hrdt-cloud', model: 'K3-256k' }),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', KIMI_CODE_HOME: home, COLUMNS: '120' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /5h … · 7d …/);
    assert.doesNotMatch(run.stdout, /14%|76%/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
