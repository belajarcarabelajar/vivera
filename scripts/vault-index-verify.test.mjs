// scripts/vault-index-verify.test.mjs
//
// T12's regression suite. The graph was assembled by hand, not by
// `graphify extract`, so the question is not "does graphify accept it" but "do the
// read paths an agent uses work, and is the coverage claim true".
//
// The pure checks are driven with fixtures and never touch the vault, so the file
// runs anywhere. The graphify read paths are integration and are exercised by the
// runner (`bun scripts/vault-index-verify.mjs`) and by T14's gate, not here —
// `checkReadPaths` takes an injected runner so its logic is still unit-tested
// without spawning graphify.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sourceFilesOf,
  checkCoverage,
  checkExcludedPrefixes,
  pickGodNode,
  checkReadPaths,
  resolveArchiveRoot,
  resolveVaultRoot,
  resolveGraphPath,
  DEFAULT_GRAPH_RELPATH,
} from './vault-index-verify.mjs';

// A small graph: a-b-c chain plus an isolated node. `b` is the god (degree 2).
function fixtureGraph() {
  return {
    nodes: [
      { id: 'a', label: 'Alpha', source_file: 'a.md' },
      { id: 'b', label: 'Beta', source_file: 'b.md' },
      { id: 'c', label: 'Gamma', source_file: 'c.md' },
      { id: 'iso', label: 'Iso', source_file: 'iso.md' },
    ],
    links: [
      { source: 'a', target: 'b', relation: 'rel' },
      { source: 'b', target: 'c', relation: 'rel' },
    ],
  };
}

test('sourceFilesOf collects every non-empty source_file', () => {
  const graph = {
    nodes: [
      { id: 'a', source_file: 'a.md' },
      { id: 'b', source_file: 'b.md' },
      { id: 'c', source_file: '' },
      { id: 'd' },
      { id: 'e', source_file: '   ' },
    ],
    links: [],
  };
  const set = sourceFilesOf(graph);
  assert.deepEqual([...set].sort(), ['a.md', 'b.md']);
});

test('checkCoverage passes when every worklist path is indexed', () => {
  const { ok, problems } = checkCoverage(fixtureGraph(), { skipped: [] }, ['a.md', 'b.md', 'c.md', 'iso.md']);
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
});

test('checkCoverage fails when a path is neither indexed nor skipped', () => {
  const { ok, problems } = checkCoverage(fixtureGraph(), { skipped: [] }, ['a.md', 'missing.md']);
  assert.equal(ok, false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing\.md/);
});

test('checkCoverage passes a path that is in the recorded skip list', () => {
  // The skip list is a recorded fact, so a skipped path is not a coverage gap.
  const { ok, problems } = checkCoverage(fixtureGraph(), { skipped: [{ path: 'missing.md' }] }, ['a.md', 'missing.md']);
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
});

test('checkExcludedPrefixes passes when no source_file is excluded', () => {
  const { ok, problems } = checkExcludedPrefixes(new Set(['a.md', 'b.md']), ['secret/x.md']);
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
});

test('checkExcludedPrefixes fails a source_file under an excluded prefix', () => {
  // The ignore rules are a privacy boundary, so this must fail loudly rather than
  // read as a coverage gap.
  const { ok, problems } = checkExcludedPrefixes(new Set(['a.md', 'Satset/secret.md']), ['Satset/secret.md']);
  assert.equal(ok, false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Satset\/secret\.md/);
});

test('pickGodNode returns the highest-degree node and a neighbour', () => {
  const { god, neighbour } = pickGodNode(fixtureGraph());
  assert.equal(god, 'b', 'b has degree 2, the highest');
  assert.ok(neighbour === 'a' || neighbour === 'c');
});

test('pickGodNode handles a graph with no edges', () => {
  const { god, neighbour } = pickGodNode({ nodes: [{ id: 'a' }], links: [] });
  assert.equal(god, null);
  assert.equal(neighbour, null);
});

test('checkReadPaths passes when all three commands exit 0 with output', () => {
  const calls = [];
  const fake = (args) => {
    calls.push(args[0]);
    return { status: 0, stdout: 'some output', stderr: '' };
  };
  const { ok, checks } = checkReadPaths(fixtureGraph(), { run: fake });
  assert.equal(ok, true);
  assert.deepEqual(checks.map((c) => c.name), ['query', 'explain', 'path']);
  assert.deepEqual(calls, ['query', 'explain', 'path']);
});

test('checkReadPaths fails when a command exits non-zero', () => {
  const fake = (args) => {
    if (args[0] === 'path') return { status: 1, stdout: '', stderr: 'boom' };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const { ok, checks } = checkReadPaths(fixtureGraph(), { run: fake });
  assert.equal(ok, false);
  const path = checks.find((c) => c.name === 'path');
  assert.equal(path.ok, false);
});

test('checkReadPaths fails when a command produces no output', () => {
  // A graph that loads but answers nothing is indistinguishable from a broken
  // one without this, so empty output is a failure, not a pass.
  const fake = () => ({ status: 0, stdout: '   ', stderr: '' });
  const { ok } = checkReadPaths(fixtureGraph(), { run: fake });
  assert.equal(ok, false);
});

test('checkReadPaths reports no connected node to query on an edgeless graph', () => {
  const { ok, checks } = checkReadPaths({ nodes: [{ id: 'a' }], links: [] }, { run: () => ({ status: 0, stdout: 'x', stderr: '' }) });
  assert.equal(ok, false);
  assert.equal(checks.length, 1);
  assert.match(checks[0].detail, /no connected node/);
});

// --- corpus roots: env var first, then local.config.json, never a default ----

describe('resolveArchiveRoot / resolveVaultRoot / resolveGraphPath', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'verify-roots-'));
    return { configPath: join(dir, 'absent.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test('each root comes from its env var when set', () => {
    process.env.VAULT_ROOT = '/tmp/vault-from-env';
    process.env.ARCHIVE_ROOT = '/tmp/archive-from-env';
    const { configPath, cleanup } = absentConfig();
    try {
      assert.equal(resolveVaultRoot({ configPath }), '/tmp/vault-from-env');
      assert.equal(resolveArchiveRoot({ configPath }), '/tmp/archive-from-env');
    } finally {
      cleanup();
    }
  });

  test('env wins over the config file, per key', () => {
    process.env.VAULT_ROOT = '/env/vault';
    delete process.env.ARCHIVE_ROOT;
    const dir = mkdtempSync(join(tmpdir(), 'verify-roots-'));
    const configPath = join(dir, 'local.config.json');
    writeFileSync(configPath, JSON.stringify({ vaultRoot: '/cfg/vault', archiveRoot: '/cfg/archive' }), 'utf8');
    try {
      assert.equal(resolveVaultRoot({ configPath }), '/env/vault');
      assert.equal(resolveArchiveRoot({ configPath }), '/cfg/archive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no env var, a root falls back to the config file', () => {
    delete process.env.VAULT_ROOT;
    delete process.env.ARCHIVE_ROOT;
    const dir = mkdtempSync(join(tmpdir(), 'verify-roots-'));
    const configPath = join(dir, 'local.config.json');
    writeFileSync(configPath, JSON.stringify({ vaultRoot: '/cfg/vault', archiveRoot: '/cfg/archive' }), 'utf8');
    try {
      assert.equal(resolveVaultRoot({ configPath }), '/cfg/vault');
      assert.equal(resolveArchiveRoot({ configPath }), '/cfg/archive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no default path: with no env var and no config it throws, naming the env var and the example file', () => {
    delete process.env.VAULT_ROOT;
    delete process.env.ARCHIVE_ROOT;
    const { configPath, cleanup } = absentConfig();
    try {
      assert.throws(() => resolveVaultRoot({ configPath }), /set VAULT_ROOT/);
      assert.throws(() => resolveVaultRoot({ configPath }), /local\.config\.example\.json/);
      assert.throws(() => resolveArchiveRoot({ configPath }), /set ARCHIVE_ROOT/);
      assert.throws(() => resolveArchiveRoot({ configPath }), /local\.config\.example\.json/);
    } finally {
      cleanup();
    }
  });

  test('resolveGraphPath joins DEFAULT_GRAPH_RELPATH under the resolved vault root', () => {
    process.env.VAULT_ROOT = '/tmp/vault-from-env';
    delete process.env.ARCHIVE_ROOT;
    const { configPath, cleanup } = absentConfig();
    try {
      assert.equal(resolveGraphPath({ configPath }), join('/tmp/vault-from-env', DEFAULT_GRAPH_RELPATH));
    } finally {
      cleanup();
    }
  });
});
