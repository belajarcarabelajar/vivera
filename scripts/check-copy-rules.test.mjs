import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkText, checkFile, EM_DASH, WATERMARK_PATTERNS } from './check-copy-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The regression these lock.
//
// A `Generated with [Claude Code]` footer was appended to PR #15 in this
// repository on 2026-10-04. The session was not Claude Code. No template in the
// repository instructed adding one, and none of the seven other PRs carried any.
// It was a general impression of what bot-authored PRs look like, published as a
// false claim about authorship in a permanently public artifact.
//
// Both copy rules already existed as prose. The em-dash rule was in the master
// skill and in the PR template checklist, and 69 em dashes rode out in a single
// diff anyway. So the tests below assert three things: the rules are still
// written down, the shipped templates obey them, and the checker actually catches
// the footer it was written for.

test('catches the exact footer that shipped on PR #15', () => {
  const body = [
    '## What this changes',
    '',
    'Three gaps in the pipeline, each closed with a gate.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
  const v = checkText(body, { where: 'pr-body' });
  const rules = v.map((x) => x.rule);
  assert.ok(rules.includes('generated-with footer'), `missed the footer: ${JSON.stringify(v)}`);
  assert.ok(rules.includes('robot emoji used as a credit badge'), `missed the emoji badge: ${JSON.stringify(v)}`);
});

test('catches every attribution shape, not only that one', () => {
  const cases = [
    'Generated with OpenCode',
    'generated with claude code',
    '🤖 Generated with Gemini',
    'Co-Authored-By: someone <a@example.com>',
    'co-authored-by: someone',
    'Signed-off-by: someone <a@example.com>',
  ];
  for (const c of cases) {
    const v = checkText(c, { where: 'x' });
    assert.ok(v.length > 0, `not caught: ${JSON.stringify(c)}`);
  }
});

test('does NOT flag a legitimate mention of a tool name', () => {
  // Found by running the first version of this checker, which matched bare vendor
  // names and failed on README's harness table listing Claude Code and Copilot as
  // supported harnesses, plus a mermaid node reading `🤖 Subagents execute`.
  // A gate that flags those is a gate people learn to ignore.
  const legitimate = [
    '| Claude Code | `~/.claude/skills/super-ultra-code-plan/` | Conditional |',
    '| Copilot | not wired | - |',
    'In OpenCode that tool is `todowrite`; in Claude Code it is `TodoWrite`.',
    '    SubWork["🤖 Subagents execute\\nin isolated workspaces"]',
    'Gemini uses `update_plan` for the same list.',
  ];
  for (const c of legitimate) {
    const v = checkText(c, { where: 'x' });
    assert.deepEqual(v.map((x) => x.rule), [], `false positive on ${JSON.stringify(c)}: ${JSON.stringify(v)}`);
  }
});

test('a line stating the rule is not a violation of the rule', () => {
  // The checklist item that documents the footer rule quotes the footer back at
  // the reader. A checker that fails on it forces the documentation to be deleted.
  const wrapped = [
    '- [ ] No attribution footer, watermark, badge, or co-author line anywhere in the',
    '      body or the commits: no `Generated with <tool>`, no `🤖`, no `Co-Authored-By`.',
  ].join('\n');
  assert.deepEqual(checkText(wrapped, { where: 't' }).map((x) => x.rule), []);
});

test('the lookback is short enough not to swallow a real violation', () => {
  // The exemption window is two lines either side. A violation well clear of a rule
  // statement is still a violation, or the exemption is a hole. Found by running
  // this: the first window looked BACK only, and flagged the README section that
  // documents this very rule, because the worked example sits a line or two AFTER
  // the sentence introducing it.
  const far = [
    '- [ ] No attribution footer or watermark anywhere in the body.',
    'unrelated line one',
    'unrelated line two',
    'unrelated line three',
    'unrelated line four',
    '🤖 Generated with Claude Code',
  ].join('\n');
  const v = checkText(far, { where: 't' });
  assert.ok(v.length > 0, 'a violation far from the rule statement must still be caught');
});

test('the README section documenting this rule does not flag itself', () => {
  // The real file, not a fixture. A rule document that cannot pass its own checker
  // is a rule document whose example gets deleted instead.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const attributionHits = checkText(readme, { where: 'README.md', emDashApplies: false });
  assert.deepEqual(attributionHits.map((v) => `${v.where} ${v.rule}`), [],
    'the copy-rules section of README quotes the footer it forbids and must be exempt');
});

test('catches the em dash in shipped copy', () => {
  assert.equal(checkText(`a sentence${EM_DASH} here`, { where: 'x' })[0]?.rule, 'em-dash');
  assert.deepEqual(checkText('a sentence - here', { where: 'x' }), []);
});

test('the master skill still states both rules', () => {
  // The half that costs nothing: a rule nobody can find is not a rule.
  const text = fs.readFileSync(path.join(ROOT, 'Super Ultra Code Plan Implementation.md'), 'utf8');
  assert.match(text, /never use em dashes/i);
  assert.match(text, /No Attribution Footer, Watermark, or Co-Author Line/i);
});

test('the PR template still carries the checklist item', () => {
  // The PR template is what an agent reads at PR time, so a rule missing from it
  // is missing exactly where it gets used.
  const text = fs.readFileSync(path.join(ROOT, 'templates', 'pull-request-template.md'), 'utf8');
  assert.match(text, /attribution footer, watermark, badge, or co-author line/i);
});

test('the PR-facing templates obey the rules today', () => {
  for (const rel of [
    'templates/pull-request-template.md',
    'templates/pr-review-template.md',
    'templates/code-review-template.md',
  ]) {
    assert.deepEqual(checkFile(rel).map((v) => `${v.where} ${v.rule}`), [], `${rel} has a copy-rule violation`);
  }
});

test('a missing file is a violation, not a silent pass', () => {
  const v = checkFile('templates/does-not-exist.md');
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'missing-file');
});

test('every watermark pattern names itself, so a hit is actionable', () => {
  assert.ok(WATERMARK_PATTERNS.every((p) => typeof p.label === 'string' && p.label.length > 0));
  // The vendor-name shapes are gone on purpose; a pattern that cannot be stated
  // as an attribution SHAPE belongs in a human's eyes, not in a false alarm.
  const sources = WATERMARK_PATTERNS.map((p) => p.re.source).join(' ');
  assert.doesNotMatch(sources, /cursor|gemini|copilot|chatgpt/i,
    'no bare vendor-name pattern: README legitimately names these tools');
});