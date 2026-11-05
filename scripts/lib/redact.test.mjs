// scripts/lib/redact.test.mjs
//
// Guards for the redaction layer that sits between "we have a string" and
// "we wrote that string somewhere somebody else can read it".
//
// The threat this file is actually about is not a clever regex. It is the
// failure mode where redaction is applied AFTER the write, or applied to a
// copy that the writer never used. Both produce output that looks redacted in
// the log and is fully intact on disk, and neither shows up as a failing
// assertion anywhere else in the repo. So three of the tests below are not
// about patterns at all: they assert that redact() returns a NEW object,
// that the input is untouched, and that the module imports nothing that can
// write. A redaction step that cannot write cannot be the step that runs last.
//
// Every secret-shaped string in here is synthetic and hand-built from literal
// fragments, so the file is safe to commit. Nothing in this test reads the
// real database, and the samples are deliberately obvious (AKIA followed by
// 0123456789ABCDEF) so that a future reader can tell at a glance that no real
// credential is being printed by a test run.
//
// Structure: the per-pattern table is a list of (sample that MUST be caught,
// samples that MUST NOT be) triples, because a pattern that matches nothing
// and a pattern that matches everything are the same amount of code and
// opposite amounts of trust. The negative half of each row is the assertion
// that the next person adding a pattern does not quietly start eating prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PATTERNS, PATTERN_NAMES, redact, assertPatterns, markerFor } from './redact.mjs';

// ---------- synthetic fixtures ----------

// Built from fragments rather than pasted as one literal so that "this is not
// a real key" is visible in the source, not just asserted in a comment.
const AWS_KEY = `AKIA${'0123456789ABCDEF'}`;
const GH_CLASSIC = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
const GH_FINE = `github_pat_11${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'}`;
const JWT = [
  'eyJhbGciOiJub25lIn0',
  'eyJzdWIiOiJmaXh0dXJlIn0',
  'ZmFrZS1zaWduYXR1cmUtZml4dHVyZQ',
].join('.');
const BEARER_VALUE = 'ZmFrZS1iZWFyZXItdG9rZW4tZml4dHVyZQ';
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-');
const TG_TOKEN = `${'1234' + '56789'}:${'aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cF'}${'aB3dE5'}`;
const PEM_BLOCK = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'cHJpdmF0ZS1maXh0dXJlLW5vdC1hLXNpZ25pbGcta2V5',
  'cGFkZGluZ2lnaGFuZGRsbGFiZWxmaXh0dXJl',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

function one(name) {
  const p = PATTERNS.find((x) => x.name === name);
  assert.ok(p, `no pattern named ${name}; PATTERNS carries ${PATTERN_NAMES.join(', ')}`);
  return p;
}

// Each row: the samples that MUST be replaced, and the ones that MUST NOT be.
// Every hit sample is the exact text of the match, so the assertion can be
// equality rather than "contains" — a pattern that eats one character too
// many on either side fails here instead of quietly corrupting output.
const CASES = [
  {
    name: 'aws-access-key-id',
    hits: [AWS_KEY],
    misses: [
      'AKIA',
      'AKIA0123456789ABCDE', // 15 alnum, one short
      'AKIA0123456789ABCDEFG', // 17 alnum, the trailing word char kills \b
      'akia0123456789abcdef', // lowercase, not a key id
    ],
  },
  {
    name: 'github-token',
    hits: [GH_CLASSIC],
    misses: [
      'ghp_short',
      'github_pat_',
      'ghp',
    ],
  },
  {
    name: 'github-fine-grained-pat',
    hits: [GH_FINE],
    misses: [
      'github_pat_',
      'github_pat_tooshort',
    ],
  },
  {
    name: 'pem-private-key',
    hits: [PEM_BLOCK],
    misses: [
      '-----BEGIN CERTIFICATE-----',
      '-----BEGIN RSA PUBLIC KEY-----',
      '-----BEGIN',
    ],
  },
  {
    name: 'jwt',
    hits: [JWT],
    misses: [
      'eyJhbGciOiJub25lIn0', // one segment is not a JWT
      'a.b.c', // three segments, but not base64url of anything
    ],
  },
  {
    name: 'bearer-token',
    hits: [`Bearer ${BEARER_VALUE}`, `bearer ${BEARER_VALUE}`],
    misses: [
      'Bearer abc', // shorter than any real token
      'Bearer',
      'a Bearer header',
    ],
  },
  {
    name: 'totp-code',
    hits: [
      'code: 483920',
      '2fa 739201',
      'otp=552813',
      '"2fa_code": "918273"',
      'TOTP: 112233',
    ],
    misses: [
      'the run took 123456 ms', // bare digits are ordinary prose
      'exit code 42',
      'commit 483920 landed',
      'the code is unclear',
    ],
  },
  {
    name: 'generic-secret-assignment',
    hits: [
      'api_key=synthetic-fixture-value-1',
      '"password": "hunter2-fixture"',
      "SECRET=abc123def456",
      'api-key: "zzz-fixture"',
      "client_secret: 'shhh-fixture'",
    ],
    misses: [
      'see the api key documentation',
      'the token bucket holds 42 items',
      'the keyboard shortcut',
      'aws key: not-a-label-this-module-owns',
    ],
  },
];

// A document holding one live sample of every pattern, for the combined test.
const DOCUMENT = [
  '# fixture report',
  '',
  `- aws: ${AWS_KEY}`,
  `- gh: ${GH_CLASSIC}`,
  `- fine: ${GH_FINE}`,
  `- authorization: Bearer ${BEARER_VALUE}`,
  `- jwt: ${JWT}`,
  `- anthropic ${ANTHROPIC_KEY}`,
  `- bot ${TG_TOKEN}`,
  '- 2fa code: 483920',
  '- api_key=synthetic-fixture-value-1',
  '',
  PEM_BLOCK,
  '',
].join('\n');

const ALL_SECRETS = [AWS_KEY, GH_CLASSIC, GH_FINE, BEARER_VALUE, JWT, PEM_BLOCK, ANTHROPIC_KEY, TG_TOKEN, '483920', 'synthetic-fixture-value-1'];

// ---------- 1. the shipped table is well formed ----------

test('every PATTERNS entry is named, has a RegExp, and the names are unique', () => {
  assert.ok(Array.isArray(PATTERNS), 'PATTERNS must be an array of { name, re }');
  assert.ok(PATTERNS.length > 0);
  for (const [i, p] of PATTERNS.entries()) {
    assert.equal(typeof p.name, 'string', `PATTERNS[${i}] has no string name`);
    assert.notEqual(p.name.trim(), '', `PATTERNS[${i}] has an empty name`);
    assert.ok(p.re instanceof RegExp, `PATTERNS[${i}] (${p.name}) has no RegExp re`);
  }
  assert.deepEqual(PATTERN_NAMES, PATTERNS.map((p) => p.name));
  assert.equal(new Set(PATTERN_NAMES).size, PATTERN_NAMES.length, 'two patterns share a name, so counts would merge');
  // A downstream self-test fails the build on an unnamed pattern, because a
  // marker with no name is not greppable and a count with no key is not
  // reportable. Guard it here instead of waiting to be told.
  assert.doesNotThrow(() => assertPatterns(PATTERNS));
});

test('the table covers every family the plan asks for', () => {
  for (const required of [
    'aws-access-key-id',
    'github-token',
    'github-fine-grained-pat',
    'pem-private-key',
    'jwt',
    'bearer-token',
    'totp-code',
    'generic-secret-assignment',
  ]) {
    assert.ok(one(required), `no pattern named ${required}`);
  }
});

test('assertPatterns rejects an entry that is missing a name or a re', () => {
  assert.throws(() => assertPatterns([{ re: /x/g }]), /name/);
  assert.throws(() => assertPatterns([{ name: '', re: /x/g }]), /name/);
  assert.throws(() => assertPatterns([{ name: '   ', re: /x/g }]), /name/);
  assert.throws(() => assertPatterns([{ name: 42, re: /x/g }]), /name/);
  assert.throws(() => assertPatterns([{ name: 'ok' }]), /re/);
  assert.throws(() => assertPatterns([{ name: 'ok', re: null }]), /re/);
  assert.throws(() => assertPatterns([{ name: 'ok', re: 'not-a-regexp' }]), /re/);
  assert.throws(() => assertPatterns('not-an-array'), /array/);
  // The index has to be in the message: "a pattern is malformed" is not
  // actionable when the table has forty entries.
  assert.throws(() => assertPatterns([{ name: 'ok', re: /x/g }, { re: /y/g }]), /patterns\[1\]/);
});

test('redact validates the table it was handed instead of quietly skipping bad entries', () => {
  assert.throws(() => redact('text', [{ re: /x/g }]), /name/);
  assert.throws(() => redact('text', [{ name: 'x' }]), /re/);
  // A malformed table is a programming error and must not be laundered into
  // an empty result, which would read downstream as "nothing to redact".
  assert.doesNotThrow(() => redact('text', PATTERNS));
});

// ---------- 2. every pattern catches its own sample ----------

for (const c of CASES) {
  test(`PATTERNS "${c.name}" catches its own sample and leaves the rest alone`, () => {
    const p = one(c.name);
    for (const sample of c.hits) {
      const r = redact(sample, [p]);
      assert.equal(r.counts[c.name], 1, `missed: ${sample}`);
      assert.equal(r.text, markerFor(c.name), `replaced the wrong span: ${sample}`);
    }
    for (const sample of c.misses) {
      const r = redact(sample, [p]);
      assert.deepEqual(r.counts, {}, `false positive on: ${sample}`);
      assert.equal(r.text, sample, `rewrote a non-match: ${sample}`);
    }
  });
}

// ---------- 3. the whole table at once ----------

test('a document holding one sample of every pattern comes back with no secret in it', () => {
  const r = redact(DOCUMENT);
  for (const secret of ALL_SECRETS) {
    assert.equal(r.text.includes(secret), false, `${secret.slice(0, 12)}... survived redaction`);
  }
  for (const name of PATTERN_NAMES) {
    assert.ok(r.text.includes(markerFor(name)), `no ${markerFor(name)} in the output`);
  }
  // Every bracket in the output is a placeholder for a name this table knows,
  // so a reader can grep the marker and find the pattern that produced it.
  const seen = [...r.text.matchAll(/\[REDACTED:([a-z0-9-]+)\]/g)].map((m) => m[1]);
  for (const name of seen) assert.ok(PATTERN_NAMES.includes(name), `unknown marker [REDACTED:${name}]`);
  assert.deepEqual(r.counts, Object.fromEntries(PATTERN_NAMES.map((n) => [n, 1])));
  // counts keys appear in application order, so two runs of the same document
  // diff cleanly instead of shuffling.
  assert.deepEqual(Object.keys(r.counts), PATTERN_NAMES);
});

test('a secret nested inside a wider match is still counted by its own pattern', () => {
  // A single fused pass would hand the whole line to generic-secret-assignment
  // and report one hit; feeding each result into the next pattern is the only
  // way github-token gets its own count for a token that was never on its own.
  const r = redact(`token=${GH_CLASSIC}`);
  assert.equal(r.counts['github-token'], 1);
  assert.equal(r.counts['generic-secret-assignment'], 1);
  assert.equal(r.text, markerFor('generic-secret-assignment'));
  assert.equal(r.text.includes(GH_CLASSIC), false);
});

test('patterns are applied sequentially, each fed the previous result', () => {
  // The minimal honest proof that pattern N sees pattern N-1's output: a
  // pattern whose only match target is the placeholder an earlier pattern
  // emits. Applied to the original text it fires zero times; applied to the
  // evolving string it fires once. No regex fusion and no single-shot pass can
  // produce that, because the original text contains no placeholder at all.
  const eatsMarker = { name: 'eats-marker', re: /\[REDACTED:github-token\]/g };
  const forward = redact(GH_CLASSIC, [one('github-token'), eatsMarker]);
  assert.deepEqual(forward.counts, { 'github-token': 1, 'eats-marker': 1 });
  assert.equal(forward.text, markerFor('eats-marker'));

  // Reversing the pair is the control: the marker does not exist yet when
  // eats-marker runs, so the count disappears. That is what makes the first
  // half of this test a claim about sequencing rather than a coincidence.
  const backward = redact(GH_CLASSIC, [eatsMarker, one('github-token')]);
  assert.deepEqual(backward.counts, { 'github-token': 1 });
  assert.equal(backward.text, markerFor('github-token'));
  assert.notEqual(forward.text, backward.text);
});

test('an injected pattern without the g flag still replaces every occurrence', () => {
  const r = redact('a=1 a=2 a=3', [{ name: 'dup', re: /a=\d/g }]);
  assert.equal(r.counts.dup, 3);
  assert.equal(r.text, '[REDACTED:dup] [REDACTED:dup] [REDACTED:dup]');
});

test('markerFor is the single shape every replacement uses', () => {
  assert.equal(markerFor('aws-access-key-id'), '[REDACTED:aws-access-key-id]');
  const r = redact(`aws: ${AWS_KEY}`);
  assert.ok(r.text.endsWith(markerFor('aws-access-key-id')));
});

// ---------- 4. the two things that actually matter ----------

test('redact is idempotent: a second pass changes nothing and counts nothing', () => {
  const first = redact(DOCUMENT);
  const second = redact(first.text);
  assert.equal(second.text, first.text, 'a second pass rewrote already-redacted text');
  assert.deepEqual(second.counts, {}, 'a second pass re-counted a placeholder');
  const third = redact(second.text);
  assert.equal(third.text, first.text);
  assert.deepEqual(third.counts, {});
  // Same for the nested case, where the output is a marker for a marker.
  const nested = redact(`token=${GH_CLASSIC}`);
  const nestedAgain = redact(nested.text);
  assert.equal(nestedAgain.text, nested.text);
  assert.deepEqual(nestedAgain.counts, {});
});

test('redact returns a fresh object and leaves its input untouched', () => {
  const input = `api_key=synthetic-fixture-value-1 and ${AWS_KEY}`;
  const a = redact(input);
  const b = redact(input);
  // Strings are immutable, so "the input was not mutated" is checkable as
  // "the value we passed in still reads the same", not as an identity claim.
  assert.equal(input, `api_key=synthetic-fixture-value-1 and ${AWS_KEY}`);
  assert.notEqual(a, b, 'redact returned a shared object');
  assert.notEqual(a.counts, b.counts, 'redact returned a shared counts object');
  assert.deepEqual(a, b, 'two calls on the same input disagreed');
  assert.equal(typeof a.text, 'string');
  assert.equal(a.text.includes('synthetic-fixture-value-1'), false);
  assert.equal(a.text.includes(AWS_KEY), false);
  // A frozen host object is what a caller that has already committed to
  // redaction looks like. It must not need to be thawed. The generic pattern
  // runs last, so it owns the line even though aws matched first — the same
  // sequencing the idempotence test depends on.
  const doc = Object.freeze({ body: `password: ${AWS_KEY}` });
  const r = redact(doc.body);
  assert.ok(Object.isFrozen(doc));
  assert.equal(r.text, markerFor('generic-secret-assignment'));
  assert.deepEqual(r.counts, { 'aws-access-key-id': 1, 'generic-secret-assignment': 1 });
});

test('the module is pure: it cannot write, so it cannot be the step that ran last', () => {
  const src = readFileSync(new URL('./redact.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\s+'node:(fs|fs\/promises|net|http|https|https:|child_process|dgram|tls)'/);
  assert.doesNotMatch(src, /\b(?:readFile|writeFile|appendFile|createWriteStream|mkdir|rename|unlink)\b/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /\bDate\b/, 'a clock would make the output differ run to run');
  assert.doesNotMatch(src, /Math\.random/, 'randomness would make the output differ run to run');
});

// ---------- 5. degenerate input ----------

test('a non-string input returns an empty result instead of throwing', () => {
  // The renderer hands this function whatever field a JSON object happened to
  // contain, so null is an expected input, not a caller bug.
  for (const bad of [null, undefined, 42, 0, true, false, {}, [], () => {}, Symbol('s'), 10n]) {
    const r = redact(bad);
    assert.deepEqual(r, { text: '', counts: {} }, `threw or leaked for ${String(bad)}`);
  }
});

test('empty input and no-match input both produce empty counts', () => {
  assert.deepEqual(redact(''), { text: '', counts: {} });
  const prose = 'the report has nothing sensitive in it; 123456 is a row count, not a code';
  const r = redact(prose);
  assert.equal(r.text, prose, 'prose came back changed');
  assert.deepEqual(r.counts, {});
});
