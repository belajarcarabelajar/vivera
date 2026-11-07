// scripts/plan-closeout-remote.test.mjs
//
// `plan-closeout --readiness` sends each task's skip_if through SUCP_REMOTE_RUNNER
// (scripts/lib/remote-runner.mjs) when it is set. Split from plan-closeout.test.mjs,
// which sits at its size ceiling.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

test('readiness CLI: SUCP_REMOTE_RUNNER receives skip_if as bash -c <cmd>', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
  dirs.push(root);
  const runner = path.join(root, 'fake-runner');
  writeFileSync(runner, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > runner-args\nexec "$@"\n');
  chmodSync(runner, 0o755);
  const file = path.join(root, 'plan.md');
  writeFileSync(file, [
    '---', 'schema: ultra-plan/v1', 'plan_id: demo', 'tasks:',
    '  - id: T1', '    depends_on: []', '    skip_if: "test -d . && echo \'ok\'"', '---', '',
  ].join('\n'));
  const r = Bun.spawnSync(['bun', script, '--readiness', file, '--cwd', root, '--timeout-s', '10'], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SUCP_REMOTE_RUNNER: runner },
  });
  assert.match(r.stdout.toString(), /^T1\tDONE\t/);
  assert.equal(readFileSync(path.join(root, 'runner-args'), 'utf8'), "bash\n-c\ntest -d . && echo 'ok'\n");
});
