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
    expect(s.checklist).toEqual({ done: 3, total: 5 });
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
    expect(s.checklist).toEqual({ done: 0, total: 0 });
    expect(s.current).toBeNull();
    expect(s.next).toBeNull();
    expect(s.open_gates).toEqual([]);
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
    expect(r.out).toContain('checklist: 3/5');
    expect(r.out).toContain('current: Task T2: Second thing');
    expect(r.out).toContain('next: Task T3: Third thing');
    expect(r.out).toContain('open gates: Plan, Close plan');
    expect(r.out).toContain('result: running');
    expect(r.out).toContain('last update: 2026-01-02T01:00:00+07:00 T2 Step 1');
    expect(r.out).toContain('stale: yes');
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
    expect(j.checklist).toEqual({ done: 3, total: 5 });
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
