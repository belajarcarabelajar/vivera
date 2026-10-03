// scripts/check-anchors.test.mjs
//
// Tests for the anchor audit tool. parseAnchors, paddingRanges and the strict
// fence helpers are pure. checkChunk and resolveFile touch the filesystem, so
// they are pointed at a temp fixture root instead of the real vault — the
// suite must not depend on this host's vault directories existing, nor on this
// repo's own package.json contents.
//
// The key invariants being tested:
// 1. parseAnchors is bracket-balanced (the original bug was greedy .+)
// 2. paddingRanges correctly identifies session-event blocks
// 3. resolveFile searches every root
// 4. checkChunk catches: missing files, out-of-range lines, padding blocks,
//    and verbatim quote failures

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseAnchors, paddingRanges, resolveFile, checkChunk, resolveDefaultRoots } from './check-anchors.mjs';

// ---------- parseAnchors ----------

test('parseAnchors extracts a simple anchor', () => {
  const s = 'text [file.md:L10] more text';
  const anchors = parseAnchors(s);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].file, 'file.md');
  assert.equal(anchors[0].line, 10);
});

test('parseAnchors handles multiple anchors', () => {
  const s = '[a.md:L1] quote one [b.md:L2] quote two';
  const anchors = parseAnchors(s);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].file, 'a.md');
  assert.equal(anchors[1].file, 'b.md');
});

test('parseAnchors is bracket-balanced with nested brackets', () => {
  // The original bug: [ses_...] before :L<n> caused greedy .+ to over-consume
  const s = '[path/to/file.md [ses_abc123]:L42] the quote';
  const anchors = parseAnchors(s);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].file, 'path/to/file.md [ses_abc123]');
  assert.equal(anchors[0].line, 42);
});

test('parseAnchors does not over-consume across sibling anchors', () => {
  // Two anchors in sequence — greedy .+ would merge them
  const s = '[file.md:L1] first [other.md:L2] second';
  const anchors = parseAnchors(s);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].file, 'file.md');
  assert.equal(anchors[1].file, 'other.md');
});

test('parseAnchors returns empty for no anchors', () => {
  assert.deepEqual(parseAnchors('no anchors here'), []);
});

test('parseAnchors skips malformed anchors', () => {
  const s = '[file.md] no line [file.md:L] bad number';
  assert.deepEqual(parseAnchors(s), []);
});

test('parseAnchors handles anchor at start of string', () => {
  const s = '[file.md:L5] the quote';
  const anchors = parseAnchors(s);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].start, 0);
});

test('parseAnchors handles anchor at end of string', () => {
  const s = 'the quote [file.md:L5]';
  const anchors = parseAnchors(s);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].end, s.length);
});

// ---------- paddingRanges ----------

test('paddingRanges identifies session-event blocks', () => {
  const lines = [
    '## [seq 1] session-event: synthetic',
    'padding line 1',
    'padding line 2',
    '## [seq 2] user: real content',
    'real line',
  ];
  const ranges = paddingRanges(lines);
  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0], [1, 3]); // 0-based: lines 1-2 are padding
});

test('paddingRanges handles multiple session-events', () => {
  const lines = [
    '## [seq 1] session-event: synthetic',
    'pad 1',
    '## [seq 2] user: content',
    'real',
    '## [seq 3] session-event: synthetic',
    'pad 2',
    '## [seq 4] assistant: response',
  ];
  const ranges = paddingRanges(lines);
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges[0], [1, 2]);
  assert.deepEqual(ranges[1], [5, 6]);
});

test('paddingRanges returns empty when no session-events', () => {
  const lines = ['line 1', 'line 2', 'line 3'];
  assert.deepEqual(paddingRanges(lines), []);
});

test('paddingRanges handles unclosed session-event at end', () => {
  const lines = [
    '## [seq 1] user: content',
    'real',
    '## [seq 2] session-event: synthetic',
    'pad',
  ];
  const ranges = paddingRanges(lines);
  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0], [3, 4]); // to end of array
});

// ---------- fixtures ----------

// A fixture root holding just enough of a `package.json` for the anchor checks.
// Line 1 is `{` so a quote on it is never verbatim; line 2 carries `ai-skills`,
// so an anchor pointing there passes.
function fixtureRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anchors-root-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    '{\n  "name": "ai-skills",\n  "version": "0.0.0"\n}\n',
  );
  return dir;
}

// A chunk file in its own temp dir; `nodes` is written verbatim.
function chunkFile(nodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anchors-chunk-'));
  const chunkPath = path.join(dir, 'chunk-test.json');
  fs.writeFileSync(chunkPath, JSON.stringify({ nodes, links: [] }));
  return { dir, chunkPath };
}

const cleanup = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};

// ---------- resolveFile ----------

test('resolveFile returns null for non-existent file', () => {
  const root = fixtureRoot();
  assert.equal(resolveFile('nonexistent/path/file.md', [root]), null);
  cleanup(root);
});

test('resolveFile searches every root, not just the first', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anchors-root-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anchors-root-b-'));
  fs.writeFileSync(path.join(second, 'package.json'), '{}\n');
  const result = resolveFile('package.json', [first, second]);
  assert.ok(result !== null);
  assert.ok(result.startsWith(second));
  assert.ok(result.endsWith('package.json'));
  cleanup(first, second);
});

// ---------- checkChunk ----------

test('checkChunk reports missing source_file', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'nonexistent/file.md', source_location: 'L1', rationale: 'test' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.nodes, 1);
  assert.equal(result.fileMissing, 1);
  assert.ok(result.failures.some((f) => f.includes('not on disk')));
  cleanup(dir, root);
});

test('checkChunk reports out-of-range source_location', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'L99999', rationale: 'test' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.locOutOfRange, 1);
  assert.ok(result.failures.some((f) => f.includes('out of range')));
  cleanup(dir, root);
});

test('checkChunk reports invalid source_location format', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'invalid', rationale: 'test' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.ok(result.failures.some((f) => f.includes('is not L<n>')));
  cleanup(dir, root);
});

test('checkChunk reports zero parsed anchors', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'L1', rationale: 'no anchors here' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.anchorsParsed, 0);
  assert.ok(result.failures.some((f) => f.includes('ZERO parsed anchors')));
  cleanup(dir, root);
});

test('checkChunk reports anchor with empty quoted span', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'L1', rationale: '[package.json:L1]' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.anchorsFailed, 1);
  assert.ok(result.failures.some((f) => f.includes('empty quoted span')));
  cleanup(dir, root);
});

test('checkChunk reports anchor path not on disk', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'L1', rationale: '[nonexistent.md:L1] quote' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.anchorsFailed, 1);
  assert.ok(result.failures.some((f) => f.includes('anchor path not on disk')));
  cleanup(dir, root);
});

test('checkChunk reports anchor line out of range', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'L1', rationale: '[package.json:L99999] quote' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.anchorsFailed, 1);
  assert.ok(result.failures.some((f) => f.includes('out of range')));
  cleanup(dir, root);
});

test('checkChunk reports verbatim quote failure', () => {
  // Fixture line 1 is '{' — this quote is not on it.
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'L1', rationale: '[package.json:L1] definitely not on this line' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.anchorsFailed, 1);
  assert.ok(result.failures.some((f) => f.includes('does NOT contain the quoted span')));
  cleanup(dir, root);
});

test('checkChunk passes when quote is verbatim', () => {
  // Fixture line 2 is '  "name": "ai-skills",' — 'ai-skills' is verbatim there.
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'L2', rationale: '[package.json:L2] ai-skills' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.anchorsFailed, 0);
  assert.equal(result.failures.length, 0);
  cleanup(dir, root);
});

test('checkChunk flags an anchor that falls inside a padding block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anchors-root-'));
  fs.writeFileSync(
    path.join(root, 'note.md'),
    '## [seq 1] session-event: synthetic\npadding\n## [seq 2] user: real\nquote\n',
  );
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'note.md', source_location: 'L4', rationale: '[note.md:L2] padding' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.anchorsInPadding, 1);
  assert.ok(result.failures.some((f) => f.includes('padding block')));
  cleanup(dir, root);
});

test('checkChunk handles array rationale', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    {
      id: 'node-1',
      source_file: 'package.json',
      source_location: 'L2',
      rationale: ['[package.json:L2] ai-skills', '[package.json:L2] ai-skills'],
    },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.anchorsParsed, 2);
  assert.equal(result.anchorsFailed, 0);
  cleanup(dir, root);
});

test('checkChunk handles missing rationale', () => {
  const root = fixtureRoot();
  const { dir, chunkPath } = chunkFile([
    { id: 'node-1', source_file: 'package.json', source_location: 'L2' },
  ]);
  const result = checkChunk(chunkPath, { roots: [root] });
  assert.equal(result.nodes, 1);
  assert.equal(result.anchorsParsed, 0);
  cleanup(dir, root);
});

// --- default roots: env var first, then local.config.json, never a default ----

describe('resolveDefaultRoots', () => {
  // Both variables are managed by every test so a value inherited from the
  // caller's shell cannot flip a case; afterEach restores what was there.
  const envKeys = ['VAULT_ROOT', 'ARCHIVE_ROOT'];
  let saved;

  beforeEach(() => {
    saved = envKeys.map((key) => [key, process.env[key]]);
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // The file is never created: resolution must take the env branch without
  // reading, or throwing against, any real local.config.json.
  function absentConfig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anchors-roots-'));
    return { configPath: path.join(dir, 'absent.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  test('roots come from their env vars when set, archive first', () => {
    process.env.VAULT_ROOT = '/tmp/vault-from-env';
    process.env.ARCHIVE_ROOT = '/tmp/archive-from-env';
    const { configPath, cleanup: rmConfig } = absentConfig();
    try {
      assert.deepEqual(resolveDefaultRoots({ configPath }), ['/tmp/archive-from-env', '/tmp/vault-from-env']);
    } finally {
      rmConfig();
    }
  });

  test('env wins over the config file, per key', () => {
    process.env.VAULT_ROOT = '/env/vault';
    delete process.env.ARCHIVE_ROOT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anchors-roots-'));
    const configPath = path.join(dir, 'local.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ vaultRoot: '/cfg/vault', archiveRoot: '/cfg/archive' }), 'utf8');
    try {
      assert.deepEqual(resolveDefaultRoots({ configPath }), ['/cfg/archive', '/env/vault']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no env var, roots fall back to the config file', () => {
    delete process.env.VAULT_ROOT;
    delete process.env.ARCHIVE_ROOT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-anchors-roots-'));
    const configPath = path.join(dir, 'local.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ vaultRoot: '/cfg/vault', archiveRoot: '/cfg/archive' }), 'utf8');
    try {
      assert.deepEqual(resolveDefaultRoots({ configPath }), ['/cfg/archive', '/cfg/vault']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no default path: with no env var and no config it throws, naming the env var and the example file', () => {
    delete process.env.VAULT_ROOT;
    delete process.env.ARCHIVE_ROOT;
    const { configPath, cleanup: rmConfig } = absentConfig();
    try {
      // The archive root is resolved first, so it is the one an entirely empty
      // config trips over.
      assert.throws(() => resolveDefaultRoots({ configPath }), /set ARCHIVE_ROOT/);
      assert.throws(() => resolveDefaultRoots({ configPath }), /local\.config\.example\.json/);
      // With the archive root provided, the missing vault root is what throws.
      process.env.ARCHIVE_ROOT = '/tmp/archive-from-env';
      assert.throws(() => resolveDefaultRoots({ configPath }), /set VAULT_ROOT/);
    } finally {
      rmConfig();
    }
  });
});
