// scripts/plan-readiness-asserted.test.mjs
//
// A task with no check command (skip_if "false" or empty) whose step boxes are
// all ticked is DONE-ASSERTED, and the readiness evidence log that
// plan-mark-done --from reads back. Temp fixture plans only, no network.

import './lib/local-runner-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// A namespace import, so a name the lib does not export yet fails its own test, not the whole file.
import * as lib from './lib/plan-readiness.mjs';
import { markDone } from './plan-mark-done.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
const FENCE = '\x60\x60\x60';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// tasks: [{ id, skipIf, body: [lines under "### Task <id>"] }]; body undefined means no section.
const planOf = (tasks) => [
  '---',
  'schema: ultra-plan/v1',
  'plan_id: demo',
  'status: Verification',
  'tasks:',
  ...tasks.flatMap(({ id, skipIf }) => [
    `  - id: ${id}`,
    '    depends_on: []',
    `    skip_if: ${JSON.stringify(skipIf)}`,
  ]),
  '---',
  '',
  '# Demo',
  '',
  ...tasks.flatMap(({ id, body }) => (body === undefined ? [] : [`### Task ${id}: work`, ...body, ''])),
].join('\n');

const run = (cmd) => ({ exit: cmd === 'true' ? 0 : 1, timedOut: false, stdout: '', stderr: '' });
const states = (text) => lib.taskReadiness(text, { run, cwd: tmpdir(), timeoutMs: 1000 }).map((r) => [r.id, r.state]);
const verdictOf = (text) => lib.readinessVerdict({
  tasks: lib.taskReadiness(text, { run, cwd: tmpdir(), timeoutMs: 1000 }),
  openBoxes: lib.openStepBoxes(text).length,
});

function cli(text, extra = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-readiness-asserted-'));
  dirs.push(root);
  const file = path.join(root, 'plan.md');
  writeFileSync(file, text);
  const r = Bun.spawnSync(['bun', script, '--readiness', file, '--cwd', root, '--timeout-s', '10', ...extra.map((a) => a.replace('<root>', root))], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
  });
  return { root, file, out: r.stdout.toString(), err: r.stderr.toString(), exit: r.exitCode };
}

const assertedPlan = planOf([
  { id: 'T1', skipIf: 'true' },
  { id: 'T2', skipIf: 'false', body: ['- [x] Step 1: did it', '- [X] Step 2: and this'] },
]);

test('asserted: a false or empty skip_if with every step box ticked is DONE-ASSERTED', () => {
  const text = planOf([
    { id: 'T1', skipIf: 'false', body: ['- [x] Step 1: a'] },
    { id: 'T2', skipIf: '', body: ['- [x] Step 1: b', '  * [X] Step 2: c'] },
  ]);
  assert.deepEqual(states(text), [['T1', 'DONE-ASSERTED'], ['T2', 'DONE-ASSERTED']]);
});

test('asserted: DONE plus DONE-ASSERTED is READY, exit 0, with the asserted count', () => {
  const v = verdictOf(assertedPlan);
  assert.equal(v.verdict, 'READY');
  assert.equal(v.exit, 0);
  assert.equal(v.asserted, 1);
});

test('asserted CLI: the task row keeps the asserted label and the verdict line counts it', () => {
  const { out, exit } = cli(assertedPlan);
  assert.equal(out, [
    'T1\tDONE\ttrue',
    'T2\tDONE-ASSERTED\tfalse',
    'open NOW follow-ups: 0',
    'open step boxes: 0',
    'other open boxes: 0 (outside task sections; tick by hand with evidence, not counted)',
    'readiness: READY (1 asserted)',
    '',
  ].join('\n'));
  assert.equal(exit, 0);
});

test('asserted: a sentinel task with no step box stays UNPROVEN and the plan NEEDS-HUMAN, exit 3', () => {
  const text = planOf([
    { id: 'T1', skipIf: 'true' },
    { id: 'T2', skipIf: 'false', body: ['Prose only, nothing to tick.'] },
    { id: 'T3', skipIf: 'false' },
  ]);
  assert.deepEqual(states(text), [['T1', 'DONE'], ['T2', 'UNPROVEN'], ['T3', 'UNPROVEN']]);
  const v = verdictOf(text);
  assert.deepEqual([v.verdict, v.exit], ['NEEDS-HUMAN', 3]);
  const r = cli(text);
  assert.match(r.out, /\nreadiness: NEEDS-HUMAN\n$/);
  assert.equal(r.exit, 3);
});

test('asserted: a sentinel task with one open step box is NOT-READY, exit 1', () => {
  const text = planOf([{ id: 'T1', skipIf: 'false', body: ['- [x] Step 1: a', '- [ ] Step 2: b'] }]);
  assert.deepEqual(states(text), [['T1', 'UNPROVEN']]);
  const v = verdictOf(text);
  assert.deepEqual([v.verdict, v.exit], ['NOT-READY', 1]);
  const r = cli(text);
  assert.match(r.out, /\nreadiness: NOT-READY\n$/);
  assert.equal(r.exit, 1);
});

test('asserted: a box inside a code fence in the task section is not a step box', () => {
  const beside = planOf([{ id: 'T1', skipIf: 'false', body: ['- [x] Step 1: a', FENCE, '- [ ] example only', FENCE] }]);
  assert.deepEqual(states(beside), [['T1', 'DONE-ASSERTED']]);
  const fencedOnly = planOf([{ id: 'T1', skipIf: 'false', body: [FENCE, '- [x] example only', FENCE] }]);
  assert.deepEqual(states(fencedOnly), [['T1', 'UNPROVEN']]);
});

test('evidence: evidenceLines lists DONE tasks only, never asserted, open, unread or unproven ones', () => {
  const tasks = [
    { id: 'T1', state: 'DONE' },
    { id: 'T2', state: 'DONE-ASSERTED' },
    { id: 'T3', state: 'OPEN' },
    { id: 'T4', state: 'UNREAD' },
    { id: 'T5', state: 'UNPROVEN' },
    { id: 'T6', state: 'DONE' },
  ];
  assert.deepEqual(lib.evidenceLines(tasks), [
    'T1: SKIPPED-IDEMPOTENT (readiness: skip_if exit 0)',
    'T6: SKIPPED-IDEMPOTENT (readiness: skip_if exit 0)',
  ]);
});

test('evidence CLI: --evidence writes the log and plan-mark-done ticks exactly the DONE tasks from it', () => {
  const text = planOf([
    { id: 'T1', skipIf: 'true', body: ['- [ ] Step 1: a', '- [ ] Step 2: b'] },
    { id: 'T2', skipIf: 'false', body: ['- [x] Step 1: c'] },
    { id: 'T3', skipIf: 'exit 1', body: ['- [ ] Step 1: d'] },
    { id: 'T4', skipIf: 'false', body: ['- [ ] Step 1: e'] },
  ]);
  const { root, exit } = cli(text, ['--evidence', '<root>/readiness.log']);
  assert.equal(exit, 1);
  const log = readFileSync(path.join(root, 'readiness.log'), 'utf8');
  assert.deepEqual(log.split('\n').map((l) => l.trim()).filter(Boolean), ['T1: SKIPPED-IDEMPOTENT (readiness: skip_if exit 0)']);
  const r = markDone(text, { logText: log });
  assert.equal(r.error ?? null, null);
  const expected = text.replace('- [ ] Step 1: a', '- [x] Step 1: a').replace('- [ ] Step 2: b', '- [x] Step 2: b');
  assert.equal(r.text, expected);
});

test('tick command: readiness writes the evidence log, then plan-mark-done always runs on it', () => {
  assert.equal(
    lib.tickCommand('docs/p.md'),
    'bun scripts/plan-closeout.mjs --readiness docs/p.md --evidence readiness.log; bun scripts/plan-mark-done.mjs docs/p.md --from readiness.log',
  );
});
