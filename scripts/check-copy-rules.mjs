#!/usr/bin/env bun
// scripts/check-copy-rules.mjs
//
// Two copy rules that are otherwise invisible to every existing gate, because
// both are things a reviewer reads rather than something a test executes:
//
//   1. No em dash (U+2014) in user-visible copy.
//   2. No attribution footer, watermark, badge, or co-author line.
//
// WHY THIS EXISTS, measured.
//
// The em-dash rule already existed as prose in the master skill and as a
// checklist item in templates/pull-request-template.md, and it still shipped.
// The `impacts` frontmatter separator was written as `"<surface> — <evidence>"`,
// which meant every validation message that taught the format printed an em dash
// into a terminal. Found only because a parent diff audit counted occurrences:
// 69 in one diff. That audit was a human reading carefully, on a good day.
//
// Then on 2026-10-04 a `Generated with [Claude Code]` footer was appended to PR
// #15 in this repository, in a session that was not Claude Code, with no support
// in any template, no instruction in any template, and no precedent in the seven
// other PRs of this repo. It published a false authorship claim into a
// permanently public artifact. A rule that only exists in prose cannot stop that,
// which is the entire reason this file exists.
//
// WHAT IS AND IS NOT CHECKED.
//
// Checked: the session's commit messages, and any file passed on the command
// line (typically the PR body, or a changed user-visible doc).
//
// NOT checked: every line of the codebase. The master skill legitimately contains
// em dashes inside code comments and inside this very rule's quoted examples, and
// a scan that flagged those would train people to ignore the scan. Pass the
// files that are ARTIFACTS.
//
// The watermark patterns are matched case-insensitively against the whole line,
// and each carries the exact phrase so a hit names itself. `Signed-off-by` is
// included because a git trailer is an authorship claim in exactly the same
// sense, and nobody asked for one.
//
// Usage:
//   bun scripts/check-copy-rules.mjs <file>...       # check artifacts
//   bun scripts/check-copy-rules.mjs --commits [N]   # last N commit messages
//   bun scripts/check-copy-rules.mjs --both <file>... # both
//
// Exit: 0 clean, 1 violations found, 2 usage error.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EM_DASH = '\u2014';

// Each entry names the rule it enforces and prints the phrase that matched, so a
// hit tells the reader what to remove without them re-deriving the rule.
// ATTRIBUTION POSITION ONLY.
//
// The first draft of this list also matched a bare vendor name (`claude code`,
// `cursor`, `gemini`, `copilot`, `gpt-N`). That was wrong, and the validator
// proved it within one run: README.md's harness table lists `Claude Code` and
// `Copilot` as supported harnesses, and the mermaid lifecycle diagram carries a
// `🤖 Subagents execute` node. Both are legitimate. A pattern broad enough to
// catch those is broad enough to be ignored, and a gate people ignore is worse
// than no gate because it reports success while checking nothing.
//
// So the patterns below match the SHAPE of an attribution line, not the names.
// `Generated with X` is an attribution whatever X is, and a bare tool name is
// not.
export const WATERMARK_PATTERNS = [
  { re: /generated with\b/i, label: 'generated-with footer' },
  // The `u` flag is load-bearing and was missing on the first attempt, which made
  // this pattern silently incapable of matching anything: without `u`,
  // `\u{1F916}` is an identity escape for the literal text `u{1F916}`. The test
  // suite caught it because it asserts against the real footer string rather than
  // against a pattern that merely looks right.
  { re: /^\s*\u{1F916}\s+\S/u, label: 'robot emoji used as a credit badge' },
  { re: /^\s*co-authored-by\s*:/im, label: 'co-author trailer' },
  { re: /^\s*signed-off-by\s*:/im, label: 'sign-off trailer' },
  { re: /^\s*(?:co-authored-by|signed-off-by)\s*\[/im, label: 'trailer in link form' },
];

/**
 * A line that STATES the rule is not a violation of it.
 *
 * Found by running this twice. The first version flagged
 * `templates/pull-request-template.md:107`, which is the checklist item quoting
 * `Generated with <tool>` back at the reader. A checker that fails on the
 * sentence describing what it forbids cannot ship that sentence, and the fix
 * would be to stop documenting the rule, which is worse than the false positive.
 *
 * The second attempt exempted only the line carrying the rule's vocabulary, and
 * still failed, because a markdown checklist item WRAPS: the words "attribution
 * footer, watermark, badge" sit on line 106 while the quoted trigger sits on line
 * 107. So the exemption looks BACK a short window rather than at one line.
 *
 * Two lines is the window, chosen from the wrap width this repository actually
 * uses (about 80 columns). Wider would start exempting real violations that
 * happen to sit under a rule statement.
 */
// Stemmed deliberately. The first version matched only the exact phrase
// `attribution footer`, and running it against README's copy-rules section
// flagged two lines: the vocabulary sat three lines away, and a neighbouring
// sentence said "Those are not attributions", which the exact phrase missed. A
// rule document discusses its own subject with pronouns and plurals, so the
// exemption has to recognise the stem. Widening the VOCABULARY is safe here;
// widening the WINDOW is what would open a hole, and the test below guards it.
// Stemmed deliberately, and the window deliberately EXCLUDES the current line.
//
// Found by running this. Two defects at once:
//
//   1. `co-authored-by: someone <a@example.com>` stopped being caught, because the
//      line contains the word "Co-Authored-By" and the widened vocabulary matched
//      it as a rule statement. The trigger phrase was exempting itself, which is
//      the worst possible failure for a gate: it reports clean on exactly the line
//      it exists to catch. The fix is to test the NEIGHBOURS, never the current
//      line, so a line is judged on its own content and only its surroundings can
//      grant an exemption.
//
//   2. README's own copy-rules table states "No attribution footer" three lines
//      above the example, outside a two-line window. Three is the width, chosen
//      from the paragraph shape this repository writes in. The hole is guarded by
//      the test below, which places a violation five lines clear of a rule
//      statement and requires it still be caught.
const RULE_STATEMENT = /attribution|watermark|co-?author|never use em dashes|no em dash|credit badge|sign-?off trailer|generated-with footer/i;
const RULE_LOOKBACK = 3;

/** Off by default: a file path pattern is a guess about which files are artifacts. */
const ARTIFACT_EXTENSIONS = new Set(['.md', '.txt']);

/**
 * Check one artifact's text. Returns violations as objects so a caller can render
 * them however it likes; the CLI does the rendering.
 */
export function checkText(text, { where, emDashApplies = true } = {}) {
  const violations = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    const at = `${where}:${i + 1}`;
    // Look FORWARD as well as back, and never include the current line.
  // See the note on RULE_STATEMENT for both decisions and the defect each fixes.
  const neighbours = [
    ...lines.slice(Math.max(0, i - RULE_LOOKBACK), i),
    ...lines.slice(i + 1, i + RULE_LOOKBACK + 1),
  ].join(' ');
  if (RULE_STATEMENT.test(neighbours)) return;
    if (emDashApplies && line.includes(EM_DASH)) {
      violations.push({ where: at, rule: 'em-dash', detail: EM_DASH, line: line.trim().slice(0, 120) });
    }
    for (const p of WATERMARK_PATTERNS) {
      if (p.re.test(line)) {
        violations.push({ where: at, rule: p.label, detail: p.re.source, line: line.trim().slice(0, 120) });
      }
    }
  });
  return violations;
}

/** Check a file on disk. A missing file is a violation, not a silent skip. */
export function checkFile(rel) {
  const abs = path.resolve(ROOT, rel);
  if (!fs.existsSync(abs)) {
    return [{ where: rel, rule: 'missing-file', detail: 'file not found', line: '' }];
  }
  return checkText(fs.readFileSync(abs, 'utf8'), { where: rel });
}

/**
 * Check commit messages, because an attribution trailer rides along there too and
 * `git log` is where a reviewer looks first.
 */
export function checkCommits(count = 20) {
  // The record separator is a literal NUL (%x00), so a multi-line commit message
  // cannot be confused with the next record. Built by concatenation because the
  // format string ends in a backtick, which would close a template literal.
  const format = '%H%x00%B%x00' + '%x00';
  const r = spawnSync('git', ['log', `-${count}`, `--format=${format}`], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    return [{ where: 'git log', rule: 'git-failed', detail: r.error ? r.error.message : String(r.status), line: '' }];
  }
  const violations = [];
  // `%H%x00%B%x00%x00` per commit, so splitting on NUL and dropping the empties
  // leaves hash/body pairs. Reading them as PAIRS is the whole fix: an earlier
  // version treated each chunk as a single "hash and body" string and sliced 41
  // characters off the front of it, which ate the first character of every body
  // and made a real violation look like it sat beside unrelated text. The commit
  // subject "feat: forbid invented attribution footers" lost its leading `f`, so
  // the rule vocabulary it carried stopped qualifying the line below it and the
  // footer example underneath was reported as a violation of a rule that was
  // never near it.
  const chunks = r.stdout.split('\u0000').filter((t) => t.trim() !== '');
  for (let i = 0; i < chunks.length; i += 2) {
    const hash = chunks[i].trim();
    const message = chunks[i + 1] ?? '';
    // The em dash rule targets USER-VISIBLE copy. A commit message is one, and a
    // subject line is read first by every reviewer, so both are checked in full.
    violations.push(...checkText(message, { where: `commit ${hash.slice(0, 8)}` }));
  }
  return violations;
}

function main(args) {
  // `args` arrives already sliced by the caller. Do not slice again: an earlier
  // version did, so every invocation reported a usage error while the tests, which
  // call the exported functions directly, passed throughout. The CLI was dead and
  // the suite was green.
  const wantCommits = args.includes('--commits') || args.includes('--both');
  // Everything that is not a flag, EXCEPT the count that follows `--commits`.
  // Without that exclusion `--commits 1` treated the literal "1" as a filename and
  // reported `missing-file` for it, which is a wrong answer rather than a usage
  // message and reads as though the repository has a missing template.
  const flags = new Set(['--commits', '--both']);
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) {
      if (a === '--commits' && /^\d+$/.test(args[i + 1] ?? '')) i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    files.push(a);
  }
  const count = (() => {
    const i = args.indexOf('--commits');
    if (i === -1) return 20;
    const n = Number.parseInt(args[i + 1], 10);
    return Number.isInteger(n) && n > 0 ? n : 20;
  })();

  if (!wantCommits && files.length === 0) {
    console.error('usage: check-copy-rules.mjs <file>... | --commits [N] | --both <file>...');
    return 2;
  }

  const violations = [];
  for (const f of files) {
    const ext = path.extname(f);
    if (ext && !ARTIFACT_EXTENSIONS.has(ext)) {
      console.warn(`  note: ${f} is not a .md/.txt artifact; checked anyway, but the em-dash rule targets prose`);
    }
    violations.push(...checkFile(f));
  }
  if (wantCommits) violations.push(...checkCommits(count));

  if (violations.length === 0) {
    console.log(`✅ Copy rules clean: ${files.length} file(s)` + (wantCommits ? ` and the last ${count} commit message(s)` : '') + '.');
    return 0;
  }
  console.error(`❌ ${violations.length} copy-rule violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.where}  [${v.rule}]${v.detail ? ` ${v.detail}` : ''}`);
    if (v.line) console.error(`      ${v.line}`);
  }
  console.error('\n   Both rules are in the master skill copy section and the PR template checklist.');
  console.error('   An attribution line is only correct when the user named the exact text.');
  return 1;
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-copy-rules.mjs');
if (isMain) process.exit(main(process.argv.slice(2)));

// REVERT: delete this file, drop the `checkCopyRules` call from validate-skill.mjs,
// and drop `copy-rules` from package.json scripts. Nothing else imports it.