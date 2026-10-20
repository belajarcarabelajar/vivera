import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RUNNER = path.join(import.meta.dirname, 'ultra-plan-runner.mjs');

// `bun test` runs the named files that exist and exits 0, so every probe below
// names a real passing file next to the missing one: without the runner's own
// check, those probes pass.
const task = (id, extra) => `  - id: ${id}
    depends_on: []
    impacts: ["demo - test -f ./plan.md"]
    files: { create: [], modify: [], test: [] }
    idempotency_key: "${id}:demo"
    verify_exit: 0
${extra}`;

const PLAN = `---
schema: ultra-plan/v1
plan_id: 2026-10-20-missing-paths-demo
status: Approved
version: 1
runner_contract: true
defaults:
  retry_transient_max: 0
tasks:
${task('T1', `    skip_if: "bun test ./present.test.mjs ./missing-skip.test.mjs"
    run:
      - cmd: "touch t1-ran"`)}
${task('T2', `    skip_if: "bun test ./present.test.mjs"
    run:
      - cmd: "touch t2-ran"`)}
${task('T3', `    run:
      - cmd: "touch t3-ran && timeout 60 bun test ./present.test.mjs ./missing-run.test.mjs"`)}
${task('T4', `    run:
      - cmd: "timeout 60 bun test ./present.test.mjs"`)}
---
# Missing paths demo

### Task T1: skip_if names a missing file
### Task T2: skip_if names only real files
### Task T3: run step names a missing file
### Task T4: run step names only real files

\`\`\`mermaid
flowchart TD
    T1["T1"]
    T2["T2"]
    T3["T3"]
    T4["T4"]
\`\`\`
`;

let dir;
let result;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'runner-missing-paths-'));
  writeFileSync(path.join(dir, 'present.test.mjs'), "import { test } from 'bun:test';\ntest('ok', () => {});\n");
  writeFileSync(path.join(dir, 'plan.md'), PLAN);
  const r = spawnSync(process.execPath, [RUNNER, 'plan.md', '--execute'], {
    cwd: dir,
    encoding: 'utf8',
    // No real publish config: the mirror gate only warns, and stays off the user's vault.
    env: { ...process.env, PLAN_PUBLISH_CONFIG: path.join(dir, 'no-such-config.json') },
  });
  result = { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const statusOf = (id) => result.out.match(new RegExp(`^  ${id}: (\\S+)`, 'm'))?.[1];
const ledgerRow = (id) => result.out.split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';

test('a skip_if naming a missing test file does not skip: the task runs its steps', () => {
  expect(statusOf('T1')).not.toBe('SKIPPED-IDEMPOTENT');
  expect(statusOf('T1')).toBe('PASSED');
  expect(existsSync(path.join(dir, 't1-ran'))).toBe(true);
});

test('a skip_if naming only existing test files still skips (control)', () => {
  expect(statusOf('T2')).toBe('SKIPPED-IDEMPOTENT');
  expect(existsSync(path.join(dir, 't2-ran'))).toBe(false);
});

test('a run step naming a missing test file fails the task without running the step', () => {
  expect(statusOf('T3')).toBe('FAILED-ISOLATED');
  expect(existsSync(path.join(dir, 't3-ran'))).toBe(false);
});

test('the Error Ledger row names E_MISSING_TEST_PATH and the missing path', () => {
  const row = ledgerRow('T3');
  expect(row).toContain('E_MISSING_TEST_PATH');
  expect(row).toContain('./missing-run.test.mjs');
  expect(row).toContain('FAILED-ISOLATED');
});

test('a run step naming only existing test files passes (control)', () => {
  expect(statusOf('T4')).toBe('PASSED');
  expect(ledgerRow('T4')).toBe('');
});

test('the run exits 1 because the ledger has a failure', () => {
  expect(result.code).toBe(1);
});
