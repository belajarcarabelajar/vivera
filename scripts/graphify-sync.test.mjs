// scripts/graphify-sync.test.mjs
//
// Guards for the end-of-session sync that registers this repository's Markdown
// in its own graphify graph.
//
// The two properties worth testing are the two that are invisible from the
// outside. The first is that a re-run is a no-op: `structural()` is
// deterministic and `merge()` is a union keyed on node id, so syncing twice must
// produce byte-identical graphs — otherwise every session's end would rewrite a
// multi-megabyte file and the "is the graph current?" check could never be green.
// The second is that the graphify-era document ids already in the graph are
// remapped onto this layer's ids instead of being duplicated, because the
// failure mode of getting that wrong is a second node for every known file and
// an orphaned first one, which no count anywhere reports.
//
// The tests run against a temporary root, so they never touch the real graph and
// never depend on graphify or the network.

import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  buildDocIdBySourceFile,
  planSync,
  gateVerdict,
  toRepoRelative,
} from './graphify-sync.mjs';
import * as syncModule from './graphify-sync.mjs';
import { serializeGraph } from './vault-index-merge.mjs';

/** A throwaway root with the named files written. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'graphify-sync-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}

const NOTE = `---
title: Session handoff
---

# Session handoff

## Next action

Continue the pipeline. See [[other-note]].
`;

const OTHER = `# Other note

Body.
`;

/** A previous graph carrying the code graph plus one already-known document. */
function previousGraph() {
  return {
    directed: false,
    multigraph: false,
    graph: { hyperedges: [] },
    nodes: [
      { id: 'code_foo', label: 'foo', file_type: 'code', source_file: 'scripts/x.mjs' },
      // The id this layer would NOT choose, so the remap path is exercised.
      { id: 'graphify_era_handoff', label: 'Session handoff', file_type: 'document', source_file: 'docs/handoff.md' },
      { id: 'concept--c', label: 'A claim', file_type: 'concept', source_file: 'docs/handoff.md' },
    ],
    links: [{ source: 'concept--c', target: 'graphify_era_handoff', relation: 'mentions', confidence: 'INFERRED' }],
    built_at_commit: 'deadbeef',
  };
}

describe('buildDocIdBySourceFile', () => {
  test('maps a source_file to its document node, never to a heading node', () => {
    const chunks = [
      {
        chunk: {
          nodes: [
            { id: 'doc_for_x', file_type: 'document', node_kind: 'document', source_file: 'x.md' },
            { id: 'heading_under_x', file_type: 'document', node_kind: 'heading', source_file: 'x.md' },
          ],
        },
      },
    ];
    const map = buildDocIdBySourceFile(chunks);
    expect(map.get('x.md')).toBe('doc_for_x');
  });

  test('ignores a non-document node citing the same file', () => {
    const map = buildDocIdBySourceFile([
      { chunk: { nodes: [{ id: 'c1', file_type: 'concept', source_file: 'x.md' }] } },
    ]);
    expect(map.has('x.md')).toBe(false);
  });
});

describe('planSync', () => {
  test('adds a document node and its headings for a new note', () => {
    const root = fixture({ 'docs/handoff.md': NOTE });
    try {
      const { graph, structuralReport } = planSync({ root, files: ['docs/handoff.md'], previous: previousGraph() });
      const doc = graph.nodes.find((n) => n.node_kind === 'document' && n.source_file === 'docs/handoff.md');
      expect(doc).toBeTruthy();
      expect(doc.label).toBe('Session handoff');
      expect(structuralReport.noSourceFile).toBe(0);
      expect(graph.nodes.length).toBeGreaterThan(previousGraph().nodes.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('remaps an existing document id instead of duplicating the file', () => {
    const root = fixture({ 'docs/handoff.md': NOTE });
    try {
      const { graph, normalization } = planSync({ root, files: ['docs/handoff.md'], previous: previousGraph() });
      const docs = graph.nodes.filter((n) => n.file_type === 'document' && n.source_file === 'docs/handoff.md' && n.node_kind !== 'heading');
      expect(docs.length).toBe(1);
      expect(docs[0].id).not.toBe('graphify_era_handoff');
      expect(normalization.documentIdsRemapped).toBe(1);
      // The concept's edge followed the remap rather than dangling.
      expect(graph.links.some((l) => l.source === 'concept--c' && l.target === docs[0].id)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('is idempotent: a second run over its own output is byte-identical', () => {
    const root = fixture({ 'docs/handoff.md': NOTE, 'docs/other.md': OTHER });
    try {
      const files = ['docs/handoff.md', 'docs/other.md'];
      const first = planSync({ root, files, previous: previousGraph() }).graph;
      const second = planSync({ root, files, previous: first }).graph;
      expect(serializeGraph(second)).toBe(serializeGraph(first));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains every previous code, concept and rationale node', () => {
    const root = fixture({ 'docs/handoff.md': NOTE });
    try {
      const { graph } = planSync({ root, files: ['docs/handoff.md'], previous: previousGraph() });
      expect(graph.nodes.some((n) => n.id === 'code_foo')).toBe(true);
      expect(graph.nodes.some((n) => n.id === 'concept--c')).toBe(true);
      expect(graph.built_at_commit).toBe('deadbeef');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gateVerdict', () => {
  test('passes when the union grows or holds', () => {
    expect(gateVerdict({ nodes: [{ id: 'a' }, { id: 'b' }] }, { nodes: [{ id: 'a' }] }).pass).toBe(true);
    expect(gateVerdict({ nodes: [{ id: 'a' }] }, { nodes: [{ id: 'a' }] }).pass).toBe(true);
  });

  test('refuses when the union would lose a node', () => {
    expect(gateVerdict({ nodes: [] }, { nodes: [{ id: 'a' }] }).pass).toBe(false);
  });
});

describe('toRepoRelative', () => {
  test('relativises an absolute path and trusts a relative one', () => {
    expect(toRepoRelative('/repo', '/repo/docs/a.md')).toBe('docs/a.md');
    expect(toRepoRelative('/repo', 'docs/a.md')).toBe('docs/a.md');
  });
});

/** A throwaway graphify-out holding the named directories and files. */
function outDirFixture({ dirs = [], files = {} }) {
  const outDir = mkdtempSync(join(tmpdir(), 'graphify-sync-prune-'));
  for (const d of dirs) mkdirSync(join(outDir, d), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return outDir;
}

describe('pruneSyncBackups', () => {
  const KEEP = 'backup-2026-10-15-sync';

  test('removes every older sync backup directory and returns the removed names sorted', () => {
    const outDir = outDirFixture({
      dirs: ['backup-2026-10-03-sync', 'backup-2026-09-30-sync', KEEP],
      files: { 'backup-2026-10-01-sync/graph.json': '{"old":1}' },
    });
    try {
      const removed = syncModule.pruneSyncBackups(outDir, KEEP);
      expect(removed).toEqual(['backup-2026-09-30-sync', 'backup-2026-10-01-sync', 'backup-2026-10-03-sync']);
      expect(readdirSync(outDir).sort()).toEqual([KEEP]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('leaves the kept backup, non-backup entries, a same-named regular file and near-miss names untouched', () => {
    const outDir = outDirFixture({
      dirs: ['cache', 'backup-foo-sync', 'backup-2026-10-01-sync-old'],
      files: {
        [`${KEEP}/graph.json`]: '{"kept":1}',
        '2026-10-02/graph.json': '{"dated":1}',
        'backup-2026-10-01-sync': 'a regular file, not a backup directory',
        'graph.json': '{"live":1}',
      },
    });
    try {
      const removed = syncModule.pruneSyncBackups(outDir, KEEP);
      expect(removed).toEqual([]);
      expect(readdirSync(outDir).sort()).toEqual([
        '2026-10-02',
        'backup-2026-10-01-sync',
        'backup-2026-10-01-sync-old',
        KEEP,
        'backup-foo-sync',
        'cache',
        'graph.json',
      ]);
      expect(readFileSync(join(outDir, KEEP, 'graph.json'), 'utf8')).toBe('{"kept":1}');
      expect(readFileSync(join(outDir, '2026-10-02', 'graph.json'), 'utf8')).toBe('{"dated":1}');
      expect(statSync(join(outDir, 'backup-2026-10-01-sync')).isFile()).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('returns an empty list without throwing when the directory does not exist', () => {
    const parent = mkdtempSync(join(tmpdir(), 'graphify-sync-prune-missing-'));
    try {
      const missing = join(parent, 'graphify-out');
      expect(existsSync(missing)).toBe(false);
      expect(syncModule.pruneSyncBackups(missing, KEEP)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('pruneGraphifyDatedBackups', () => {
  test('keeps the newest graphify dated backup and returns the removed older ones sorted', () => {
    const outDir = outDirFixture({
      files: {
        '2026-10-09/graph.json': '{"day":9}',
        '2026-10-09/GRAPH_REPORT.md': '# day 9',
        '2026-10-09/.graphify_labels.json': '{}',
        '2026-10-15/graph.json': '{"day":15}',
        '2026-10-15/GRAPH_REPORT.md': '# day 15',
        '2026-10-02/graph.json': '{"day":2}',
        '2026-10-02/GRAPH_REPORT.md': '# day 2',
      },
    });
    try {
      const removed = syncModule.pruneGraphifyDatedBackups(outDir);
      expect(removed).toEqual(['2026-10-02', '2026-10-09']);
      expect(readdirSync(outDir).sort()).toEqual(['2026-10-15']);
      expect(readdirSync(join(outDir, '2026-10-15')).sort()).toEqual(['GRAPH_REPORT.md', 'graph.json']);
      expect(readFileSync(join(outDir, '2026-10-15', 'graph.json'), 'utf8')).toBe('{"day":15}');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('skips a dated folder holding a foreign file or a subdirectory, which never counts as the newest kept', () => {
    const outDir = outDirFixture({
      files: {
        '2026-10-01/graph.json': '{"day":1}',
        '2026-10-05/graph.json': '{"day":5}',
        '2026-10-20/graph.json': '{"day":20}',
        '2026-10-20/notes.txt': 'a hand-written note',
        '2026-10-21/graph.json': '{"day":21}',
        '2026-10-21/nested/graph.json': '{"nested":21}',
      },
    });
    try {
      const removed = syncModule.pruneGraphifyDatedBackups(outDir);
      expect(removed).toEqual(['2026-10-01']);
      expect(readdirSync(outDir).sort()).toEqual(['2026-10-05', '2026-10-20', '2026-10-21']);
      expect(readFileSync(join(outDir, '2026-10-05', 'graph.json'), 'utf8')).toBe('{"day":5}');
      expect(readdirSync(join(outDir, '2026-10-20')).sort()).toEqual(['graph.json', 'notes.txt']);
      expect(readFileSync(join(outDir, '2026-10-20', 'notes.txt'), 'utf8')).toBe('a hand-written note');
      expect(readdirSync(join(outDir, '2026-10-21')).sort()).toEqual(['graph.json', 'nested']);
      expect(readFileSync(join(outDir, '2026-10-21', 'nested', 'graph.json'), 'utf8')).toBe('{"nested":21}');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('leaves non-date names, a date-named regular file, near-miss names and an empty dated folder untouched', () => {
    const outDir = outDirFixture({
      dirs: ['2026-10-04'],
      files: {
        '2026-10-10/graph.json': '{"day":10}',
        'cache/entry.json': '{"cache":1}',
        'backup-2026-10-15-sync/graph.json': '{"sync":1}',
        '2026-10-03': 'a regular file named like a date',
        '2026-10-1/graph.json': '{"short":1}',
        '2026-10-15-old/graph.json': '{"old":1}',
      },
    });
    try {
      const removed = syncModule.pruneGraphifyDatedBackups(outDir);
      expect(removed).toEqual([]);
      expect(readdirSync(outDir).sort()).toEqual([
        '2026-10-03',
        '2026-10-04',
        '2026-10-1',
        '2026-10-10',
        '2026-10-15-old',
        'backup-2026-10-15-sync',
        'cache',
      ]);
      expect(readFileSync(join(outDir, '2026-10-10', 'graph.json'), 'utf8')).toBe('{"day":10}');
      expect(readFileSync(join(outDir, 'cache', 'entry.json'), 'utf8')).toBe('{"cache":1}');
      expect(readFileSync(join(outDir, 'backup-2026-10-15-sync', 'graph.json'), 'utf8')).toBe('{"sync":1}');
      expect(statSync(join(outDir, '2026-10-03')).isFile()).toBe(true);
      expect(readFileSync(join(outDir, '2026-10-1', 'graph.json'), 'utf8')).toBe('{"short":1}');
      expect(readFileSync(join(outDir, '2026-10-15-old', 'graph.json'), 'utf8')).toBe('{"old":1}');
      expect(statSync(join(outDir, '2026-10-04')).isDirectory()).toBe(true);
      expect(readdirSync(join(outDir, '2026-10-04'))).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('returns an empty list without throwing when the directory does not exist', () => {
    const parent = mkdtempSync(join(tmpdir(), 'graphify-sync-prune-missing-'));
    try {
      const missing = join(parent, 'graphify-out');
      expect(existsSync(missing)).toBe(false);
      expect(syncModule.pruneGraphifyDatedBackups(missing)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
