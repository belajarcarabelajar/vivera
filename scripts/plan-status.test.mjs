// scripts/plan-status.test.mjs
//
// plan-status rebuilds a resumed session's state from the plan file and the
// overnight handoff on disk, never from model text. Fixtures are written to a
// scratch dir and `--now` pins the clock, so the stale flag is deterministic.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planStatus } from './plan-status.mjs';

const SCRIPT = join(import.meta.dir, 'plan-status.mjs');
const SCRATCH = join(process.env.HOME ?? '/tmp', '.cache/tmp/vivera-scratch');
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, 'plan-status-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PLAN = `---
schema: ultra-plan/v1
plan_id: 2026-01-01-demo
status: Approved
version: 1
tasks:
  - id: T1
    depends_on: []
---

# Demo plan

### Task T1: First thing

- [x] Step 1: Write failing tests.
- [x] Step 2: Run them.

### Task T2: Second thing

- [x] Step 1: Write failing tests.
- [ ] Step 2: Implement.

### Task T3: Third thing

- [ ] Step 1: Write failing tests.

\`\`\`markdown
- [ ] Step 9: an example inside a fence, not a step.
\`\`\`

## Approval

| Gate | Answer | Date |
|---|---|---|
| \`Intent\` | Lock intent | 2026-01-01 |
| \`Plan\` | pending | |
| \`Close plan\` |  | |
`;

const NO_CHECKLIST = `---
schema: ultra-plan/v1
plan_id: 2026-01-02-empty
status: Draft
---

# Nothing to tick yet
`;

const handoff = (result, lastUpdate) => `# Overnight handoff

Result: ${result}
Started: 2026-01-01T22:00:00+07:00
Last update: ${lastUpdate}

## Evidence
`;

const NOW = '2026-01-02T06:00:00+07:00';

// Shape of templates/implementation-plan-template.md: boxes outside task
// sections (acceptance criteria, affected surfaces, the gate, the backlog), a
// heading that only mentions approval in passing, and the gate as a checkbox.
const TEMPLATE_SHAPE = `---
schema: ultra-plan/v1
plan_id: 2026-01-03-template
status: Draft
---

## 1. Intent & Scope
  - [ ] AC-1: first criterion
  - [x] AC-2: second criterion

## 2b. Affected Surfaces - approval gate blocker if empty
- [ ] Every task appears above.

## 4. Work Breakdown & Task Checklist

### Task T1: Component
  - [x] Dependency: tool exits 0
- [x] **Step 1 - Failing Test (RED):** cmd: \`bun test a\`
- [ ] **Step 2 - Implementation (GREEN):** minimal code

### Notes on T1
- [ ] not a task step either

## 7. Human Approval Gate
- [ ] Partner / Human approval received for this plan before implementation begins.

## 8. Session-Close Debt Sweep & Follow-Up Backlog
- [ ] 3-5 ranked follow-ups injected.
`;

// Shape used in scripts/plan-closeout.test.mjs: the gate as a list item.
const LIST_GATE = `---
schema: ultra-plan/v1
plan_id: 2026-01-04-list
status: Approved
---

### Task T1: todo
- [ ] Step 1 todo

## Approval
- [ ] Approved
- [x] Spec approved
`;

function run(args) {
  const p = Bun.spawnSync(['bun', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function writePlan(name, md, handoffText) {
  const sub = mkdtempSync(join(dir, 'p-'));
  const path = join(sub, `${name}.md`);
  writeFileSync(path, md);
  if (handoffText !== undefined) writeFileSync(join(sub, `${name}-overnight-handoff.md`), handoffText);
  return path;
}

describe('planStatus computed from the plan file', () => {
  test('reads plan id and status from the frontmatter', () => {
    const s = planStatus(PLAN, { handoff: null, now: new Date(NOW), staleHours: 2 });
    expect(s.plan_id).toBe('2026-01-01-demo');
    expect(s.status).toBe('Approved');
  });

  test('counts checklist steps outside code fences', () => {
    const s = planStatus(PLAN, { handoff: null, now: new Date(NOW), staleHours: 2 });
    expect(s.task_steps).toEqual({ done: 3, total: 5 });
  });

  test('current task is the first with an unchecked step, next is the one after', () => {
    const s = planStatus(PLAN, { handoff: null, now: new Date(NOW), staleHours: 2 });
    expect(s.current).toBe('Task T2: Second thing');
    expect(s.next).toBe('Task T3: Third thing');
  });

  test('open approval gates are rows answered pending or left empty', () => {
    const s = planStatus(PLAN, { handoff: null, now: new Date(NOW), staleHours: 2 });
    expect(s.open_gates).toEqual(['Plan', 'Close plan']);
  });

  test('a plan with no checklist reports 0/0 and no current task', () => {
    const s = planStatus(NO_CHECKLIST, { handoff: null, now: new Date(NOW), staleHours: 2 });
    expect(s.task_steps).toEqual({ done: 0, total: 0 });
    expect(s.current).toBeNull();
    expect(s.next).toBeNull();
    expect(s.open_gates).toEqual([]);
  });
});

describe('task steps and gates in other plan shapes', () => {
  const opts = { handoff: null, now: new Date(NOW), staleHours: 2 };

  test('only boxes inside Task sections count as task steps', () => {
    expect(planStatus(TEMPLATE_SHAPE, opts).task_steps).toEqual({ done: 2, total: 3 });
  });

  test('an unchecked box under a Human Approval Gate heading is an open gate, named by its text', () => {
    expect(planStatus(TEMPLATE_SHAPE, opts).open_gates).toEqual([
      'Partner / Human approval received for this plan before implementation begins.',
    ]);
  });

  test('an unchecked list item under ## Approval is an open gate, a ticked one is not', () => {
    const s = planStatus(LIST_GATE, opts);
    expect(s.open_gates).toEqual(['Approved']);
    expect(s.task_steps).toEqual({ done: 0, total: 1 });
  });
});

describe('overnight handoff and the stale handoff flag', () => {
  test('no handoff file means overnight is null', () => {
    const s = planStatus(PLAN, { handoff: null, now: new Date(NOW), staleHours: 2 });
    expect(s.overnight).toBeNull();
  });

  test('a running handoff updated 5 hours ago is a stale handoff at the 2 hour default', () => {
    const s = planStatus(PLAN, { handoff: handoff('running', '2026-01-02T01:00:00+07:00 T2 Step 1'), now: new Date(NOW), staleHours: 2 });
    expect(s.overnight).toEqual({ result: 'running', last_update: '2026-01-02T01:00:00+07:00 T2 Step 1', stale: true });
  });

  test('a running handoff updated 1 hour ago is not stale', () => {
    const s = planStatus(PLAN, { handoff: handoff('running', '2026-01-02T05:00:00+07:00 T2 Step 1'), now: new Date(NOW), staleHours: 2 });
    expect(s.overnight.stale).toBe(false);
  });

  test('a finished run is never stale however old its last update', () => {
    const s = planStatus(PLAN, { handoff: handoff('PR #12 opened', '2026-01-01T23:00:00+07:00 T3 Step 1'), now: new Date(NOW), staleHours: 2 });
    expect(s.overnight.result).toBe('PR #12 opened');
    expect(s.overnight.stale).toBe(false);
  });

  test('an unparseable last update gives stale unknown', () => {
    const s = planStatus(PLAN, { handoff: handoff('running', 'sometime last night'), now: new Date(NOW), staleHours: 2 });
    expect(s.overnight.stale).toBe('unknown');
  });

  test('--stale-hours widens the threshold', () => {
    const s = planStatus(PLAN, { handoff: handoff('running', '2026-01-02T01:00:00+07:00 T2'), now: new Date(NOW), staleHours: 6 });
    expect(s.overnight.stale).toBe(false);
  });
});

describe('CLI', () => {
  test('prints the computed block and exits 0', () => {
    const path = writePlan('2026-01-01-demo', PLAN, handoff('running', '2026-01-02T01:00:00+07:00 T2 Step 1'));
    const r = run([path, '--now', NOW]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('plan: 2026-01-01-demo');
    expect(r.out).toContain('status: Approved');
    expect(r.out).toContain('task steps: 3/5');
    expect(r.out).toContain('current: Task T2: Second thing');
    expect(r.out).toContain('next: Task T3: Third thing');
    expect(r.out).toContain('open gates: Plan, Close plan');
    expect(r.out).toContain('result: running');
    expect(r.out).toContain('last update: 2026-01-02T01:00:00+07:00 T2 Step 1');
    expect(r.out).toContain('stale: yes');
  });

  test('the template shape prints its open gate', () => {
    const path = writePlan('2026-01-03-template', TEMPLATE_SHAPE);
    const r = run([path, '--now', NOW]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('task steps: 2/3');
    expect(r.out).toContain('open gates: Partner / Human approval received');
  });

  test('without a handoff prints overnight: none', () => {
    const path = writePlan('2026-01-01-demo', PLAN);
    const r = run([path, '--now', NOW]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('overnight: none');
  });

  test('an unparseable last update prints stale: unknown', () => {
    const path = writePlan('2026-01-01-demo', PLAN, handoff('running', 'sometime last night'));
    const r = run([path, '--now', NOW]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('stale: unknown');
  });

  test('--json prints the same status as JSON', () => {
    const path = writePlan('2026-01-01-demo', PLAN, handoff('running', '2026-01-02T05:00:00+07:00 T2'));
    const r = run([path, '--now', NOW, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.task_steps).toEqual({ done: 3, total: 5 });
    expect(j.overnight.stale).toBe(false);
  });

  test('--stale-hours is honoured', () => {
    const path = writePlan('2026-01-01-demo', PLAN, handoff('running', '2026-01-02T01:00:00+07:00 T2'));
    const r = run([path, '--now', NOW, '--stale-hours', '6']);
    expect(r.out).toContain('stale: no');
  });

  test('a missing plan file exits 1', () => {
    const r = run([join(dir, 'nope.md')]);
    expect(r.code).toBe(1);
  });

  test('no argument, an unknown flag, or a bad number exits 2', () => {
    expect(run([]).code).toBe(2);
    const path = writePlan('2026-01-01-demo', PLAN);
    expect(run([path, '--bogus']).code).toBe(2);
    expect(run([path, '--stale-hours', 'abc']).code).toBe(2);
    expect(run([path, '--now', 'not-a-date']).code).toBe(2);
  });
});
