import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseAlternatives, buildCorpus, crossPairs, classBalance, harvest,
  normalizeBody, stableId, MIN_BODY, LABELS,
} from './spike-alt-corpus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'spike-alt-corpus.mjs');

// The real-corpus tests below harvest the workspace through plans.publish.json,
// which enumerates the sibling projects by absolute path. On a clone that cannot
// see those projects (a CI runner, a VPS) the registry yields no sets: the
// measured-harvest test would fail on `sets.length !== 2`, and the loops over an
// empty harvest would pass vacuously. Both are wrong, so the tests that assert
// on the real corpus skip with the reason instead of manufacturing confidence.
//
// plans.publish.json is itself machine-local, gitignored config (see
// .gitignore): a fresh clone does not carry it, and `harvest()` would throw
// `missing plan publish config` at module load before a single test ran. The
// module-level harvest is therefore guarded on its existence, and the tests
// that need the registry skip with a reason that says which case is which.
// The recorded measurement is tied to two specific plans (the clipboard
// profanity filter and the release-pinning follow-up), so `liveRecorded` is
// narrower than `liveCorpus`: it runs only where both are actually harvested,
// which is the premise the recorded numbers were produced under.
const REGISTRY_PATH = process.env.PLAN_PUBLISH_CONFIG || path.join(ROOT, 'plans.publish.json');
const REGISTRY_PRESENT = fs.existsSync(REGISTRY_PATH);
const REGISTRY_ABSENT_SKIP =
  'plans.publish.json is absent: it is gitignored, machine-local publish-routing config (see .gitignore) naming this machine\'s project checkouts, so a fresh clone does not carry it; '
  + 'copy plans.publish.example.json to plans.publish.json and register this checkout to run this test';
const NO_HARVEST_SKIP =
  'plans.publish.json loaded, but none of the project roots it names is visible from this host (they are machine-local absolute paths), so harvest() found no plans to assert on';
const liveSkip = REGISTRY_PRESENT ? NO_HARVEST_SKIP : REGISTRY_ABSENT_SKIP;
const harvestedSets = REGISTRY_PRESENT ? harvest() : [];
const hasRealCorpus = harvestedSets.length > 0;
const hasRecordedCorpus =
  harvestedSets.length === 2 &&
  harvestedSets.some((s) => s.key === 'profanity') &&
  harvestedSets.some((s) => s.key === 'pinning');
const liveCorpus = hasRealCorpus ? test : (name, fn) => test(name, { skip: liveSkip }, fn);
const liveRecorded = hasRecordedCorpus ? test : (name, fn) => test(name, { skip: liveSkip }, fn);

test('an alternative is found through every markdown wrapper a plan uses', () => {
  const md = [
    '### Trade-offs',
    '',
    '- **Option A (recommended):** restore `scripts/coverage/assert-thresholds.mjs` so the gate works again.',
    '* Approach B: remove the `assert-thresholds` reference from `package.json:17` and the assertion.',
    '| Alternative C | ship a local model instead, which is slower and adds a privacy cost |',
    '**Option D.** a bare label with no body at all',
  ].join('\n');
  const got = parseAlternatives(md);
  assert.deepEqual(got.map((a) => a.id), ['A', 'B', 'C'],
    'D carries no body so it is a heading, not an alternative');
  assert.match(got[0].body, /restore/, 'the (recommended): tail must not eat the body');
  assert.doesNotMatch(got[0].body, /\(recommended\)/, 'the label tail is stripped, not left in the text');
  assert.match(got[2].body, /local model/);
});

test('a bare label is not an alternative', () => {
  // The whole point of MIN_BODY: `Option A:` on its own line is a heading, and
  // counting it would inflate every set with rows that carry no proposal.
  assert.deepEqual(parseAlternatives('**Option A.**'), []);
  assert.equal(MIN_BODY, 40, 'the threshold is a constant so a fixture cannot quietly reshape it');
});

test('a glossary or appendix is not an alternatives section, however it is worded', () => {
  const md = [
    '### Options',
    '- Option A: a real alternative that clears the minimum body length threshold easily.',
    '### Glossary',
    '- Option A: a glossary entry that happens to use the word Option and should be skipped.',
  ].join('\n');
  const got = parseAlternatives(md);
  assert.equal(got.length, 1, 'the glossary entry is excluded');
  assert.match(got[0].body, /real alternative/);
});

test('normalizeBody collapses whitespace so a re-wrapped paragraph is the same row', () => {
  assert.equal(normalizeBody('  a\n\n  b   c '), 'a b c');
});

liveCorpus('the corpus is byte-identical on a re-run, which is what makes skip_if mean anything', () => {
  const sets = harvest();
  const a = JSON.stringify(buildCorpus(sets));
  const b = JSON.stringify(buildCorpus(harvest()));
  assert.equal(a, b);
  // And a reversed input order does not change it, because rows sort by id.
  const reversed = [...sets].reverse().map((s) => ({ ...s, alts: [...s.alts].reverse() }));
  assert.equal(JSON.stringify(buildCorpus(reversed)), a);
});

liveCorpus('every row carries both texts verbatim and a provenance string', () => {
  for (const row of buildCorpus(harvest())) {
    assert.ok(row.a.length >= MIN_BODY, `row ${row.id} lost its first text`);
    assert.ok(row.b.length >= MIN_BODY, `row ${row.id} lost its second text`);
    assert.ok(row.sourceA.includes('#'), 'a row must name the file and the letter it came from');
    assert.ok(row.sourceB.includes('#'));
    assert.ok(row.rationale.length > 10, 'an adjudication without a reason is a guess');
    assert.ok(LABELS.includes(row.label), `unexpected label ${row.label}`);
  }
});

test('a pair with no adjudication is kept but unlabelled, never guessed', () => {
  // The load-bearing property: an unadjudicated row stays visible and is
  // excluded from the score. Defaulting it to a label would be inventing
  // ground truth, which is the defect that killed spike v1.
  const sets = [{
    key: 'k', plan: '/tmp/nowhere.md', project: 'p', sectionHeading: false,
    alts: [{ id: 'A', body: 'x'.repeat(60) }, { id: 'B', body: 'y'.repeat(60) }],
  }];
  const rows = buildCorpus(sets);
  assert.equal(rows[0].label, null, 'no adjudication means no label');
  assert.equal(rows[0].rationale, 'no adjudication recorded');
  const bal = classBalance(rows);
  assert.equal(bal.unlabelled, 1, 'it is counted as unlabelled, not as distinct');
  assert.equal(bal.distinct, 0);
});

test('synthetic rows are excluded from every count and can never pad the minority class', () => {
  const rows = [
    { label: 'distinct', synthetic: false, crossSet: false },
    { label: 'near-duplicate', synthetic: false, crossSet: false },
    { label: 'near-duplicate', synthetic: true, crossSet: false },
    { label: 'near-duplicate', synthetic: false, crossSet: true },
  ];
  const bal = classBalance(rows, [{ label: 'distinct' }, { label: 'distinct' }]);
  assert.equal(bal.nearDuplicate, 1, 'only the harvested within-set pair counts');
  assert.equal(bal.synthetic, 1);
  assert.equal(bal.crossSet, 2);
  assert.equal(bal.total, 2);
  assert.equal(bal.degenerate, false);
});

test('the balance check refuses an empty minority class', () => {
  // THE refusal this whole file exists to make. Without a near-duplicate class,
  // every ECE bin has a constant outcome and any agreement number is the class
  // prior: a model answering `distinct` to everything scores 1.00.
  const bal = classBalance([{ label: 'distinct', synthetic: false, crossSet: false }], []);
  assert.equal(bal.degenerate, true);
  assert.equal(bal.nearDuplicate, 0);
  assert.equal(bal.distinct, 1);
});

test('cross-set pairs are never folded into the scored total', () => {
  const sets = [
    { key: 'a', plan: '/x.md', project: 'p', sectionHeading: false, alts: [{ id: 'A', body: 'x'.repeat(60) }, { id: 'B', body: 'y'.repeat(60) }] },
    { key: 'b', plan: '/y.md', project: 'p', sectionHeading: false, alts: [{ id: 'A', body: 'z'.repeat(60) }, { id: 'B', body: 'w'.repeat(60) }] },
  ];
  const bal = classBalance(buildCorpus(sets), crossPairs(sets));
  assert.equal(bal.total, 2, '2 within-set pairs, not 8');
  assert.equal(bal.crossSet, 4);
});

test(
  'the CLI exits non-zero and writes nothing on a degenerate corpus',
  {
    // The CLI reads plans.publish.json (gitignored, machine-local config; see
    // .gitignore) before it can reach the balance refusal, and without it dies
    // on `missing plan publish config` with the wrong stderr. Skip with the
    // reason; with the registry present the refusal path is exercised as is.
    skip: REGISTRY_PRESENT ? false : REGISTRY_ABSENT_SKIP,
  },
  () => {
    // The refusal must be a refusal, not a warning. A balance check that only
    // ever passes is not a check, and a file written on the degenerate branch is
    // a file a later reader will score.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-corpus-'));
    const out = path.join(tmp, 'alt-corpus.json');
    let status = 0;
    let stderr = '';
    try {
      execFileSync('bun', [CLI, '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      status = e.status;
      stderr = String(e.stderr ?? '');
    }
    assert.equal(status, 1, 'a degenerate corpus must exit 1');
    assert.match(stderr, /E_PRECOND_IMBALANCE/);
    assert.match(stderr, /near-duplicate 0/);
    assert.equal(fs.existsSync(out), false, 'nothing may be written on the degenerate branch');
    fs.rmSync(tmp, { recursive: true, force: true });
  },
);

test('the balance check would exit zero on a populated corpus', () => {
  // The other direction, and the one that matters: a check that refuses
  // everything is indistinguishable from one that refuses correctly.
  const rows = [
    { label: 'near-duplicate', synthetic: false, crossSet: false },
    { label: 'distinct', synthetic: false, crossSet: false },
  ];
  assert.equal(classBalance(rows).degenerate, false);
  assert.equal(classBalance(rows).nearDuplicate, 1);
});

liveRecorded('the measured harvest matches what the plan recorded', () => {
  // Plan §2, reproduced. If these move, the plan's premise has changed and the
  // spike needs re-reading before anything else runs.
  const sets = harvest();
  assert.equal(sets.length, 2, 'two plans carry >= 2 real alternative bodies');
  const corpus = buildCorpus(sets);
  const cross = crossPairs(sets);
  const bal = classBalance(corpus, cross);
  assert.equal(bal.total, 4, '3 pairs from the 3-alternative set, 1 from the 2-alternative set');
  assert.equal(bal.nearDuplicate, 0, 'the finding: the minority class is empty');
  assert.equal(bal.distinct, 4);
  assert.equal(bal.crossSet, 6);
  assert.equal(bal.synthetic, 0);
  assert.equal(bal.degenerate, true);
});

liveCorpus('no row in the real corpus is synthetic — nothing here was paraphrased to make a class', () => {
  for (const row of buildCorpus(harvest())) {
    assert.equal(row.synthetic, false, 'a paraphrased restatement would be synthetic and excluded');
  }
});

test('stableId is deterministic and content-addressed', () => {
  assert.equal(stableId('a'), stableId('a'));
  assert.notEqual(stableId('a'), stableId('b'));
  assert.match(stableId('a'), /^[0-9a-f]{12}$/);
});