// scripts/frontmatter-strict.test.mjs
//
// The runner's own parser (`parseUltraPlanYaml`) is a lenient YAML subset, so a
// plan can pass every runner check and still not be YAML. Obsidian reads the
// frontmatter with a real parser; on failure it shows the block as raw red text
// instead of Properties. These guards pin the strict check that closes that gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strictYamlError } from './frontmatter-strict.mjs';

const OK = 'schema: ultra-plan/v1\nplan_id: x\ntasks:\n  - id: T1\n    files: { create: [a/b.ts], modify: [], test: [] }\n';

test('valid frontmatter yields no error', () => {
  assert.equal(strictYamlError(OK), null);
});

test('an unquoted [token].astro path inside a flow list is rejected', () => {
  const bad = 'tasks:\n  - id: T1\n    files: { modify: [apps/web/src/pages/csat/[token].astro], test: [] }\n';
  const msg = strictYamlError(bad);
  assert.ok(msg, 'must report an error');
  assert.match(msg, /line 3/);
  assert.match(msg, /quote/i);
});

test('the same path in double quotes is accepted', () => {
  const good = 'tasks:\n  - id: T1\n    files: { modify: ["apps/web/src/pages/csat/[token].astro"], test: [] }\n';
  assert.equal(strictYamlError(good), null);
});

test('nested double quotes and invalid escapes are rejected', () => {
  assert.ok(strictYamlError('skip_if: "tgrep -q \'href="/pricing"\' a.astro"\n'));
  assert.ok(strictYamlError('skip_if: "node v.mjs --nsi C:\\BuildTemp\\x64"\n'));
});

test('empty or missing frontmatter is not this check\'s concern', () => {
  assert.equal(strictYamlError(''), null);
});
