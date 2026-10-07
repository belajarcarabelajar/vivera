import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractFrontmatter,
  parseUltraPlanYaml,
  topoSort,
  descendants,
  validatePlan,
  executePlan,
  classifySkipIf,
  classifyFailure,
  validateRetryIf,
  ledgerTrace,
  renderLedger,
  RUNNER_CONTRACT_KEYS,
} from './ultra-plan-runner.mjs';
// Imported, not reimplemented. The cross-module test at the end of this file
// asserts that the WIDENED ledger is still readable by the tool that consumes it,
// and it can only be honest if it uses that tool's own parser.
import { parseRunnerLog, classifyStatus } from './plan-mark-done.mjs';
// T1's frozen snapshot, imported here so one test can assert the two classifiers
// have genuinely diverged. It is a historical record, not a second source of
// truth: nothing in production depends on it.
import { classifySpikeSkipIf } from './spike-skipif-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'ultra-plan-runner.mjs');
const PUBLISHER = path.join(ROOT, 'scripts', 'plan-publish.mjs');

const SAMPLE_FM = `---
schema: ultra-plan/v1
plan_id: 2026-09-19-demo
status: Approved
version: 1
runner_contract: true
defaults:
  retry_transient_max: 2
  step_timeout_s: 90
  on_precondition_fail: stop-task-continue-independent
tasks:
  - id: T1
    depends_on: []
    files: { create: [src/a.ts], modify: [], test: [src/a.test.ts] }
    idempotency_key: "T1:src/a.ts"
    skip_if: "bun test src/a.test.ts"
    verify_exit: 0
  - id: T2
    depends_on: [T1]
    files: { create: [src/b.ts], modify: [], test: [src/b.test.ts] }
    idempotency_key: "T2:src/b.ts"
    skip_if: "bun test src/b.test.ts"
    verify_exit: 0
---
# Demo Implementation Plan

### Task T1: A
### Task T2: B

\`\`\`mermaid
flowchart TD
    T1["T1: A"] --> T2["T2: B"]
\`\`\`
`;

test('extractFrontmatter splits frontmatter and body', () => {
  const { frontmatter, body } = extractFrontmatter(SAMPLE_FM);
  assert.match(frontmatter, /schema: ultra-plan\/v1/);
  assert.match(body, /# Demo Implementation Plan/);
  assert.doesNotMatch(body, /schema: ultra-plan/);
});

test('extractFrontmatter throws when frontmatter missing', () => {
  assert.throws(() => extractFrontmatter('# no frontmatter here'), /frontmatter/i);
});

test('parseUltraPlanYaml parses scalars, defaults, and tasks', () => {
  const { frontmatter } = extractFrontmatter(SAMPLE_FM);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.schema, 'ultra-plan/v1');
  assert.equal(plan.version, 1);
  assert.equal(plan.runner_contract, true);
  assert.equal(plan.defaults.retry_transient_max, 2);
  assert.equal(plan.defaults.step_timeout_s, 90);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].id, 'T1');
  assert.deepEqual(plan.tasks[0].depends_on, []);
  assert.deepEqual(plan.tasks[0].files.create, ['src/a.ts']);
  assert.deepEqual(plan.tasks[0].files.modify, []);
  assert.equal(plan.tasks[0].skip_if, 'bun test src/a.test.ts');
  assert.equal(plan.tasks[0].idempotency_key, 'T1:src/a.ts');
  assert.equal(plan.tasks[0].verify_exit, 0);
  assert.deepEqual(plan.tasks[1].depends_on, ['T1']);
});

test('topoSort orders dependents after dependencies', () => {
  const tasks = [
    { id: 'T2', depends_on: ['T1'] },
    { id: 'T3', depends_on: ['T2'] },
    { id: 'T1', depends_on: [] },
  ];
  const order = topoSort(tasks);
  assert.ok(order.indexOf('T1') < order.indexOf('T2'));
  assert.ok(order.indexOf('T2') < order.indexOf('T3'));
});

test('topoSort throws on cycle', () => {
  const tasks = [
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['A'] },
  ];
  assert.throws(() => topoSort(tasks), /cycle/i);
});

test('descendants computes downstream blast radius', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
    { id: 'T3', depends_on: ['T2'] },
    { id: 'T4', depends_on: [] },
  ];
  const d = descendants('T1', tasks);
  assert.deepEqual([...d].sort(), ['T2', 'T3']);
  assert.equal(descendants('T4', tasks).size, 0);
});

test('validatePlan passes on a consistent plan', () => {
  const { frontmatter, body } = extractFrontmatter(SAMPLE_FM);
  const plan = parseUltraPlanYaml(frontmatter);
  const { errors } = validatePlan(plan, body);
  assert.deepEqual(errors, []);
});

test('validatePlan flags missing dependency, duplicate id, bad schema', () => {
  const plan = {
    schema: 'wrong/v9',
    tasks: [
      { id: 'T1', depends_on: ['GHOST'] },
      { id: 'T1', depends_on: [] },
    ],
  };
  const { errors } = validatePlan(plan, '');
  assert.ok(errors.some((e) => /schema/i.test(e)));
  assert.ok(errors.some((e) => /duplicate/i.test(e)));
  assert.ok(errors.some((e) => /GHOST/.test(e)));
});

test('validatePlan flags task id missing its heading or mermaid node', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T9', depends_on: [] }],
  };
  // A map exists, but T9 is never a node in it.
  const { errors } = validatePlan(plan, '# Plan\n### Task T9: x\n```mermaid\nflowchart TD\n    T1["T1: a"]\n```\n');
  assert.ok(errors.some((e) => /mermaid/i.test(e) && /T9/.test(e)));
});

test('validatePlan rejects a plan body with no mermaid diagram', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T1', depends_on: [] }],
  };
  const { errors } = validatePlan(plan, '# Plan\n### Task T1: x\nNo diagram here.\n');
  assert.ok(errors.some((e) => /at least one.*mermaid/i.test(e)));
});

// ---------- Mermaid as a machine-checked contract ----------
// The skill claims `depends_on` (frontmatter) == Mermaid edges == task headings.
// These tests hold that claim honest: both directions of drift must fail.

// Every task gets a hook so these fixtures are valid plans under the
// execution-hook contract. Without it each one also trips the unrelated
// "no run[] and no skip_if" error, and a Mermaid test that fails on a hook
// problem can no longer say what it is about.
const withHook = (tasks) => tasks.map((t) => (t.run || t.skip_if ? t : { ...t, skip_if: 'true' }));
const planWith = (tasks) => ({ schema: 'ultra-plan/v1', runner_contract: true, tasks: withHook(tasks) });
const headings = (ids) => ids.map((id) => `### Task ${id}: work`).join('\n');
const mapWith = (inner) => `# Plan\n\n\`\`\`mermaid\nflowchart TD\n${inner}\n\`\`\`\n`;

test('validatePlan accepts a plan whose mermaid edges match depends_on exactly', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
    { id: 'T3', depends_on: ['T1', 'T2'] },
  ];
  const body = headings(['T1', 'T2', 'T3']) + mapWith([
    '    T1["T1: a"] --> T2["T2: b"]',
    '    T1 --> T3["T3: c"]',
    '    T2 --> T3',
  ].join('\n'));
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, []);
});

test('validatePlan flags a depends_on edge that is missing from the mermaid map', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  // T2 exists as a node but no T1 --> T2 edge exists.
  const body = headings(['T1', 'T2']) + mapWith('    T1["T1: a"]\n    T2["T2: b"]');
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /T1/.test(e) && /T2/.test(e) && /depends_on|edge/i.test(e)),
    `expected a missing-edge error, got: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan flags a mermaid edge between task nodes that is absent from depends_on', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: [] },
  ];
  // Diagram claims T1 -> T2 but frontmatter says T2 depends on nothing.
  const body = headings(['T1', 'T2']) + mapWith('    T1["T1: a"] --> T2["T2: b"]');
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /T1/.test(e) && /T2/.test(e) && /does not declare|absent|extra/i.test(e)),
    `expected an undeclared-edge error, got: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan ignores edges where an endpoint is not a task (gates, entry nodes)', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  const body = headings(['T1', 'T2']) + mapWith([
    '    Start(["Start"]) --> T1["T1: a"]',
    '    T1 --> Gate{{"Human approval"}}',
    '    T1 --> T2["T2: b"]',
    '    Gate --> T2',
    '    T2 --> Verify["Verify"]',
  ].join('\n'));
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, [], `gate/entry edges must not be flagged: ${JSON.stringify(errors)}`);
});

test('validatePlan requires a direct edge, not merely transitive reachability', () => {
  // Deliberate design decision: the contract is `depends_on` == Mermaid edges,
  // one edge per dependency. Reachability is not enough, because deleting an
  // arrow must fail loudly instead of silently leaving a stale map.
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: [] },
    { id: 'T3', depends_on: ['T1'] },
  ];
  const body = headings(['T1', 'T2', 'T3']) + mapWith([
    '    T1 --> T2',
    '    T2 --> T3["T3: c"]',
  ].join('\n'));
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /T1/.test(e) && /T3/.test(e) && /no edge T1 --> T3/.test(e)),
    `expected a direct-edge error for T3, got: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan does not count a task id that appears only inside an unrelated diagram label', () => {
  const tasks = [{ id: 'T1', depends_on: [] }, { id: 'T7', depends_on: ['T1'] }];
  const body = headings(['T1', 'T7']) + [
    mapWith('    T1["T1: a"] --> T7["T7: b"]'),
    // A second, unrelated diagram that merely mentions T7 as prose.
    '```mermaid\nflowchart LR\n    Note["Rollback: rerun T7 if it fails"] --> End(["End"])\n```\n',
  ].join('\n');
  const { errors } = validatePlan(planWith(tasks), body);
  // T7 is a real node in the first map, so this must pass; the label mention is noise.
  assert.deepEqual(errors, []);
});

test('validatePlan flags a task that is missing from the map even if its id is prose in another block', () => {
  const tasks = [{ id: 'T1', depends_on: [] }, { id: 'T7', depends_on: ['T1'] }];
  const body = headings(['T1', 'T7']) + [
    mapWith('    T1["T1: a"]'),
    '```mermaid\nflowchart LR\n    Note["T7 needs attention"] --> End(["End"])\n```\n',
  ].join('\n');
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /T7/.test(e) && /node/i.test(e)),
    `expected a missing-node error for T7, got: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan recognizes labelled, dotted, and thick edge syntaxes', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
    { id: 'T3', depends_on: ['T2'] },
  ];
  const body = headings(['T1', 'T2', 'T3']) + mapWith([
    '    T1["a"] -->|yes| T2["b"]',
    '    T2 -.-> T3["c"]',
  ].join('\n'));
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, []);
});

test('validatePlan does not read task edges out of a non-flowchart diagram', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  // Arrows inside a sequenceDiagram are interactions, not dependencies.
  const body = headings(['T1', 'T2']) + '```mermaid\nsequenceDiagram\n    Parent->>Sub: chunk\n    T1->>T2: not a dependency\n```\n';
  const { errors } = validatePlan(planWith(tasks), body);
  assert.ok(
    errors.some((e) => /flowchart or graph/i.test(e)),
    `expected a missing-visual-map error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => /depends_on/.test(e)),
    `sequence arrows must not be read as task edges: ${JSON.stringify(errors)}`,
  );
});

test('validatePlan accepts a plan with a flowchart map plus a sequence diagram', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  const body = headings(['T1', 'T2'])
    + mapWith('    T1["T1: a"] --> T2["T2: b"]')
    + '```mermaid\nsequenceDiagram\n    Parent->>Sub: dispatch T1 then T2\n```\n';
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, []);
});

test('validatePlan treats a node that only appears as an edge endpoint as present', () => {
  const tasks = [
    { id: 'T1', depends_on: [] },
    { id: 'T2', depends_on: ['T1'] },
  ];
  // T2 is never given its own shape declaration.
  const body = headings(['T1', 'T2']) + mapWith('    T1["T1: a"] --> T2');
  const { errors } = validatePlan(planWith(tasks), body);
  assert.deepEqual(errors, []);
});

// ---------- execution-hook contract ----------

// The runner's whole point is executing a plan. `run[]` is the only key that
// makes it do anything, and until these tests existed nothing covered it: the
// suite exercised frontmatter, the DAG, the Mermaid contract, and the mirror
// gate, then stopped. `executePlan` had zero references, so a regression in
// retry accounting, exit-code matching, or blast-radius classification would
// have shipped green.

const execDir = mkdtempSync(path.join(tmpdir(), 'ultra-runner-exec-'));
process.on('exit', () => rmSync(execDir, { recursive: true, force: true }));

const abs = (f) => path.join(execDir, f);

// Fails on the first run, succeeds on the second. A real file-based counter
// rather than a quoted one-liner, so the test asserts the runner's retry loop
// and not the shell's parsing.
const flaky = abs('flaky.sh');
writeFileSync(flaky, '#!/bin/sh\n'
  + 'd=$(dirname "$0")\n'
  + 'n=$(cat "$d/count" 2>/dev/null || echo 0)\n'
  + 'n=$((n+1))\n'
  + 'echo "$n" > "$d/count"\n'
  + '[ "$n" -ge 2 ]\n');
chmodSync(flaky, 0o755);

function runPlan(tasks, defaults = {}) {
  return executePlan(
    { tasks, defaults: { retry_transient_max: 0, step_timeout_s: 30, ...defaults } },
    { execute: true },
  );
}

test('block-style run[] parses as steps of the task it belongs to', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-blockrun
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "bun test a.test.ts"
        expect_exit: 0
        retry: 2
    skip_if: "bun test a.test.ts"
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  // The regression this locks: the `- cmd` line used to open a NEW task, so
  // the plan came back with 2 tasks, the second one id-less.
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].id, 'T1');
  assert.equal(plan.tasks[0].run.length, 1);
  assert.equal(plan.tasks[0].run[0].cmd, 'bun test a.test.ts');
  assert.equal(plan.tasks[0].run[0].expect_exit, 0);
  assert.equal(plan.tasks[0].run[0].retry, 2);
  // A sibling key after the block must not be swallowed by the sequence.
  assert.equal(plan.tasks[0].skip_if, 'bun test a.test.ts');
});

test('executePlan runs every step and reports PASSED', () => {
  const out = abs('made.txt');
  rmSync(out, { force: true });
  const { status, ledger } = runPlan([{
    id: 'T1',
    depends_on: [],
    run: [
      { cmd: `printf hello > ${out}` },
      { cmd: `grep -q hello ${out}` },
    ],
  }]);
  assert.equal(status.get('T1'), 'PASSED');
  assert.equal(ledger.length, 0);
  assert.match(readFileSync(out, 'utf8'), /hello/);
});

test('executePlan honours a non-zero expect_exit, so a RED step can pass', () => {
  const { status, ledger } = runPlan([{
    id: 'T1',
    depends_on: [],
    run: [{ cmd: `test -f ${abs('never-created')}`, expect_exit: 1 }],
  }]);
  assert.equal(status.get('T1'), 'PASSED');
  assert.equal(ledger.length, 0);
});

test('executePlan retries a transient failure and counts the retry', () => {
  rmSync(abs('count'), { force: true });
  const { status, ledger } = runPlan(
    [{ id: 'T1', depends_on: [], run: [{ cmd: flaky, retry: 1 }] }],
    { retry_transient_max: 1 },
  );
  assert.equal(status.get('T1'), 'PASSED');
  assert.equal(ledger.length, 0);
});

test('executePlan does not retry when retry is 0, and records the step and exit', () => {
  rmSync(abs('count'), { force: true });
  const { status, ledger } = runPlan([{ id: 'T1', depends_on: [], run: [{ cmd: flaky, retry: 0 }] }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].step, 1);
  assert.equal(ledger[0].retry, '0/0');
  assert.equal(ledger[0].exit, 1);
});

test('a task with no dependents fails ISOLATED and the run continues', () => {
  const { status, order } = runPlan([
    { id: 'T1', depends_on: [], run: [{ cmd: 'exit 3' }] },
    { id: 'T2', depends_on: [], run: [{ cmd: 'true' }] },
  ]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(status.get('T2'), 'PASSED');
  assert.deepEqual(order, ['T1', 'T2']);
});

test('a task others depend on fails BLOCKING and halts only its descendants', () => {
  const { status, ledger } = runPlan([
    { id: 'T1', depends_on: [], run: [{ cmd: 'exit 1' }] },
    { id: 'T2', depends_on: ['T1'], run: [{ cmd: 'true' }] },
    { id: 'T3', depends_on: ['T2'], run: [{ cmd: 'true' }] },
    { id: 'T4', depends_on: [], run: [{ cmd: 'true' }] },
  ]);
  assert.equal(status.get('T1'), 'FAILED-BLOCKING');
  assert.equal(status.get('T2'), 'HALTED-UPSTREAM');
  assert.equal(status.get('T3'), 'HALTED-UPSTREAM');
  assert.equal(status.get('T4'), 'PASSED');
  // The ledger carries the failure and every halt it caused, so the blast
  // radius is auditable; only T1 is the actual failing step.
  assert.deepEqual(ledger.map((e) => `${e.task}:${e.status}`), [
    'T1:FAILED-BLOCKING', 'T2:HALTED-UPSTREAM', 'T3:HALTED-UPSTREAM',
  ]);
  assert.equal(ledger.find((e) => e.task === 'T1').step, 1);
});

test('a step that outlives step_timeout_s is killed and reported as 124', () => {
  const { status, ledger } = runPlan(
    [{ id: 'T1', depends_on: [], run: [{ cmd: 'sleep 5', retry: 0 }] }],
    { step_timeout_s: 1 },
  );
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].exit, 124);
});

test('skip_if exiting 0 short-circuits the task before any step runs', () => {
  const marker = abs('never-written.txt');
  rmSync(marker, { force: true });
  const { status, ledger } = runPlan([{
    id: 'T1',
    depends_on: [],
    skip_if: 'true',
    run: [{ cmd: `printf ran > ${marker}` }],
  }]);
  assert.equal(status.get('T1'), 'SKIPPED-IDEMPOTENT');
  assert.equal(ledger.length, 0);
  assert.equal(existsSync(marker), false);
});

test('a task with skip_if but no run[] is reported NEEDS-AGENT, not silently skipped', () => {
  const { status, ledger } = runPlan([{ id: 'T1', depends_on: [], skip_if: 'false' }]);
  assert.equal(status.get('T1'), 'NEEDS-AGENT');
  assert.equal(ledger.length, 0);
});

test('validatePlan rejects a task with neither run[] nor skip_if', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1', depends_on: [] }] };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /T1 has no execution hook/.test(e)), errors.join(' | '));
});

test('validatePlan rejects a run[] step with no cmd', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1', depends_on: [], run: [{ expect_exit: 0 }] }] };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /run\[0\] has no cmd/.test(e)), errors.join(' | '));
});

test('validatePlan warns, but does not block, when a task only has skip_if', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1', depends_on: [], skip_if: 'bun test a.test.ts' }] };
  const { errors, warnings } = validatePlan(plan, null);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => /T1 declares skip_if but no run\[\]/.test(w)), warnings.join(' | '));
});

test('classifySkipIf separates a behavioural check from a file-content probe', () => {
  // Behavioural: a tool has to succeed first, so the probe reads its output.
  assert.equal(classifySkipIf("bun test a.test.ts 2>&1 | grep -q 'passes'"), 'behavioural');
  assert.equal(classifySkipIf('systemctl --user is-active foo.timer'), 'behavioural');
  assert.equal(classifySkipIf('git diff --quiet -- path'), 'behavioural');
  // Loose: proves a string is present in a file, nothing more. It survives the
  // string being moved into a comment, and plan-mark-done then ticks the task.
  assert.equal(classifySkipIf("grep -q 'Plan Publish Gate' snippets/x.md"), 'loose');
  assert.equal(classifySkipIf('test -f out.txt'), 'loose');
  assert.equal(classifySkipIf('ls dist/'), 'loose');
});

// ---------- T2: the classes that were being guessed at ----------
//
// `classifySkipIf` used to end in `return FILE_PROBE.test(cmd) ? 'loose' : 'behavioural'`.
// That `: 'behavioural'` is the whole defect: a command matching neither regex was
// filed under `behavioural` — the one class that means "this proves the work
// works" — and the verdict was indistinguishable from a real tool invocation.
// Every test below exists to make one of those two guesses a named class.

test('the documented false sentinel is its own class, not an accident of matching nothing', () => {
  // `skip_if: "false"` is how a task says it has no command at all
  // (`skills/sucp-plan/SKILL.md`, Idempotency Honesty:
  // "When a task genuinely has no command, say so with `skip_if: "false"`
  // rather than inventing a probe that passes"). 77 tasks across 22 plans in
  // the registry write exactly that.
  //
  // It passed before this rule existed, but only because it matched no regex
  // and fell through to `behavioural` — the same path an unlisted tool takes.
  // Named explicitly, the pass is deliberate and separate from the guessing.
  assert.equal(classifySkipIf('false'), 'sentinel');
  assert.equal(classifySkipIf(' false '), 'sentinel', 'surrounding whitespace is not a different marker');
  // The sentinel is the string `false`, not a family of falsy-looking strings.
  // `False`, `falsey` and `no` are commands nobody documented; they are unknown.
  assert.equal(classifySkipIf('False'), 'unknown');
  assert.equal(classifySkipIf('falsey'), 'unknown');
});

test('empty still means blank or non-string, and is decided before the sentinel', () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.equal(classifySkipIf(bad), 'empty', `input ${JSON.stringify(bad)} should be empty`);
  }
});

test('a command matching neither regex is unknown, not behavioural', () => {
  // These are real `skip_if` values from the registry, measured in the plan's §2
  // as reaching the `behavioural` fallthrough. Each is a command that CAN assert
  // something, and none of them can be decided by the rule as written: `bash` in
  // `--verify` mode fails on behaviour and in generate mode writes a file and
  // exits 0, and no token-level regex can tell those apart. `pacman -Q rtkit`
  // asserts a package is installed, which no code change can regress. The honest
  // answer is that the classifier does not know, and says so.
  for (const cmd of [
    'bash scripts/kwin-effect-control.sh --verify evidence/anim-02-kwin-control.txt',
    'pacman -Q rtkit >/dev/null 2>&1',
    'cmp -s a b',
    "pwsh -NoProfile -Command Test-Path 'C:\\x'",
    'cf d1 query ID --sql "SELECT 1"',
  ]) {
    assert.equal(classifySkipIf(cmd), 'unknown', `${cmd} matches neither EVIDENCE_COMMAND nor FILE_PROBE`);
  }
});

test('NO command reaches behavioural without matching EVIDENCE_COMMAND', () => {
  // The lock. Every other test here asserts a particular answer, and an assertion
  // on the new answers passes just as happily while the old `: 'behavioural'`
  // fallthrough is still sitting at the end of the function. This one cannot: it
  // walks commands that provably contain no evidence token and requires that not
  // one of them is called behavioural.
  //
  // The token list is an independent copy, not an import. If it were derived from
  // the production regex then widening `EVIDENCE_COMMAND` would silently shrink
  // this fixture and the lock would decay into a test of nothing — which is the
  // same failure mode as the defect it guards, one level up.
  const EVIDENCE_TOKENS = [
    'bun', 'node', 'npm', 'pnpm', 'yarn', 'deno', 'python3', 'python', 'pytest',
    'go', 'cargo', 'make', 'cmake', 'git', 'systemctl', 'curl', 'docker', 'tsc',
    'eslint', 'vitest', 'jest', 'ruff', 'mypy', 'gradle', 'mvn',
  ];
  const hasEvidenceToken = new RegExp(`\\b(?:${EVIDENCE_TOKENS.join('|')})\\b`);

  // The §2 measured examples, plus commands invented for this test. Note the
  // grep-family shapes: `tgrep -q …` is a file probe that the current
  // FILE_PROBE does not recognise, and will keep answering non-behavioural when
  // T5 widens that regex. The lock holds across that change by design.
  const NO_EVIDENCE = [
    'bash scripts/kwin-effect-control.sh --verify evidence/anim-02-kwin-control.txt',
    'pacman -Q rtkit >/dev/null 2>&1',
    'cmp -s a b',
    "pwsh -NoProfile -Command Test-Path 'C:\\x'",
    'cf d1 query ID --sql "SELECT 1"',
    "sh -c 'true'",
    'md5sum -c checksums.txt',
    "awk 'NR==1{print}' src/x.md",
    "tgrep -q 'marker' apps/x.test.ts",
    "sqlite3 db.sqlite 'PRAGMA integrity_check'",
    'diff -u expected.txt actual.txt',
    'openssl dgst -sha256 out.bin',
  ];

  // Guard the fixture first. A leak here would make the assertion below pass for
  // the wrong reason, so it is reported as a broken lock rather than a green run.
  const leaked = NO_EVIDENCE.filter((c) => hasEvidenceToken.test(c));
  assert.deepEqual(leaked, [], `lock fixture is broken: these commands DO contain an evidence token: ${JSON.stringify(leaked)}`);

  const misfiled = NO_EVIDENCE.filter((c) => classifySkipIf(c) === 'behavioural');
  assert.deepEqual(
    misfiled,
    [],
    `${misfiled.length} command(s) with no evidence token were called behavioural — the fallthrough is back: ${JSON.stringify(misfiled)}`,
  );

  // Positive control, or the lock is satisfiable by deleting the EVIDENCE_COMMAND
  // branch entirely: a classifier that never says `behavioural` would pass every
  // assertion above. These must still be behavioural.
  for (const cmd of [
    'bun test scripts/x.test.ts',
    'git diff --quiet -- path',
    'make -C dir build',
    'python3 -m pytest -q',
    'systemctl --user is-active foo.timer',
  ]) {
    assert.equal(classifySkipIf(cmd), 'behavioural', `${cmd} runs a tool that has to succeed first`);
  }
});

test('the frozen spike classifier and the live one have genuinely diverged', () => {
  // T1 froze `classifySkipIf` as it stood on 2026-09-30 so the Jev spike's
  // published 0.995 stays reproducible. This asserts the freeze is doing real
  // work: for the same five commands the frozen three-value contract still says
  // `behavioural` and the live five-value contract says `unknown`.
  //
  // If the snapshot had been left delegating to the live function, both columns
  // would read `unknown`, the published 0.995 would stop being reproducible, and
  // nothing else in the suite would notice — this test is the guard against that.
  const FIVE = [
    'bash scripts/kwin-effect-control.sh --verify evidence/anim-02-kwin-control.txt',
    'pacman -Q rtkit >/dev/null 2>&1',
    'cmp -s a b',
    "pwsh -NoProfile -Command Test-Path 'C:\\x'",
    'cf d1 query ID --sql "SELECT 1"',
  ];
  for (const cmd of FIVE) {
    assert.equal(classifySpikeSkipIf(cmd), 'behavioural', `frozen 2026-09-30 contract: ${cmd}`);
    assert.equal(classifySkipIf(cmd), 'unknown', `live contract: ${cmd}`);
  }
  // The two agreeing where they should is the control: the frozen classifier is
  // not a different function that happens to differ everywhere.
  for (const cmd of ["grep -q 'marker' file.md", 'bun test a.test.ts', '']) {
    assert.equal(
      classifySpikeSkipIf(cmd),
      classifySkipIf(cmd),
      `frozen and live must still agree on ${JSON.stringify(cmd)}`,
    );
  }
});

// ---------- T5: a grep-family probe is `loose`, whatever qualifies the tool name ----------
//
// `FILE_PROBE` anchored on `(^|[\s;&|(])`, so a probe was only recognised when
// nothing but whitespace or a shell operator stood in front of the tool name.
// Two shapes walked straight past it, and both read a file and assert a string
// is in it — the false-pass channel the rule exists to close, because the string
// survives being moved into a comment and `plan-mark-done.mjs` then ticks the
// task off it:
//
//   tgrep -q 'solutions/social-media.astro' apps/website/test/page-style-parity.test.ts
//   /usr/bin/grep -q 'pomodoroMusicPlayer.ts:81' docs/website/privacy-facts-matrix.md
//
// 30 real `skip_if` values across 3 Snipset plans were misfiled on that gap.
//
// The expectations below are built from two string constants that are NOT
// imported from production. A test whose "before" column were derived from the
// live regex could not distinguish "the fix landed" from "the yardstick moved
// with the code", which is the exact failure this lock exists to catch.
const T5_PRE_CHANGE_FILE_PROBE_SOURCE = String.raw`(^|[\s;&|(])(grep|egrep|rg|cat|head|tail|ls|find|wc|test)\b`;
const T5_PRE_CHANGE_FILE_PROBE = new RegExp(T5_PRE_CHANGE_FILE_PROBE_SOURCE);

// An independent copy of the evidence token list, same reason and same pattern
// as the lock above. `EVIDENCE_COMMAND` is untouched by T5, so the only thing
// that decides these rows is whether the probe is seen.
const T5_EVIDENCE_TOKENS = [
  'bun', 'node', 'npm', 'pnpm', 'yarn', 'deno', 'python3', 'python', 'pytest',
  'go', 'cargo', 'make', 'cmake', 'git', 'systemctl', 'curl', 'docker', 'tsc',
  'eslint', 'vitest', 'jest', 'ruff', 'mypy', 'gradle', 'mvn',
];
const T5_HAS_EVIDENCE_TOKEN = new RegExp(`\\b(?:${T5_EVIDENCE_TOKENS.join('|')})\\b`);

// `classifySkipIf` as it stood before this change, reconstructed from the
// constants above. Its last line is the one that was wrong: a command matching
// neither rule was filed under `behavioural`, the one class that means "this
// proves the work works".
function classifySkipIfBeforeT5(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') return 'empty';
  if (cmd.trim() === 'false') return 'sentinel';
  if (T5_HAS_EVIDENCE_TOKEN.test(cmd)) return 'behavioural';
  return T5_PRE_CHANGE_FILE_PROBE.test(cmd) ? 'loose' : 'behavioural';
}

// The 30 rows the audit named, transcribed from
// `bun scripts/skipif-registry-audit.mjs --grep "tgrep -q"` (18) and
// `--grep "/usr/bin/grep"` (12). Every one classified `unknown` at the time.
const T5_GREP_FAMILY_ROWS = [
  // Snipset  2026-09-26-linux-youtube-player-error-pomodoro.md (1)
  ['2026-09-26-linux-youtube-player-error-pomodoro.md', 'T6', "/usr/bin/grep -q 'pomodoroMusicPlayer.ts:81' docs/website/privacy-facts-matrix.md"],
  // Snipset  2026-09-26-youtube-native-audio-linux.md (11)
  ['2026-09-26-youtube-native-audio-linux.md', 'T1', "/usr/bin/grep -q 'youtube_audio_service' apps/desktop/src-tauri/src/services/mod.rs"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T2', "/usr/bin/grep -q 'pub struct YoutubeAudioSource' apps/desktop/src-tauri/src/services/youtube_audio_service.rs"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T3', "/usr/bin/grep -q 'extract_youtube_audio_cmd' apps/desktop/src-tauri/src/commands/mod.rs"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T4', "/usr/bin/grep -q 'fn resolve_result_serializes_camel_case' apps/desktop/src-tauri/src/commands/youtube_cmds.rs"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T5', "/usr/bin/grep -q 'resolveYoutubeAudio' apps/web/src/services/TauriAdapter.ts"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T6', "/usr/bin/grep -q 'youtube-native' apps/web/src/features/pomodoro/types.ts"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T7', "/usr/bin/grep -q 'resolvedSourceUrl' apps/web/src/features/pomodoro/pomodoroMusicPlayer.ts"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T8', "/usr/bin/grep -q 'routes a resolved youtube track through the audio element' apps/web/src/features/pomodoro/pomodoroMusicPlayer.test.ts"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T9', "/usr/bin/grep -q 'resolveYoutubeAudio' apps/web/src/pages/pomodoro/PomodoroMusicBar.tsx"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T10', "/usr/bin/grep -q 'pomoMusicExtractorMissing' apps/web/src/i18n/locales/en/main.ts"],
  ['2026-09-26-youtube-native-audio-linux.md', 'T11', "/usr/bin/grep -q 'stripResolvedSourceUrl' apps/web/src/pages/pomodoro/PomodoroMusicBar.tsx"],
  // Snipset  2026-09-27-solutions-social-media-landing.md (18)
  ['2026-09-27-solutions-social-media-landing.md', 'T5', "tgrep -q 'solutions/social-media.astro' apps/website/test/page-style-parity.test.ts"],
  ['2026-09-27-solutions-social-media-landing.md', 'T6', "tgrep -q '/solutions/social-media|' apps/website/src/data/siteSearchIndex.ts"],
  ['2026-09-27-solutions-social-media-landing.md', 'T7', "tgrep -q 'solutions/social-media.astro' apps/website/test/seo/breadcrumb-list.test.ts"],
  ['2026-09-27-solutions-social-media-landing.md', 'T8', "tgrep -q '/solutions/social-media' apps/website/src/pages/solutions/marketing.astro"],
  ['2026-09-27-solutions-social-media-landing.md', 'T9', "tgrep -q 'solutions/social-media' apps/website/dist/client/sitemap-0.xml"],
  ['2026-09-27-solutions-social-media-landing.md', 'T10', "tgrep -q 'solutions/social-media' apps/website/public/llms.txt"],
  ['2026-09-27-solutions-social-media-landing.md', 'T11', "tgrep -q 'solutions/social-media' apps/website/dist/client/id/solutions/social-media/index.html"],
  ['2026-09-27-solutions-social-media-landing.md', 'T15', "tgrep -q '/id/docs' apps/website/src/data/solutions/social-media.id.ts && exit 1 || exit 0"],
  ['2026-09-27-solutions-social-media-landing.md', 'T16', "tgrep -q 'href=\"/pricing\"' apps/website/src/pages/id/solutions/social-media.astro"],
  ['2026-09-27-solutions-social-media-landing.md', 'T17', "tgrep -q 'Tidak dinilai' apps/website/src/data/solutions/social-media.id.ts"],
  ['2026-09-27-solutions-social-media-landing.md', 'T18', "tgrep -q 'solutions-social-media' apps/website/src/lib/ruleChat/evaluationPageCases.ts"],
  ['2026-09-27-solutions-social-media-landing.md', 'T19', "tgrep -q 'solutions-social-media' apps/website/src/lib/ruleChat/knowledge.test.ts"],
  ['2026-09-27-solutions-social-media-landing.md', 'T20', "tgrep -q 'solutions-social-media' apps/website/src/lib/ruleChat/flows.ts"],
  ['2026-09-27-solutions-social-media-landing.md', 'T21', 'tgrep -q "verifyTurnstileWithReason" apps/website/test/api/verify-license.test.ts'],
  ['2026-09-27-solutions-social-media-landing.md', 'T22', 'tgrep -q "lihat harga" apps/website/src/pages/id/solutions/social-media.astro'],
  ['2026-09-27-solutions-social-media-landing.md', 'T23', 'tgrep -q "solutions/social-media" apps/website/scripts/llms-txt/index.ts'],
  ['2026-09-27-solutions-social-media-landing.md', 'T24', 'tgrep -q "solutions-social-media" apps/website/src/lib/ruleChat/knowledgeAliases.ts'],
  ['2026-09-27-solutions-social-media-landing.md', 'T25', 'tgrep -q "dateTime:+" apps/website/src/pages/solutions/marketing.astro'],
];

test('tgrep is a file probe even though the tool name is a single token', () => {
  // `tgrep` is the trigram-index grep on this machine. The pre-change alternation
  // had no entry for it, and `^t` matched neither `^` nor the boundary class, so
  // the row was unrecognised.
  assert.equal(classifySkipIf("tgrep -q 'marker' apps/x.test.ts"), 'loose');
});

test('a path-qualified grep is a file probe', () => {
  // `/usr/bin/grep` is a real invocation and the same false-pass channel; a
  // leading `/` is what put it out of reach of `(^|[\s;&|(])`.
  assert.equal(classifySkipIf("/usr/bin/grep -q 'marker' docs/x.md"), 'loose');
});

test('all 30 grep-family rows are now loose, and every one of them was behavioural before', () => {
  // The regression lock, and the second half is the load-bearing half. Asserting
  // only `loose` would pass just as happily if the probe had never been
  // misclassified in the first place — the test would be measuring the fixture,
  // not the defect. So each row is run through the pre-change classifier too and
  // must come back `behavioural`: that is what `plan-mark-done.mjs` was being
  // handed, under the one class that means "this proves the work works".
  //
  // Guard the fixture first, or the "before" column is unfalsifiable: if any of
  // these commands contains an evidence token, it was `behavioural` for a
  // legitimate reason and proves nothing about the probe gap.
  const withEvidenceToken = T5_GREP_FAMILY_ROWS
    .map(([plan, task, cmd]) => [plan, task, cmd])
    .filter(([, , cmd]) => T5_HAS_EVIDENCE_TOKEN.test(cmd));
  assert.deepEqual(
    withEvidenceToken.map(([, task]) => task),
    [],
    'lock fixture is broken: these commands DO run a tool, so their old verdict was correct anyway',
  );

  const notLooseNow = [];
  const notBehaviouralBefore = [];
  for (const [plan, task, cmd] of T5_GREP_FAMILY_ROWS) {
    if (classifySkipIf(cmd) !== 'loose') notLooseNow.push(`${plan} ${task}`);
    if (classifySkipIfBeforeT5(cmd) !== 'behavioural') notBehaviouralBefore.push(`${plan} ${task}`);
  }
  assert.deepEqual(notLooseNow, [], 'these grep-family rows are not file probes any more');
  assert.deepEqual(
    notBehaviouralBefore,
    [],
    'these rows were NOT misclassified before the change, so asserting "now loose" proves nothing',
  );

  // The pre-change regex really is the one that was in the file, checked here so
  // a typo in the constant above cannot quietly make the "before" column agree
  // with the "after" one for a reason that has nothing to do with the gap.
  assert.equal(T5_PRE_CHANGE_FILE_PROBE.test("grep -q 'x' f.md"), true, 'the old regex did catch a bare grep');
  assert.equal(T5_PRE_CHANGE_FILE_PROBE.test("tgrep -q 'x' f.md"), false, 'the old regex missed tgrep');
  assert.equal(T5_PRE_CHANGE_FILE_PROBE.test("/usr/bin/grep -q 'x' f.md"), false, 'the old regex missed a path-qualified grep');
});

test('adding / to the boundary class does not turn a path segment into a probe', () => {
  // The risk this change introduces, recorded in the plan's risk table: a `/`
  // in the boundary class means `/test/`, `/head/`, `/find/` and `/ls/` inside a
  // path now match FILE_PROBE. Every command below has such a segment in a path
  // argument and none of them is a file probe — each one runs a tool that has to
  // succeed first, so each must stay `behavioural`. A false rejection here means
  // a real idempotency proof gets refused.
  const OVER_REACH = [
    'bun run app/head/foo.ts',
    'bun run app/test/foo.ts',
    'bun test apps/website/test/page-style-parity.test.ts',
    'git diff --quiet -- apps/website/test/page-style-parity.test.ts',
    'make -C apps/test build',
    'cargo build --manifest-path apps/head/Cargo.toml',
  ];
  // Guard: each of these must be `behavioural` because it matches
  // EVIDENCE_COMMAND, which is tested FIRST. If one ever stopped matching, it
  // would be passing this assertion by accident, via the probe branch.
  const withoutEvidenceToken = OVER_REACH.filter((cmd) => !T5_HAS_EVIDENCE_TOKEN.test(cmd));
  assert.deepEqual(withoutEvidenceToken, [], 'over-reach fixture is broken: these do not run a known tool');

  for (const cmd of OVER_REACH) {
    assert.equal(classifySkipIf(cmd), 'behavioural', `${cmd} runs a tool; a path segment is not a probe`);
  }
  // The distinction the rule turns on is unchanged: the same widened boundary
  // must not rescue a command whose ONLY tool is a file reader.
  assert.equal(classifySkipIf('ls apps/head/'), 'loose', 'a bare path listing is still a file probe');
  assert.equal(classifySkipIf("head -n 20 apps/test/log.txt"), 'loose');
});

test('the widening is additive: a bare grep or rg probe is still loose', () => {
  // Guards against a reclassification dressed as a fix. If the change had moved
  // the probe branch, or reordered it behind the evidence branch, these would
  // stop being `loose`.
  for (const cmd of [
    "grep -q 'Plan Publish Gate' snippets/x.md",
    'rg -q marker src/x.ts',
    "egrep -q 'a|b' f.md",
    "cat f.md | grep -q 'x'",
    'test -f out.txt',
    'find . -name "*.png"',
  ]) {
    assert.equal(classifySkipIf(cmd), 'loose', `${cmd} reads a file and asserts a string is in it`);
  }
  // And a grep filtering a tool's output stays behavioural, which is the reason
  // the evidence branch is ordered first.
  assert.equal(classifySkipIf("bun test a.test.ts 2>&1 | grep -q 'passes'"), 'behavioural');
});

test('a behavioural skip_if that greps a tool is not a file-content probe', () => {
  // The distinction that has to hold: a grep filtering a test run is
  // behavioural, because the runner has to exit 0 before the grep sees
  // anything. A grep reading a file is not.
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T1', depends_on: [], skip_if: "bun test a.test.ts 2>&1 | grep -q 'passes'" }],
  };
  const { errors } = validatePlan(plan, null);
  assert.deepEqual(errors, []);
});

test('a double-quoted cmd keeps one backslash, not two', () => {
  // The defect this locks: `coerceScalar` stripped the quotes without expanding
  // escapes, so `run\\[\\]` reached the shell as `run\\[\\]` and the step failed
  // with "exit mismatch" and no hint that the string had been misparsed. A plan
  // author writing a regex in a grep hit a command the runner never sent.
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-escape
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "grep -q 'run\\[\\]' src/x.md"
        expect_exit: 0
        retry: 0
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  // The plan author wrote two backslashes; the shell must receive one.
  assert.equal(plan.tasks[0].run[0].cmd, "grep -q 'run\\[\\]' src/x.md");
});

test('an unrecognised escape survives, because cmd fields carry regexes', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-escape2
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "grep -q 'a\\db' src/x.md"
        expect_exit: 0
        retry: 0
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.tasks[0].run[0].cmd, "grep -q 'a\\db' src/x.md");
});

test('a single-quoted scalar is literal, as YAML specifies', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-escape3
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: 'grep -q "run\\[\\]" src/x.md'
        expect_exit: 0
        retry: 0
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.tasks[0].run[0].cmd, 'grep -q "run\\[\\]" src/x.md');
});

test('a double-quoted escape for a quote and a tab is expanded', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-09-28-escape4
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "echo \\"a\\"\\tb"
        expect_exit: 0
        retry: 0
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.tasks[0].run[0].cmd, 'echo "a"\tb');
});

test('a parsed cmd is what the shell actually receives', () => {
  // End-to-end: the point of the three tests above is that this command runs.
  const marker = abs('escape-target.txt');
  writeFileSync(marker, 'run[]\n');
  const { status } = runPlan([{
    id: 'T1',
    depends_on: [],
    run: [{ cmd: `grep -q 'run\\[\\]' ${marker}`, expect_exit: 0 }],
  }]);
  assert.equal(status.get('T1'), 'PASSED');
});

test('RUNNER_CONTRACT_KEYS names the keys the template has to document', () => {
  // This list is what validate-skill.mjs checks the template against. If the
  // runner grows a new input, adding it here is the only way CI notices that
  // the template was never updated.
  for (const k of ['schema', 'tasks[].id', 'tasks[].depends_on', 'tasks[].skip_if', 'tasks[].run', 'tasks[].run[].cmd']) {
    assert.ok(RUNNER_CONTRACT_KEYS.includes(k), `missing contract key: ${k}`);
  }
  // The four keys that were documented but unread are now read, so they belong
  // here. A key listed but unimplemented is the exact defect this list exists
  // to prevent, so there must be none.
  for (const k of ['tasks[].files', 'tasks[].verify_exit', 'tasks[].idempotency_key', 'defaults.on_precondition_fail']) {
    assert.ok(RUNNER_CONTRACT_KEYS.includes(k), `${k} is documented but not enforced`);
  }
  // And none of them may claim a key the runner never touches.
  for (const k of ['tasks[].notes', 'tasks[].agent_hint', 'defaults.magic']) {
    assert.ok(!RUNNER_CONTRACT_KEYS.includes(k), `${k} is not read by the runner`);
  }
});

// ---------- verify_exit, files, idempotency_key, on_precondition_fail ----------
//
// These four were documented in the template and read by nothing. Documenting a
// key that does nothing is worse than not documenting it, because the plan
// looks precise. Each one is now enforced, and each has a test that fails when
// the enforcement is removed.

test('a step with no expect_exit falls back to verify_exit', () => {
  // verify_exit: 2 means "this task's steps are expected to exit 2". A step that
  // says nothing inherits it, so the field is a real default rather than a
  // decorative copy of 0.
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [], verify_exit: 2,
    run: [{ cmd: 'exit 2' }],
  }]);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('an explicit expect_exit still overrides verify_exit', () => {
  const { status } = runPlan([{
    id: 'T1', depends_on: [], verify_exit: 2,
    run: [{ cmd: 'exit 1', expect_exit: 1 }],
  }]);
  assert.equal(status.get('T1'), 'PASSED');
});

test('a declared file that is absent before the task runs fails the precondition', () => {
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    files: { create: [], modify: [abs('does-not-exist.ts')], test: [] },
    run: [{ cmd: 'true' }],
  }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].step, 'pre');
  assert.match(ledger[0].cause, /absent before the task ran/);
});

test('a declared create file still missing after the steps ran fails the postcondition', () => {
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    files: { create: [abs('never-made.txt')], modify: [], test: [] },
    run: [{ cmd: 'true' }],
  }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.match(ledger[0].cause, /still absent after the task ran/);
});

test('a create file that appears is a pass, so a re-run stays idempotent', () => {
  const target = abs('reused.txt');
  writeFileSync(target, 'already here\n');
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    files: { create: [target], modify: [], test: [] },
    run: [{ cmd: `grep -q already ${target}` }],
  }]);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
});

test('a task that declares no files is unaffected by the file checks', () => {
  const { status } = runPlan([{ id: 'T1', depends_on: [], run: [{ cmd: 'true' }] }]);
  assert.equal(status.get('T1'), 'PASSED');
});

test('validatePlan rejects an idempotency_key that names a different task', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1', depends_on: [], idempotency_key: 'T2:a.ts', skip_if: 'true' }] };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /names task "T2"/.test(e)), errors.join(' | '));
});

test('an idempotency_key may name a behaviour rather than a path', () => {
  // The key names the task's unit of work, and in every real plan in this
  // repository that is a description, not a filename: `T3:two-stage-trigger`,
  // `T5:lifecycle-audit`, `T18:bulk-publish-267`. A first draft of this check
  // demanded the right-hand side be a declared file path, which rejected all of
  // them and broke four plans that had nothing wrong with them.
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{
      id: 'T3', depends_on: [], idempotency_key: 'T3:two-stage-trigger',
      files: { create: [], modify: ['snippets/x.md'], test: [] },
      skip_if: 'bun test a.test.ts',
    }],
  };
  const { errors } = validatePlan(plan, null);
  assert.deepEqual(errors, []);
});

test(
  'every plan in docs/code-plan/plans still validates',
  {
    // docs/code-plan/ is machine-local, gitignored plan storage (see
    // .gitignore): the plans live in the checkout that wrote them and a fresh
    // clone carries none, where readdirSync would throw ENOENT. Skip with the
    // reason instead; on a checkout that HAS the plans every assertion runs.
    skip: existsSync(path.join(ROOT, 'docs', 'code-plan', 'plans'))
      ? false
      : 'docs/code-plan/plans is absent: docs/code-plan/ is gitignored, machine-local plan storage (see .gitignore), so a fresh clone does not carry the plans this test validates',
  },
  () => {
    // The regression this locks. A check added to the runner is a check every
    // existing plan must survive; four of them failed it on the first run, which
    // is exactly the shape of breakage a unit test on the new check alone misses.
    const dir = path.join(ROOT, 'docs', 'code-plan', 'plans');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'no plans found to check');
    const broken = [];
    for (const f of files) {
      const { frontmatter } = extractFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      const { errors } = validatePlan(parseUltraPlanYaml(frontmatter), null);
      if (errors.length) broken.push(`${f}: ${errors.join('; ')}`);
    }
    assert.deepEqual(broken, []);
  },
);

test('a loose skip_if is a hard error once the allowlist exists', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T3', depends_on: [], skip_if: "grep -q 'Marker' src/x.md" }],
  };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /T3 skip_if is a file-content probe/.test(e)), errors.join(' | '));
});

test('an allowlisted loose skip_if passes', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { allow_loose_skip_if: ['T3'] },
    tasks: [{ id: 'T3', depends_on: [], skip_if: "grep -q 'Marker' src/x.md" }],
  };
  const { errors } = validatePlan(plan, null);
  assert.deepEqual(errors, []);
});

test('a stale exemption is itself an error, so the allowlist cannot become permanent', () => {
  // The failure mode of any allowlist is that it outlives its reason. A name
  // that no longer corresponds to a loose skip_if is dead weight that hides a
  // future regression, so it is reported rather than ignored.
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { allow_loose_skip_if: ['T1', 'TGONE'] },
    tasks: [{ id: 'T1', depends_on: [], skip_if: 'bun test a.test.ts' }],
  };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /allow_loose_skip_if names "TGONE"/.test(e)), errors.join(' | '));
  assert.ok(errors.some((e) => /allow_loose_skip_if names "T1"/.test(e)), errors.join(' | '));
});

// ---------- T4: `unknown` warns instead of passing silently ----------
//
// `classifySkipIf` already returns `unknown` for a command that matches neither
// rule. Before T4 nothing read that class: it fell through validation untouched,
// so an unrecognised `skip_if` was as invisible as a real test run. T4 names it —
// as a warning, per task, with the remediation. Never as an error, and that is
// the load-bearing half: 14 tasks in 7 plans would stop running, four of those
// plans in repositories this one does not own.
//
// The tests below come in pairs on purpose. A test that only checks the happy
// path passes just as happily if the warning is emitted unconditionally, or if
// `unknown` is escalated to an error. Each of those two failure modes gets its
// own lock below.
const isUnknownWarning = (w) => /matches neither the evidence rule nor the file-probe rule/.test(w);

test('an unknown skip_if is reported as a warning naming the task and the command, and not as an error', () => {
  const { errors, warnings } = validatePlan({
    schema: 'ultra-plan/v1',
    tasks: [
      { id: 'T2', depends_on: [], skip_if: 'bash scripts/kwin-effect-control.sh --verify evidence/anim-02-kwin-control.txt' },
      { id: 'T4', depends_on: [], skip_if: 'pacman -Q rtkit >/dev/null 2>&1' },
      { id: 'T5', depends_on: [], skip_if: 'cmp -s a b' },
    ],
  }, null);
  assert.deepEqual(errors, [], 'an unknown skip_if must not become unrunnable');
  // Three tasks, three rows to repair independently. One aggregate warning would
  // read fine and be useless: the debt only closes when each of the 14 registry
  // rows is adjudicated on its own.
  const mine = warnings.filter(isUnknownWarning);
  assert.equal(mine.length, 3, 'one warning per unknown row, not one aggregate');
  for (const [id, cmd] of [
    ['T2', 'bash scripts/kwin-effect-control.sh --verify evidence/anim-02-kwin-control.txt'],
    ['T4', 'pacman -Q rtkit >/dev/null 2>&1'],
    ['T5', 'cmp -s a b'],
  ]) {
    assert.ok(
      mine.some((w) => w.includes(id) && w.includes(cmd)),
      `no warning names both ${id} and its command; got: ${mine.join(' | ')}`,
    );
  }
});

test('the unknown warning says what to do about it', () => {
  const { warnings } = validatePlan({
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T4', depends_on: [], skip_if: 'pacman -Q rtkit >/dev/null 2>&1' }],
  }, null);
  const w = warnings.find(isUnknownWarning);
  assert.ok(w, 'expected an unknown warning');
  // Both remedies are named, because both are correct answers to different rows:
  // name the tool in a recognised form, or admit the command has no exit status
  // worth asserting and use the documented sentinel.
  assert.match(w, /name the tool in a form the rule recognises/i, w);
  assert.match(w, /skip_if: "false"/, w);
  assert.match(w, /cannot tell whether it fails on behaviour/, w);
});

test('the loose error is unchanged, character for character', () => {
  // The regression lock for "do not reword". This message is load-bearing for
  // anyone who has read it, so T4 branches on the class around it rather than
  // rewriting it. If this string ever changes, that is a deliberate act, not a
  // side effect of adding a branch next door.
  const { errors } = validatePlan({
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T3', depends_on: [], skip_if: "grep -q 'Marker' src/x.md" }],
  }, null);
  const expected = 'task T3 skip_if is a file-content probe: "grep -q \'Marker\' src/x.md". '
    + 'It proves a string is present, not that the behaviour works — it survives the string moving into a comment. '
    + 'Use a command that fails on behaviour, or add this task id to defaults.allow_loose_skip_if '
    + 'to grandfather an existing plan.';
  assert.deepEqual(errors, [expected]);
});

test('a sentinel produces no unknown warning, and neither does a behavioural skip_if', () => {
  // The distinction the five classes exist for. `"false"` is a deliberate
  // no-command marker; `bun test` is a real tool run. Neither is a command the
  // classifier failed to understand, so neither is reported as one. A test that
  // only covered the unknown rows would pass with the warning keyed off "not
  // behavioural" — which would light up 77 sentinels and every probe at once.
  const { warnings } = validatePlan({
    schema: 'ultra-plan/v1',
    tasks: [
      { id: 'S1', depends_on: [], skip_if: 'false' },
      { id: 'S2', depends_on: [], skip_if: ' false ' },
      { id: 'B1', depends_on: [], skip_if: 'bun test a.test.ts' },
      { id: 'B2', depends_on: [], skip_if: "bun test a.test.ts 2>&1 | grep -q 'passes'" },
      { id: 'L1', depends_on: [], skip_if: 'test -f out.txt' },
    ],
  }, null);
  assert.deepEqual(warnings.filter(isUnknownWarning), []);
});

test('NEGATIVE CONTROL: a plan with no unknown rows carries no unknown warning', () => {
  // Without this, every test above would also pass against an unconditional
  // `warnings.push(...)`. This is the one test that says the warning is earned.
  const { warnings } = validatePlan({
    schema: 'ultra-plan/v1',
    tasks: [
      { id: 'T1', depends_on: [], skip_if: 'bun test a.test.ts' },
      { id: 'T2', depends_on: [], skip_if: 'false' },
      { id: 'T3', depends_on: [], run: [{ cmd: 'bun test a.test.ts' }] },
    ],
  }, null);
  assert.deepEqual(warnings.filter(isUnknownWarning), [], warnings.join(' | '));
});

test('a plan whose only defect is an unknown skip_if still validates clean', () => {
  // The property that keeps 14 tasks in 7 plans runnable. Promoting `unknown` to
  // an error would fail exactly here, which is why this test exists separately
  // from the first one: it asserts the absence of the error, not the presence
  // of the warning.
  const { errors } = validatePlan({
    schema: 'ultra-plan/v1',
    runner_contract: true,
    tasks: [
      { id: 'T2', depends_on: [], skip_if: 'bash scripts/plasma-anim-baseline.sh --verify evidence/anim-02.txt' },
      { id: 'T4', depends_on: [], skip_if: 'pacman -Q rtkit >/dev/null 2>&1' },
    ],
  }, null);
  assert.deepEqual(errors, []);
});

test('on_precondition_fail: halt-plan stops independent tasks too', () => {
  const { status } = runPlan(
    [
      { id: 'T1', depends_on: [], files: { create: [], modify: [abs('nope.ts')], test: [] }, run: [{ cmd: 'true' }] },
      { id: 'T2', depends_on: [], run: [{ cmd: 'true' }] },
    ],
    { on_precondition_fail: 'halt-plan' },
  );
  assert.equal(status.get('T1'), 'FAILED-BLOCKING');
  // T2 does not depend on T1, so under the permissive policy it would still run.
  assert.equal(status.get('T2'), 'HALTED-PLAN');
});

test('on_precondition_fail: stop-task-continue-independent keeps independent work running', () => {
  const { status } = runPlan([
    { id: 'T1', depends_on: [], files: { create: [], modify: [abs('nope.ts')], test: [] }, run: [{ cmd: 'true' }] },
    { id: 'T2', depends_on: [], run: [{ cmd: 'true' }] },
  ]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(status.get('T2'), 'PASSED');
});

test('an unrecognised on_precondition_fail throws instead of defaulting to the permissive value', () => {
  assert.throws(
    () => runPlan([{ id: 'T1', depends_on: [], run: [{ cmd: 'true' }] }], { on_precondition_fail: 'stop-everything' }),
    /on_precondition_fail/,
  );
});

// ---------- vault mirror gate (T2) ----------
//
// The runner is the one place that can make "publish the plan" mandatory instead
// of advisory, because it is the last thing that runs before a task step
// executes. These cases drive the real CLI as a SUBPROCESS against a throwaway
// vault, for the same reason the publisher tests do: the contract is an exit
// code plus what did or did not run, and an in-process call cannot prove
// process.exit() behaviour.
//
// Nothing here touches the real vault. PLAN_PUBLISH_CONFIG redirects the
// registry, which is the seam the publisher was built with.

const GATE_PLAN = '2026-09-27-gate-demo.md';

// A minimal VALID plan: one task, `skip_if` but no `run[]` steps. No run[]
// means the runner reports NEEDS-AGENT and executes nothing, which is exactly
// what lets these tests assert "the DAG was reached" versus "the gate stopped
// it" without any task command being able to fail for an unrelated reason.
// The `skip_if` is what keeps the fixture valid under the execution-hook
// contract: a task with neither run[] nor skip_if is a validation error, and
// an errored plan never reaches the gate at all — which would make these tests
// pass for the wrong reason.
function gatePlanBody() {
  return `---
schema: ultra-plan/v1
plan_id: 2026-09-27-gate-demo
status: Approved
version: 1
runner_contract: true
defaults:
  retry_transient_max: 1
  step_timeout_s: 30
  on_precondition_fail: stop-task-continue-independent
tasks:
  - id: T1
    depends_on: []
    files: { create: [src/a.ts], modify: [], test: [] }
    idempotency_key: "T1:src/a.ts"
    skip_if: "true"
    verify_exit: 0
---
# Gate demo

### Task T1: A

\`\`\`mermaid
flowchart TD
    T1["T1: A"] --> Done["done"]
\`\`\`
`;
}

function gateFixture(tag, { mirror = true } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), `runner-gate-${tag}-`));
  const vault = path.join(base, 'vault');
  const projectRoot = path.join(base, 'proj');
  const plansDir = path.join(projectRoot, 'docs', 'code-plan', 'plans');
  mkdirSync(vault, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: vault, encoding: 'utf8' });
  mkdirSync(plansDir, { recursive: true });
  // `mirror` toggles the registry flag, which is how the vault's own plans are
  // declared: they are already inside the vault, so there is no mirror to be
  // current about and the gate must not apply.
  const config = path.join(base, 'plans.publish.json');
  writeFileSync(config, JSON.stringify({
    vault,
    destDirTemplate: '01 - Projects/{project}/plans',
    stageInVault: true,
    projects: [{ name: 'demo', root: projectRoot, mirror }],
  }, null, 2), 'utf8');
  const plan = path.join(plansDir, GATE_PLAN);
  writeFileSync(plan, gatePlanBody(), 'utf8');
  return { base, vault, projectRoot, plansDir, config, plan };
}

function runRunner(f, args) {
  const r = spawnSync(process.execPath, [RUNNER, f.plan, ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function publish(f) {
  const r = spawnSync(process.execPath, [PUBLISHER, f.plan], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config },
  });
  assert.equal(r.status, 0, `publish failed: ${r.stderr}`);
}

test('refuses to execute a plan whose mirror is stale', () => {
  const f = gateFixture('stale');
  try {
    // 1. Never published. The whole reason this gate exists: a plan that is
    //    perfectly valid, in a project, with nothing in the vault.
    let r = runRunner(f, ['--execute']);
    assert.equal(r.code, 3, `an unpublished plan must not execute, got ${r.code}:\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /NEEDS-AGENT/, 'no task step may run while the gate is closed');
    assert.match(`${r.stdout}${r.stderr}`, /MIRROR GATE/, 'the block must be visible in the output');
    assert.ok(`${r.stdout}${r.stderr}`.includes(GATE_PLAN), 'the block must name the plan');
    assert.match(`${r.stdout}${r.stderr}`, /planFreshness|no mirror|MISSING/i,
      'the block must say why, not just that it failed');
    // The fix has to be copy-pasteable, because the person hitting this is
    // mid-plan and should not have to reconstruct the command.
    assert.match(`${r.stdout}${r.stderr}`, /plan-publish\.mjs/, 'the block must name the publish command');

    // 2. Published, then the source edited. This is the case that used to slip
    //    through: the mirror exists, so a presence check would pass it.
    publish(f);
    r = runRunner(f, ['--execute']);
    assert.notEqual(r.code, 3, `a current mirror must execute, got:\n${r.stdout}${r.stderr}`);

    appendFileSync(f.plan, '\nedited after publishing\n', 'utf8');
    r = runRunner(f, ['--execute']);
    assert.equal(r.code, 3, `a drifted mirror must not execute, got ${r.code}:\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /NEEDS-AGENT/, 'no task step may run on drift');
    assert.match(`${r.stdout}${r.stderr}`, /!=/, `the block must show both hashes:\n${r.stdout}${r.stderr}`);

    // 3. Republish and it runs again. A gate with no way back is a dead end.
    publish(f);
    r = runRunner(f, ['--execute']);
    assert.notEqual(r.code, 3, `republishing must unblock, got:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /NEEDS-AGENT/, 'the DAG must actually be reached after republishing');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('the mirror gate does not apply where there is no mirror', () => {
  // mirror:false — the vault's own plans. Gating these would make every vault
  // plan unrunnable, so the gate must step aside rather than invent a mirror.
  const f = gateFixture('notapplicable', { mirror: false });
  try {
    const r = runRunner(f, ['--execute']);
    assert.notEqual(r.code, 3, `a mirror:false plan must not be gated, got:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /NEEDS-AGENT/, 'the DAG must be reached');
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /MIRROR GATE: BLOCKED/,
      'a not-applicable gate must not be reported as a block');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('a dry run is never gated', () => {
  // Plan validation must keep working on a machine with no vault at all: that
  // is the common case for anyone reading or writing a plan.
  const f = gateFixture('dryrun');
  try {
    const r = runRunner(f, []);
    assert.equal(r.code, 0, `validation must not need a mirror, got ${r.code}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Validation: OK/);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /MIRROR GATE/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('the escape flag runs the DAG and says it was used', () => {
  const f = gateFixture('escape');
  try {
    const r = runRunner(f, ['--execute', '--skip-mirror-gate']);
    assert.notEqual(r.code, 3, `the escape must actually escape, got:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /NEEDS-AGENT/, 'the DAG must be reached');
    // Silently passing is how an escape hatch becomes the default. It must be
    // loud every single time it is used.
    assert.match(`${r.stdout}${r.stderr}`, /skip-mirror-gate/,
      'using the escape must be reported in the output');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('an unresolvable plan fails the gate closed, not open', () => {
  const f = gateFixture('unroutable');
  try {
    // A plan outside every registered project root. Failing open here would
    // mean a typo'd path silently executes with no mirror, which is precisely
    // the class of bug this gate is here to prevent.
    const outside = path.join(f.base, 'elsewhere', 'plan.md');
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, gatePlanBody(), 'utf8');
    const r = spawnSync(process.execPath, [RUNNER, outside, '--execute'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config },
    });
    assert.equal(r.status, 3, `an unroutable plan must fail closed, got ${r.status}:\n${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /plans\.publish\.json/, 'the block must name the file to fix');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

// ---------- tasks[].impacts ----------
//
// The regression these lock. `files` names what a task touches and `depends_on`
// orders tasks inside one plan, so nothing in the contract ever asked what a task
// BREAKS. A task could change a shared interface, declare only its own file, and
// pass every gate while every consumer stayed broken. The prose rules that were
// supposed to cover it ("inspect all callers", "fix at the shared root cause")
// cannot fail, so nothing exited non-zero when an agent forgot.

test('a task declaring no impacts is an error when the plan requires them', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true },
    tasks: [{ id: 'T1', depends_on: [], skip_if: 'bun test a.test.ts' }],
  };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /task T1 declares no impacts/.test(e)), errors.join(' | '));
});

test('without require_impacts the same plan warns instead of erroring', () => {
  // The same reasoning that made an unclassifiable `skip_if` a warning: several
  // plans in the registry belong to repositories this one does not own, and
  // erroring there would be one commit here deciding someone else's plan cannot
  // run. One aggregated warning, not one per task.
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [
      { id: 'T1', depends_on: [], skip_if: 'bun test a.test.ts' },
      { id: 'T2', depends_on: ['T1'], skip_if: 'bun test b.test.ts' },
    ],
  };
  const { errors, warnings } = validatePlan(plan, null);
  assert.deepEqual(errors, []);
  const hits = warnings.filter((w) => /declare no impacts/.test(w));
  assert.equal(hits.length, 1, `expected one aggregated warning, got ${hits.length}: ${warnings.join(' | ')}`);
  assert.match(hits[0], /T1, T2/);
});

test('an empty impacts list is an error, because it claims nothing', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true },
    tasks: [{ id: 'T1', depends_on: [], impacts: [], skip_if: 'bun test a.test.ts' }],
  };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /T1 impacts is an empty list/.test(e)), errors.join(' | '));
});

test('the "none:" sentinel passes, and only when it names the check that ran', () => {
  const good = {
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true },
    tasks: [{ id: 'T1', depends_on: [], impacts: ['none: bun test a.test.ts'], skip_if: 'bun test a.test.ts' }],
  };
  assert.deepEqual(validatePlan(good, null).errors, []);

  // "No downstream exists" is exactly as easy to fabricate as a check that was
  // never run, so the sentinel without its command is refused.
  const bare = {
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true },
    tasks: [{ id: 'T1', depends_on: [], impacts: ['none:'], skip_if: 'bun test a.test.ts' }],
  };
  const { errors } = validatePlan(bare, null);
  assert.ok(errors.some((e) => /"none:" sentinel with no command/.test(e)), errors.join(' | '));
});

test('a non-string impact entry is reported as the parser defect it is', () => {
  // `impacts:` written block-style parses to [{}], because parseBlockSeq drops a
  // `- item` line with no `:` to split on. Silently vanishing is the failure
  // mode; the message has to name the flow-style form that works.
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true },
    tasks: [{ id: 'T1', depends_on: [], impacts: [{}], skip_if: 'bun test a.test.ts' }],
  };
  const { errors } = validatePlan(plan, null);
  assert.ok(errors.some((e) => /non-string or blank entry/.test(e) && /flow-style only/.test(e)), errors.join(' | '));
});

test('block-style impacts really do misparse, so the error is not hypothetical', () => {
  // Two block-style shapes, and both are refused. The parser cannot tell a bare
  // scalar `- "text"` from a step map `- cmd: "text"`, so it builds an object
  // either way: with no `:` inside the entry arrives empty, and with a `:` inside
  // it arrives as a one-key map. Neither is a string, so neither can pass as an
  // impact claim. The evidence has to be that the misparse is real, because the
  // alternative is a plan that looks guarded and is not.
  const plain = parseUltraPlanYaml([
    'tasks:',
    '  - id: T1',
    '    impacts:',
    '      - "scripts/x.mjs - bun test x"',
  ].join('\n'));
  assert.deepEqual(plain.tasks[0].impacts, [{}]);

  const colonIn = parseUltraPlanYaml([
    'tasks:',
    '  - id: T1',
    '    impacts:',
    '      - "scripts/x.mjs - evidence: bun test x"',
  ].join('\n'));
  assert.equal(typeof colonIn.tasks[0].impacts[0], 'object');

  // Flow-style is the form that works, and it survives the same round trip.
  const flow = parseUltraPlanYaml([
    'tasks:',
    '  - id: T1',
    '    impacts: ["scripts/x.mjs - bun test x"]',
  ].join('\n'));
  assert.deepEqual(flow.tasks[0].impacts, ['scripts/x.mjs - bun test x']);

  const mk = (impacts) => ({
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true },
    tasks: [{ id: 'T1', depends_on: [], impacts, skip_if: 'bun test a' }],
  });
  for (const shape of [plain.tasks[0].impacts, colonIn.tasks[0].impacts]) {
    const { errors } = validatePlan(mk(shape), null);
    assert.ok(errors.some((e) => /non-string or blank entry/.test(e)), errors.join(' | '));
  }
  assert.deepEqual(validatePlan(mk(flow.tasks[0].impacts), null).errors, []);
});

test('allow_no_impacts exempts a task, and a stale exemption is itself an error', () => {
  // Same anti-decay rule as allow_loose_skip_if: an exemption outliving its
  // reason is dead weight that hides the next regression.
  const exempt = {
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true, allow_no_impacts: ['T2'] },
    tasks: [
      { id: 'T1', depends_on: [], impacts: ['a - bun test a'], skip_if: 'bun test a' },
      { id: 'T2', depends_on: ['T1'], skip_if: 'bun test b' },
    ],
  };
  assert.deepEqual(validatePlan(exempt, null).errors, []);

  const stale = {
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true, allow_no_impacts: ['T9'] },
    tasks: [{ id: 'T1', depends_on: [], impacts: ['a - bun test a'], skip_if: 'bun test a' }],
  };
  assert.ok(validatePlan(stale, null).errors.some((e) => /allow_no_impacts names "T9"/.test(e)));

  // And the exemption cannot be left behind once the task declares its own.
  const needless = {
    schema: 'ultra-plan/v1',
    defaults: { require_impacts: true, allow_no_impacts: ['T1'] },
    tasks: [{ id: 'T1', depends_on: [], impacts: ['a - bun test a'], skip_if: 'bun test a' }],
  };
  assert.ok(validatePlan(needless, null).errors.some((e) => /remove the exemption/.test(e)));
});

test('impacts is a flow-style list of strings, end to end through the parser', () => {
  const { tasks } = parseUltraPlanYaml([
    'tasks:',
    '  - id: T1',
    '    impacts: ["scripts/a.mjs - bun test a", "none: bun test b"]',
  ].join('\n'));
  assert.deepEqual(tasks[0].impacts, ['scripts/a.mjs - bun test a', 'none: bun test b']);
});

test('the shipped plan template opts into the gate and validates clean', () => {
  // A key the runner reads but the template does not demonstrate is a key every
  // plan author copies without it. This is the same failure
  // check-runner-contract.mjs guards, seen from the other side: the template has
  // to not merely DECLARE the key, it has to PASS with it.
  const text = fs.readFileSync(path.join(ROOT, 'templates', 'implementation-plan-template.md'), 'utf8');
  const { frontmatter } = extractFrontmatter(text);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.defaults.require_impacts, true, 'the template must turn the gate on');
  const { errors } = validatePlan(plan, text);
  assert.deepEqual(errors, [], errors.join(' | '));
  for (const t of plan.tasks) {
    assert.ok(Array.isArray(t.impacts) && t.impacts.length > 0, `task ${t.id} declares no impacts`);
  }
});

// ---------- failure classification, evidence, and orphan reaping ----------
//
// The regression these lock, in the shape it actually had. Every step failure
// reached the Error Ledger as `klass: 'code'` with no log output at all, because
// `run()` captured stderr and stdout and no caller ever read either. A row said
// "exit 1" and stopped. So a missing binary and a failing assertion were the same
// row, and diagnosing a failure meant re-running the command by hand — which for
// a stateful step is not the same command twice.

test('classifyFailure separates what the exit code PROVES from what it cannot', () => {
  // Facts first: these are the codes a POSIX shell defines.
  assert.deepEqual(classifyFailure({ exit: 127 }), {
    klass: 'environment', transient: false, basis: 'exit 127 (command not found)',
  });
  assert.equal(classifyFailure({ exit: 126 }).klass, 'environment');
  assert.equal(classifyFailure({ exit: 130 }).klass, 'interrupted');
  assert.equal(classifyFailure({ exit: 143 }).klass, 'terminated');
  assert.deepEqual(classifyFailure({ exit: 124, timedOut: true }), {
    klass: 'timeout', transient: true, basis: 'ETIMEDOUT from spawnSync',
  });

  // And the honest remainder. A flaky test and a deterministic failure both
  // exit 1, so `transient` is `unknown`, not `false`. Guessing either way would
  // be wrong, and reporting `unknown` is the same rule classifySkipIf follows.
  const generic = classifyFailure({ exit: 1 });
  assert.equal(generic.klass, 'code');
  assert.equal(generic.transient, 'unknown');
  assert.match(generic.basis, /cannot separate/);
});

test('a provably deterministic failure skips the retry, and says why', async () => {
  // Before this, exit 127 meant the command ran twice. A missing binary does not
  // appear between attempt one and attempt two.
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T1', depends_on: [], verify_exit: 0, run: [{ cmd: 'definitely-not-a-real-binary-xyz', expect_exit: 0, retry: 3 }] }],
  };
  const lines = [];
  const { ledger } = executePlan(plan, { execute: true, log: (l) => lines.push(l) });
  assert.equal(ledger.length, 1);
  const row = ledger[0];
  assert.equal(row.klass, 'environment');
  assert.equal(row.transient, false);
  assert.equal(row.retry, '0/3', 'no attempt may be spent on a retry that cannot help');
  assert.match(row.note, /retry skipped/);
  assert.ok(lines.some((l) => /retry skipped/.test(l)), 'the skip must be visible in the run, not only in the ledger');
});

test('an unknown-transient failure still retries, so a flaky step is not broken by this', () => {
  // The regression guard for the change above: making retries smarter must not
  // make them rarer. `unknown` keeps the pre-existing behaviour.
  const marker = path.join(tmpdir(), `vivera-flaky-${process.pid}`);
  const cmd = `sh -c 'if [ -f ${marker} ]; then exit 0; else touch ${marker}; exit 1; fi'`;
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T1', depends_on: [], verify_exit: 0, run: [{ cmd, expect_exit: 0, retry: 1 }] }],
  };
  try {
    const { status } = executePlan(plan, { execute: true, log: () => {} });
    assert.equal(status.get('T1'), 'PASSED', 'a first-attempt failure classified `unknown` must be retried');
  } finally {
    if (existsSync(marker)) rmSync(marker, { force: true });
  }
});

test('the ledger carries the command output that explains the failure', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [{
      id: 'T1', depends_on: [], verify_exit: 0,
      run: [{ cmd: 'sh -c "echo boom: expected 3 got 7 1>&2; exit 1"', expect_exit: 0, retry: 0 }],
    }],
  };
  const { ledger } = executePlan(plan, { execute: true, log: () => {} });
  assert.equal(ledger[0].klass, 'code');
  assert.match(ledger[0].trace, /boom: expected 3 got 7/, 'the log tail is the diagnosis');
  assert.equal(ledger[0].expected, 0, 'the row states the expectation, not only the actual exit');
  assert.match(ledger[0].cause, /exited 1, expected 0/);
});

test('a trace cannot break the ledger row it lives in', () => {
  // plan-mark-done.mjs parses these rows back out of the rendered table and
  // takes the LAST `|`-split cell as the status, so an unescaped pipe is not a
  // cosmetic defect: it changes which cell that is. `ledgerTrace` escapes it,
  // backticks included, because a `code` span in the middle of a cell would
  // otherwise render as broken markdown.
  const nasty = 'a | b `code` c';
  assert.equal(ledgerTrace({ stderr: nasty }), "a \\| b 'code' c");
  const rendered = renderLedger([{
    task: 'T1', step: 1, klass: 'code', exit: 1, transient: 'unknown', basis: 'b',
    cause: 'c', expected: 0, retry: '0/0', status: 'FAILED-ISOLATED', trace: ledgerTrace({ stderr: nasty }),
  }]);
  const row = rendered.split('\n').find((l) => l.startsWith('| T1'));
  const cells = row.split('|').slice(1, -1);
  // A naive split cannot distinguish an escaped pipe from a separator, which is
  // exactly why the assertion is on the invariant that matters: the status is
  // still the last cell, so plan-mark-done still reads the row correctly.
  assert.equal(cells[cells.length - 1].trim(), '`FAILED-ISOLATED`', 'the status must remain the LAST cell');
  assert.equal(cells[0].trim(), 'T1', 'the task id must remain the FIRST cell');
  const { ledger } = parseRunnerLog(rendered);
  assert.equal(ledger.size, 1, 'one pipe in a log line must not manufacture a second row');
  assert.ok(ledger.get('T1')[0].includes('a \\| b'), 'the escaped pipe must survive into the parsed row');
});

test('the trace is a bounded tail, and says how much it hid', () => {
  const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const t = ledgerTrace({ stderr: many });
  assert.match(t, /earlier line\(s\) hidden/, 'a hidden head must be declared, not silently dropped');
  assert.match(t, /line 39$/, 'the tail is the end, which is where the error is');
  assert.ok(t.length < 900, `the cell must stay small enough to read, got ${t.length} chars`);
});

test('stderr wins over stdout, and an empty capture says so instead of lying', () => {
  assert.match(ledgerTrace({ stderr: 'from stderr', stdout: 'from stdout' }), /from stderr/);
  const rendered = renderLedger([{
    task: 'T1', step: 1, klass: 'code', exit: 1, transient: 'unknown', basis: 'b',
    cause: 'c', expected: 0, retry: '0/0', status: 'FAILED-ISOLATED', trace: '',
  }]);
  assert.match(rendered, /_no output captured_/);
});

test('a timed-out step takes its background children with it', () => {
  // Measured, and the reason `detached: true` plus a negated-pid signal exists.
  // Without it, `spawnSync(..., { shell: true, timeout })` signals only the
  // shell: on `sh -c "sleep N & wait"` the backgrounded sleep was still running
  // after the runner had already reported ETIMEDOUT. The master skill has a whole
  // guardrail section about dangling workers — aimed at the agent, never at the
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
    let alive = true;
    try { process.kill(orphan, 0); } catch { alive = false; }
    assert.equal(alive, false, `the grandchild ${orphan} outlived the step and is still running`);
  } finally {
    rmSync(pidFile, { force: true });
  }
});

test('the widened ledger is still parsed by plan-mark-done', () => {
  // The cross-module contract that adding columns could have broken silently.
  // plan-mark-done identifies a ledger row BY SHAPE (id-shaped first cell,
  // backticked status last), which is what makes widening safe — and this is
  // the test that keeps that property true instead of merely documented.
  const rendered = renderLedger([
    { task: 'T1', step: 2, klass: 'environment', exit: 127, transient: false, basis: 'exit 127 (command not found)', cause: 'step 2 exited 127, expected 0', expected: 0, retry: '0/1', status: 'FAILED-ISOLATED', trace: 'bash: nope: command not found' },
    { task: 'T2', step: 1, klass: 'timeout', exit: 124, transient: true, basis: 'ETIMEDOUT from spawnSync', cause: 'step 1 exited 124, expected 0', expected: 0, retry: '0/0', status: 'HALTED-UPSTREAM', trace: '' },
  ]);
  const { ledger } = parseRunnerLog(rendered);
  assert.deepEqual([...ledger.keys()], ['T1', 'T2']);
  assert.equal(ledger.get('T1').length, 1, 'one row per failure, not one per pipe in the trace');
  assert.equal(ledger.has('Task'), false, 'the header is not a task id');
  assert.equal(ledger.has('---'), false, 'the separator is not a task id');
  assert.equal(classifyStatus('FAILED-ISOLATED'), 'failed');
});

// ---------- defaults.retry_if ----------
//
// The regression this locks. Making the STRICT retry policy the default would
// have stopped retrying flaky tests in every plan in the registry, because
// `transient: 'unknown'` is exactly the ordinary exit 1 where a deterministic
// assertion failure and a flaky test look identical from an exit code. That is
// why the strict policy is opt-in and the default keeps the older behaviour.

const flakyCmd = (marker) => `sh -c 'if [ -f ${marker} ]; then exit 0; else touch ${marker}; exit 1; fi'`;

test('retry_if any keeps the older behaviour: an unknown-transient failure retries', () => {
  const marker = path.join(tmpdir(), `vivera-retryif-any-${process.pid}`);
  rmSync(marker, { force: true });
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { retry_if: 'any' },
    tasks: [{ id: 'T1', depends_on: [], verify_exit: 0, run: [{ cmd: flakyCmd(marker), expect_exit: 0, retry: 1 }] }],
  };
  try {
    assert.equal(executePlan(plan, { execute: true, log: () => {} }).status.get('T1'), 'PASSED');
  } finally {
    rmSync(marker, { force: true });
  }
});

test('retry_if transient spends the budget only on a failure classified transient', () => {
  const marker = path.join(tmpdir(), `vivera-retryif-strict-${process.pid}`);
  rmSync(marker, { force: true });
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { retry_if: 'transient' },
    tasks: [{ id: 'T1', depends_on: [], verify_exit: 0, run: [{ cmd: flakyCmd(marker), expect_exit: 0, retry: 1 }] }],
  };
  try {
    const { status, ledger } = executePlan(plan, { execute: true, log: () => {} });
    assert.equal(status.get('T1'), 'FAILED-ISOLATED', 'the strict policy must not retry an unknown-transient failure');
    assert.equal(ledger[0].retry, '0/1');
    assert.match(ledger[0].note, /retry skipped under retry_if: transient/);
  } finally {
    rmSync(marker, { force: true });
  }
});

test('retry_if transient still retries a timeout, which IS classified transient', () => {
  // The strict policy must not become "never retry". A step that outlived its
  // budget is the one case where a re-run can plausibly succeed.
  const plan = {
    schema: 'ultra-plan/v1',
    defaults: { retry_if: 'transient', step_timeout_s: 1 },
    tasks: [{ id: 'T1', depends_on: [], verify_exit: 0, run: [{ cmd: 'sleep 5', expect_exit: 0, retry: 1 }] }],
  };
  const { ledger } = executePlan(plan, { execute: true, log: () => {} });
  assert.equal(ledger[0].klass, 'timeout');
  assert.equal(ledger[0].retry, '1/1', 'a timeout must consume its retry under the strict policy');
  assert.ok(!ledger[0].note, `a retried timeout must not be reported as skipped, got: ${ledger[0].note}`);
});

test('an unrecognised retry_if throws rather than defaulting to the weaker semantics', () => {
  // Same reason `on_precondition_fail` throws: a typo must not quietly grant a
  // policy nobody asked for.
  assert.throws(() => validateRetryIf('maybe'), /defaults\.retry_if must be one of/);
  assert.throws(() => validateRetryIf(true), /defaults\.retry_if must be one of/);
  assert.equal(validateRetryIf(undefined), 'any', 'an absent value is the documented default, not an error');
  assert.equal(validateRetryIf('transient'), 'transient');
  assert.throws(
    () => executePlan({
      schema: 'ultra-plan/v1',
      defaults: { retry_if: 'strict-ish' },
      tasks: [{ id: 'T1', depends_on: [], skip_if: 'false' }],
    }, { execute: true, log: () => {} }),
    /defaults\.retry_if must be one of/,
    'the throw must happen on the execution path, not only in the unit test',
  );
});

test('the plan template ships the strict policy commented, and defaults to any', () => {
  const text = fs.readFileSync(path.join(ROOT, 'templates', 'implementation-plan-template.md'), 'utf8');
  const { frontmatter } = extractFrontmatter(text);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.match(text, /retry_if: any/, 'the documented default must be the weaker, current behaviour');
  assert.equal(plan.defaults.retry_if, 'any');
  assert.deepEqual(validatePlan(plan, text).errors, []);
});

// ---------- tasks[].run[].loop_until ----------
//
// What this key is for, and what it is not.
//
// The runner already bounds how many times a step may RE-RUN: `retry`,
// `retry_transient_max`, `retry_if`. None of them answers the question an
// iterative step actually has, which is what proves an ITERATION has finished.
// "Keep fixing until the test goes green" writes its convergence condition as
// prose, and prose cannot fail, so the runner cannot tell "converged" from
// "still going" and a later round re-pays to rediscover work an earlier round
// already rejected.
//
// `loop_until` is that convergence condition, as a COMMAND. Exit 0 means
// converged and the step passes. Non-zero means the iteration has not finished:
// the step re-runs inside the retry budget it already had, and when the budget is
// spent the step FAILS with the cause naming `loop_until` and the exit code it
// returned. Absence stays legal, because most steps are not iterative.

// (b) Converged. The probe runs AFTER the step's own command succeeds, and a
// zero exit from it is what makes the step pass.
test('loop_until that exits 0 lets the step pass', () => {
  const probe = abs('converged.sh');
  writeFileSync(probe, '#!/bin/sh\nexit 0\n');
  chmodSync(probe, 0o755);
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    run: [{ cmd: 'true', loop_until: probe }],
  }]);
  assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
  assert.deepEqual(ledger, []);
});

// The probe is not a second opinion, it is a gate: it runs only after the step's
// own command exits as expected, and a command that never runs never converges.
test('loop_until does not run when the step itself fails', () => {
  const probeMarker = abs('probe-ran.txt');
  rmSync(probeMarker, { force: true });
  const probe = abs('touch-and-pass.sh');
  writeFileSync(probe, `#!/bin/sh\ntouch ${probeMarker}\nexit 0\n`);
  chmodSync(probe, 0o755);
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    run: [{ cmd: 'exit 3', expect_exit: 0, loop_until: probe, retry: 0 }],
  }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(existsSync(probeMarker), false, 'a probe may not launder a step that did not pass');
  assert.match(ledger[0].cause, /exited 3, expected 0/);
});

// (c) Never converged, no budget. The failure must name `loop_until` and carry
// its exit code, or a reader cannot tell an unconverged loop from a bad step.
test('loop_until that never converges with retry 0 fails, and the row names loop_until', () => {
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    run: [{ cmd: 'true', loop_until: 'exit 1', retry: 0 }],
  }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger.length, 1);
  assert.match(ledger[0].cause, /loop_until/);
  assert.match(ledger[0].cause, /exited 1/, 'the row carries the probe exit code, not the step\'s');
  assert.equal(ledger[0].exit, 1);
  // Classified by the existing classifyFailure, not a new class of its own.
  assert.equal(ledger[0].klass, 'code');
  assert.equal(ledger[0].transient, 'unknown');
});

// The iteration, not the step: re-running spends the SAME budget the step already
// had. A loop that converges on its second pass passes, and pays one retry for it.
test('an unconverged loop re-runs the step inside the existing retry budget', () => {
  const marker = path.join(tmpdir(), `vivera-loop-${process.pid}`);
  rmSync(marker, { force: true });
  // The probe converges only once it has been run twice, so the step genuinely
  // has to iterate.
  const probe = `sh -c 'n=$(cat ${marker} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${marker}; [ "$n" -ge 2 ]'`;
  const { status, ledger } = runPlan(
    [{ id: 'T1', depends_on: [], run: [{ cmd: 'true', loop_until: probe, retry: 2 }] }],
  );
  try {
    assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
    assert.deepEqual(ledger, []);
    assert.equal(readFileSync(marker, 'utf8').trim(), '2', 'the probe ran twice: once unconverged, once converged');
  } finally {
    rmSync(marker, { force: true });
  }
});

// Budget exhausted while still unconverged. The retry accounting must report the
// loop, not hide it behind the step's own exit.
test('a loop that outruns its retry budget fails with the exhausted count', () => {
  const { status, ledger } = runPlan(
    [{ id: 'T1', depends_on: [], run: [{ cmd: 'true', loop_until: 'exit 1', retry: 1 }] }],
  );
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].retry, '1/1');
  assert.match(ledger[0].cause, /loop_until/);
});

// A probe that is not even executable on this machine. classifyFailure already
// has a class for 127, and the loop must reuse it rather than inventing one.
test('an unrunnable loop_until is classified as environment by the existing taxonomy', () => {
  const { status, ledger } = runPlan([{
    id: 'T1', depends_on: [],
    run: [{ cmd: 'true', loop_until: 'definitely-not-a-real-binary-xyz', retry: 3 }],
  }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].klass, 'environment');
  assert.equal(ledger[0].exit, 127);
  assert.match(ledger[0].cause, /loop_until/);
});

// A probe that outlives step_timeout_s must be reaped like any other step, or
// the loop is the one place a child can escape the process-group kill.
test('a loop_until that overruns step_timeout_s is reported as 124', () => {
  const { status, ledger } = runPlan(
    [{ id: 'T1', depends_on: [], run: [{ cmd: 'true', loop_until: 'sleep 5', retry: 0 }] }],
    { step_timeout_s: 1 },
  );
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].exit, 124);
  assert.equal(ledger[0].klass, 'timeout');
  assert.match(ledger[0].cause, /loop_until/);
});

// (d) A convergence condition that is not a command is a validation error, not
// a runtime surprise discovered half-way through an execution.
test('a blank or non-string loop_until is a validation error naming the task and step', () => {
  for (const bad of ['', '   ', 42, true, null, ['bun test a'], { cmd: 'true' }]) {
    const plan = {
      schema: 'ultra-plan/v1',
      tasks: [{ id: 'T7', depends_on: [], run: [{ cmd: 'true', loop_until: bad }] }],
    };
    const { errors } = validatePlan(plan, null);
    assert.ok(
      errors.some((e) => /T7/.test(e) && /run\[0\]/.test(e) && /loop_until/.test(e)),
      `expected a loop_until validation error for ${JSON.stringify(bad)}, got: ${JSON.stringify(errors)}`,
    );
  }
});

// The text-probe ban. A convergence condition satisfied by reading a file and
// finding a string survives the behaviour being reverted, which is the exact
// false pass `skip_if` already refuses. Enforced with the SAME classifiers, so
// the two keys cannot disagree about the same command.
test('a loop_until that only reads a file is refused as a false pass', () => {
  for (const probe of ["grep -q 'done' out.txt", 'test -f out.txt', 'ls dist/', 'rg -q marker src/x.ts']) {
    const plan = {
      schema: 'ultra-plan/v1',
      tasks: [{ id: 'T1', depends_on: [], run: [{ cmd: 'true', loop_until: probe }] }],
    };
    const { errors } = validatePlan(plan, null);
    assert.ok(
      errors.some((e) => /loop_until/.test(e) && /probe|file/i.test(e)),
      `${probe} reads a file and asserts a string; it must not count as convergence`,
    );
  }
});

// And the ban must not refuse the honest form: a tool invocation that has to
// succeed first, even when a grep filters its output.
test('a loop_until that runs a tool stays legal, grep filter included', () => {
  for (const probe of ['bun test a.test.ts', "bun test a.test.ts 2>&1 | grep -q 'passes'", 'git diff --quiet -- path']) {
    const plan = {
      schema: 'ultra-plan/v1',
      tasks: [{ id: 'T1', depends_on: [], run: [{ cmd: 'true', loop_until: probe }] }],
    };
    assert.deepEqual(validatePlan(plan, null).errors, [], `${probe} runs a tool that has to succeed first`);
  }
});

// (a) The absence case, and the most important one: a plan that declares no
// loop_until validates and executes exactly as before. Asserted as whole
// objects, so a new field on a ledger row or a changed status fails here.
test('NEGATIVE CONTROL: a plan with no loop_until is untouched by any of this', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    runner_contract: true,
    tasks: [
      { id: 'T1', depends_on: [], skip_if: 'bun test a.test.ts' },
      { id: 'T2', depends_on: ['T1'], skip_if: 'false', verify_exit: 0, run: [{ cmd: 'exit 4', expect_exit: 0, retry: 0 }] },
      { id: 'T3', depends_on: ['T2'], skip_if: 'bun test c.test.ts' },
    ],
  };
  const { errors, warnings } = validatePlan(plan, null);
  assert.deepEqual(errors, [], 'absence must stay legal');
  // The plan is not warning-free by construction (NEEDS-AGENT and impacts both
  // speak on it), so the assertion is that NONE of the existing warnings is
  // about the key that was never declared.
  assert.ok(!warnings.some((w) => /loop_until/.test(w)), warnings.join(' | '));

  const { order, status, ledger } = executePlan(
    { ...plan, defaults: { retry_transient_max: 0, step_timeout_s: 30 } },
    { execute: true, log: () => {} },
  );
  assert.deepEqual(order, ['T1', 'T2', 'T3']);
  assert.equal(status.get('T1'), 'NEEDS-AGENT');
  assert.equal(status.get('T2'), 'FAILED-BLOCKING');
  assert.equal(status.get('T3'), 'HALTED-UPSTREAM');
  assert.deepEqual(
    ledger.map((e) => [e.task, e.step, e.klass, e.exit, e.expected, e.retry, e.status]),
    [
      ['T2', 1, 'code', 4, 0, '0/0', 'FAILED-BLOCKING'],
      ['T3', '-', 'contract', '-', undefined, '0/0', 'HALTED-UPSTREAM'],
    ],
  );
  // No row anywhere may mention the key that was never declared.
  assert.ok(!ledger.some((e) => JSON.stringify(e).includes('loop_until')),
    'an absent loop_until must not appear in the ledger');
});

// One more absence guard, at the parser level: an unknown key on a step is
// carried through untouched and must not be mistaken for a convergence claim.
test('loop_until is declared by the contract, so CI can tell the template is behind', () => {
  assert.ok(RUNNER_CONTRACT_KEYS.includes('tasks[].run[].loop_until'),
    'a key the runner acts on but does not declare here cannot be checked against the template');
  // Present in the list, and read by the enforcement the tests above exercise.
  // Asserting only the membership would pass against a key nothing enforces.
  const { status } = runPlan([{ id: 'T1', depends_on: [], run: [{ cmd: 'true', loop_until: 'exit 1', retry: 0 }] }]);
  assert.equal(status.get('T1'), 'FAILED-ISOLATED', 'membership plus a working enforcement');
});

// End to end through the parser, because a key that cannot be written in the
// template is a key every plan author copies without it.
test('loop_until parses from block-style run[] the way a plan writes it', () => {
  const { frontmatter } = extractFrontmatter(`---
schema: ultra-plan/v1
plan_id: 2026-10-05-loop
status: Approved
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    run:
      - cmd: "bun test a.test.ts"
        expect_exit: 0
        retry: 2
        loop_until: "bun test a.test.ts"
---
# p
`);
  const plan = parseUltraPlanYaml(frontmatter);
  assert.equal(plan.tasks[0].run[0].loop_until, 'bun test a.test.ts');
  assert.deepEqual(validatePlan(plan, null).errors, []);
});

// ---------- Test-reversal proof for the RED-step iteration gap ----------
//
// A loop declared on an expect_exit:1 step is the case the key exists for: the
// step's own command is expected to fail, and the question "has the iteration
// finished" is separate from that expected failure. This test exists because the
// suite had no RED step carrying a loop_until, and the gap it left was invisible.
//
// THE DEFECT THIS PINS. The runner assigned the probe result into `r` and then
// compared `r.exit` against the step's `want` to decide the step had passed. A
// RED step declares expect_exit 1 and an unconverged probe exits 1, so that
// comparison was true, the retry loop broke after one pass, and zero of the
// declared budget was spent. Reverting the guard on this line makes this test
// fail with status FAILED-ISOLATED, retry '0/2', and a single probe invocation,
// where it asserts PASSED, '2/2', and two.
test('a loop_until on a RED step iterates inside its retry budget and can converge', () => {
  const marker = path.join(tmpdir(), `vivera-red-loop-${process.pid}`);
  rmSync(marker, { force: true });
  // The probe converges only on its second invocation, so the step genuinely has
  // to iterate. Its exit codes are 1 before convergence and 0 after, which is
  // also what makes this a RED-step case: 1 is the step's declared success.
  const probe = `sh -c 'n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; [ "$n" -ge 1 ]'`;
  const { status, ledger } = runPlan([
    { id: 'T1', depends_on: [], run: [{ cmd: 'exit 1', expect_exit: 1, loop_until: probe, retry: 2 }] },
  ]);
  try {
    assert.equal(status.get('T1'), 'PASSED', JSON.stringify(ledger));
    assert.deepEqual(ledger, []);
    assert.equal(readFileSync(marker, 'utf8').trim(), '2',
      'the probe ran twice: once unconverged, once converged, so the budget was spent');
  } finally {
    rmSync(marker, { force: true });
  }
});

// The counterpart that keeps the fix honest in the other direction: a RED step
// whose loop NEVER converges must still fail, and must report the exhausted
// budget rather than passing on the step's own expected exit. Before the fix
// this failed with retry '0/2', which is the accounting this asserts.
test('a RED step whose loop never converges fails with the exhausted budget', () => {
  const marker = path.join(tmpdir(), `vivera-red-loop-fail-${process.pid}`);
  rmSync(marker, { force: true });
  const probe = `sh -c 'n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; exit 1'`;
  const { status, ledger } = runPlan([
    { id: 'T1', depends_on: [], run: [{ cmd: 'exit 1', expect_exit: 1, loop_until: probe, retry: 2 }] },
  ]);
  try {
    assert.equal(status.get('T1'), 'FAILED-ISOLATED');
    assert.equal(ledger[0].retry, '2/2', 'the whole declared budget was spent on the loop');
    assert.match(ledger[0].cause, /loop_until/);
    assert.match(ledger[0].cause, /exited 1/, 'the probe exit, not the step\'s own expected 1');
    assert.equal(readFileSync(marker, 'utf8').trim(), '3', 'one probe per pass: initial plus two retries');
  } finally {
    rmSync(marker, { force: true });
  }
});
