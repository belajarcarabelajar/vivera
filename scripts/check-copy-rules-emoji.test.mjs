// Rule 3 of check-copy-rules.mjs: no decorative emoji in artifacts. Split from
// check-copy-rules.test.mjs to keep both files under the size gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkText } from './check-copy-rules.mjs';
import { EMOJI_RE } from './lib/copy-rule-patterns.mjs';

test('catches a decorative emoji, allows the status marks and plain symbols', () => {
  assert.deepEqual(checkText('Ship it \u{1F680} now', { where: 'x' }).map((v) => `${v.rule} ${v.detail}`), ['emoji \u{1F680}']);
  assert.deepEqual(checkText('Pause \u23F8\uFE0F here', { where: 'x' }).map((v) => v.rule), ['emoji']);
  assert.deepEqual(checkText('\u2705 pass, \u274C fail, \u26A0\uFE0F warn', { where: 'x' }), []);
  assert.deepEqual(checkText('a \u2192 b, \u2713 done, \u00A9 2026', { where: 'x' }), []);
});

test('a script file keeps its progress emoji', () => {
  assert.deepEqual(checkText('console.log("\u23ED\uFE0F  SKIPPED")', { where: 'x.mjs', emDashApplies: false }), []);
});

test('a rule statement may quote the emoji it forbids', () => {
  assert.deepEqual(checkText('No decorative emoji, for example:\n\u{1F389} party', { where: 'x' }), []);
});

test('EMOJI_RE is global, so a line with two emoji reports both', () => {
  assert.ok(EMOJI_RE.flags.includes('g'));
  assert.equal(checkText('\u{1F680} and \u{1F4A1}', { where: 'x' })[0]?.detail, '\u{1F680} \u{1F4A1}');
});
