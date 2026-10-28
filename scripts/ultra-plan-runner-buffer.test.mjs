import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePlan } from './ultra-plan-runner.mjs';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Measured 2026-10-29: `bun run test` in repo bcb printed 1,483,368 bytes and
// exited 0, and the runner reported it as `exit 1, expected 0` because
// spawnSync's default 1 MiB maxBuffer killed it with ENOBUFS.
const BIG = 'yes a | head -c 1500000';

function runOne(cmd, opts = {}) {
  return executePlan(
    { tasks: [{ id: 'T1', depends_on: [], run: [{ cmd, retry: 0 }] }], defaults: { retry_transient_max: 0, step_timeout_s: 30 } },
    { execute: true, ...opts },
  );
}

test('a step that prints more than 1 MiB and exits 0 is PASSED', () => {
  const { status, ledger } = runOne(BIG);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('a step that prints more than 1 MiB and exits 3 reports exit 3', () => {
  const { status, ledger } = runOne(`${BIG}; exit 3`);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].exit, 3);
  assert.equal(ledger[0].klass, 'code');
});

test('output past the runner buffer is an output-limit failure, never a code failure', () => {
  const { status, ledger } = runOne(BIG, { maxBuffer: 1000 });
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  const row = ledger[0];
  assert.equal(row.klass, 'output-limit');
  assert.notEqual(row.exit, 1);
  assert.match(row.cause, /ENOBUFS/);
  assert.match(row.cause, /1000 bytes/);
  assert.match(row.trace, /ENOBUFS/);
});

test('a step stopped for output past the buffer leaves no background child running', () => {
  const dir = path.join(os.homedir(), '.cache/tmp/vivera-scratch');
  mkdirSync(dir, { recursive: true });
  const pidFile = path.join(dir, `buffer-reap-${process.pid}.pid`);
  rmSync(pidFile, { force: true });
  const cmd = `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; yes a | head -c 5000`;
  const { ledger } = runOne(cmd, { maxBuffer: 1000 });
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  rmSync(pidFile, { force: true });
  assert.ok(pid > 0, 'the step should have written the background pid');
  // A killed child can linger briefly as a zombie until init reaps it.
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0); Bun.sleepSync(100); } catch { alive = false; }
  }
  if (alive) process.kill(pid, 'SIGKILL');
  assert.equal(ledger[0].klass, 'output-limit');
  assert.equal(alive, false, `background child ${pid} survived the ENOBUFS stop`);
});
