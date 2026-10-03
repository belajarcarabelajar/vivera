import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { summarize, verdictFor, PRICE_PER_MTOK } from './spike-skipif-probe.mjs';
import { classifySpikeSkipIf } from './spike-skipif-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The cassette files are machine-local, untracked state: `spike-out/` holds the
// corpus and the scored artefact the probe recorded on the machine that ran the
// spike, and .gitignore keeps the directory out of the tree, so a fresh clone
// carries neither file. The tests below that read them from disk would die
// there with ENOENT, so each one gates on the file it actually reads and skips
// with a reason that says what is missing and why. On a machine that HAS the
// cassette nothing changes: every assertion still runs.
const CORPUS_FILE = path.join(ROOT, 'spike-out', 'corpus.json');
const SCORED_FILE = path.join(ROOT, 'spike-out', 'two-class.json');
const corpusPresent = fs.existsSync(CORPUS_FILE);
const scoredPresent = fs.existsSync(SCORED_FILE);
const cassetteSkipReason = (missing) =>
  `${missing} is absent: spike-out/ is gitignored, machine-local spike output (see .gitignore), so a fresh clone does not carry it; `
  + 're-record the cassette with scripts/spike-skipif-corpus.mjs and scripts/spike-skipif-probe.mjs to run this test';
const withCorpus = corpusPresent ? test : (name, fn) => test(name, { skip: cassetteSkipReason('spike-out/corpus.json') }, fn);
const withCassette =
  corpusPresent && scoredPresent
    ? test
    : (name, fn) => test(name, { skip: cassetteSkipReason('spike-out/corpus.json and spike-out/two-class.json') }, fn);

test('summarize scores a corpus against the frozen classifier snapshot', () => {
  const corpus = [
    { id: 'a', cmd: 'bun test x.test.mjs', label: 'behavioural' },
    { id: 'b', cmd: "grep -q 'M' f.md", label: 'loose' },
    { id: 'c', cmd: 'test -f f.md', label: 'loose' },
  ];
  // Two agree, one disagrees: Jev calls `test -f f.md` behavioural.
  const results = [
    { id: 'a', verdict: { predicted: 'behavioural', correct: true, p: 0.9 } },
    { id: 'b', verdict: { predicted: 'loose', correct: true, p: 0.8 } },
    { id: 'c', verdict: { predicted: 'behavioural', correct: false, p: 0.6 } },
  ];
  const s = summarize(corpus, results);
  assert.equal(s.total, 3);
  assert.equal(s.agree, 2);
  assert.ok(Math.abs(s.agreement - 2 / 3) < 1e-9);
  assert.equal(s.confusion.trueLoosePredBehavioural, 1);
  assert.equal(s.confusion.agree, 2);
  assert.equal(s.disagreements.length, 1);
  assert.equal(s.disagreements[0].id, 'c');
  // The disagreement must carry enough for T5 to adjudicate it without re-running.
  assert.equal(s.disagreements[0].cmd, 'test -f f.md');
  assert.equal(s.disagreements[0].reference, 'loose');
  assert.equal(s.disagreements[0].predicted, 'behavioural');
});

test('summarize refuses a result whose id is not in the corpus', () => {
  // A silently dropped or renamed row would inflate the agreement rate by
  // shrinking the denominator, which is exactly the failure this metric exists
  // to detect.
  assert.throws(
    () => summarize([{ id: 'a', cmd: 'bun test x', label: 'behavioural' }], [{ id: 'zzz', verdict: { predicted: 'loose', correct: true, p: 1 } }]),
    /no corpus row/,
  );
});

test('summarize recomputes cost from the API-reported token usage', () => {
  const corpus = [
    { id: 'a', cmd: 'bun test x', label: 'behavioural' },
    { id: 'b', cmd: "grep -q 'M' f", label: 'loose' },
  ];
  const results = [
    { id: 'a', verdict: { predicted: 'behavioural', correct: true, p: 1 }, usage: { input_tokens: 1_000_000 } },
    { id: 'b', verdict: { predicted: 'loose', correct: true, p: 1 }, usage: { input_tokens: 1_000_000 } },
  ];
  const s = summarize(corpus, results, { latency: [100, 200] });
  // Two million input tokens at $0.042 per million is $0.084.
  assert.ok(Math.abs(s.cost.recomputedUsd - 0.084) < 1e-9, `got ${s.cost.recomputedUsd}`);
  assert.equal(s.cost.apiReportedInputTokens, 2_000_000);
  assert.equal(s.latency.meanMs, 150);
  assert.equal(s.latency.p95Ms, 200);
  assert.equal(PRICE_PER_MTOK, 0.042);
});

test('summarize reports the price it used so a price change is visible', () => {
  const s = summarize(
    [
      { id: 'a', cmd: 'bun test x', label: 'behavioural' },
      { id: 'b', cmd: "grep -q 'M' f", label: 'loose' },
    ],
    [
      { id: 'a', verdict: { predicted: 'behavioural', correct: true, p: 1 }, usage: { input_tokens: 100 } },
      { id: 'b', verdict: { predicted: 'loose', correct: true, p: 1 }, usage: { input_tokens: 100 } },
    ],
  );
  assert.equal(s.cost.pricePerMtokUsd, PRICE_PER_MTOK);
  assert.match(s.cost.basis, /vendor/i, 'the price is a published figure, not a measured one');
});

test('verdictFor applies the plan gate exactly as written', () => {
  const ok = { total: 200, agreement: 0.86, ece: 0.09, regexWrongCases: 1 };
  assert.equal(verdictFor(ok).verdict, 'gate passes', JSON.stringify(verdictFor(ok)));

  const lowAgreement = { ...ok, agreement: 0.74 };
  assert.equal(verdictFor(lowAgreement).verdict, 'gate fails');

  const badEce = { ...ok, ece: 0.21 };
  assert.equal(verdictFor(badEce).verdict, 'gate fails');

  // The condition that matters: high agreement with no case where the regex is
  // wrong is not a pass. Imitating a correct rule is not a reason to add a
  // network call.
  const noRegexWin = { ...ok, regexWrongCases: 0 };
  const v = verdictFor(noRegexWin);
  assert.equal(v.verdict, 'gate fails');
  assert.match(v.reason, /regex/i);

  const middling = { total: 200, agreement: 0.80, ece: 0.15, regexWrongCases: 1 };
  assert.equal(verdictFor(middling).verdict, 'insufficient evidence');
});

test('verdictFor refuses to rule on a corpus too small to rule on', () => {
  const tiny = { total: 12, agreement: 0.99, ece: 0.01, regexWrongCases: 3 };
  const v = verdictFor(tiny);
  assert.equal(v.verdict, 'insufficient evidence');
  assert.match(v.reason, /sample/i);
});

withCassette('the probe replays the committed cassette and reproduces the committed scores', async () => {
  // T4 Step 3. Replay must be byte-identical to record, otherwise the probe
  // has a determinism bug and its numbers mean nothing.
  const saved = JSON.parse(fs.readFileSync(SCORED_FILE, 'utf8'));
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));
  const replayed = await runReplay(corpus);
  // The written report spreads the summary at the top level rather than nesting
  // it, so both sides are read through the same accessor.
  assert.equal(replayed.summarize.agreement, saved.agreement);
  assert.equal(replayed.summarize.ece, saved.ece);
  assert.equal(replayed.summarize.brier, saved.brier);
  assert.equal(replayed.summarize.confusion.agree, saved.confusion.agree);
  assert.deepEqual(replayed.summarize.disagreements.map((d) => d.id), saved.disagreements.map((d) => d.id));
  assert.equal(replayed.summarize.verdict.verdict, saved.verdict.verdict);
});

withCorpus('every reference label agrees with the frozen classifier snapshot', () => {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));
  for (const row of corpus) {
    assert.equal(row.label, classifySpikeSkipIf(row.cmd), `stale label on ${row.cmd}`);
  }
});

withCorpus('a replay does not re-date the recording, because recordedAt means "when the calls were made"', async () => {
  // The defect this locks: the CLI wrote `recordedAt: new Date().toISOString()`
  // on every run, including replay. Replay re-derives every number in the file
  // from the cassette without making one request, so that line overwrote the
  // recording date with the date someone last replayed it. The freeze test
  // reads `recordedAt` to date the classifier snapshot, so a replay silently
  // re-dated the freeze — and on a later day it would have failed the freeze for
  // a reason that has nothing to do with the classifier.
  //
  // This is a process-level test: it runs the CLI, not a function, because the
  // bug lived in the CLI's write path and no unit test of `runProbe` could see
  // it. `runProbe` takes `out` and writes nothing, which is why it was
  // invisible until the CLI was actually invoked.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-probe-replay-'));
  const target = path.join(tmp, 'two-class.json');
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));

  // Seed a target that claims a recording on a distinctive day.
  const seededAt = '2026-01-02T03:04:05.000Z';
  fs.writeFileSync(target, JSON.stringify({ probe: 'jev-skipif-two-class', recordedAt: seededAt }, null, 2));

  const { execFileSync } = await import('node:child_process');
  const probeCli = path.join(ROOT, 'scripts', 'spike-skipif-probe.mjs');
  execFileSync('bun', [probeCli, '--replay', '--corpus', CORPUS_FILE, '--out', target], {
    encoding: 'utf8',
  });

  const after = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(after.recordedAt, seededAt,
    'a replay re-dated the recording; recordedAt must keep meaning "when the API calls were made"');
  assert.equal(typeof after.replayedAt, 'string',
    'a replay must record its own timestamp separately, under a name that says what it is');
  assert.notEqual(after.replayedAt, seededAt);
  // And the numbers it did re-derive must still be the committed ones, or the
  // test above would be asserting a timestamp on an otherwise broken file.
  assert.equal(after.agreement, 0.995);
  assert.equal(after.mode, 'replay');

  fs.rmSync(tmp, { recursive: true, force: true });
});

withCassette('a replay that reproduces the file writes nothing, so verification does not dirty the tree', async () => {
  // Why this exists: replay stamps its own `replayedAt`, so a replay that always
  // wrote left the committed evidence one second newer after every check. A
  // committed evidence file that diffs on each read teaches the next reader to
  // ignore a dirty diff, which is how a real change hides.
  //
  // The property is stronger than "does not re-date" — it is "says nothing new,
  // says nothing at all". The write still happens when the re-derived numbers
  // differ, which is the seeded-fixture test above exercising.
  const before = fs.readFileSync(SCORED_FILE);
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('bun', [path.join(ROOT, 'scripts', 'spike-skipif-probe.mjs'), '--replay', '--out', SCORED_FILE], {
    encoding: 'utf8',
  });
  assert.match(out, /write\s+skipped/, 'a replay with nothing to add must not write');
  assert.deepEqual(fs.readFileSync(SCORED_FILE), before, 'the committed evidence changed on a no-op replay');
});

async function runReplay(corpus) {
  const { runProbe } = await import('./spike-skipif-probe.mjs');
  return runProbe({ corpus, mode: 'replay', out: null });
}
