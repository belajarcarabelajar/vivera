import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFrontmatter, parseUltraPlanYaml, validatePlan } from './ultra-plan-runner.mjs';
import { normaliseAcIds } from './lib/plan-traceability.mjs';

const ROW_HEAD = '| AC | Task | Check | Evidence |\n|---|---|---|---|';

function planMd({ requireKey = false, acs = ['AC-1', 'AC-2'], table = null, marker = '**Traceability:**' } = {}) {
  const fm = `---
schema: ultra-plan/v1
plan_id: 2026-10-31-trace-demo
status: Approved
version: 1
runner_contract: true
defaults:
  retry_transient_max: 1
  step_timeout_s: 90
  on_precondition_fail: stop-task-continue-independent
${requireKey ? '  require_traceability: true\n' : ''}tasks:
  - id: T1
    depends_on: []
    impacts: ["none: demo fixture - bun test scripts/plan-traceability.test.mjs"]
    files: { create: [src/a.ts], modify: [], test: [src/a.test.ts] }
    idempotency_key: "T1:src/a.ts"
    skip_if: "bun test src/a.test.ts"
    verify_exit: 0
  - id: T2
    depends_on: [T1]
    impacts: ["none: demo fixture - bun test scripts/plan-traceability.test.mjs"]
    files: { create: [src/b.ts], modify: [], test: [src/b.test.ts] }
    idempotency_key: "T2:src/b.ts"
    skip_if: "bun test src/b.test.ts"
    verify_exit: 0
---
`;
  const acLines = acs.map((id) => `- [ ] ${id}: behaviour ${id}`).join('\n');
  const tbl = table === null ? '' : `${marker}\n\n${ROW_HEAD}\n${table}\n`;
  const body = `# Demo

## Acceptance Criteria

${acLines}

${tbl}
### Task T1: A
### Task T2: B

\`\`\`mermaid
flowchart TD
    T1["T1: A"] --> T2["T2: B"]
\`\`\`
`;
  return fm + body;
}

function check(md) {
  const { frontmatter, body } = extractFrontmatter(md);
  return validatePlan(parseUltraPlanYaml(frontmatter), body, { frontmatter });
}

const traceWarnings = (warnings) => warnings.filter((w) => /traceab/i.test(w));

test('a complete Traceability table under the key validates clean', () => {
  const { errors } = check(planMd({ requireKey: true, table: '| AC-1 | T1 | `bun test a` | exit |\n| AC-2 | T2 | `bun test b \\| tail -3` | exit |' }));
  assert.deepEqual(errors, []);
});

test('AC-1: under the key, a defined AC with no row is an error naming the AC', () => {
  const { errors } = check(planMd({ requireKey: true, table: '| AC-1 | T1 | `bun test a` | exit |' }));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /AC-2/);
  assert.match(errors[0], /Traceability/);
});

test('AC-2: under the key, a row naming a task not in tasks[] is a GHOST reference error', () => {
  const { errors } = check(planMd({ requireKey: true, table: '| AC-1, AC-2 | T1, T9 | `bun test a` | exit |' }));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /GHOST reference: T9/);
});

test('AC-2: under the key, a row whose Task cell names no task id is an error', () => {
  const { errors } = check(planMd({ requireKey: true, table: '| AC-1, AC-2 | later | `bun test a` | exit |' }));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /names no task/);
});

test('AC-3: under the key, a row with an empty Check cell is an error', () => {
  const { errors } = check(planMd({ requireKey: true, table: '| AC-1, AC-2 | T1 |  | exit |' }));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /empty Check cell/);
});

test('AC-4: warning only, without the key an untraced AC is one aggregated warning and never an error', () => {
  const { errors, warnings } = check(planMd({ table: '| AC-1 | T9 |  | exit |' }));
  assert.deepEqual(errors, []);
  const tw = traceWarnings(warnings);
  assert.equal(tw.length, 1, tw.join('\n'));
  assert.match(tw[0], /AC-2/);
  assert.match(tw[0], /`defaults\.require_traceability: true`/);
});

test('AC-4: warning only, without the key a missing table is one warning', () => {
  const { errors, warnings } = check(planMd({ table: null }));
  assert.deepEqual(errors, []);
  const tw = traceWarnings(warnings);
  assert.equal(tw.length, 1, tw.join('\n'));
  assert.match(tw[0], /no Traceability table/);
});

test('AC-5: AC-1, AC1, AC1-AC3, AC-1..AC-3, AC-1 to AC-3 and AC-01 normalise to the same ids', () => {
  assert.deepEqual(normaliseAcIds('AC-1'), ['AC-1']);
  assert.deepEqual(normaliseAcIds('AC1'), ['AC-1']);
  assert.deepEqual(normaliseAcIds('AC-01'), ['AC-1']);
  for (const cell of ['AC1-AC3', 'AC-1..AC-3', 'AC-1 to AC-3', 'AC-3, AC-1, AC-2, AC-2']) {
    assert.deepEqual(normaliseAcIds(cell), ['AC-1', 'AC-2', 'AC-3'], cell);
  }
  assert.deepEqual(normaliseAcIds('AC-10, AC-9'), ['AC-9', 'AC-10']);
});

test('a range written backwards is an error naming the cell', () => {
  const { errors } = check(planMd({ requireKey: true, table: '| AC2-AC1 | T1 | `bun test a` | exit |' }));
  assert.ok(errors.some((e) => /backwards/.test(e) && e.includes('AC2-AC1')), errors.join('\n'));
});

test('a plan with no defined ACs is not checked, even under the key', () => {
  const { errors, warnings } = check(planMd({ requireKey: true, acs: [], table: null }));
  assert.deepEqual(errors, []);
  assert.deepEqual(traceWarnings(warnings), []);
});

test('under the key, a missing table is an error', () => {
  const { errors } = check(planMd({ requireKey: true, table: null }));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /no Traceability table/);
});

test('under the key, a table without a Check column is an error', () => {
  const md = planMd({ requireKey: true, table: '| AC-1, AC-2 | T1 | x | y |' }).replace(ROW_HEAD, '| AC | Task | Notes | Evidence |\n|---|---|---|---|');
  const { errors } = check(md);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /Check/);
});

test('the table is also found under a heading, and an AC only in the table is a warning', () => {
  const md = planMd({ requireKey: true, marker: '### Traceability', table: '| AC-1, AC-2, AC-7 | T1 | `bun test a` | exit |' });
  const { errors, warnings } = check(md);
  assert.deepEqual(errors, []);
  const tw = traceWarnings(warnings);
  assert.equal(tw.length, 1, tw.join('\n'));
  assert.match(tw[0], /AC-7/);
});

test('the table is also found under a list-item marker, as the plan template writes it', () => {
  const md = planMd({ requireKey: true, marker: '- **Traceability:** one row per AC.', table: '| AC-1, AC-2 | T1 | `bun test a` | exit |' });
  assert.deepEqual(check(md).errors, []);
});

test('AC lines and tables inside code fences are ignored', () => {
  const md = planMd({ requireKey: true, acs: [], table: null })
    .replace('# Demo', '# Demo\n\n```markdown\n- [ ] AC-1: example\n```');
  const { errors } = check(md);
  assert.deepEqual(errors, []);
});
