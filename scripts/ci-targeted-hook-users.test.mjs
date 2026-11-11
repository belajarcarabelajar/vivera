// scripts/ci-targeted-hook-users.test.mjs
//
// A hook change also plans the other test files that name the hook path, not only
// scripts/<hook>.test.mjs, so a hook edit that breaks another suite is caught. The user
// fixture names the hook the way the sprite-agents target tests do: inside a YAML string
// after "$CLAUDE_PROJECT_DIR" and before an escaped newline, which no path-mention rule
// of the planner matched before.

import { expect, test } from 'bun:test';
import { planChecks } from './ci-targeted.mjs';

const USER_SRC = String.raw`const yaml = 'command: bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/block-git-writes.mjs\n';` + '\n';
const SOURCES = {
  'scripts/block-git-writes.test.mjs': "const HOOK = '.claude/hooks/block-git-writes.mjs';\n",
  'scripts/target-user.test.mjs': USER_SRC,
  'scripts/unrelated.test.mjs': "const p = 'scripts/core.mjs';\n",
  'scripts/core.mjs': 'export const core = 1;\n',
};
const testsCmd = (plan) => plan.suites.find((s) => s.name === 'tests')?.cmd;

test('a hook change plans its own test and every test that names the hook path', () => {
  const plan = planChecks(['.claude/hooks/block-git-writes.mjs'], { sources: SOURCES });
  expect([plan.full, testsCmd(plan)]).toEqual([
    false,
    ['bun', 'test', '--timeout', '30000', './scripts/block-git-writes.test.mjs', './scripts/target-user.test.mjs'],
  ]);
});

test('a hook without its own test still goes FULL even when another test names it', () => {
  const { 'scripts/block-git-writes.test.mjs': _own, ...rest } = SOURCES;
  expect(planChecks(['.claude/hooks/block-git-writes.mjs'], { sources: rest }).full).toBe(true);
});
