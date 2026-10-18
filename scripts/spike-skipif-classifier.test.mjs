// T1 — the drift lock that makes the freeze durable.
//
// The Jev decision-gate spike in
// `docs/code-plan/spikes/2026-09-30-jev-decision-gate-spike-report.md` is
// COMPLETE and published. Its headline number — agreement 0.995, ECE 0.011,
// Brier 0.005, $0.004129 against jev-1.13.0 — was measured with a specific
// `classifySkipIf` in `scripts/ultra-plan-runner.mjs`.
//
// `classifySkipIf` is production code and is about to change: it will gain
// `sentinel` and `unknown` return values and widen `FILE_PROBE`. Those are the
// right changes, and each of them makes rows in `spike-out/corpus.json` stale.
// When that happens `summarize()` throws `stale label` and the published 0.995
// stops being reproducible.
//
// So the classifier is snapshotted in `spike-skipif-classifier.mjs`, and the
// spike scripts (retired on 2026-10-19) imported the snapshot, not the live
// function. This file is what notices if the snapshot drifts. A comment is not a
// guard; these assertions are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifySpikeSkipIf,
  SPIKE_EVIDENCE_COMMAND,
  SPIKE_FILE_PROBE,
  SPIKE_CLASSIFIER_FROZEN_ON,
  SPIKE_CORPUS_PATH,
  SPIKE_SCORED_PATH,
} from './spike-skipif-classifier.mjs';

// The literals as they stand in `scripts/ultra-plan-runner.mjs` on 2026-09-30,
// kept here as the independent copy the snapshot is compared against. If either
// side is edited, one of the two assertions below stops holding.
const EXPECTED_EVIDENCE_COMMAND_SOURCE =
  '/\\b(bun|node|npm|pnpm|yarn|deno|python3?|pytest|go|cargo|make|cmake|git|systemctl|curl|docker|tsc|eslint|vitest|jest|ruff|mypy|gradle|mvn)\\b/';
const EXPECTED_FILE_PROBE_SOURCE =
  '/(^|[\\s;&|(])(grep|egrep|rg|cat|head|tail|ls|find|wc|test)\\b/';

// The cassette files are machine-local, untracked state. `spike-out/` holds the
// corpus the spike harvested and the scored artefact the probe wrote, on the
// machine that ran the spike, and .gitignore keeps the directory out of the
// tree, so a fresh clone carries neither file. The two tests below read them
// from disk and would die there with ENOENT, so each one gates on the file it
// actually reads and skips with a reason that says what is missing and why.
// On a machine that HAS the cassette nothing changes: every assertion still
// runs.
const CORPUS_FILE = 'spike-out/corpus.json';
const SCORED_FILE = 'spike-out/two-class.json';
const corpusPresent = fs.existsSync(SPIKE_CORPUS_PATH);
const scoredPresent = fs.existsSync(SPIKE_SCORED_PATH);
const cassetteSkipReason = (missing) =>
  `${missing} is absent: spike-out/ is gitignored, machine-local spike output (see .gitignore), so a fresh clone does not carry it; `
  + 'the scripts that recorded it were retired on 2026-10-19, so only a machine that kept spike-out/ runs this test';
const withCorpus = corpusPresent ? test : (name, fn) => test(name, { skip: cassetteSkipReason(CORPUS_FILE) }, fn);
const withScored = scoredPresent ? test : (name, fn) => test(name, { skip: cassetteSkipReason(SCORED_FILE) }, fn);

test('a tool that must succeed first is behavioural', () => {
  // The rule as written: a tool invocation qualifies even when a grep filters
  // its output, because the tool has to pass before the grep is ever read.
  assert.equal(
    classifySpikeSkipIf("bun test a.test.ts 2>&1 | grep -q 'passes'"),
    'behavioural',
    'a test runner piped into grep is still a behavioural check — the grep is not the assertion',
  );
  assert.equal(classifySpikeSkipIf('git status --porcelain'), 'behavioural');
  assert.equal(classifySpikeSkipIf('bun run ci'), 'behavioural');
});

test('a bare file probe is loose', () => {
  for (const cmd of ["grep -q 'marker' file.md", 'test -f out.txt', 'ls dist/']) {
    assert.equal(classifySpikeSkipIf(cmd), 'loose', `${cmd} reads a file and asserts nothing ran`);
  }
});

test('blank and non-string input is empty', () => {
  for (const bad of ['', '   ', undefined, null, 42, {}, []]) {
    assert.equal(classifySpikeSkipIf(bad), 'empty', `input ${JSON.stringify(bad)} should be empty`);
  }
});

test('the frozen regex sources are byte-identical to the literals they were copied from', () => {
  // `source` omits the delimiters and `flags` is a separate field, so both are
  // reassembled here to reconstruct the literal exactly as it was written.
  // Comparing the body alone would pass on a pattern carrying a stray `g` flag,
  // and a stateful regex would silently make the label non-deterministic.
  assert.equal(
    `/${SPIKE_EVIDENCE_COMMAND.source}/${SPIKE_EVIDENCE_COMMAND.flags}`,
    EXPECTED_EVIDENCE_COMMAND_SOURCE,
    'EVIDENCE_COMMAND in the snapshot no longer matches the one the 0.995 was measured against',
  );
  assert.equal(
    `/${SPIKE_FILE_PROBE.source}/${SPIKE_FILE_PROBE.flags}`,
    EXPECTED_FILE_PROBE_SOURCE,
    'FILE_PROBE in the snapshot no longer matches the one the 0.995 was measured against',
  );
});

withScored('the freeze is dated to the day the probe actually ran', () => {
  assert.equal(SPIKE_CLASSIFIER_FROZEN_ON, '2026-09-30');
  // The date is not a claim, it is read back out of the recorded artefact. If
  // the cassette is ever re-recorded on another day, this fails and the freeze
  // date has to be revisited deliberately rather than inherited.
  const scored = JSON.parse(fs.readFileSync(SPIKE_SCORED_PATH, 'utf8'));
  const recordedDay = String(scored.recordedAt).slice(0, 10);
  assert.equal(recordedDay, SPIKE_CLASSIFIER_FROZEN_ON, `two-class.json was recorded on ${recordedDay}, not ${SPIKE_CLASSIFIER_FROZEN_ON}`);
});

withCorpus('the frozen classifier reproduces the label of all 200 committed corpus rows', () => {
  const corpus = JSON.parse(fs.readFileSync(SPIKE_CORPUS_PATH, 'utf8'));
  assert.equal(corpus.length, 200, 'the committed corpus is 200 rows; a different count means the file was regenerated');

  const drifted = [];
  for (const row of corpus) {
    const now = classifySpikeSkipIf(row.cmd);
    if (now !== row.label) drifted.push({ cmd: row.cmd, committed: row.label, frozen: now });
  }
  assert.deepEqual(
    drifted,
    [],
    `${drifted.length} of ${corpus.length} committed corpus labels drifted: ${JSON.stringify(drifted.slice(0, 5))}`,
  );
});
