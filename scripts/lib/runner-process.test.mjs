// scripts/lib/runner-process.test.mjs
//
// Process-group reaping of a timed-out plan step (runner-process.mjs), driven
// through executePlan so the ledger contract (timeout, exit 124) is checked too.
// Moved out of ultra-plan-runner.test.mjs, which sits at its size-gate ceiling.

import { test } from 'node:test';
import './local-runner-env.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executePlan } from '../ultra-plan-runner.mjs';

// Whether pid is still RUNNING, which is not the same as still having a pid.
//
// Measured 2026-11-26 in the ma-run cloud container: the grandchild was killed
// with its group and reparented to pid 1 (`process_api --firecracker-init`),
// which had not reaped it 200 ms later; /proc/<pid>/stat read `(sleep) Z 1`.
// `kill(pid, 0)` succeeds on a zombie, so it alone read a dead process as a leak.
// A zombie has exited and holds no resources; only its parent can remove it,
// and that parent is init, not the runner. So a zombie counts as gone. Any
// other /proc read failure keeps the process alive, and so does a missing /proc
// while kill(pid, 0) still succeeds, so the check cannot pass vacuously.
function isRunning(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return true;
    // ENOENT: either the process vanished since the kill above, or there is no
    // /proc at all. Ask the kernel again; only the first case makes it fail.
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  // The state is the first field after the command name, which is in parens and
  // may itself contain spaces or parens, so split after the LAST ')'.
  const state = stat.slice(stat.lastIndexOf(')') + 1).trim().split(' ')[0];
  return state !== 'Z' && state !== 'X';
}

test('a timed-out step takes its background children with it', () => {
  // Measured, and the reason `detached: true` plus a negated-pid signal exists.
  // Without it, `spawnSync(..., { shell: true, timeout })` signals only the
  // shell: on `sh -c "sleep N & wait"` the backgrounded sleep was still running
  // after the runner had already reported ETIMEDOUT. The master skill has a whole
  // guardrail section about dangling workers, aimed at the agent, never at the
  // runner acting on its behalf.
  const pidFile = path.join(tmpdir(), `vivera-orphan-${process.pid}.pid`);
  rmSync(pidFile, { force: true });
  const cmd = `sh -c "sleep 30 & echo \\$! > ${pidFile}; wait"`;
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { step_timeout_s: 1 },
    tasks: [{ id: 'T1', depends_on: [], verify_exit: 0, run: [{ cmd, expect_exit: 0, retry: 0 }] }],
  };
  try {
    const { status, ledger } = executePlan(plan, { execute: true, log: () => {} });
    assert.equal(status.get('T1'), 'FAILED-ISOLATED');
    assert.equal(ledger[0].klass, 'timeout');
    assert.equal(ledger[0].exit, 124, 'a timeout reports 124, the code the rest of POSIX reserves for it');
    assert.ok(existsSync(pidFile), 'the inner shell must have recorded the pid it spawned');
    const orphan = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(orphan > 0, `expected a real pid, got ${orphan}`);
    assert.equal(isRunning(orphan), false, `the grandchild ${orphan} outlived the step and is still running`);
  } finally {
    rmSync(pidFile, { force: true });
  }
});

test('isRunning reads this process as running and an unused pid as gone', () => {
  assert.equal(isRunning(process.pid), true, 'this test process is running');
  assert.equal(isRunning(2 ** 22 + 1), false, 'a pid above pid_max cannot exist');
});

test('isRunning counts a zombie as gone, where kill(pid, 0) alone does not', () => {
  // The cloud failure in miniature: a child that has exited but is not reaped
  // yet, because the blocking sleep keeps the event loop from waiting on it.
  const child = spawn('true');
  spawnSync('sleep', ['0.3']);
  let killZero = true;
  try { process.kill(child.pid, 0); } catch { killZero = false; }
  assert.equal(killZero, true, 'control: the exited child must still hold its pid as a zombie');
  assert.equal(isRunning(child.pid), false);
});
