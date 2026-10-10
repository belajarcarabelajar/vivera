import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalize,
  extractPromptBody,
  loadManifest,
  checkDrift,
} from './sync-snippets.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('normalize folds the cosmetic differences between source and database copy', () => {
  const source = 'SUBAGENT-FIRST — mandatory, “quoted”, it’s fine, 1 \u2192 2';
  const dbCopy = 'SUBAGENT-FIRST - mandatory, "quoted", it\'s fine, 1 -> 2';
  assert.equal(normalize(source), normalize(dbCopy));
});

test('normalize is idempotent', () => {
  const once = normalize('a \u2014 b\n\n\n');
  assert.equal(normalize(once), once);
});

test('normalize strips trailing whitespace and CRLF', () => {
  assert.equal(normalize('line one   \r\nline two\t'), 'line one\nline two');
});

test('normalize preserves a real content difference', () => {
  assert.notEqual(normalize('HIGH FAN-OUT FLOOR'), normalize('HIGH FANOUT FLOOR'));
});

test('extractPromptBody drops the title and the usage note above the fence', () => {
  const md = [
    '# Snippet Orkestrasi: Debugging',
    '',
    '> Copy-paste isi blok di bawah ini.',
    '',
    '---',
    '',
    'Apply super-ultra-code-plan with Systematic Debugging.',
  ].join('\n');
  const body = extractPromptBody(md);
  assert.equal(body, 'Apply super-ultra-code-plan with Systematic Debugging.');
  assert.doesNotMatch(body, /Copy-paste/);
  assert.doesNotMatch(body, /Snippet Orkestrasi/);
});

test('extractPromptBody falls back to the whole file when there is no fence', () => {
  assert.equal(extractPromptBody('just a prompt'), 'just a prompt');
});

test('loadManifest reads the repo manifest and every source file exists', () => {
  const m = loadManifest();
  assert.ok(m.snippets.length >= 2, 'manifest should track at least the two trigger snippets');
  for (const e of m.snippets) {
    for (const field of ['source', 'uuid', 'keyword', 'name', 'description']) {
      assert.ok(e[field], `${e.source} is missing ${field}`);
    }
  }
});

test('checkDrift reports in-sync when the database matches the source', () => {
  const m = loadManifest();
  const entry = { source: m.snippets[0].source, uuid: 'x', keyword: 'k', name: 'n', description: 'd' };
  // Echo back exactly what the source file contains: the comparison must pass.
  const real = extractPromptBody(readFileSync(path.join(rootDir, entry.source), 'utf8'));
  const results = checkDrift({ snippets: [entry] }, { fetch: () => ({ snippet: real }) });
  assert.equal(results.length, 1);
  assert.equal(results[0].inSync, true);
});

test('checkDrift tolerates a database copy that uses ASCII where the source uses typographic characters', () => {
  const m = loadManifest();
  const entry = { source: m.snippets[0].source, uuid: 'x', keyword: 'k', name: 'n', description: 'd' };
  const real = extractPromptBody(readFileSync(path.join(rootDir, entry.source), 'utf8'));
  // Same text, but the database side uses typographic quotes and an en dash
  // where the source uses ASCII. This must still compare clean.
  const decorated = real.replace(/-/g, '\u2013').replace(/'([^']*)'/g, '\u2018$1\u2019');
  const results = checkDrift({ snippets: [entry] }, { fetch: () => ({ snippet: decorated }) });
  assert.equal(results[0].inSync, true);
});

test('checkDrift reports drift when the database is stale', () => {
  const m = loadManifest();
  const results = checkDrift(
    { snippets: [{ source: m.snippets[0].source, uuid: 'x', keyword: 'k', name: 'n', description: 'd' }] },
    { fetch: () => ({ snippet: 'an older revision' }) },
  );
  assert.equal(results[0].inSync, false);
  assert.notEqual(results[0].localHash, results[0].remoteHash);
});

test('checkDrift surfaces a fetch failure instead of silently passing', () => {
  const m = loadManifest();
  const results = checkDrift(
    { snippets: [{ source: m.snippets[0].source, uuid: 'x', keyword: 'k', name: 'n', description: 'd' }] },
    { fetch: () => { throw new Error('database unreachable'); } },
  );
  assert.equal(results[0].inSync, false);
  assert.match(results[0].problem, /database unreachable/);
});

test('checkDrift marks a missing CLI as unreachable, not as drift', () => {
  const m = loadManifest();
  const err = new Error('cannot run "snipset": spawn snipset ENOENT. Is Snipset installed and on PATH?');
  err.code = 'ENOENT';
  const results = checkDrift(
    { snippets: [{ source: m.snippets[0].source, uuid: 'x', keyword: 'k', name: 'n', description: 'd' }] },
    { fetch: () => { throw err; } },
  );
  assert.equal(results[0].unreachable, true, 'a missing database must be an environment boundary');
  assert.equal(results[0].inSync, false, 'unreachable must never report as in sync');
});

test('checkDrift marks a failed CLI exit as unreachable, not as drift', () => {
  const m = loadManifest();
  const results = checkDrift(
    { snippets: [{ source: m.snippets[0].source, uuid: 'x', keyword: 'k', name: 'n', description: 'd' }] },
    { fetch: () => { throw new Error('"snipset snippet get x" exited 1: database not found'); } },
  );
  assert.equal(results[0].unreachable, true);
});

test('checkDrift does not treat a real content mismatch as unreachable', () => {
  const m = loadManifest();
  const results = checkDrift(
    { snippets: [{ source: m.snippets[0].source, uuid: 'x', keyword: 'k', name: 'n', description: 'd' }] },
    { fetch: () => ({ snippet: 'stale content' }) },
  );
  assert.equal(results[0].unreachable, false);
  assert.equal(results[0].inSync, false);
});

test('checkDrift reports a missing snippet rather than treating it as empty', () => {
  const m = loadManifest();
  const results = checkDrift(
    { snippets: [{ source: m.snippets[0].source, uuid: 'x', keyword: 'k', name: 'n', description: 'd' }] },
    { fetch: () => null },
  );
  assert.equal(results[0].inSync, false);
  assert.match(results[0].problem, /not found/);
});

// The progress meter is defined once, in `sucp-rules` (Progress Meter at Checkpoints).
// A snippet that leaves it to the agent to load that skill gets no meter when the
// skill is not loaded, which is the case for every short `cmd-*` snippet. So every
// trigger carries the same paragraph itself, and this test keeps them identical.
test('every trigger snippet carries the same progress-meter paragraph', () => {
  const manifest = loadManifest();
  const paragraphs = new Map();
  for (const s of manifest.snippets) {
    const body = extractPromptBody(readFileSync(path.join(rootDir, s.source), 'utf8'));
    const found = body.split('\n').filter((l) => l.startsWith('PROGRESS METER:'));
    assert.equal(found.length, 1, `${s.source} must contain exactly one PROGRESS METER paragraph, found ${found.length}`);
    paragraphs.set(s.source, found[0]);
  }
  assert.ok(paragraphs.size >= 16, `expected every manifest snippet, got ${paragraphs.size}`);
  const first = [...paragraphs.values()][0];
  for (const [src, p] of paragraphs) assert.equal(p, first, `${src} drifted from the shared paragraph`);
  for (const token of ['▰', '▱', 'N/M', '★', '☆', 'never estimate', 'never written to a file']) {
    assert.ok(first.includes(token), `shared paragraph lost "${token}"`);
  }
});
