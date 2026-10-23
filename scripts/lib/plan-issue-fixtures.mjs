// scripts/lib/plan-issue-fixtures.mjs
//
// Test fixtures shared by scripts/plan-issue-sync.test.mjs and
// scripts/plan-issue-render.test.mjs: one plan text and one recording gh stub.

export const PLAN_REL = 'docs/code-plan/plans/2026-10-01-add-pr.md';

export function plan(status = 'Draft', extra = '') {
  return `---
schema: ultra-plan/v1
plan_id: 2026-10-01-add-pr
status: ${status}
version: 1
---

# Add PR delivery

**Goal:** one thing.
${extra}
`;
}

// A recording stub, for the paths that never reach the network: refusals that
// happen before any gh call, and the pure decision layer.
export function stub(result = { ok: true, url: 'https://github.com/u/r/issues/7' }) {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    return typeof result === 'function' ? result(args, input) : result;
  };
  run.calls = calls;
  return run;
}
