// scripts/hooks/overnight-notify.test.mjs
//
// Guards for the StopFailure and quota Notification hook that pings the owner
// during an unattended sucp-overnight run.
//
// The hook is spawned the way Claude Code runs it (one JSON object on stdin)
// with a temp VIVERA_OVERNIGHT_DIR and a stub NOTIFY_TS that records its argv,
// because the real notify CLI is the system boundary (Telegram bridge).

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.join(import.meta.dir, 'overnight-notify.mjs');
const tempDirs = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function setup({ stub = 'ok', marker = true, sessionId = 'sess-1' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'overnight-notify-'));
  tempDirs.push(root);
  const dir = path.join(root, 'state');
  const calls = path.join(root, 'calls.jsonl');
  const notify = path.join(root, 'notify-stub.mjs');
  const body = {
    ok: `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    exit1: `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(1);\n`,
    throws: `throw new Error('stub crashed');\n`,
  }[stub];
  writeFileSync(notify, body);
  if (marker) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, sessionId), 'plan=2026-11-08-demo-plan\nhandoff=/tmp/demo/handoff.md\n');
  }
  return { dir, calls, notify };
}

function run(env, input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const r = spawnSync('bun', [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, VIVERA_OVERNIGHT_DIR: env.dir, NOTIFY_TS: env.notify },
    timeout: 30_000,
  });
  return r;
}

function calls(env) {
  if (!existsSync(env.calls)) return [];
  return readFileSync(env.calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function errorLines(env) {
  const f = path.join(env.dir, 'errors.log');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
}

test('marker present and StopFailure rate_limit sends one line with plan, event, type and handoff', () => {
  const env = setup();
  const r = run(env, { session_id: 'sess-1', hook_event_name: 'StopFailure', error_type: 'rate_limit' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  const c = calls(env);
  expect(c.length).toBe(1);
  expect(c[0].length).toBe(1);
  expect(c[0][0]).toBe('2026-11-08-demo-plan: StopFailure rate_limit (handoff /tmp/demo/handoff.md)');
});

test('marker present and Notification quota_auto_resume_stale sends the same shape', () => {
  const env = setup();
  const r = run(env, {
    session_id: 'sess-1',
    hook_event_name: 'Notification',
    notification_type: 'quota_auto_resume_stale',
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  const c = calls(env);
  expect(c.length).toBe(1);
  expect(c[0][0]).toBe('2026-11-08-demo-plan: Notification quota_auto_resume_stale (handoff /tmp/demo/handoff.md)');
});

test('missing type falls back to unknown', () => {
  const env = setup();
  run(env, { session_id: 'sess-1', hook_event_name: 'StopFailure' });
  expect(calls(env)[0][0]).toBe('2026-11-08-demo-plan: StopFailure unknown (handoff /tmp/demo/handoff.md)');
});

test('message and error text never reach the notice line', () => {
  const env = setup();
  const r = run(env, {
    session_id: 'sess-1',
    hook_event_name: 'StopFailure',
    error_type: 'authentication_failed',
    message: 'SECRET-TOKEN-abc123',
    error: 'SECRET-ERROR-xyz',
  });
  expect(r.status).toBe(0);
  const c = calls(env);
  expect(c.length).toBe(1);
  expect(c[0][0]).not.toContain('SECRET');
});

test('no marker means notify is not called, exit 0, no output', () => {
  const env = setup({ marker: false });
  const r = run(env, { session_id: 'sess-1', hook_event_name: 'StopFailure', error_type: 'rate_limit' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(calls(env).length).toBe(0);
  expect(errorLines(env).length).toBe(0);
});

for (const bad of ['../x', 'a/b', '..', '']) {
  test(`session id ${JSON.stringify(bad)} is rejected before it becomes a path`, () => {
    const env = setup();
    // A marker at the traversal target would be read if the id were trusted.
    writeFileSync(path.join(path.dirname(env.dir), 'x'), 'plan=evil\nhandoff=/evil\n');
    const r = run(env, { session_id: bad, hook_event_name: 'StopFailure', error_type: 'rate_limit' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(calls(env).length).toBe(0);
    expect(errorLines(env).length).toBe(1);
  });
}

test('bad JSON exits 0 and logs one timestamped error line', () => {
  const env = setup({ marker: false });
  const r = run(env, '{not json');
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  const lines = errorLines(env);
  expect(lines.length).toBe(1);
  expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('notify exiting 1 still exits 0 and logs an error', () => {
  const env = setup({ stub: 'exit1' });
  const r = run(env, { session_id: 'sess-1', hook_event_name: 'StopFailure', error_type: 'overloaded' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(calls(env).length).toBe(1);
  expect(errorLines(env).length).toBe(1);
});

test('notify throwing still exits 0 and logs an error', () => {
  const env = setup({ stub: 'throws' });
  const r = run(env, { session_id: 'sess-1', hook_event_name: 'StopFailure', error_type: 'billing_error' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(errorLines(env).length).toBe(1);
});
