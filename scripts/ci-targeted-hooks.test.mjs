// scripts/ci-targeted-hooks.test.mjs
//
// A hook under .claude/hooks plans its own test, scripts/<hook>.test.mjs, instead of
// the full list (a change to block-git-writes.mjs alone used to run every suite).

import { expect, test } from 'bun:test';
import { planChecks } from './ci-targeted.mjs';

const SOURCES = {
  'scripts/block-git-writes.test.mjs': "const HOOK = '.claude/hooks/block-git-writes.mjs';\n",
  'scripts/core.mjs': 'export const core = 1;\n',
};
const testsCmd = (plan) => plan.suites.find((s) => s.name === 'tests')?.cmd;

test('a change to .claude/hooks/block-git-writes.mjs plans its test without FULL mode', () => {
  const plan = planChecks(['.claude/hooks/block-git-writes.mjs'], { sources: SOURCES });
  expect([plan.full, testsCmd(plan)]).toEqual([false, ['bun', 'test', '--timeout', '30000', './scripts/block-git-writes.test.mjs']]);
});

test('a hook change goes FULL when its test is missing, never untested', () => {
  expect(planChecks(['.claude/hooks/new-hook.mjs'], { sources: SOURCES }).full).toBe(true);
});

test('a file below .claude/hooks that is not a hook script still forces FULL mode', () => {
  expect(planChecks(['.claude/hooks/README.md'], { sources: SOURCES }).full).toBe(true);
});
