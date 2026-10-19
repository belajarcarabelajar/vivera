import { expect, test } from 'bun:test';
import { planChecks } from './ci-targeted.mjs';

// A category's own tests read its inputs through the script (snippets through the
// manifest), not by path, so path matching alone never selects them.
test('a changed snippet selects the tests of the snippet sync script', () => {
  const sources = {
    'scripts/sync-snippets.mjs': 'export const x = 1;\n',
    'scripts/sync-snippets.test.mjs': "import { x } from './sync-snippets.mjs';\n",
    'snippets/a.md': 'prompt\n',
  };
  const tests = planChecks(['snippets/a.md'], { sources }).suites.find((s) => s.name === 'tests');
  expect(tests?.cmd ?? []).toContain('./scripts/sync-snippets.test.mjs');
});

test('a docs/guide change selects what a README.md change selects', () => {
  const picked = (p) => planChecks([p], { sources: {} }).suites.map((s) => s.name)
    .filter((n) => ['validate-skill', 'docs-gen', 'copy-rules'].includes(n)).sort();
  expect(picked('README.md')).toEqual(['copy-rules', 'docs-gen', 'validate-skill']);
  expect(picked('docs/guide/tooling-validation.md')).toEqual(['copy-rules', 'docs-gen', 'validate-skill']);
});
