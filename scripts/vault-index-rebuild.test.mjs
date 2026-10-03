import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildIdBySourceFile,
  normalizePreviousIds,
  degreeZero,
  gateVerdict,
  buildManifest,
  resolveUnderRoots,
  resolveVaultRoot,
  resolveArchiveRoot,
} from './vault-index-rebuild.mjs';

const doc = (id, source_file) => ({ id, file_type: 'document', source_file });

describe('buildIdBySourceFile', () => {
  test('indexes only document nodes, by source_file', () => {
    const chunks = [
      { chunk: { nodes: [doc('a', 'x.md'), { id: 'c1', file_type: 'concept', source_file: 'x.md' }] } },
      { chunk: { nodes: [doc('b', 'y.md')] } },
    ];
    const m = buildIdBySourceFile(chunks);
    expect(m.get('x.md')).toBe('a');
    expect(m.get('y.md')).toBe('b');
    expect(m.size).toBe(2);
  });

  test('first document id wins on a repeated source_file', () => {
    const m = buildIdBySourceFile([
      { chunk: { nodes: [doc('first', 'x.md')] } },
      { chunk: { nodes: [doc('second', 'x.md')] } },
    ]);
    expect(m.get('x.md')).toBe('first');
  });

  test('never lets a heading node become the mapped document id', () => {
    const m = buildIdBySourceFile([
      { chunk: { nodes: [{ id: 'h', file_type: 'document', node_kind: 'heading', source_file: 'x.md' }, doc('root', 'x.md')] } },
    ]);
    expect(m.get('x.md')).toBe('root');
  });
});

describe('normalizePreviousIds', () => {
  test('remaps a document id and rewrites its links', () => {
    const previous = {
      nodes: [doc('old_doc', 'notes/x.md'), { id: 'concept--c', file_type: 'concept', source_file: 'notes/x.md' }],
      links: [{ source: 'old_doc', target: 'concept--c', relation: 'mentions' }],
    };
    const { previous: out, report } = normalizePreviousIds(previous, new Map([['notes/x.md', 'notes_x']]));
    expect(out.nodes.find((n) => n.id === 'notes_x')).toBeTruthy();
    expect(out.nodes.some((n) => n.id === 'old_doc')).toBe(false);
    expect(out.links[0].source).toBe('notes_x');
    expect(report.documentIdsRemapped).toBe(1);
    expect(report.linksRewritten).toBe(1);
  });

  test('never remaps a heading node, even though it is file_type document', () => {
    // The structural layer gives heading nodes `file_type: 'document'`. Fusing
    // one onto its file's document id would carry the heading's source_location
    // and heading_level onto the document and break a re-run's idempotency.
    const previous = {
      nodes: [
        doc('x', 'x.md'),
        { id: 'x_heading', file_type: 'document', node_kind: 'heading', source_file: 'x.md', source_location: 'L3' },
      ],
      links: [],
    };
    const { previous: out, report } = normalizePreviousIds(previous, new Map([['x.md', 'x']]));
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['x', 'x_heading']);
    expect(report.documentIdsRemapped).toBe(0);
  });

  test('never remaps a non-document node, even when it cites the same file', () => {
    const previous = {
      nodes: [{ id: 'concept--c', file_type: 'concept', source_file: 'notes/x.md' }],
      links: [],
    };
    const { previous: out, report } = normalizePreviousIds(previous, new Map([['notes/x.md', 'notes_x']]));
    expect(out.nodes[0].id).toBe('concept--c');
    expect(report.documentIdsRemapped).toBe(0);
  });

  test('collapses two documents that map to one id', () => {
    const previous = {
      nodes: [doc('a', 'x.md'), { ...doc('b', 'x.md'), label: 'filled' }],
      links: [{ source: 'a', target: 'b', relation: 'rel' }],
    };
    const { previous: out, report } = normalizePreviousIds(previous, new Map([['x.md', 'x']]));
    expect(out.nodes.length).toBe(1);
    expect(report.nodesCollapsed).toBe(1);
    // the edge between the two fused nodes becomes a self-loop and is dropped
    expect(report.selfLoopsDropped).toBe(1);
    expect(out.links.length).toBe(0);
  });

  test('is a no-op (same object) when nothing maps', () => {
    const previous = { nodes: [doc('a', 'x.md')], links: [] };
    const { previous: out, report } = normalizePreviousIds(previous, new Map());
    expect(out).toBe(previous);
    expect(report.documentIdsRemapped).toBe(0);
  });

  test('does not mutate the input', () => {
    const previous = { nodes: [doc('a', 'x.md')], links: [] };
    normalizePreviousIds(previous, new Map([['x.md', 'x']]));
    expect(previous.nodes[0].id).toBe('a');
  });
});

describe('degreeZero', () => {
  test('counts nodes absent from every endpoint', () => {
    const graph = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      links: [{ source: 'a', target: 'b' }],
    };
    expect(degreeZero(graph)).toBe(1);
  });
});

describe('gateVerdict', () => {
  test('passes when nodes do not shrink and degree-0 falls', () => {
    const previous = { nodes: [{ id: 'a' }, { id: 'b' }], links: [] };
    const graph = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links: [{ source: 'a', target: 'c' }] };
    const v = gateVerdict(graph, previous);
    expect(v.pass).toBe(true);
    expect(v.d0Before).toBe(2);
    expect(v.d0After).toBe(1);
  });

  test('fails when degree-0 rises, even if nodes grow', () => {
    const previous = { nodes: [{ id: 'a' }], links: [{ source: 'a', target: 'z' }] };
    const graph = { nodes: [{ id: 'a' }, { id: 'b' }], links: [{ source: 'a', target: 'z' }] };
    const v = gateVerdict(graph, previous);
    expect(v.pass).toBe(false);
    expect(v.d0After).toBe(1);
    expect(v.d0Before).toBe(0);
  });
});

// --- T9 manifest: every indexed file + content hash, and the skip list -------

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function tempRoots() {
  const dir = mkdtempSync(join(tmpdir(), 'vault-manifest-'));
  const rootA = join(dir, 'archive');
  const rootB = join(dir, 'vault');
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  return { dir, rootA, rootB, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('resolveUnderRoots', () => {
  test('resolves to the first root under which the file exists', () => {
    const { rootA, rootB, cleanup } = tempRoots();
    try {
      writeFileSync(join(rootA, 'a.md'), 'a', 'utf8');
      writeFileSync(join(rootB, 'b.md'), 'b', 'utf8');
      expect(resolveUnderRoots('a.md', [rootA, rootB])?.root).toBe(rootA);
      expect(resolveUnderRoots('b.md', [rootA, rootB])?.root).toBe(rootB);
    } finally {
      cleanup();
    }
  });

  test('returns null for a file that exists under no root', () => {
    const { rootA, cleanup } = tempRoots();
    try {
      expect(resolveUnderRoots('ghost.md', [rootA])).toBe(null);
    } finally {
      cleanup();
    }
  });

  test('refuses a path that escapes the root', () => {
    const { rootA, cleanup } = tempRoots();
    try {
      // A traversal that resolves to a real file outside the root must not be
      // attributed to the root: that would record an external file as indexed.
      expect(resolveUnderRoots('../escape.md', [rootA])).toBe(null);
    } finally {
      cleanup();
    }
  });
});

describe('buildManifest', () => {
  test('indexes cited files with a content hash, and lists the rest as skipped', () => {
    const { rootA, rootB, cleanup } = tempRoots();
    try {
      writeFileSync(join(rootA, 'a.md'), 'alpha', 'utf8');
      writeFileSync(join(rootB, 'b.md'), 'beta', 'utf8');
      const graph = {
        nodes: [
          { id: 'n1', file_type: 'concept', source_file: 'a.md' },
          { id: 'n2', file_type: 'concept', source_file: 'a.md' },
          { id: 'n3', file_type: 'concept', source_file: 'b.md' },
          { id: 'n4', file_type: 'concept', source_file: 'ghost.md' },
        ],
        links: [],
      };
      const eligibleByRoot = [
        { root: rootA, eligible: ['a.md', 'skip.md'] },
        { root: rootB, eligible: ['b.md'] },
      ];
      const m = buildManifest({ graph, roots: [rootA, rootB], eligibleByRoot, builtAtCommit: 'abc' });

      expect(m.files['a.md'].sha256).toBe(sha256('alpha'));
      expect(m.files['a.md'].root).toBe(rootA);
      expect(m.files['a.md'].nodes).toBe(2, 'two nodes cite a.md');
      expect(m.files['b.md'].sha256).toBe(sha256('beta'));
      expect(m.files['b.md'].root).toBe(rootB);
      expect(m.unresolved).toEqual(['ghost.md'], 'a deleted file is reported, not dropped');
      expect(m.skipped).toEqual([
        { path: 'skip.md', root: rootA, reason: 'no node cites this file' },
      ]);
      expect(m.totals).toEqual({
        eligible: 3,
        indexed: 2,
        skipped: 1,
        unresolved: 1,
        nodes: 4,
        links: 0,
      });
      expect(m.built_at_commit).toBe('abc');
      expect(m.version).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('a source_file that resolves under no root is unresolved, not indexed', () => {
    const { rootA, cleanup } = tempRoots();
    try {
      const graph = { nodes: [{ id: 'n1', file_type: 'concept', source_file: 'gone.md' }], links: [] };
      const m = buildManifest({ graph, roots: [rootA], eligibleByRoot: [{ root: rootA, eligible: [] }] });
      expect(m.files).toEqual({});
      expect(m.unresolved).toEqual(['gone.md']);
      expect(m.totals.indexed).toBe(0);
      expect(m.totals.unresolved).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('an eligible file that no node cites is skipped', () => {
    const { rootA, cleanup } = tempRoots();
    try {
      writeFileSync(join(rootA, 'a.md'), 'alpha', 'utf8');
      writeFileSync(join(rootA, 'orphan.md'), 'x', 'utf8');
      const graph = { nodes: [{ id: 'n1', file_type: 'concept', source_file: 'a.md' }], links: [] };
      const m = buildManifest({
        graph,
        roots: [rootA],
        eligibleByRoot: [{ root: rootA, eligible: ['a.md', 'orphan.md'] }],
      });
      expect(m.skipped).toHaveLength(1);
      expect(m.skipped[0].path).toBe('orphan.md');
      expect(m.totals.skipped).toBe(1);
      expect(m.totals.indexed).toBe(1);
    } finally {
      cleanup();
    }
  });
});

// --- corpus roots: env var first, then local.config.json, never a default ----

describe('resolveVaultRoot / resolveArchiveRoot', () => {
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
  // reading, or throw against, any real local.config.json.
  function absentConfig() {
    const dir = mkdtempSync(join(tmpdir(), 'vault-roots-'));
    return { configPath: join(dir, 'absent.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test('each root comes from its env var when set', () => {
    process.env.VAULT_ROOT = '/tmp/vault-from-env';
    process.env.ARCHIVE_ROOT = '/tmp/archive-from-env';
    const { configPath, cleanup } = absentConfig();
    try {
      expect(resolveVaultRoot({ configPath })).toBe('/tmp/vault-from-env');
      expect(resolveArchiveRoot({ configPath })).toBe('/tmp/archive-from-env');
    } finally {
      cleanup();
    }
  });

  test('env wins over the config file', () => {
    process.env.VAULT_ROOT = '/env/vault';
    delete process.env.ARCHIVE_ROOT;
    const dir = mkdtempSync(join(tmpdir(), 'vault-roots-'));
    const configPath = join(dir, 'local.config.json');
    writeFileSync(configPath, JSON.stringify({ vaultRoot: '/cfg/vault', archiveRoot: '/cfg/archive' }), 'utf8');
    try {
      expect(resolveVaultRoot({ configPath })).toBe('/env/vault');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no env var, a root falls back to the config file', () => {
    delete process.env.VAULT_ROOT;
    delete process.env.ARCHIVE_ROOT;
    const dir = mkdtempSync(join(tmpdir(), 'vault-roots-'));
    const configPath = join(dir, 'local.config.json');
    writeFileSync(configPath, JSON.stringify({ vaultRoot: '/cfg/vault', archiveRoot: '/cfg/archive' }), 'utf8');
    try {
      expect(resolveVaultRoot({ configPath })).toBe('/cfg/vault');
      expect(resolveArchiveRoot({ configPath })).toBe('/cfg/archive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no default path: with no env var and no config it throws, naming the env var and the example file', () => {
    delete process.env.VAULT_ROOT;
    delete process.env.ARCHIVE_ROOT;
    const { configPath, cleanup } = absentConfig();
    try {
      expect(() => resolveVaultRoot({ configPath })).toThrow(/set VAULT_ROOT/);
      expect(() => resolveVaultRoot({ configPath })).toThrow(/local\.config\.example\.json/);
      expect(() => resolveArchiveRoot({ configPath })).toThrow(/set ARCHIVE_ROOT/);
      expect(() => resolveArchiveRoot({ configPath })).toThrow(/local\.config\.example\.json/);
    } finally {
      cleanup();
    }
  });
});
