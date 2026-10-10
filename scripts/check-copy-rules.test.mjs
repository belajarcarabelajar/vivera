import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkText, checkFile, checkDiff, main, EM_DASH, WATERMARK_PATTERNS } from './check-copy-rules.mjs';
import { readSkillCorpus } from './skill-corpus.mjs';

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
  const text = readSkillCorpus(ROOT);
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
// --diff <base>: only what a branch adds. A temp repository stands in for a real
// branch because the module resolves its own ROOT, which is this checkout.

// Hooks and signing are disabled per call so a global git config cannot make the
// fixture depend on this host.
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const TRAILER = ['Co-Authored', 'By: x <x@example.invalid>'].join('-');

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-rules-diff-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  const put = (rel, lines) => fs.writeFileSync(path.join(dir, rel), lines.join('\n') + '\n');
  put('doc.md', ['# Doc', `old line${EM_DASH} at base`, 'plain']);
  put('code.mjs', ['export const a = 1;']);
  put('gone.md', [`deleted${EM_DASH} file`]);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  // Fillers keep the trailer more than three lines from the em dash, so the
  // rule-statement neighbour window cannot exempt either line.
  put('doc.md', ['# Doc', `old line${EM_DASH} at base`, 'plain',
    `new line${EM_DASH} on branch`, 'a', 'b', 'c', 'd', TRAILER]);
  put('code.mjs', ['export const a = 1;', `// a comment${EM_DASH} in code`]);
  fs.rmSync(path.join(dir, 'gone.md'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `feat: branch lines\n\n${TRAILER}`);
  // Uncommitted on top: the working tree counts too.
  fs.appendFileSync(path.join(dir, 'doc.md'), ['e', 'f', 'g', `uncommitted${EM_DASH} line`].join('\n') + '\n');
  return dir;
}

test('--diff reports an em dash the branch adds in a .md file, with its line', () => {
  const r = checkDiff({ base: 'main', cwd: fixtureRepo() });
  const dashes = r.violations.filter((v) => v.rule === 'em-dash').map((v) => v.where);
  assert.deepEqual(dashes.sort(), ['doc.md:13', 'doc.md:4']);
});

test('--diff does not report an em dash that existed at the base', () => {
  const r = checkDiff({ base: 'main', cwd: fixtureRepo() });
  assert.ok(!r.violations.some((v) => v.where === 'doc.md:2'), JSON.stringify(r.violations));
});

test('--diff applies the em dash rule to .md/.txt only', () => {
  const r = checkDiff({ base: 'main', cwd: fixtureRepo() });
  assert.ok(!r.violations.some((v) => v.where.startsWith('code.mjs')), JSON.stringify(r.violations));
});

test('--diff reports an added attribution line in any file', () => {
  const r = checkDiff({ base: 'main', cwd: fixtureRepo() });
  assert.ok(r.violations.some((v) => v.where === 'doc.md:9' && v.rule === 'co-author trailer'),
    JSON.stringify(r.violations));
});

test('--diff checks the commit messages of the branch range', () => {
  const r = checkDiff({ base: 'main', cwd: fixtureRepo() });
  assert.ok(r.violations.some((v) => v.where.startsWith('commit ') && v.rule === 'co-author trailer'),
    JSON.stringify(r.violations));
});

test('--diff scans a new untracked file, but not an ignored one', () => {
  const dir = fixtureRepo();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.md\n');
  fs.writeFileSync(path.join(dir, 'new.md'), ['# New', `fresh${EM_DASH} line`].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'ignored.md'), `ignored${EM_DASH} line\n`);
  const r = checkDiff({ base: 'main', cwd: dir });
  const where = r.violations.map((v) => v.where);
  assert.ok(where.includes('new.md:2'), JSON.stringify(where));
  assert.ok(!where.some((w) => w.startsWith('ignored.md')), JSON.stringify(where));
});

test('--diff returns the scanned counts, skipping deleted files', () => {
  const r = checkDiff({ base: 'main', cwd: fixtureRepo() });
  // doc.md lines 4-13 and code.mjs line 2; gone.md was deleted.
  assert.equal(r.addedLines, 11);
  assert.equal(r.files, 2);
  assert.equal(r.commits, 1);
  assert.match(r.mergeBase, /^[0-9a-f]{40}$/);
});

test('--diff throws a clear error for an unknown base', () => {
  assert.throws(() => checkDiff({ base: 'no-such-ref-for-test', cwd: fixtureRepo() }), /no-such-ref-for-test/);
});

test('--diff without a base is a usage error', () => {
  assert.equal(main(['--diff']), 2);
});

test('the CLI exits 2 for an unknown --diff base', () => {
  const script = path.join(ROOT, 'scripts', 'check-copy-rules.mjs');
  const r = spawnSync(process.execPath, [script, '--diff', 'no-such-ref-for-test'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--diff <base>/);
});
