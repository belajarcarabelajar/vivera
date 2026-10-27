// scripts/ci-targeted-workflows.test.mjs
//
// A workflow file under .github/workflows plans its structure test instead of the
// full list (ci-targeted.test.mjs sits at its size ceiling, so this lives apart).

import { expect, test } from 'bun:test';
import { planChecks } from './ci-targeted.mjs';

const SOURCES = {
  'scripts/workflows.test.mjs': "const DIR = path.join(ROOT, '.github', 'workflows');\n",
  'scripts/core.mjs': 'export const core = 1;\n',
};
const testsCmd = (plan) => plan.suites.find((s) => s.name === 'tests')?.cmd;

test('a change to .github/workflows/platforms.yml plans workflows.test.mjs without FULL mode', () => {
  const plan = planChecks(['.github/workflows/platforms.yml'], { sources: SOURCES });
  expect([plan.full, testsCmd(plan)]).toEqual([false, ['bun', 'test', '--timeout', '30000', './scripts/workflows.test.mjs']]);
});

test('a .yaml workflow is recognized the same way', () => {
  expect(planChecks(['.github/workflows/nightly.yaml'], { sources: SOURCES }).full).toBe(false);
});

test('an unknown path elsewhere still forces FULL mode', () => {
  const plan = planChecks(['.github/CODEOWNERS'], { sources: SOURCES });
  expect([plan.full, plan.suites[0].reasons]).toEqual([true, ['.github/CODEOWNERS: unrecognized path']]);
});

test('a workflow change goes FULL when workflows.test.mjs is missing, never untested', () => {
  expect(planChecks(['.github/workflows/platforms.yml'], { sources: { 'scripts/core.mjs': '' } }).full).toBe(true);
});
