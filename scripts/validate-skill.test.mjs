import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  SUBAGENT_CONTRACT_TERMS,
  SNIPPET_CONTRACTS,
  REQUIRED_SNIPPETS,
  TINYFISH_LADDER_NEED,
  BANNED_RUNTIME_SNIPPETS,
  RENDERER_OPEN_AWK,
  RENDERER_CLOSE_AWK,
  findMissingTerms,
  checkSnippetContract,
  checkTinyFishLadder,
  checkBannedRuntime,
  hasStrictMermaidFence,
  extractMermaidBlocksStrict,
} from './validate-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = fs.readFileSync(path.join(ROOT, 'scripts', 'validate-skill.mjs'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'scripts', 'render-diagrams.sh'), 'utf8');
const readSnip = (n) => fs.readFileSync(path.join(ROOT, 'snippets', n), 'utf8');

// --- Gap 2: the review snippet is a first-class contract --------------------

test('every manifest source has a snippet contract entry (no orphan snippets)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'snippets.manifest.json'), 'utf8'));
  const sources = manifest.snippets.map((e) => path.basename(e.source));
  for (const src of sources) {
    assert.ok(
      SNIPPET_CONTRACTS[src],
      `${src} is tracked in snippets.manifest.json but has no entry in SNIPPET_CONTRACTS — it bypasses all content checks`,
    );
  }
});

test('every required snippet is tracked in the manifest (or it never reaches the DB)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'snippets.manifest.json'), 'utf8'));
  const sources = manifest.snippets.map((e) => e.source);
  for (const snip of REQUIRED_SNIPPETS) {
    assert.ok(sources.includes(`snippets/${snip}`), `${snip} has a contract but is not tracked in the manifest`);
  }
});

test('orkestrasi-pr-review.md is under contract', () => {
  assert.ok(REQUIRED_SNIPPETS.includes('orkestrasi-pr-review.md'));
  assert.ok(SNIPPET_CONTRACTS['orkestrasi-pr-review.md'].length > 0);
});

// Ported from PR #2 (2026-10-01-snippet-db-sync), whose other two changes had
// already landed by another path. Without this needle the PR snippet could
// silently drop the "close the plan's issue only after the debt sweep" rule and
// still pass validation — the gap PR #2 was opened to close.
test('orkestrasi-pr.md is held to the issue-close-after-the-sweep sync', () => {
  assert.ok(
    SNIPPET_CONTRACTS['orkestrasi-pr.md'].includes('plan-issue-sync.mjs'),
    'the PR snippet contract must require plan-issue-sync.mjs so the issue-close rule cannot be dropped unnoticed',
  );
});

test('all live snippets pass their contract, ladder, and runtime checks', () => {
  assert.ok(REQUIRED_SNIPPETS.length >= 4, 'expected at least the four trigger snippets');
  for (const [snip, extra] of Object.entries(SNIPPET_CONTRACTS)) {
    const body = readSnip(snip);
    assert.deepEqual(checkSnippetContract(body, extra), [], `${snip} missing contract terms`);
    assert.deepEqual(checkTinyFishLadder(body), [], `${snip} missing TinyFish ladder terms`);
    assert.deepEqual(checkBannedRuntime(body), [], `${snip} uses a prohibited runtime`);
  }
});

test('snippet checks fail when a term is deleted (negative controls)', () => {
  const body = readSnip('orkestrasi-pr-review.md');
  const extra = SNIPPET_CONTRACTS['orkestrasi-pr-review.md'];
  // Remove one shared term and one phase term; each must be reported.
  const withoutShared = body.replaceAll('TASK-CHUNKING', 'XXXXXXXX');
  assert.ok(checkSnippetContract(withoutShared, extra).includes('TASK-CHUNKING'));
  const phaseTerm = extra.find((t) => body.includes(t));
  assert.ok(phaseTerm, 'phase-term list names nothing the snippet contains, so this test proves nothing');
  const withoutPhase = body.replaceAll(phaseTerm, 'YYYYYYYY');
  assert.ok(checkSnippetContract(withoutPhase, extra).includes(phaseTerm));
  // Ladder + runtime negatives.
  assert.ok(checkTinyFishLadder(body.replaceAll('fetch_content', 'ZZZZZZ')).includes('fetch_content'));
  const withBanned = `${body}\nrun: npm test\n`;
  assert.ok(checkBannedRuntime(withBanned).includes('npm test'));
});

// --- Gap 3: validator and renderer agree on what a fence looks like ---------

test('render-diagrams.sh still uses the strict awk fence both sides assume', () => {
  assert.ok(RENDERER.includes('/^```mermaid[ \\t]*$/'), 'renderer open pattern changed — update validate-lib.mjs to match');
  assert.ok(RENDERER.includes('/^```[ \\t]*$/'), 'renderer close pattern changed — update validate-lib.mjs to match');
  assert.equal(RENDERER_OPEN_AWK, '/^```mermaid[ \\t]*$/');
  assert.equal(RENDERER_CLOSE_AWK, '/^```[ \\t]*$/');
});

test('strict extractor mirrors the awk semantics', () => {
  const exact = 'before\n```mermaid\nflowchart TB\n A-->B\n```\nafter';
  assert.deepEqual(extractMermaidBlocksStrict(exact), ['flowchart TB\n A-->B']);
  assert.ok(hasStrictMermaidFence(exact));

  const trailingSpaces = '```mermaid   \nX\n```  \n';
  assert.ok(hasStrictMermaidFence(trailingSpaces));
  assert.deepEqual(extractMermaidBlocksStrict(trailingSpaces), ['X']);

  // A fence the loose /```mermaid/ regex accepted but awk never extracts.
  const withConfig = '```mermaid {config}\nX\n```\n';
  assert.ok(!hasStrictMermaidFence(withConfig), '```mermaid {extra} must not count: the renderer skips it');
  assert.deepEqual(extractMermaidBlocksStrict(withConfig), []);

  // Unclosed block: awk never flushes buf, so neither do we.
  assert.deepEqual(extractMermaidBlocksStrict('```mermaid\nnever closed'), []);
  // Two blocks stay separate.
  const two = '```mermaid\nA\n```\ntext\n```mermaid\nB\n```\n';
  assert.deepEqual(extractMermaidBlocksStrict(two), ['A', 'B']);
});

test('validator uses the strict helpers, not a loose regex', () => {
  assert.match(VALIDATOR, /from '\.\/validate-lib\.mjs'/);
  assert.match(VALIDATOR, /hasStrictMermaidFence/);
  assert.match(VALIDATOR, /extractMermaidBlocksStrict/);
  assert.doesNotMatch(VALIDATOR, /\/```mermaid\[\\s\\S\]/);
  assert.doesNotMatch(VALIDATOR, /blockRe = \/```mermaid/);
});

test('every mermaid-required template passes the strict fence check', () => {
  const templates = [
    'implementation-plan-template.md',
    'spike-report-template.md',
    'systematic-debugging-log-template.md',
    'verification-checklist-template.md',
    'adr-template.md',
    'subagent-contract-template.md',
    'code-review-template.md',
    'follow-up-injection-template.md',
    'pull-request-template.md',
    'pr-review-template.md',
  ];
  for (const tmpl of templates) {
    const content = fs.readFileSync(path.join(ROOT, 'templates', tmpl), 'utf8');
    assert.ok(hasStrictMermaidFence(content), `${tmpl} has no strict fence the renderer would extract`);
    assert.ok(extractMermaidBlocksStrict(content).length > 0, `${tmpl} yields zero strict blocks`);
  }
});

// --- Gap 1: validator logic is pinned without running the minutes-long gate --

test('validator imports contracts from the lib instead of redefining them', () => {
  assert.match(VALIDATOR, /SNIPPET_CONTRACTS as snippetContracts/);
  assert.match(VALIDATOR, /SUBAGENT_CONTRACT_TERMS as subagentContractTerms/);
  assert.match(VALIDATOR, /TINYFISH_LADDER_NEED/);
  assert.match(VALIDATOR, /BANNED_RUNTIME_SNIPPETS/);
  assert.doesNotMatch(VALIDATOR, /const subagentContractTerms = \[/);
  assert.doesNotMatch(VALIDATOR, /const snippetContracts = \{/);
});

test('findMissingTerms is substring-exact and order-stable', () => {
  assert.deepEqual(findMissingTerms('aaa bbb', ['aaa', 'missing']), ['missing']);
  assert.deepEqual(findMissingTerms('', ['x']), ['x']);
});

// --- A skip must stay visible: a gate that proves nothing says so ------------

// The three gitignored machine-local inputs (plans.publish.json,
// plan.issues.json, and node_modules for mmdc) fail in every fresh worktree,
// because no clone has them. They now report as skipped rather than as errors.
// Pinned here on the same source-shape basis as the tests above, because
// running the real gate costs minutes and these are string conditions.

test('a gitignored missing input is reported as a skip, never as an error', () => {
  assert.match(VALIDATOR, /const skip = \(/);
  assert.match(VALIDATOR, /let skipped = 0/);
  // The clean-pass summary must not be reachable while a check was skipped,
  // or the gate reports a pass it never earned.
  assert.match(VALIDATOR, /SKIPPED, so this is NOT a clean pass/);
  assert.match(VALIDATOR, /does NOT prove the skill is correct end to end/);
});

test('every skip names the missing input and the check it did not perform', () => {
  // The wording lives in the shared helper, so it is asserted once there, and
  // the call sites are then required to pass both a subject and a reason.
  assert.match(VALIDATOR, /SKIPPED: \$\{what\} \(did not run\)/);
  const calls = VALIDATOR.match(/^\s*skip\(/gm) || [];
  assert.ok(calls.length >= 3, `expected the three gitignored inputs to skip, found ${calls.length}`);
  // The three reasons are written per input rather than shared, so what is
  // pinned is that each names the absent input and states the consequence.
  for (const input of ['plans.publish.json', 'plan.issues.json', 'mmdc']) {
    assert.match(VALIDATOR, new RegExp(`skip\\([\\s\\S]{0,400}?${input.replace('.', '\\.')}`),
      `the skip for ${input} must name it`);
  }
  assert.match(VALIDATOR, /so its JSON was NOT parsed/);
  assert.match(VALIDATOR, /the entire Mermaid render gate did NOT run/);
});

test('the skip counter is reported in the summary, not just incremented', () => {
  assert.match(VALIDATOR, /skipped/);
  // Counting without printing would reintroduce the silent-skip failure.
  assert.match(VALIDATOR, /check\(s\) were SKIPPED/);
});

// ---------- Behaviour layer for the SKIPPED outcome ----------
//
// WHY THIS EXISTS, and it is a review finding rather than an addition.
//
// The tests above pin the skip mechanism by matching source strings, which is a
// real limitation: they prove the wording and the call sites are present, and
// they prove nothing about what the gate actually does. Measured, on this
// branch: changing one line inside `skip()` from `skipped++` to `errors++`
// flips the real validator from exit 0 to exit 1 on a fresh checkout, and all
// 15 tests in this file still pass. That is the mutation this file exists to
// catch, because the behaviour it changes is the entire point of the SKIPPED
// outcome: absent gitignored machine-local state must not fail a clean clone,
// and must still refuse to call that run clean.
//
// So this test runs the real gate and asserts on the two things that matter at
// once. Both are asserted because either alone is insufficient: exit 0 alone is
// satisfied by deleting the checks outright, and the NOT-a-clean-pass line alone
// is satisfied by printing it and still exiting 1.
//
// COST. Running the validator costs about a second, so it is one test rather
// than a per-case sweep.
//
// IT RUNS IN ITS OWN TREE, not against ROOT. The condition under test is a tree
// MISSING the gitignored machine-local state, and the checkout the suite runs in
// normally HAS all three, so asserting against it measured the wrong tree: the
// gate exited 0 with no SKIPPED line at all, because nothing skipped. Measured
// 2026-10-05 on main, where that test failed with `null !== 0` while the gate
// itself exited 0 in 58s. A test whose fixture does not reproduce the condition
// is worse than no test, because it is green or red for an unrelated reason.
//
// The tree is built by copying the validator and its inputs into a temp
// directory and deleting the three gitignored paths, so the assertion runs
// against the condition rather than against whatever the developer happens to
// have installed. `timeout` is set because the full render gate takes about a
// minute when mermaid IS present, and spawnSync returns status null with a
// signal when it is killed, which reads as a failure of the gate.
// IT RUNS AGAINST A FRESH-CLONE TREE, built from `git ls-files`. The condition
// under test is a tree MISSING the gitignored machine-local state, and the
// checkout the suite runs in normally HAS all three, so asserting against it
// measured the wrong tree: the gate exited 0 with no SKIPPED line at all,
// because nothing skipped. Measured 2026-10-05 on main, where this test failed
// with `null !== 0` while the gate itself exited 0 in 58s. A test whose fixture
// does not reproduce the condition is worse than no test, because it is green
// or red for an unrelated reason.
//
// Copying TRACKED files is what makes the fixture correct by construction: the
// three gitignored paths are absent because `git ls-files` never lists them,
// not because the test remembered to delete them. An earlier attempt copied
// `scripts/` by hand and the gate reported 15 errors instead of 3 skips,
// because the validator also reads the templates, snippets, diagrams and the
// master skill. `timeout` is set because the run takes about a minute and
// spawnSync returns status null when it kills the child, which reads as a
// failure of the gate rather than of the test.
test('a tree missing gitignored state exits 0 and still refuses a clean pass', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-freshclone-'));
  try {
    const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(ls.status, 0, `git ls-files failed: ${ls.stderr}`);
    const files = ls.stdout.split('\0').filter(Boolean);
    assert.ok(files.length > 50, `expected a real tree, listed ${files.length} tracked files`);
    const tar = spawnSync('tar', ['-C', ROOT, '--null', '-T', '-', '-cf', '-'], {
      input: files.join('\0') + '\0', encoding: null, maxBuffer: 256 * 1024 * 1024,
    });
    assert.equal(tar.status, 0, `tar of tracked files failed: ${tar.stderr?.toString().slice(0, 300)}`);
    const untar = spawnSync('tar', ['-C', tmp, '-xf', '-'], { input: tar.stdout, encoding: null });
    assert.equal(untar.status, 0, `untar into the fixture failed: ${untar.stderr?.toString().slice(0, 300)}`);

    // The fixture must genuinely lack the three gitignored inputs, or this test
    // silently degrades into the wrong-tree assertion it replaced.
    for (const absent of ['plans.publish.json', 'plan.issues.json', 'node_modules']) {
      assert.ok(!fs.existsSync(path.join(tmp, absent)), `fixture unexpectedly has ${absent}`);
    }

    const r = spawnSync('bun', [path.join(tmp, 'scripts', 'validate-skill.mjs')], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: 180_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 0,
      `absent gitignored state must not fail the gate; got ${r.status} signal=${r.signal}\n${out.slice(-600)}`);
    assert.match(out, /SKIPPED/,
      'the skip must be reported, not silent');
    assert.match(out, /NOT a clean pass/,
      'exit 0 must not be reported as a clean pass while checks did not run');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
