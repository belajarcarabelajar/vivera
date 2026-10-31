import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, planChecks } from './ci-targeted.mjs';

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

test('the root GLOSSARY.md is a recognized doc file, not a reason to run everything', () => {
  const plan = planChecks(['GLOSSARY.md'], { sources: {} });
  expect(plan.full).toBe(false);
  expect(plan.suites.map((s) => s.name)).toContain('copy-rules');
});

const MOD_SOURCES = {
  'scripts/telegram-ask.test.mjs': 'test\n',
  'scripts/sprite-model-router.test.mjs': 'test\n',
  'scripts/other.test.mjs': 'test\n',
};
const MOD_INDEX = { sources: MOD_SOURCES, marketplaceMods: ['sprite-model-router', 'telegram-ask'] };
const modPlan = (paths) => planChecks(paths, MOD_INDEX);
const modTestFiles = (plan) => plan.suites.find((s) => s.name === 'tests')?.cmd.slice(4) ?? [];

test('a change inside one mod selects that mod suite test, not full', () => {
  const plan = modPlan(['mods/telegram-ask/bridge/server.ts', 'mods/telegram-ask/README.md', 'docs/note.md']);
  expect(plan.full).toBe(false);
  expect(modTestFiles(plan)).toEqual(['./scripts/telegram-ask.test.mjs']);
});

test('the mods marketplace selects the suite test of every mod it lists', () => {
  const plan = modPlan(['mods/.claude-plugin/marketplace.json']);
  expect(plan.full).toBe(false);
  expect(modTestFiles(plan)).toEqual(['./scripts/sprite-model-router.test.mjs', './scripts/telegram-ask.test.mjs']);
});

test('a mod without a suite test, or a listed mod without one, stays unrecognized', () => {
  const lone = modPlan(['mods/unknown-mod/index.ts']);
  expect(lone.full).toBe(true);
  expect(lone.suites[0].reasons).toEqual(['mods/unknown-mod/index.ts: unrecognized path']);
  const listed = planChecks(['mods/.claude-plugin/marketplace.json'], { ...MOD_INDEX, marketplaceMods: ['telegram-ask', 'unknown-mod'] });
  expect(listed.full).toBe(true);
  expect(modPlan(['mods/README.md']).full).toBe(true);
});

test('the scripts test of a mod still selects itself as before', () => {
  const plan = modPlan(['scripts/telegram-ask.test.mjs']);
  expect(plan.full).toBe(false);
  expect(modTestFiles(plan)).toEqual(['./scripts/telegram-ask.test.mjs']);
});

test('the index lists the mods named by the marketplace sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-targeted-mods-'));
  try {
    fs.mkdirSync(path.join(root, 'mods/.claude-plugin'), { recursive: true });
    const plugins = [{ name: 'a', source: './mod-a' }, { name: 'mod-b', source: { source: 'github', repo: 'x/y' } }];
    fs.writeFileSync(path.join(root, 'mods/.claude-plugin/marketplace.json'), JSON.stringify({ plugins }));
    expect(buildIndex(root, [], 'HEAD').marketplaceMods).toEqual(['mod-a', 'mod-b']);
    fs.writeFileSync(path.join(root, 'mods/.claude-plugin/marketplace.json'), '{ not json');
    expect(buildIndex(root, [], 'HEAD').marketplaceMods).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mod change leaves the tests of another mod out unless they name the changed path', () => {
  const sources = {
    ...MOD_SOURCES,
    'scripts/sprite-model-router.test.mjs': "const HOOK = path.join(ROOT, 'mods/sprite-model-router/hooks/route.ts');\n",
    'scripts/readme-reader.test.mjs': "read('mods/telegram-ask/README.md');\n",
  };
  const plan = planChecks(['mods/telegram-ask/README.md'], { ...MOD_INDEX, sources });
  expect(modTestFiles(plan)).toEqual(['./scripts/readme-reader.test.mjs', './scripts/telegram-ask.test.mjs']);
});
