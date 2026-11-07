// scripts/lib/remote-runner.mjs
//
// Optional remote runner for the commands a plan supplies (`skip_if`,
// `run[].cmd`, `loop_until`), so a host that sends heavy work elsewhere can
// keep plan test commands off the local machine.
//
//   SUCP_REMOTE_RUNNER                 a command prefix; `<cmd>` then runs as
//                                      `<prefix> bash -c '<cmd>'`. Unset or blank
//                                      runs `<cmd>` locally, as before.
//   SUCP_REMOTE_RUNNER_FALLBACK_EXIT   an exit code meaning "runner unavailable";
//                                      on that code `<cmd>` reruns locally once.

// POSIX single quoting: the only character that needs care is the quote itself.
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function fallbackExit(env) {
  const v = (env.SUCP_REMOTE_RUNNER_FALLBACK_EXIT ?? '').trim();
  return /^\d+$/.test(v) ? Number(v) : null;
}

// `exec(shellString)` runs one shell string the way the call site always has
// and returns a result with `exit`; this only decides which string it gets.
export function runPlanCommand(cmd, exec, env = process.env) {
  const runner = (env.SUCP_REMOTE_RUNNER ?? '').trim();
  if (!runner) return exec(cmd);
  const r = exec(`${runner} bash -c ${shellQuote(cmd)}`);
  const fb = fallbackExit(env);
  return fb !== null && r.exit === fb ? exec(cmd) : r;
}
