// scripts/lib/runner-process.mjs
//
// Step execution for scripts/ultra-plan-runner.mjs: one shell command per call,
// with its timeout, output buffer, and process-group reaping. Split out of the
// runner so the runner stays under its size-gate ceiling.

import { spawnSync } from 'node:child_process';

// A step that overruns `step_timeout_s` must take its CHILDREN with it.
//
// Measured, not assumed. `spawnSync(..., { shell: true, timeout })` signals only
// the shell it spawned: on `sh -c "sleep 47 & wait"` with a 2s timeout it
// returned ETIMEDOUT/SIGTERM and the backgrounded `sleep 47` was still running
// afterwards. A plan step is written as a command chain (`&&`), and commands in
// this repository spawn builds, test runners, and browsers, so a timed-out step
// used to leave exactly the dangling worker the master skill's own Stalled
// Subagent & Stale-Writer Guardrail warns about — aimed at the agent, and never
// at the runner executing on its behalf.
//
// `detached: true` puts the child in its OWN process group, so one signal to the
// negated pid reaches every descendant. SIGTERM first (the polite signal, so a
// build gets to clean up its own temp files), then SIGKILL for whatever is left
// after a short grace period.
const GROUP_KILL_GRACE_MS = 500;

export function reapGroup(pid, { log, why = 'timed-out' } = {}) {
  if (!pid) return false;
  let killed = false;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal);
      killed = true;
    } catch (e) {
      // ESRCH means the group is already gone, which is the success case here.
      // EPERM means it exists and is not ours, and retrying SIGKILL would not
      // change that, so both stop the sweep rather than throwing: a cleanup path
      // that throws would mask the timeout the caller is trying to report.
      break;
    }
    if (signal === 'SIGTERM') {
      // Synchronous by design. There is no event loop to come back to inside
      // spawnSync's caller, so the grace period is a blocking wait, and it is
      // bounded and short by design.
      spawnSync('sleep', [`${GROUP_KILL_GRACE_MS / 1000}`]);
    }
  }
  if (killed) log?.(`      (reaped the ${why} step's process group ${pid})`);
  return killed;
}

// Measured 2026-10-29: `bun run test` in repo bcb printed 1,483,368 bytes, past the 1 MiB default, and was killed with ENOBUFS.
export const STEP_MAX_BUFFER = 256 * 1024 * 1024;

export function run(cmd, timeoutMs, { log, maxBuffer = STEP_MAX_BUFFER } = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: timeoutMs, detached: true, maxBuffer });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  // Any other spawn error means the runner, not the step, ended the command, so
  // `status` is null and the step's real exit code is unknown. Mapping that to
  // exit 1 made an ENOBUFS kill read as an ordinary test failure.
  const spawnError = r.error && !timedOut ? { code: r.error.code || 'unknown', maxBuffer } : null;
  // ENOBUFS kills only the shell, like a timeout does, so its children need the same sweep.
  const reaped = timedOut
    ? reapGroup(r.pid, { log })
    : (spawnError ? reapGroup(r.pid, { log, why: `stopped (${spawnError.code})` }) : false);
  let stderr = r.stderr || '';
  if (spawnError) {
    const why = spawnError.code === 'ENOBUFS'
      ? `ENOBUFS: step output exceeded the runner's maxBuffer of ${maxBuffer} bytes`
      : `spawn error ${spawnError.code}`;
    const note = `[runner] ${why}; the step's real exit code is unknown`;
    log?.(`      (${note})`);
    stderr = `${stderr}${!stderr || stderr.endsWith('\n') ? '' : '\n'}${note}\n`;
  }
  return {
    exit: timedOut ? 124 : (spawnError ? '-' : (r.status ?? 1)),
    timedOut,
    reaped,
    spawnError,
    stderr,
    stdout: r.stdout || '',
  };
}
