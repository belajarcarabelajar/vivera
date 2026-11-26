// scripts/closeout-verdict.test.mjs
//
// The close-out verdict printed when a session is recorded as merged, by
// `state <s> merged` and by `reconcile`. The check is injected, so the line
// shapes are pinned here without a repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeoutVerdict } from './lib/closeout-verdict.mjs';

const SESSION = { session: 'w1', plan: 'my-plan' };
const GAP = { code: 'PLAN_NOT_COMPLETE', message: 'plan.md has status "Verification", not Complete', fix: 'set "status: Complete"' };
const GAP2 = { code: 'ISSUE_NOT_CLOSED', message: 'issue #5 is recorded as "open", not closed', fix: 'bun scripts/plan-issue-sync.mjs plan.md' };
const DUE = 'due: bun scripts/plan-close-loop.mjs --due';
const NO_PLAN = 'no plan file at /r/docs/code-plan/plans/my-plan.md (a one-task change has no plan file)';

test('closeoutVerdict prints one message and one fix per gap and ends with the due line', () => {
  const verdict = closeoutVerdict(SESSION, { repoRoot: '/r', check: () => ({ skipped: null, gaps: [GAP, GAP2] }) });
  assert.deepEqual(verdict.lines, [
    'warning: recording "w1" as merged, but plan my-plan is not closed out:',
    '  - [PLAN_NOT_COMPLETE] plan.md has status "Verification", not Complete',
    '    fix: set "status: Complete"',
    '  - [ISSUE_NOT_CLOSED] issue #5 is recorded as "open", not closed',
    '    fix: bun scripts/plan-issue-sync.mjs plan.md',
    'readiness: bun scripts/plan-closeout.mjs --readiness /r/docs/code-plan/plans/my-plan.md',
    DUE,
  ]);
});

test('closeoutVerdict prints no due line when there are no gaps', () => {
  const empty = closeoutVerdict(SESSION, { repoRoot: '/r', check: () => ({ skipped: null, gaps: [] }) });
  assert.deepEqual(empty.lines, []);
  const note = closeoutVerdict({ ...SESSION, repo: '/r' }, { repoRoot: '/r', check: () => ({ skipped: NO_PLAN, gaps: [] }) });
  assert.deepEqual(note.lines, [`note: close-out not fully checked: ${NO_PLAN}`]);
  const guessed = closeoutVerdict(SESSION, { repoRoot: '/r', check: () => ({ skipped: NO_PLAN, gaps: [] }) });
  assert.equal(guessed.lines[0], `warning: close-out not fully checked: ${NO_PLAN}`);
  assert.ok(!guessed.lines.includes(DUE), guessed.lines.join('\n'));
});
