import { test, afterAll } from 'bun:test';
import './lib/local-runner-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  executePlan,
  validatePlan,
  parseUltraPlanYaml,
  RUNNER_CONTRACT_KEYS,
} from './ultra-plan-runner.mjs';

// Per-task files_root: the folder a task's relative `files` resolve against.
// The 31 to 35 close ran a plan from the vivera checkout whose tasks declared
// bcb paths, and every precondition failed because the paths resolved against
// the runner's cwd. Only the public runner API is imported, so a missing helper
// module shows up as a failed assertion, not as an import error.

const RUNNER = path.join(import.meta.dirname, 'ultra-plan-runner.mjs');
const scratch = mkdtempSync(path.join(tmpdir(), 'files-root-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function folders() {
  n += 1;
  const a = path.join(scratch, `case-${n}`, 'runner-cwd');
  const b = path.join(scratch, `case-${n}`, 'other-repo');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  return { a, b };
}

const plan = (tasks) => ({ schema: 'ultra-plan/v1', runner_contract: true, defaults: {}, tasks });
const run = (tasks, dir) => executePlan(plan(tasks), { execute: true, dir });

// ---------- RED cases ----------

test('modify and test paths resolve against files_root, not the runner cwd', () => {
  const { a, b } = folders();
  writeFileSync(path.join(b, 'x.txt'), 'x\n');
  writeFileSync(path.join(b, 'x.test.txt'), 'x\n');
  const { status, ledger } = run([{
    id: 'T1', depends_on: [], files_root: b,
    files: { create: [], modify: ['x.txt'], test: ['x.test.txt'] },
    run: [{ cmd: 'true' }],
  }], a);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('a create path resolves against files_root after the steps ran', () => {
  const { a, b } = folders();
  const made = path.join(b, 'made.txt');
  const { status, ledger } = run([{
    id: 'T1', depends_on: [], files_root: b,
    files: { create: ['made.txt'], modify: [], test: [] },
    run: [{ cmd: `touch '${made}'` }],
  }], a);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('with files_root set, a path present only in the runner cwd is missing', () => {
  const { a, b } = folders();
  writeFileSync(path.join(a, 'x.txt'), 'x\n');
  const { status, ledger } = run([{
    id: 'T1', depends_on: [], files_root: b,
    files: { create: [], modify: ['x.txt'], test: [] },
    run: [{ cmd: 'true' }],
  }], a);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.match(ledger[0].cause, /modify: x\.txt/);
});

test('the CLI run from folder A passes a task whose files live in folder B', () => {
  const { a, b } = folders();
  writeFileSync(path.join(b, 'x.txt'), 'x\n');
  const md = [
    '---',
    'schema: ultra-plan/v1',
    'plan_id: 2026-11-21-files-root-demo',
    'status: Approved',
    'runner_contract: true',
    'tasks:',
    '  - id: T1',
    '    depends_on: []',
    `    files_root: "${b}"`,
    '    files: { create: [], modify: [x.txt], test: [] }',
    '    run:',
    '      - cmd: "true"',
    '        expect_exit: 0',
    '---',
    '# Demo',
    '',
    '### Task T1: files in another folder',
    '',
    '```mermaid',
    'flowchart TD',
    '    T1["T1: files in another folder"]',
    '```',
    '',
  ].join('\n');
  const file = path.join(a, 'plan.md');
  writeFileSync(file, md);
  const r = spawnSync('bun', [RUNNER, file, '--execute'], { cwd: a, encoding: 'utf8', env: { ...process.env } });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /T1: PASSED/);
});

for (const [label, value] of [['blank', ''], ['whitespace', '   '], ['relative', 'sub/dir'], ['non-string', 5]]) {
  test(`validatePlan rejects a ${label} files_root and names the task`, () => {
    const { errors } = validatePlan(plan([{ id: 'T7', depends_on: [], files_root: value, skip_if: 'false' }]), null);
    assert.ok(errors.some((e) => /task T7 files_root/.test(e)), errors.join(' | '));
  });
}

test('RUNNER_CONTRACT_KEYS names tasks[].files_root', () => {
  assert.ok(RUNNER_CONTRACT_KEYS.includes('tasks[].files_root'));
});

// ---------- controls: hold before and after ----------

test('control: without files_root a missing relative path still fails the precondition', () => {
  const { a, b } = folders();
  writeFileSync(path.join(b, 'x.txt'), 'x\n');
  const { status, ledger } = run([{
    id: 'T1', depends_on: [],
    files: { create: [], modify: ['x.txt'], test: [] },
    run: [{ cmd: 'true' }],
  }], a);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].step, 'pre');
  assert.match(ledger[0].cause, /modify: x\.txt/);
});

test('control: without files_root a relative path present in the runner cwd passes', () => {
  const { a } = folders();
  writeFileSync(path.join(a, 'x.txt'), 'x\n');
  const { status, ledger } = run([{
    id: 'T1', depends_on: [],
    files: { create: [], modify: ['x.txt'], test: [] },
    run: [{ cmd: 'true' }],
  }], a);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('control: an absolute files entry resolves as written whatever files_root says', () => {
  const { a, b } = folders();
  const elsewhere = path.join(scratch, `abs-${n}.txt`);
  writeFileSync(elsewhere, 'x\n');
  const { status, ledger } = run([{
    id: 'T1', depends_on: [], files_root: b,
    files: { create: [], modify: [elsewhere], test: [] },
    run: [{ cmd: 'true' }],
  }], a);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('control: an absolute files_root raises no files_root error', () => {
  const { errors } = validatePlan(plan([{ id: 'T7', depends_on: [], files_root: '/srv/repo', skip_if: 'false' }]), null);
  assert.ok(!errors.some((e) => /files_root/.test(e)), errors.join(' | '));
});

test('control: the frontmatter parser reads files_root as a plain string', () => {
  const parsed = parseUltraPlanYaml('schema: ultra-plan/v1\ntasks:\n  - id: T1\n    files_root: "/abs/dir"\n    files: { create: [], modify: [x.txt], test: [] }\n');
  assert.equal(parsed.tasks[0].files_root, '/abs/dir');
  assert.deepEqual(parsed.tasks[0].files.modify, ['x.txt']);
});
