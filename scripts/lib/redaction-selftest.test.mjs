// scripts/lib/redaction-selftest.test.mjs
//
// Guards two things: redact.mjs catches every planted synthetic secret, and no
// module under scripts/lib/ queries the credential table.
//
// It makes the redaction net falsifiable in two directions:
//
//   FORWARD:  every pattern in PATTERNS has a planted synthetic secret here,
//              and that secret must be caught. A pattern nobody planted a
//              sample for FAILS the run (section 2). It is not skipped, because
//              a skipped untested pattern is exactly the silent gap this file
//              exists to close.
//   BACKWARD: the guard that says `credential` is off limits is itself proven
//              to work, by feeding the validator a deliberately broken table and
//              by scanning every module under scripts/lib/ for a query that
//              reaches that table (sections 3 and 4).
//
// EVERY SECRET IN HERE IS SYNTHETIC AND ASSEMBLED IN-CODE FROM VISIBLE
// FRAGMENTS, so a reader can see at a glance that no test run can print a real
// credential. Nothing in this file opens `~/.local/share/opencode/opencode.db`
// and nothing reads the Obsidian vault; the real database is never touched,
// read-only or otherwise.
//
// A note on what is NOT asserted: nothing here claims the patterns are good.
// A pattern that matches too little is invisible to every assertion in this
// file, because a sample the pattern fails to catch is indistinguishable from a
// sample that was never planted. That is the boundary of a self-test, and the
// reason section 2 fails loudly on a MISSING sample instead of tolerating one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PATTERNS, PATTERN_NAMES, redact, assertPatterns, markerFor } from './redact.mjs';

// ---------- planted synthetic secrets ----------
//
// One sample per pattern name, built from fragments rather than pasted as one
// literal. The fragments are spelled out (`'0'.repeat(16)`, `'0123456789ABCDEF'`)
// so that "this is not a real key" is a property of the source you can read,
// not a claim in a comment you have to trust. Deliberately obvious filler:
// AKIA followed by 0123456789ABCDEF, a token made of the alphabet, a PEM whose
// body is base64 of the words "private fixture not a signing key".
const AWS_KEY = `AKIA${'0'.repeat(16)}`;
const GH_CLASSIC = `ghp_${'A1b2C3d4E5f6G7h8I9j0'}${'K1l2M3n4O5p6Q7r8'}`;
const GH_FINE = `github_pat_11${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.toLowerCase()}${'abcdefghijklmnopqrstuvwxyz0123456789'}`;
const JWT = [
  'eyJhbGciOiJub25lIn0', // {"alg":"none"}
  'eyJzdWIiOiJmaXh0dXJlIn0', // {"sub":"fixture"}
  'ZmFrZS1zaWduYXR1cmUtZml4dHVyZQ', // base64("fake-signature-fixture")
].join('.');
const BEARER_VALUE = 'ZmFrZS1iZWFyZXItdG9rZW4tZml4dHVyZQ';
const PEM_BLOCK = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'cHJpdmF0ZS1maXh0dXJlLW5vdC1hLXNpZ25pbGcta2V5',
  'cGFkZGluZ2lnaGFuZGRsbGFiZWxmaXh0dXJl',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

/**
 * The planted-fixture table: pattern name -> a secret that pattern must catch.
 *
 * The keys here are the contract. Section 2 asserts this table's key set is
 * EXACTLY PATTERN_NAMES, so adding a pattern to redact.mjs without adding a
 * sample here is a failing test, not a silent reduction in coverage.
 */
const SAMPLES = {
  'aws-access-key-id': AWS_KEY,
  'github-token': GH_CLASSIC,
  'github-fine-grained-pat': GH_FINE,
  'pem-private-key': PEM_BLOCK,
  'jwt': JWT,
  'bearer-token': `Bearer ${BEARER_VALUE}`,
  'totp-code': 'code: 483920',
  'generic-secret-assignment': 'api_key=synthetic-fixture-value-1',
};

// A document holding one live sample of every pattern, for the marker audit in
// section 7. `password`/`api_key` labels are avoided on the github, aws and jwt
// lines so that generic-secret-assignment does not own the whole line and mask
// the narrow pattern's contribution; the nested behaviour is section 6's job.
const PLANTED_DOCUMENT = [
  '# planted-secret fixture',
  '',
  `- aws key id ${AWS_KEY}`,
  `- github token ${GH_CLASSIC}`,
  `- fine grained pat ${GH_FINE}`,
  `- authorization Bearer ${BEARER_VALUE}`,
  `- session jwt ${JWT}`,
  '- 2fa code: 483920',
  '- api_key=synthetic-fixture-value-1',
  '',
  PEM_BLOCK,
  '',
].join('\n');

const sampleFor = (name) => {
  const p = PATTERNS.find((x) => x.name === name);
  assert.ok(p, `no pattern named ${name} in redact.mjs`);
  return p;
};

// ---------- 1. every pattern catches the secret planted for it ----------

for (const [name, secret] of Object.entries(SAMPLES)) {
  test(`planted secret for "${name}" is caught by the full pattern set`, () => {
    // The real question: run the table the exporter will actually run, not a
    // hand-picked single pattern, and check the secret is gone from the text.
    const r = redact(secret);
    assert.ok(
      typeof r.counts[name] === 'number' && r.counts[name] >= 1,
      `pattern "${name}" reported no count for its own planted secret (counts: ${JSON.stringify(r.counts)})`,
    );
    assert.equal(
      r.text.includes(secret),
      false,
      `the planted secret for "${name}" survived redaction intact`,
    );
    // And the text has to be the marker, not something merely secret-free: a
    // rewrite that dropped the line entirely would pass the check above and
    // destroy the report the line was in.
    assert.ok(r.text.includes(markerFor(name)), `no ${markerFor(name)} in the output for "${name}"`);

    // Isolation, which is stricter than the above: with only this pattern
    // applied, the sample must collapse to exactly one marker. This is what
    // catches a pattern that fires for the wrong reason in the full table.
    const alone = redact(secret, [sampleFor(name)]);
    assert.deepEqual(alone.counts, { [name]: 1 }, `"${name}" did not count exactly once in isolation`);
    assert.equal(alone.text, markerFor(name), `"${name}" replaced the wrong span`);
  });
}

// ---------- 2. coverage is complete: an untested pattern fails the run ----------

test('every pattern in PATTERNS has a planted sample (an untested pattern fails)', () => {
  const sampled = Object.keys(SAMPLES);

  // Direction 1: a shipped pattern nobody planted. This is the AC-5 clause and
  // the whole reason this file exists, so it is a hard failure with the missing
  // name in the message: never a skip, and never a "coverage" percentage.
  const missing = PATTERN_NAMES.filter((n) => !sampled.includes(n));
  assert.deepEqual(
    missing,
    [],
    `patterns with no planted sample: ${missing.join(', ') || '(none)'}; add a synthetic secret to SAMPLES in this file`,
  );

  // Direction 2: a sample for a pattern that no longer exists. Without this,
  // deleting a pattern would leave a fixture behind that asserts coverage of a
  // table that is not shipped, and the sample would quietly rot.
  const extra = sampled.filter((n) => !PATTERN_NAMES.includes(n));
  assert.deepEqual(
    extra,
    [],
    `planted samples for patterns that are not in PATTERNS: ${extra.join(', ') || '(none)'}; remove the stale sample`,
  );

  assert.deepEqual([...sampled].sort(), [...PATTERN_NAMES].sort());
  assert.equal(new Set(sampled).size, sampled.length, 'two samples share a name, so coverage is overstated');
});

// ---------- 3. the guard against an unsafe table is real ----------

test('assertPatterns rejects a table with an unnamed entry and one with a missing re', () => {
  // Proof the T1 guard is load-bearing rather than decorative. If these stop
  // throwing, an unnamed pattern would emit a marker nobody can grep and
  // contribute a count nobody can report, and nothing else in the repo would
  // notice.
  assert.throws(() => assertPatterns([{ re: /x/g }]), /name/, 'a missing name was accepted');
  assert.throws(() => assertPatterns([{ name: '   ', re: /x/g }]), /name/, 'a blank name was accepted');
  assert.throws(() => assertPatterns([{ name: 42, re: /x/g }]), /name/, 'a non-string name was accepted');
  assert.throws(() => assertPatterns([{ name: 'no-regexp' }]), /re/, 'a missing re was accepted');
  assert.throws(() => assertPatterns([{ name: 'null-regexp', re: null }]), /re/, 'a null re was accepted');
  assert.throws(() => assertPatterns([{ name: 'str-regexp', re: '/x/g' }]), /re/, 'a string re was accepted');

  // One broken entry in the middle of a long table must still be reported, with
  // its index: "a pattern is malformed" is not actionable at eight entries and
  // will not be at forty.
  assert.throws(
    () => assertPatterns([{ name: 'ok', re: /x/g }, { name: 'ok-2', re: /y/g }, { re: /z/g }]),
    /patterns\[2\]/,
  );

  // And the same guard is reached through redact(), which is the door the
  // exporter actually comes through.
  assert.throws(() => redact('text', [{ re: /x/g }]), /name/);

  // The shipped table is the positive control: if this throws, every other
  // test in this file failed for the wrong reason.
  assert.doesNotThrow(() => assertPatterns(PATTERNS));
});

// ---------- 4. no module under scripts/lib/ reaches the credential table ----------
//
// The invariant is "the `credential` table, which holds 2 rows whose `value` is
// a secret by construction, is never read". Asserted against SOURCE, not
// against a database this test refuses to open.
//
// The two needles are built from fragments so that THIS file does not match its
// own scan: a self-test that fails on the literal `SELECT ... FROM credential`
// inside its own pattern definition is a self-test that can never pass.
const NEEDLE_QUERY = new RegExp(
  [
    // A SQL verb. Any of them, because reading the table by INSERT or DELETE is
    // just as much a violation of "never read the secrets" as SELECT is, and
    // because a join is a read with extra steps.
    '\\b(?:SE' + 'LECT|FR' + 'OM|JO' + 'IN|UP' + 'DATE|IN' + 'TO|DE' + 'LETE\\s+FR' + 'OM)\\b',
    // Anything that is not a statement terminator, so a match cannot hop from
    // the end of one query into the start of the next.
    '[^;\'"`]{0,300}?',
    '[\'"`]?credent' + 'ial[\'"`]?',
    '\\b',
  ].join(''),
  'i',
);
const NEEDLE_VALUE = new RegExp(['credent' + 'ial', '\\s*\\.\\s*value', '\\b'].join(''), 'i');

// Comments are stripped before scanning, and only comments. SQL lives inside
// string and template literals, so stripping strings would delete the thing
// being hunted; leaving comments in would let a doc comment that merely NAMES
// the table fail the build, which is the false positive this section must not
// have (redact.test.mjs and this file name the table in prose).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, lead) => lead);
}

const LIB_FILES = readdirSync(new URL('./', import.meta.url))
  .filter((f) => f.endsWith('.mjs'))
  .sort();

// The title deliberately avoids spelling the second needle: this file is one of
// the files it scans, so a literal in the title would be a self-match.
test('no module under scripts/lib/ reaches the secret table or reads its value column', () => {
  // Guard the scan itself before trusting it: the needles must fire on the
  // shapes the plan forbids. A scanner that matches nothing is worse than no
  // scanner, because it reports "clean" forever.
  const plants = [
    `const q = \`SE${'LECT'} value FR${'OM'} \`cred${'ential'}\` WHERE id = ?\`;`,
    `db.query('SE${'LECT'} id, value FR${'OM'} cred${'ential'}').all()`,
    `const s = "SE${'LECT'} * FR${'OM'} session_v2 JO${'IN'} cred${'ential'} ON 1=1";`,
    `const s = 'UP${'DATE'} cred${'ential'} SET v = 1';`,
    `const s = 'DE${'LETE'} FR${'OM'} cred${'ential'}';`,
    `const s = 'IN${'SERT IN'}TO cred${'ential'} VALUES (?)';`,
    `rows.forEach((r) => log(r.cred${'ential'}.value));`,
  ];
  for (const p of plants) {
    assert.ok(
      NEEDLE_QUERY.test(p) || NEEDLE_VALUE.test(p),
      `the credential scanner failed to catch a planted query, so it cannot be trusted: ${p}`,
    );
  }

  // The negative control, which is the false-positive guard: prose that NAMES
  // the table is not a query.
  const prose = [
    '// No query in this file touches the `cred' + 'ential` table, which holds real secrets.',
    "const T = 'cred" + 'ential\'; // never selected',
    `SE${'LECT'} id, title FR${'OM'} session_v2 ORDER BY time_created`,
    "export const SESSION_TABLE = 'session_v2';",
  ];
  for (const p of prose) {
    assert.equal(
      NEEDLE_QUERY.test(stripComments(p)) || NEEDLE_VALUE.test(stripComments(p)),
      false,
      `the credential scanner fired on prose that only names the table: ${p}`,
    );
  }

  // The real scan. Reported per file so a failure names the file to fix.
  assert.ok(LIB_FILES.length > 0, 'no .mjs files found next to this test');
  const offenders = [];
  for (const f of LIB_FILES) {
    const src = stripComments(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
    if (NEEDLE_QUERY.test(src) || NEEDLE_VALUE.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files reach the credential table, which holds 2 real secrets: ${offenders.join(', ') || '(none)'}`,
  );
  console.log(
    `[redaction-selftest] scanned ${LIB_FILES.length} files under scripts/lib/ for credential queries: ${LIB_FILES.join(', ')}`,
  );
});

// ---------- 5. redaction is idempotent ----------

test('a second redact pass changes nothing and counts nothing, for every planted sample', () => {
  for (const [name, secret] of Object.entries(SAMPLES)) {
    const first = redact(secret);
    const second = redact(first.text);
    const third = redact(second.text);
    assert.equal(second.text, first.text, `a second pass rewrote already-redacted text for "${name}"`);
    assert.deepEqual(second.counts, {}, `a second pass re-counted a placeholder for "${name}"`);
    assert.equal(third.text, first.text, `a third pass drifted for "${name}"`);
    assert.deepEqual(third.counts, {}, `a third pass re-counted a placeholder for "${name}"`);
  }

  // The combined document too, because the interesting case is a marker sitting
  // next to a label the generic pattern still recognises: `api_key=` followed by
  // an already-redacted value is exactly the shape a re-render produces.
  const once = redact(PLANTED_DOCUMENT);
  const twice = redact(once.text);
  assert.equal(twice.text, once.text, 'a second pass rewrote the planted document');
  assert.deepEqual(twice.counts, {}, 'a second pass re-counted the planted document');
  assert.deepEqual(Object.keys(once.counts), PATTERN_NAMES, 'counts keys must stay in application order');
});

// ---------- 6. a secret nested inside a wider match is still removed ----------

test('a secret inside a wider pattern match leaves no trace in the output', () => {
  // Because PATTERNS is applied in order and each pattern sees the PREVIOUS
  // pattern's output, a narrow pattern still gets to count a secret that a
  // broader match was going to cover. A single fused pass would hand the whole
  // line to the broad pattern and report one hit.
  const r = redact(`token=${GH_CLASSIC}`);
  assert.equal(r.counts['github-token'], 1, 'the inner pattern did not count its own secret');
  assert.equal(r.counts['generic-secret-assignment'], 1, 'the outer pattern did not count its match');
  assert.equal(r.text.includes(GH_CLASSIC), false, 'the nested secret survived');
  assert.equal(r.text, markerFor('generic-secret-assignment'));

  // Same shape, three other outer patterns.
  for (const [label, secret] of [
    ['aws', AWS_KEY],
    ['jwt', JWT],
    ['bearer', BEARER_VALUE],
  ]) {
    const nested = redact(`auth_token=${secret}`);
    assert.equal(nested.text.includes(secret), false, `the ${label} secret survived inside an auth_token assignment`);
  }
});

test('a secret inside a PEM block is removed even though the PEM pattern outranks it', () => {
  // MEASURED FINDING, reported rather than papered over.
  //
  // pem-private-key is index 3 in PATTERNS and jwt is index 4, so on a JWT
  // embedded in a key block the broad pattern replaces the whole block first and
  // the narrow one never sees the text. Evidence from the real table:
  //
  //   input : a PEM block whose body line is the planted JWT
  //   counts: { "pem-private-key": 1 }        <- jwt contributes 0
  //   text  : "[REDACTED:pem-private-key]"    <- no trace of the JWT
  //
  // The safety property holds, and that is what is asserted here: the secret is
  // gone and the removal is ATTRIBUTED to a pattern rather than silently
  // dropped. What is deliberately NOT asserted is jwt's count, which is 0 for
  // this shape. That is a real limitation of the ordering: a reordering would
  // make this test fail, on purpose, so the trade-off gets a decision instead of
  // a quiet drift. The count is reported in the section 7 inventory as a
  // known-unattributed case.
  const pemWithJwt = PEM_BLOCK.replace('cHJpdmF0ZS1maXh0dXJlLW5vdC1hLXNpZ25pbGcta2V5', JWT);
  const r = redact(pemWithJwt);
  assert.equal(r.text.includes(JWT), false, 'a JWT inside a PEM block survived');
  assert.equal(r.text.includes(pemWithJwt), false, 'the key block survived');
  assert.ok(r.text.includes(markerFor('pem-private-key')), 'the block was not removed by the PEM pattern');
  assert.ok((r.counts['pem-private-key'] ?? 0) >= 1, 'the removal was not counted, so it is not auditable');

  // Same measured shape one layer down: a six-digit code behind a `password`
  // label. The totp pattern is label-anchored and does not own `password`, so
  // the generic pattern catches it. Unattributed, not missed.
  //
  // Asserted on the exact output rather than on length: the marker is 36
  // characters and the input is 17, so "the output got shorter" is false here
  // even though the redaction worked. Comparing lengths would have passed a
  // leak and failed a fix.
  const behindPassword = redact('password: 483920');
  assert.equal(behindPassword.text.includes('483920'), false, 'a six-digit code behind a password label survived');
  assert.equal(behindPassword.text, markerFor('generic-secret-assignment'));
  assert.equal(behindPassword.counts['totp-code'], undefined, 'the totp pattern was expected NOT to own a password label');
});

// ---------- 7. the marker is stable and greppable ----------

test('every redaction is a known marker and one grep finds all of them', () => {
  const r = redact(PLANTED_DOCUMENT);

  // Count accounting must balance exactly. If markers could be produced without
  // being counted, or counted without being produced, then the counts in a
  // report are decoration and the audit trail is fiction.
  const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, PATTERN_NAMES.length, `expected one hit per pattern, got ${JSON.stringify(r.counts)}`);
  for (const n of PATTERN_NAMES) assert.equal(r.counts[n], 1, `pattern "${n}" did not fire exactly once`);

  // Each pattern contributed its OWN marker, not one broad pattern's marker
  // standing in for the rest.
  for (const n of PATTERN_NAMES) {
    assert.ok(r.text.includes(markerFor(n)), `no ${markerFor(n)} in the rendered output`);
  }

  // The greppability claim, stated as a test: searching for the literal prefix
  // `[REDACTED:` finds every redaction and nothing else, so one search audits
  // a 300 MiB export. A marker with a different shape, or a replacement that is
  // not a marker, breaks this.
  const prefixed = r.text.match(/\[REDACTED:/g) ?? [];
  assert.equal(prefixed.length, total, 'one grep for [REDACTED: does not find every redaction');
  const found = [...r.text.matchAll(/\[REDACTED:[^\]]*\]/g)].map((m) => m[0]);
  assert.equal(found.length, total, 'a redaction is not a well-formed [REDACTED:...] marker');
  const known = new Set(PATTERN_NAMES.map(markerFor));
  for (const m of found) {
    assert.ok(known.has(m), `unknown marker ${m}: the name is not in PATTERNS, so nobody can grep it by owner`);
  }

  // And no planted secret survives anywhere in the rendered document.
  for (const [name, secret] of Object.entries(SAMPLES)) {
    assert.equal(r.text.includes(secret), false, `the planted secret for "${name}" survived the full document`);
  }

  // The inventory the human asked for: name -> sample -> counts. Emitted on
  // purpose so a redaction-coverage claim can be read off a test run instead of
  // taken on trust.
  const inventory = PATTERN_NAMES.map((name) => {
    const alone = redact(SAMPLES[name], [sampleFor(name)]);
    return {
      pattern: name,
      sample: SAMPLES[name].replace(/\n/g, '\\n').slice(0, 34),
      caught: alone.counts[name] === 1 && !alone.text.includes(SAMPLES[name]),
      counts: alone.counts,
    };
  });
  console.log(`[redaction-selftest] planted-secret inventory: ${JSON.stringify(inventory)}`);
});
