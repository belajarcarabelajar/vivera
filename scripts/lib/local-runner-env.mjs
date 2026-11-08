// scripts/lib/local-runner-env.mjs
//
// Imported first by tests that cover the local path of skip_if and plan steps.
// The shell may set SUCP_REMOTE_RUNNER (~/.bashrc), which sends those commands to
// a remote machine, so the tests failed whenever it was set and the remote was down.
// Importing this clears it for the test process. Bun.spawnSync without an `env`
// option does not see the delete, so spawn children with `env: { ...process.env }`.
// plan-closeout-remote.test.mjs and lib/remote-runner.test.mjs cover the remote path.

delete process.env.SUCP_REMOTE_RUNNER;
delete process.env.SUCP_REMOTE_RUNNER_FALLBACK_EXIT;
