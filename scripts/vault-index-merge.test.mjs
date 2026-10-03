// scripts/vault-index-merge.test.mjs
//
// Guards for the join that turns N independent subagent outputs into one
// graph.json, and — the reason this file exists at all — for the two numbers
// that are the only evidence the join worked.
//
// Measured against the real vault graph on 2026-10-02: 6,155 nodes, 5,527
// links, 416 hyperedges, and 1,415 nodes that are not the source or target of
// any single edge. The obvious reading of that last figure is "dangling
// endpoints", and it is wrong. Re-checking the same file by hand: 1,415 nodes
// have zero incident edges AND 0 of the 10,854 endpoint references in the link
// array fail to resolve. The graph is internally consistent. It is a forest of
// disconnected pairs, not a graph with holes in it. Which is why this module
// reports `crossChunkDangling` as its own counter rather than deriving a claim
// about orphans from it — a dangling endpoint and an unreferenced node are
// different defects with different fixes, and a report that conflates them
// sends the next person to the wrong file.
//
// The substantive behaviour is cross-chunk resolution, and it is the one thing
// about a parallel extraction that cannot be tested per-subagent. A subagent
// reading batch A sees a wiki link to a note that lives in batch B. That note
// is not in A's node list, is not in A's context window, and may not be
// assigned an id until B's subagent has already finished. Judged in isolation,
// A's link is unresolvable — so the link is either dropped, and the
// relationship between the two notes vanishes from the rebuild forever, or it
// is written, and the graph acquires 1,415 orphans. Neither is a bug that
// anybody notices at the time. The fix is a second pass over the union of all
// ids, after every chunk is in hand, and the tests below are built around the
// fact that that pass is what makes the graph a graph.
//
// Three decisions are pinned here rather than argued in prose, because all
// three are the kind that survive review and then quietly do the wrong thing
// at 6,000 nodes:
//
//   1. A REJECTED CHUNK IS REJECTED WHOLE. Not "merged until the bad link",
//      not "the nodes are fine so keep those". Partial acceptance is how one
//      confused subagent shrinks the graph, because a half-chunk produces a
//      plausible node count and nobody goes back to reconcile it. Rejection
//      is counted, and the offending chunk is NAMED, because "2 of 40 chunks
//      rejected" is unactionable and "batch-17.json was rejected" is a
//      resubmit.
//
//   2. A NODE-ID COLLISION AND A DUPLICATE LINK ARE DIFFERENT COUNTS, AND
//      NEITHER IS A DISAGREEMENT. Two chunks declaring the same node id is one
//      node plus one collision. Two chunks emitting the same
//      `source|target|relation` is one edge plus one duplicate — even when
//      they disagree about `confidence`, because a disagreement is a fact
//      about the extractors, not a second edge. The disagreement is counted
//      separately (`confidenceDisagreements`) so that dropping the second edge
//      does not also drop the information that the extractors did not agree.
//
//   3. `confidence_score` AND `weight` ARE NEVER DERIVED. It is tempting to
//      map EXTRACTED->1.0, INFERRED->0.75, AMBIGUOUS->0.5 and be done with it.
//      The measured file refuses: its EXTRACTED links carry both 1.0 and 0.9,
//      and its AMBIGUOUS links carry both 0.5 and 1.0. Those fields are the
//      output of a scoring pass that runs after this one, and a value invented
//      here would be indistinguishable from a real one in every downstream
//      read. The same rule applies to `built_at_commit`: threaded through or
//      null, never invented.
//
// Fixtures are synthetic and built in memory. A merge test that reaches into
// the real vault passes on this machine and fails on the next one, and the
// counts it would assert are exactly the counts that are allowed to drift.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  merge,
  serializeGraph,
  writeGraph,
  foldLabel,
  GHOST_POLICIES,
  DEFAULT_GHOST_POLICY,
  discoverChunkFiles,
  loadChunks,
  resolveSourceRoots,
  CHUNK_FILE_SCHEMES,
  NON_CHUNK_FILES,
  NODE_KEY_ORDER,
  LINK_KEY_ORDER,
  TOP_LEVEL_KEY_ORDER,
} from './vault-index-merge.mjs';
import { validateChunk, FILE_TYPES, RELATIONS, CONFIDENCES } from './lib/chunk-schema.mjs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------- fixtures ----------

// The minimum a node needs to pass the peer validator: identity (id, label),
// and the two fields the validator can check without reading the repository.
// Everything else in the real graph — community, norm_label, _origin — is
// assigned by a later pass that owns those decisions, so requiring them here
// would force every synthetic node to invent a community number.
function node(id, overrides = {}) {
  return {
    id,
    label: `Label ${id}`,
    file_type: 'concept',
    source_file: `notes/${id}.md`,
    ...overrides,
  };
}

function link(source, target, overrides = {}) {
  return {
    source,
    target,
    relation: 'references',
    confidence: 'EXTRACTED',
    ...overrides,
  };
}

// Batch A and batch B overlap on exactly one node id, which is the only way two
// independent subagents can collide: they were both handed the same note.
function twoChunks() {
  return [
    {
      name: 'batch-a',
      chunk: {
        nodes: [node('a1'), node('shared', { label: 'Shared note' }), node('a2')],
        links: [link('a1', 'shared'), link('a2', 'a1')],
      },
    },
    {
      name: 'batch-b',
      chunk: {
        nodes: [node('shared', { label: 'Shared note' }), node('b1')],
        links: [link('b1', 'shared')],
      },
    },
  ];
}

function idsOf(nodes) {
  return nodes.map((n) => n.id);
}

function linkKeys(links) {
  return links.map((l) => `${l.source}\u0000${l.target}\u0000${l.relation}`);
}

// A previous graph carrying the fields a real one carries, including the
// optional ones, so that "previous survives" is tested against something with
// the shape of the thing it is standing in for rather than a two-field stub.
function previousGraph() {
  return {
    directed: false,
    multigraph: false,
    graph: { hyperedges: [] },
    nodes: [
      {
        id: 'old-1',
        label: 'Old One',
        norm_label: 'old one',
        file_type: 'document',
        source_file: 'notes/old-1.md',
        source_location: 'L1-L9',
        community: 3,
        community_name: 'cluster-3',
        _origin: 'previous',
        author: 'someone',
      },
      {
        id: 'old-2',
        label: 'Old Two',
        norm_label: 'old two',
        file_type: 'paper',
        source_file: 'notes/old-2.md',
        community: 3,
        community_name: 'cluster-3',
        _origin: 'previous',
      },
    ],
    links: [
      // `rationale` is one of the ten real links in the measured graph that
      // carry a field outside the canonical set, so the fixture has one too.
      link('old-1', 'old-2', { relation: 'cites', _origin: 'previous', confidence_score: 1, weight: 1, rationale: 'because' }),
    ],
    hyperedges: [],
    built_at_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
}

// ---------- 1. the ordinary case ----------

describe('two chunks merge into one graph', () => {
  test('every node from both chunks is present', () => {
    const { graph } = merge(twoChunks());
    assert.deepEqual(idsOf(graph.nodes), ['a1', 'a2', 'b1', 'shared']);
    assert.equal(graph.nodes.length, 4);
  });

  test('every link from both chunks is present', () => {
    const { graph } = merge(twoChunks());
    assert.equal(graph.links.length, 3);
    assert.deepEqual(linkKeys(graph.links).sort(), [
      'a1\u0000shared\u0000references',
      'a2\u0000a1\u0000references',
      'b1\u0000shared\u0000references',
    ].sort());
  });

  test('both chunks are counted as read and none as rejected', () => {
    const { report } = merge(twoChunks());
    assert.equal(report.chunksRead, 2);
    assert.equal(report.chunksRejected, 0);
    assert.equal(report.chunksAccepted, 2);
  });

  test('report counts agree with the graph they describe', () => {
    const { graph, report } = merge(twoChunks());
    assert.equal(report.nodes, graph.nodes.length);
    assert.equal(report.links, graph.links.length);
  });
});

// ---------- 2. node union ----------

describe('a node id declared by two chunks', () => {
  test('appears exactly once', () => {
    const { graph } = merge(twoChunks());
    assert.equal(idsOf(graph.nodes).filter((id) => id === 'shared').length, 1);
  });

  test('counts one collision, not two', () => {
    // Two records, one kept: the surplus is what a collision IS. Counting the
    // kept one as well would make the number scale with the number of chunks
    // that agreed rather than with the number of disagreements.
    const { report } = merge(twoChunks());
    assert.equal(report.nodeIdCollisions, 1);
  });

  test('the kept record carries fields from both, first non-empty winning', () => {
    const { graph } = merge([
      { name: 'a', chunk: { nodes: [node('x', { label: 'From A' })], links: [] } },
      { name: 'b', chunk: { nodes: [node('x', { label: 'From B', source_location: 'L4' })], links: [] } },
    ]);
    const kept = graph.nodes[0];
    assert.equal(kept.label, 'From A', 'the first chunk to declare an id owns the fields it supplied');
    assert.equal(kept.source_location, 'L4', 'a field the first chunk left empty is filled from the next');
    assert.equal(kept.file_type, 'concept', 'fields both declared survive the union');
  });

  test('a field that is an empty string does not overwrite a filled one', () => {
    // Empty string is the shape of "the extractor had nothing", not of "the
    // label is the empty string". Treating it as a value is how a merged node
    // ends up with a blank label.
    const { graph } = merge([
      { name: 'a', chunk: { nodes: [node('x', { label: 'Real label' })], links: [] } },
      { name: 'b', chunk: { nodes: [node('x', { label: '' })], links: [] } },
    ]);
    assert.equal(graph.nodes[0].label, 'Real label');
  });
});

// ---------- 3. link dedupe ----------

describe('a duplicate link', () => {
  const duplicated = () => [
    { name: 'a', chunk: { nodes: [node('p'), node('q')], links: [link('p', 'q')] } },
    { name: 'b', chunk: { nodes: [node('p'), node('q')], links: [link('p', 'q')] } },
  ];

  test('is kept once', () => {
    const { graph } = merge(duplicated());
    assert.equal(graph.links.length, 1);
  });

  test('is counted once', () => {
    const { report } = merge(duplicated());
    assert.equal(report.duplicatesDropped, 1);
  });

  test('is still one edge when the two extractors disagree about confidence', () => {
    // Confidence is excluded from the dedupe key on purpose. Two subagents
    // reading the same file and rating the same edge differently is a
    // disagreement about certainty, not a second claim that the edge exists.
    // The disagreement is preserved as its own number below, so dropping the
    // second edge does not also drop the fact they did not agree.
    const { graph, report } = merge([
      { name: 'a', chunk: { nodes: [node('p'), node('q')], links: [link('p', 'q', { confidence: 'EXTRACTED' })] } },
      { name: 'b', chunk: { nodes: [node('p'), node('q')], links: [link('p', 'q', { confidence: 'AMBIGUOUS' })] } },
    ]);
    assert.equal(graph.links.length, 1);
    assert.equal(report.duplicatesDropped, 1);
    assert.equal(report.confidenceDisagreements, 1);
  });

  test('the same pair with a different relation is a different edge', () => {
    const { graph, report } = merge([
      { name: 'a', chunk: { nodes: [node('p'), node('q')], links: [link('p', 'q', { relation: 'references' })] } },
      { name: 'b', chunk: { nodes: [node('p'), node('q')], links: [link('p', 'q', { relation: 'depends_on' })] } },
    ]);
    assert.equal(graph.links.length, 2);
    assert.equal(report.duplicatesDropped, 0);
  });

  test('a duplicate inside ONE chunk is a validation failure, not a dedupe', () => {
    // The two cases are asymmetric on purpose. Within a chunk the peer
    // validator already sees both copies, so it rejects the chunk and names
    // the index. Across chunks nothing can see both until the join, and by
    // then two agreeing subagents are evidence, not a defect.
    const { graph, report } = merge([
      { name: 'a', chunk: { nodes: [node('p'), node('q')], links: [link('p', 'q'), link('p', 'q')] } },
    ]);
    assert.equal(report.chunksRejected, 1);
    assert.equal(graph.links.length, 0, 'a rejected chunk contributes no links at all');
  });
});

// ---------- 4. cross-chunk resolution: the reason for this module ----------

describe('a link whose endpoint lives in another chunk', () => {
  // batch-a sees a wiki link to a note that batch-b was handed. Nothing in a's
  // own node list mentions b1, and nothing about a's execution could have
  // told it. Judged on its own, this link is unresolvable.
  const crossChunked = () => [
    { name: 'batch-a', chunk: { nodes: [node('a1')], links: [link('a1', 'b1')] } },
    { name: 'batch-b', chunk: { nodes: [node('b1')], links: [] } },
  ];

  test('RESOLVES: the link survives into the graph', () => {
    const { graph } = merge(crossChunked());
    assert.equal(graph.links.length, 1);
    assert.equal(graph.links[0].target, 'b1');
  });

  test('RESOLVES: it is counted as resolved, once for the endpoint', () => {
    const { report } = merge(crossChunked());
    assert.equal(report.crossChunkResolved, 1);
  });

  test('RESOLVES: it is not counted as dangling', () => {
    const { report } = merge(crossChunked());
    assert.equal(report.crossChunkDangling, 0);
  });

  test('counts in ENDPOINTS, so a link with both ends elsewhere counts twice', () => {
    // The unit is the endpoint, matching the peer validator's `stats.crossChunk`.
    // A link count would understate exactly the batch that only ever references
    // the rest of the corpus, which is the batch most at risk of being dropped.
    const { report } = merge([
      { name: 'mid', chunk: { nodes: [node('mid-1')], links: [link('x1', 'y1')] } },
      { name: 'x', chunk: { nodes: [node('x1')], links: [] } },
      { name: 'y', chunk: { nodes: [node('y1')], links: [] } },
    ]);
    assert.equal(report.crossChunkResolved, 2);
    assert.equal(report.links, 1);
  });

  test('an endpoint in previous also resolves', () => {
    // The previous graph is part of the union for the same reason the other
    // chunks are: a freshly extracted batch will reference notes that were
    // indexed in an earlier run, and those references are real edges too.
    const { report } = merge(
      [{ name: 'a', chunk: { nodes: [node('new-1')], links: [link('new-1', 'old-1')] } }],
      { previous: previousGraph() },
    );
    assert.equal(report.crossChunkResolved, 1);
    assert.equal(report.crossChunkDangling, 0);
  });
});

describe('a link to an id in no chunk at all', () => {
  const ghosted = () => [
    { name: 'a', chunk: { nodes: [node('real')], links: [link('real', 'never-extracted')] } },
  ];

  test('is counted as dangling', () => {
    const { report } = merge(ghosted());
    assert.equal(report.crossChunkDangling, 1);
  });

  test('is named in the report, not just counted', () => {
    // A bare number is unactionable at 6,000 nodes. The count says how bad it
    // is; the sample says which batch to go re-read.
    const { report } = merge(ghosted());
    assert.equal(report.danglingSamples.length, 1);
    assert.equal(report.danglingSamples[0].chunk, 'a');
    assert.equal(report.danglingSamples[0].endpoint, 'never-extracted');
    assert.equal(report.danglingSamples[0].end, 'target');
  });

  test('is dropped from the graph by default', () => {
    // The graph loader that reads graph.json cannot tell a dangling edge from a
    // good one — both are well-formed objects. Writing it is how 1,415 orphans
    // become 1,415 orphans plus a link count that means nothing. So the edge is
    // not written, and the number that would have hidden the problem is in the
    // report instead.
    const { graph, report } = merge(ghosted());
    assert.equal(graph.links.length, 0);
    assert.equal(report.danglingLinksDropped, 1);
  });

  test('is still written when the caller asks for it, and says so', () => {
    const { graph, report } = merge(ghosted(), { keepDangling: true });
    assert.equal(graph.links.length, 1);
    assert.equal(report.crossChunkDangling, 1);
    assert.equal(report.danglingLinksDropped, 0);
  });

  test('the sample list is bounded, because a 6,000-node graph can produce thousands', () => {
    const many = [];
    for (let i = 0; i < 60; i += 1) many.push(link('n', `ghost-${i}`));
    const { report } = merge([{ name: 'a', chunk: { nodes: [node('n')], links: many } }]);
    assert.equal(report.crossChunkDangling, 60);
    assert.ok(report.danglingSamples.length < 60, 'a count of 60 must not come with 60 lines of output');
    assert.ok(report.danglingSamples.length > 0);
  });

  test('the peer validator\'s count and this module\'s sample scan agree', () => {
    // The counter comes from the peer validator's `stats.dangling`; the sample
    // list is built by a second membership test written here, because the
    // validator's errors are prose and a report wants ids. Two implementations
    // of one number is a liability unless something holds them together, and
    // this is that something. The mixed shape below covers a dangling target, a
    // dangling source, and a link with neither end resolvable.
    const { report } = merge([
      { name: 'a', chunk: { nodes: [node('here')], links: [link('here', 'ghost-target'), link('ghost-source', 'here')] } },
      { name: 'b', chunk: { nodes: [], links: [link('ghost-a', 'ghost-b')] } },
    ]);
    assert.equal(report.crossChunkDangling, 4);
    assert.equal(report.danglingSamples.length, 4);
    assert.deepEqual(
      report.danglingSamples.map((s) => s.endpoint).sort(),
      ['ghost-a', 'ghost-b', 'ghost-source', 'ghost-target'],
    );
    assert.equal(new Set(report.danglingSamples.map((s) => s.chunk)).size, 2, 'both chunks are named');
  });
});

// ---------- 5. rejection is containment ----------

describe('a malformed chunk', () => {
  // A chunk whose nodes are fine and whose links are not. This is the shape
  // that matters: accepting the nodes would leave a plausible node count and a
  // quietly missing relationship, and nobody reconciles those two later.
  const mixed = () => [
    { name: 'good', chunk: { nodes: [node('g1'), node('g2')], links: [link('g1', 'g2')] } },
    {
      name: 'broken',
      chunk: {
        nodes: [node('b1', { file_type: 'not-a-file-type' })],
        links: [link('b1', 'g1', { relation: 'invented_relation' })],
      },
    },
  ];

  test('is rejected and named', () => {
    const { report } = merge(mixed());
    assert.equal(report.chunksRejected, 1);
    assert.equal(report.rejections.length, 1);
    assert.equal(report.rejections[0].name, 'broken');
    assert.equal(report.rejections[0].index, 1);
  });

  test('carries the validator errors, not a generic message', () => {
    const { report } = merge(mixed());
    const text = report.rejections[0].errors.join('\n');
    assert.match(text, /node-file-type-invalid/);
    assert.match(text, /link-relation-invalid/);
  });

  test('contributes NOTHING: not the good nodes, not the bad links', () => {
    const { graph } = merge(mixed());
    assert.deepEqual(idsOf(graph.nodes), ['g1', 'g2']);
    assert.equal(graph.links.length, 1);
  });

  test('does not stop the other chunks merging', () => {
    const { report } = merge(mixed());
    assert.equal(report.chunksRead, 2);
    assert.equal(report.chunksAccepted, 1);
  });

  test('its node ids are not in the union, so links to them dangle', () => {
    // The consequence of rejection that is easiest to get wrong: if a rejected
    // chunk's ids still entered the id union, every other chunk's references
    // to them would resolve onto nodes that are not in the graph. The link
    // would look fine and terminate at nothing.
    const { report } = merge([
      { name: 'bad', chunk: { nodes: [node('b1', { file_type: 'nope' })], links: [] } },
      { name: 'good', chunk: { nodes: [node('g1')], links: [link('g1', 'b1')] } },
    ]);
    assert.equal(report.crossChunkDangling, 1);
    assert.equal(report.crossChunkResolved, 0);
  });

  test('a null entry is rejected, not thrown on', () => {
    // `null` is what JSON.parse hands back for a file containing the word null,
    // and one unreadable batch must not take down the other thirty-nine.
    const { report } = merge([{ name: 'empty', chunk: null }, { name: 'good', chunk: { nodes: [node('g1')], links: [] } }]);
    assert.equal(report.chunksRejected, 1);
    assert.equal(report.chunksAccepted, 1);
  });

  test('a bare chunk with no wrapper is accepted, and named by position', () => {
    const { report } = merge([{ nodes: [node('bare')], links: [] }]);
    assert.equal(report.chunksAccepted, 1);
    assert.equal(report.chunksRejected, 0);
  });
});

// ---------- 6. previous graph retention ----------

describe('a previous graph', () => {
  test('has all of its nodes in the merged result', () => {
    const { graph } = merge(twoChunks(), { previous: previousGraph() });
    for (const id of ['old-1', 'old-2']) {
      assert.ok(idsOf(graph.nodes).includes(id), `${id} from the previous graph was discarded`);
    }
  });

  test('has all of its links in the merged result', () => {
    const { graph } = merge(twoChunks(), { previous: previousGraph() });
    assert.ok(linkKeys(graph.links).includes('old-1\u0000old-2\u0000cites'));
  });

  test('keeps the optional fields its nodes carry', () => {
    // A previous graph is 6,155 nodes of real work. Reducing them to the four
    // fields the validator requires would discard author, rationale,
    // source_url and everything else, while still passing every test that
    // counts nodes.
    const { graph } = merge(twoChunks(), { previous: previousGraph() });
    const old = graph.nodes.find((n) => n.id === 'old-1');
    assert.equal(old.author, 'someone');
    assert.equal(old.community_name, 'cluster-3');
    assert.equal(old.source_location, 'L1-L9');
  });

  test('keeps its links optional fields too', () => {
    const { graph } = merge(twoChunks(), { previous: previousGraph() });
    const kept = graph.links.find((l) => l.source === 'old-1');
    assert.equal(kept.confidence_score, 1);
    assert.equal(kept._origin, 'previous');
  });

  test('retains the previous hyperedges rather than dropping them silently', () => {
    const previous = previousGraph();
    previous.hyperedges = [{ id: 'he-1', label: 'A group', nodes: ['old-1', 'old-2'] }];
    previous.graph = { hyperedges: previous.hyperedges };
    const { graph, report } = merge(twoChunks(), { previous });
    assert.equal(graph.hyperedges.length, 1);
    assert.equal(report.hyperedges, 1);
  });

  test('merges additively: nothing from before is lost, nothing new is doubled', () => {
    const { graph, report } = merge(twoChunks(), { previous: previousGraph() });
    // 2 previous + 4 new unique = 6. 1 previous link + 3 new = 4.
    assert.equal(report.nodes, 6);
    assert.equal(report.links, 4);
    assert.equal(report.nodesRetainedFromPrevious, 2);
    assert.equal(report.linksRetainedFromPrevious, 1);
  });

  test('a link duplicating a previous link is dropped, not doubled', () => {
    const { graph, report } = merge(
      [{ name: 'a', chunk: { nodes: [node('old-1'), node('old-2')], links: [link('old-1', 'old-2', { relation: 'cites' })] } }],
      { previous: previousGraph() },
    );
    assert.equal(linkKeys(graph.links).filter((k) => k === 'old-1\u0000old-2\u0000cites').length, 1);
    assert.equal(report.duplicatesDropped, 1);
  });

  test('a node id from previous is not counted as a fresh collision when the new record adds detail', () => {
    // previous seeds the union first, so a re-extracted node is a collision
    // with history rather than with another chunk. It is still counted, because
    // the number is the only signal that the corpus and the graph disagree.
    const { report } = merge(
      [{ name: 'a', chunk: { nodes: [node('old-1', { label: 'Old One', source_location: 'L1-L9' })], links: [] } }],
      { previous: previousGraph() },
    );
    assert.equal(report.nodeIdCollisions, 1);
  });

  test('a previous node with no usable source_file is counted, not dropped', () => {
    // Measured on the real vault graph: 1,269 of 6,155 nodes carry
    // `source_file: null` and 30 carry an empty string, so 1,299 of them fail
    // the peer validator. Two wrong responses are available here and both are
    // worse than a count — deleting a fifth of the vault's nodes, or inventing
    // a path to fill the hole. Preserving the node and publishing the number is
    // the only option that leaves the defect visible and attached to its cause.
    const previous = previousGraph();
    previous.nodes[1] = { ...previous.nodes[1], source_file: null };
    const { graph, report } = merge(twoChunks(), { previous });
    assert.equal(report.previousNodesUnusableSourceFile, 1);
    assert.ok(idsOf(graph.nodes).includes('old-2'), 'the node must survive the merge');
    assert.equal(graph.nodes.find((n) => n.id === 'old-2').source_file, null, 'and must not be given an invented path');
  });

  test('a chunk that supplies a real source_file fills the gap the previous record left', () => {
    const previous = previousGraph();
    previous.nodes[1] = { ...previous.nodes[1], source_file: null };
    const { graph, report } = merge(
      [{ name: 'a', chunk: { nodes: [node('old-2', { label: 'Old Two', file_type: 'paper', source_file: 'notes/recovered.md' })], links: [] } }],
      { previous },
    );
    assert.equal(report.previousNodesUnusableSourceFile, 1, 'the defect in the previous graph is still reported');
    assert.equal(graph.nodes.find((n) => n.id === 'old-2').source_file, 'notes/recovered.md');
  });
});

// ---------- 7. built_at_commit is threaded, never invented ----------

describe('built_at_commit', () => {
  test('is taken from opts.builtAtCommit', () => {
    const { graph } = merge(twoChunks(), { builtAtCommit: 'b'.repeat(40) });
    assert.equal(graph.built_at_commit, 'b'.repeat(40));
  });

  test('is null when the caller supplies nothing and there is no previous graph', () => {
    // A fabricated hash is worse than a null one: it looks like a real
    // provenance record to every consumer that reads it, and there is no way to
    // tell later that nobody looked it up.
    const { graph } = merge(twoChunks());
    assert.equal(graph.built_at_commit, null);
  });

  test('falls back to the previous graph rather than to nothing', () => {
    const { graph } = merge(twoChunks(), { previous: previousGraph() });
    assert.equal(graph.built_at_commit, previousGraph().built_at_commit);
  });

  test('opts wins over previous', () => {
    const { graph } = merge(twoChunks(), { previous: previousGraph(), builtAtCommit: 'c'.repeat(40) });
    assert.equal(graph.built_at_commit, 'c'.repeat(40));
  });
});

// ---------- 8. the emitted file is loadable, and loadable the same way twice ----------

describe('the serialised file', () => {
  test('parses', () => {
    const { graph } = merge(twoChunks(), { builtAtCommit: 'd'.repeat(40) });
    assert.doesNotThrow(() => JSON.parse(serializeGraph(graph)));
  });

  test('carries every required top-level key, in the measured order', () => {
    const { graph } = merge(twoChunks());
    assert.deepEqual(Object.keys(JSON.parse(serializeGraph(graph))), TOP_LEVEL_KEY_ORDER);
  });

  test('hyperedges is a list even when there are none', () => {
    // Present-but-not-a-list is the failure a consumer finds late. Emitting []
    // means the key's TYPE is fixed whether or not the merge produced groups.
    const { graph } = merge(twoChunks());
    assert.ok(Array.isArray(graph.hyperedges));
    assert.ok(Array.isArray(graph.graph.hyperedges));
  });

  test('carries the graph flags the measured vault graph carries', () => {
    const { graph } = merge(twoChunks());
    assert.equal(graph.directed, false);
    assert.equal(graph.multigraph, false);
  });

  test('emits node keys in the declared order, surplus fields after them', () => {
    const { graph } = merge(twoChunks(), { previous: previousGraph() });
    const keys = Object.keys(JSON.parse(serializeGraph(graph)).nodes.find((n) => n.id === 'old-1'));
    const surplus = keys.filter((k) => !NODE_KEY_ORDER.includes(k));
    assert.deepEqual(keys, [...NODE_KEY_ORDER.filter((k) => keys.includes(k)), ...surplus]);
    assert.deepEqual(surplus, ['author']);
    for (const k of NODE_KEY_ORDER) assert.ok(keys.includes(k), `${k} was dropped from a node that had it`);
  });

  test('emits link keys in the declared order, surplus fields after them', () => {
    // Asserted as an ordering rule rather than an exact array, because the
    // canonical order lists optional fields a given link may not carry. The
    // rule is: declared keys in declared order, then everything else.
    const { graph } = merge(twoChunks(), { previous: previousGraph() });
    const keys = Object.keys(JSON.parse(serializeGraph(graph)).links.find((l) => l.source === 'old-1'));
    const surplus = keys.filter((k) => !LINK_KEY_ORDER.includes(k));
    assert.deepEqual(keys, [...LINK_KEY_ORDER.filter((k) => keys.includes(k)), ...surplus]);
    assert.deepEqual(surplus, ['rationale']);
    assert.ok(keys.includes('confidence_score'), 'a field the measured graph sets was dropped');
  });

  test('two runs on the same input produce byte-identical output', () => {
    // This is the whole idempotency argument. The caller has no other cheap way
    // to prove a re-run did not quietly reorder 6,000 nodes, and a diff of two
    // graph.json files is the check that would otherwise never be made.
    const a = serializeGraph(merge(twoChunks(), { previous: previousGraph(), builtAtCommit: 'e'.repeat(40) }).graph);
    const b = serializeGraph(merge(twoChunks(), { previous: previousGraph(), builtAtCommit: 'e'.repeat(40) }).graph);
    assert.equal(a, b);
  });

  test('is byte-identical even when the chunks arrive in a different order', () => {
    // Order independence is a stronger claim than order stability, and it is
    // the one that matters: a fan-out over subagents does not promise to
    // finish in submission order. This holds because first-non-empty-wins is
    // only ever observable in fields, and every emitted array is sorted.
    const forwards = serializeGraph(merge(twoChunks(), { previous: previousGraph() }).graph);
    const backwards = serializeGraph(merge([...twoChunks()].reverse(), { previous: previousGraph() }).graph);
    assert.equal(forwards, backwards);
  });

  test('sorts by codepoint, not by ICU collation', () => {
    // The byte-stability claim is only worth anything if the ordering does not
    // depend on the host. These ids were chosen because the two comparators
    // genuinely disagree on them — `localeCompare` sorts case-insensitively at
    // the primary level, so it puts `_x` and `Ä` first and `B-note` after
    // `a-note`, where codepoint order puts `A-note` and `B-note` first. A
    // fixture of lowercase ASCII ids would pass under either implementation,
    // which is exactly how a locale dependency survives review: the test suite
    // agrees with the bug.
    const tricky = ['B-note', 'a-note', 'A-note', '_x', 'z', 'Ä'];
    const { graph } = merge([
      { name: 't', chunk: { nodes: tricky.map((id) => node(id)), links: [] } },
      { name: 'u', chunk: { nodes: [], links: tricky.map((id, i) => link(id, tricky[(i + 1) % tricky.length])) } },
    ]);
    assert.deepEqual(idsOf(graph.nodes), ['A-note', 'B-note', '_x', 'a-note', 'z', 'Ä']);
    assert.notDeepEqual(
      idsOf(graph.nodes),
      [...tricky].sort((x, y) => x.localeCompare(y)),
      'the fixture no longer distinguishes codepoint order from collation order',
    );
    // The same rule governs links, whose sort is a three-key comparison. Only
    // the first key is exercised here, because that is the one a collation
    // regression changes; the other two are covered by the two-chunk tests.
    const sources = graph.links.map((l) => l.source);
    assert.deepEqual(sources, [...sources].sort());
    assert.notDeepEqual(
      sources,
      [...sources].sort((x, y) => x.localeCompare(y)),
      'the link fixture no longer distinguishes codepoint order from collation order',
    );
  });

  test('a __proto__ key on a record from disk never reaches the output', () => {
    // Keys copied out of a previous graph came off disk, and JSON.parse is the
    // one thing that makes `__proto__` an OWN property — an object literal sets
    // a prototype instead, and Object.assign turns it back into a prototype
    // assignment. Only spread (CreateDataPropertyOrThrow) reproduces the hazard,
    // so the fixture uses it.
    //
    // Stated honestly about its own reach: this test pins the OBSERVABLE
    // contract, and deleting the merge's `FORBIDDEN_KEYS` guard does not fail
    // it. Without the guard the key is assigned rather than created, which
    // swaps the intermediate record's prototype; but every record is rebuilt
    // from a fresh object by the serialiser, so that swap does not survive into
    // anything a caller can see. The guard is kept because it is correct, not
    // because a test here would notice its removal — and a test that claimed
    // otherwise would be a test that lies the next time the rebuild path is
    // reused somewhere the record is not rebuilt.
    const tainted = { ...JSON.parse('{"__proto__":{"polluted":true}}') };
    const previous = previousGraph();
    previous.nodes[0] = { ...tainted, ...previous.nodes[0], tainted: 'yes' };
    const { graph } = merge(twoChunks(), { previous });
    const text = serializeGraph(graph);
    assert.ok(!text.includes('__proto__'), 'the key reached the output');
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
    for (const n of graph.nodes) {
      assert.equal(Object.getPrototypeOf(n), Object.prototype, `${n.id} carries a swapped prototype`);
      assert.ok(!Object.getOwnPropertyNames(n).includes('__proto__'), `${n.id} has a __proto__ own property`);
    }
    const old = graph.nodes.find((n) => n.id === 'old-1');
    assert.equal(old.tainted, 'yes', 'the legitimate surplus field is still kept');
  });

  test('a __proto__ key on a COLLIDING record cannot pollute the kept record', () => {
    // The same hazard on the other code path: this record loses the union, so
    // the tainted fields are folded into a record that already exists rather
    // than creating a new one. Covered separately because it is a different
    // branch, and because "the first record wins" is only true if the losers
    // are genuinely unable to contribute anything.
    const previous = previousGraph();
    const { graph } = merge(
      [
        {
          name: 'a',
          chunk: {
            nodes: [{ ...JSON.parse('{"__proto__":{"polluted":true}}'), id: 'old-1', label: 'Old One', file_type: 'document', source_file: 'notes/old-1.md' }],
            links: [],
          },
        },
      ],
      { previous },
    );
    const old = graph.nodes.find((n) => n.id === 'old-1');
    assert.equal(Object.getPrototypeOf(old), Object.prototype);
    assert.equal({}.polluted, undefined);
    assert.equal(old.label, 'Old One', 'the previous record still owns the fields it supplied');
    assert.equal(Object.getPrototypeOf(graph.nodes.find((n) => n.id === 'old-2')).polluted, undefined);
  });
});

describe('writeGraph', () => {
  test('writes the same bytes it returns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-merge-'));
    try {
      const { graph } = merge(twoChunks(), { builtAtCommit: 'f'.repeat(40) });
      const path = join(dir, 'graph.json');
      const written = writeGraph(graph, path);
      assert.equal(written.text, readFileSync(path, 'utf8'));
      assert.equal(written.bytes, Buffer.byteLength(written.text, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a second write over the first changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-merge-'));
    try {
      const path = join(dir, 'graph.json');
      const first = writeGraph(merge(twoChunks(), { builtAtCommit: 'f'.repeat(40) }).graph, path);
      const second = writeGraph(merge(twoChunks(), { builtAtCommit: 'f'.repeat(40) }).graph, path);
      assert.equal(first.text, second.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- 9. the round trip: the merged graph is itself a valid chunk ----------

describe('round trip', () => {
  // The guarantee that lets the merge be part of a loop rather than a one-shot:
  // a graph.json that this module produced can be fed back in as `previous`
  // and the result is a no-op, and it can be wrapped back into chunk form and
  // handed to the peer validator with no complaints. If a merge could emit
  // something the validator rejects, then merging a merge is a cumulative
  // corruption, and the rebuild could not be resumed after an interruption.
  test('the merged graph passes validateChunk when wrapped back into chunk form', () => {
    const { graph } = merge(twoChunks(), { previous: previousGraph(), builtAtCommit: '9'.repeat(40) });
    const allIds = new Set(idsOf(graph.nodes));
    const verdict = validateChunk({ nodes: graph.nodes, links: graph.links }, { knownNodeIds: allIds });
    assert.deepEqual(verdict.errors, []);
    assert.equal(verdict.ok, true);
  });

  test('the merged graph survives being merged again, unchanged', () => {
    const once = merge(twoChunks(), { previous: previousGraph(), builtAtCommit: '9'.repeat(40) });
    const twice = merge([], { previous: once.graph });
    assert.equal(serializeGraph(twice.graph), serializeGraph(once.graph));
    assert.equal(twice.report.nodes, once.report.nodes);
    assert.equal(twice.report.links, once.report.links);
  });

  test('adding a new chunk to a merged graph grows it and keeps the old', () => {
    const once = merge(twoChunks(), { previous: previousGraph(), builtAtCommit: '9'.repeat(40) });
    const again = merge(
      [{ name: 'later', chunk: { nodes: [node('later-1'), node('a1')], links: [link('later-1', 'old-1')] } }],
      { previous: once.graph },
    );
    assert.ok(idsOf(again.graph.nodes).includes('later-1'));
    assert.ok(idsOf(again.graph.nodes).includes('old-1'));
    assert.equal(again.report.nodes, once.report.nodes + 1);
    assert.equal(again.report.crossChunkResolved, 1, 'a new batch referencing an old note resolves');
  });

  test('the merged graph uses only the frozen vocabularies', () => {
    // If the merge could mint a file_type or a relation of its own, the
    // round trip above would still pass (the validator would only complain
    // about endpoints) and the vocabularies would drift anyway. This is the
    // cheap check that they have not.
    const { graph } = merge(twoChunks(), { previous: previousGraph() });
    for (const n of graph.nodes) assert.ok(FILE_TYPES.includes(n.file_type), `file_type ${n.file_type} is not in the table`);
    for (const l of graph.links) {
      assert.ok(RELATIONS.includes(l.relation), `relation ${l.relation} is not in the table`);
      assert.ok(CONFIDENCES.includes(l.confidence), `confidence ${l.confidence} is not in the table`);
    }
  });
});

// ---------- 9. ghosts: nodes whose source_file is null or empty ----------
//
// The real vault graph, 2026-10-02: of 6,155 nodes, 1,269 carry `source_file:
// null` and 30 an empty string. 1,185 of the 1,299 are an endpoint of some
// edge, so they are not inert debris — they are carrying relationships that
// cannot be checked against a file. `ghostPolicy` decides what happens to them.
//
// Measured against the real corpus, the three outcomes are 402 unique matches,
// 292 ambiguous and 605 unmatched. The default is `reattribute` because it is
// the only policy that cannot delete a fifth of the graph; the tests below pin
// the arithmetic and the refusals rather than the numbers, so they keep
// meaning if the corpus moves.

describe('ghostPolicy', () => {
  // One previous node with no usable source_file, of each of the three shapes
  // the real graph uses, plus a live node they are all linked to.
  function ghostGraph() {
    return {
      nodes: [
        { id: 'live', label: 'Live Note', file_type: 'document', source_file: 'notes/live.md' },
        { id: 'g-null', label: 'Alpha Note', file_type: 'document', source_file: null },
        { id: 'g-empty', label: 'Beta Note', file_type: 'document', source_file: '' },
        { id: 'g-conc', label: 'Gamma Note', file_type: 'concept', source_file: null },
      ],
      links: [link('g-null', 'live'), link('g-empty', 'live'), link('g-conc', 'live')],
      hyperedges: [],
    };
  }

  // A chunk supplying exactly one `document` titled `Alpha Note`.
  function alphaChunk() {
    return [{
      name: 'structural',
      chunk: {
        nodes: [node('notes_alpha_note', { label: 'Alpha Note', file_type: 'document', source_file: 'notes/alpha-note.md' })],
        links: [],
      },
    }];
  }

  test('the default is reattribute, not drop', () => {
    // The one assertion that decides the argument. `drop` would delete the 1,299
    // and orphan 1,454 of 5,527 links; `reattribute` can only ever fill in a
    // path, and a wrong guess is visible in the counters where a deletion is
    // not. Pinning the default stops a future edit from quietly choosing the
    // destructive one.
    assert.equal(DEFAULT_GHOST_POLICY, 'reattribute');
    const { report } = merge(alphaChunk(), { previous: ghostGraph() });
    assert.equal(report.ghostPolicy, 'reattribute');
    assert.equal(report.ghostNodesDropped, 0);
    assert.equal(report.nodes, 5, 'nothing is deleted under the default');
  });

  test('drop removes the ghosts, counts them, and keeps the rest', () => {
    const { graph, report } = merge(alphaChunk(), { previous: ghostGraph(), ghostPolicy: 'drop' });
    assert.equal(report.ghostNodesDropped, 3);
    assert.deepEqual(idsOf(graph.nodes).sort(), ['live', 'notes_alpha_note']);
    assert.equal(report.ghostPolicy, 'drop');
  });

  test('drop counts every link a dropped node was carrying, as orphans', () => {
    // The cost of the choice, stated as a number. Each of the three ghosts is
    // the SOURCE of one link, so all three links lose an endpoint; none of them
    // is left in the graph looking intact.
    const { graph, report } = merge(alphaChunk(), { previous: ghostGraph(), ghostPolicy: 'drop' });
    assert.equal(report.linksOrphanedByGhosts, 3);
    assert.deepEqual(graph.links, [], 'an orphaned link is removed, not left dangling');
    assert.equal(report.danglingLinksDropped, 3, 'and it is counted there too, so the two reasons stay separable');
  });

  test('a link between two live nodes is not counted against the drop', () => {
    // The orphan count must be about the ghosts, not about the graph. A link
    // whose both endpoints survive the drop has nothing to do with it, and
    // counting it would inflate the cost of the policy into a number nobody can
    // act on.
    const previous = ghostGraph();
    previous.nodes.push(node('live-2', { file_type: 'document', source_file: 'notes/live-2.md' }));
    previous.links.push(link('live', 'live-2'));
    const { graph, report } = merge(alphaChunk(), { previous, ghostPolicy: 'drop' });
    assert.equal(report.linksOrphanedByGhosts, 3, 'only the three that named a ghost');
    assert.deepEqual(linkKeys(graph.links), ['live live-2 references']);
  });

  test('reattribute attaches a uniquely-matched ghost and reports it', () => {
    const { graph, report } = merge(alphaChunk(), { previous: ghostGraph() });
    assert.equal(report.ghostNodesReattributed, 1);
    assert.equal(graph.nodes.find((n) => n.id === 'g-null').source_file, 'notes/alpha-note.md');
    // The other two are left exactly as they were — present, still unattributed,
    // and visible in a counter.
    assert.equal(graph.nodes.find((n) => n.id === 'g-empty').source_file, '');
    assert.equal(graph.nodes.find((n) => n.id === 'g-conc').source_file, null);
  });

  test('reattribute counts a no-match ghost instead of silently dropping it', () => {
    const { graph, report } = merge(alphaChunk(), { previous: ghostGraph() });
    assert.equal(report.unmatchedReattribution, 2);
    assert.ok(idsOf(graph.nodes).includes('g-empty'), 'a ghost nobody matched is still in the graph');
    assert.ok(idsOf(graph.nodes).includes('g-conc'));
  });

  test('an ambiguous label match is counted, never guessed', () => {
    // Two notes with the same title. Picking either one asserts an origin
    // nothing in the data supports, and the assertion would be invisible
    // downstream — `graphify explain` would link the node to a file and be
    // wrong. The measured corpus has 292 of these, so this is the common case.
    const { graph, report } = merge(
      [{
        name: 'structural',
        chunk: {
          nodes: [
            node('alpha_one', { label: 'Alpha Note', file_type: 'document', source_file: 'notes/alpha-one.md' }),
            node('alpha_two', { label: 'Alpha Note', file_type: 'document', source_file: 'notes/alpha-two.md' }),
          ],
          links: [],
        },
      }],
      { previous: ghostGraph() },
    );
    assert.equal(report.ambiguousReattribution, 1);
    assert.equal(report.ghostNodesReattributed, 0);
    assert.equal(graph.nodes.find((n) => n.id === 'g-null').source_file, null, 'left unattributed on purpose');
  });

  test('a label match is restricted to the same file_type', () => {
    // The measured structural layer emits `document` nodes only, so a key that
    // ignored file_type would offer a `concept` ghost the title of a document.
    // 460 of the real ghosts are concepts; this is the rule that stops all of
    // them from being attributed to whatever note happens to share a name.
    const { graph, report } = merge(alphaChunk(), { previous: ghostGraph() });
    assert.equal(graph.nodes.find((n) => n.id === 'g-conc').source_file, null);
    assert.equal(report.ghostNodesReattributed, 1, 'only the document ghost matched');
  });

  test('a label match folds case, accents and punctuation', () => {
    const previous = {
      nodes: [{ id: 'g', label: 'Café-Strategy 2024!', file_type: 'document', source_file: null }],
      links: [],
      hyperedges: [],
    };
    const { graph, report } = merge(
      [{
        name: 'structural',
        chunk: {
          nodes: [node('note', { label: 'café strategy 2024', file_type: 'document', source_file: 'notes/real.md' })],
          links: [],
        },
      }],
      { previous },
    );
    assert.equal(report.ghostNodesReattributed, 1);
    assert.equal(graph.nodes.find((n) => n.id === 'g').source_file, 'notes/real.md');
  });

  test('an empty label matches nothing rather than the first real title', () => {
    const previous = {
      nodes: [
        { id: 'blank', label: '', file_type: 'document', source_file: null },
        { id: 'punc', label: '---', file_type: 'document', source_file: null },
      ],
      links: [],
      hyperedges: [],
    };
    const { report } = merge(alphaChunk(), { previous });
    assert.equal(report.unmatchedReattribution, 2);
    assert.equal(report.ghostNodesReattributed, 0);
  });

  test('a ghost the union has already filled in is not a ghost', () => {
    // A chunk that supplies the same id with a real path has resolved the
    // defect; re-attributing on top of that would overwrite a real path with a
    // guessed one.
    const { graph, report } = merge(
      [
        {
          name: 'structural',
          chunk: {
            nodes: [node('g-null', { label: 'Alpha Note', file_type: 'document', source_file: 'notes/authoritative.md' })],
            links: [],
          },
        },
      ],
      { previous: ghostGraph() },
    );
    assert.equal(report.ghostNodes, 2, 'only the two the union never filled');
    assert.equal(graph.nodes.find((n) => n.id === 'g-null').source_file, 'notes/authoritative.md');
  });

  test('an unknown ghostPolicy is refused rather than defaulted', () => {
    assert.throws(() => merge([], { ghostPolicy: 'guess' }), /ghostPolicy must be one of/);
  });

  test('both policies leave a graph with no previous ghost untouched', () => {
    // previousGraph() has two nodes and twoChunks() contributes four distinct
    // ids (a1, shared, a2, b1), so the union is six. `drop` must not find a
    // seventh thing to remove just because it was asked to.
    for (const ghostPolicy of GHOST_POLICIES) {
      const { graph, report } = merge(twoChunks(), { previous: previousGraph(), ghostPolicy });
      assert.equal(report.ghostNodes, 0);
      assert.equal(report.ghostNodesDropped, 0);
      assert.equal(report.ghostNodesReattributed, 0);
      assert.equal(report.linksOrphanedByGhosts, 0);
      assert.equal(graph.nodes.length, 6, `every node survives under ${ghostPolicy}`);
    }
  });

  test('the merged output stays a valid chunk after a drop', () => {
    // The point of dropping is that the result can be re-validated. If the
    // orphan removal left anything malformed, the policy would trade one
    // invalid graph for a differently invalid one.
    const { graph } = merge(alphaChunk(), { previous: ghostGraph(), ghostPolicy: 'drop' });
    const allIds = new Set(idsOf(graph.nodes));
    const verdict = validateChunk({ nodes: graph.nodes, links: graph.links }, { knownNodeIds: allIds });
    assert.deepEqual(verdict.errors, []);
  });

  test('the previous graph is never mutated by either policy', () => {
    // `previous` came off disk. A merge that rewrote it would make the second
    // run's input depend on the first run's policy, which is how a `drop`
    // becomes permanent without anybody deciding it twice.
    for (const ghostPolicy of GHOST_POLICIES) {
      const previous = ghostGraph();
      const before = JSON.stringify(previous);
      merge(alphaChunk(), { previous, ghostPolicy });
      assert.equal(JSON.stringify(previous), before, `${ghostPolicy} left previous alone`);
    }
  });
});

// ---------- 11. which chunk files are inputs, and which nodes can be attributed ----------

// Fixtures below write real files into a temp dir and a fake corpus of two
// roots. Synthetic on purpose: the real numbers that motivate this section
// (88 vs 20 files, 300 orphaned ids, 8 unattributable nodes) are measured in
// the comment headers of the module under test, not asserted here, so that
// adding a note to the vault cannot turn this suite red.

// A corpus with two roots and one deliberately absent file. `tmpDir` returns
// the root so the fixtures can name paths inside it that really exist.
function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'vault-merge-corpus-'));
  const roots = [join(dir, 'conversations'), join(dir, 'vault')];
  for (const root of roots) mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(roots[0], 'notes', 'live-transcript.md'), '# transcript\n', 'utf8');
  writeFileSync(join(roots[1], 'notes', 'live-note.md'), '# note\n', 'utf8');
  // Referenced by `deleted.md` below and never written, standing in for the
  // N8n raw captures deleted in commit 3a968b2.
  return { dir, roots };
}

// A semantic dir holding one file per naming scheme, plus chunks that point at
// the corpus: live, live, and deleted.
function schemeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-merge-scheme-'));
  for (const [name, nodes] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify({ nodes, links: [] }), 'utf8');
  }
  return dir;
}

function chunkNode(id, sourceFile) {
  return node(id, { source_file: sourceFile });
}

describe('discoverChunkFiles', () => {
  test('BOTH naming schemes are read, not just the current one', () => {
    // The whole reason this function exists. `chunk-NNN.json` is the older
    // layout; a glob would catch it, an allowlist of `chunk-rem-*` would not,
    // and the difference is 300 node ids covering 38 live transcripts.
    const dir = schemeDir({
      'chunk-rem-001.json': [chunkNode('a', 'notes/live.md')],
      'chunk-rem-002.json': [chunkNode('b', 'notes/live.md')],
      'chunk-001.json': [chunkNode('c', 'notes/live.md')],
      'chunk-002.json': [chunkNode('d', 'notes/live.md')],
    });
    try {
      const { files, byScheme } = discoverChunkFiles(dir);
      assert.deepEqual(files.map((f) => f.name), [
        'chunk-001.json',
        'chunk-002.json',
        'chunk-rem-001.json',
        'chunk-rem-002.json',
      ]);
      assert.equal(byScheme.rem.length, 2);
      assert.equal(byScheme.bare.length, 2, 'the older scheme is read too');
      assert.deepEqual(byScheme.bare, ['chunk-001.json', 'chunk-002.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the two schemes do not shadow each other on the same number', () => {
    const dir = schemeDir({
      'chunk-007.json': [chunkNode('from-old', 'notes/live.md')],
      'chunk-rem-007.json': [chunkNode('from-new', 'notes/live.md')],
    });
    try {
      const { byScheme } = discoverChunkFiles(dir);
      assert.deepEqual(byScheme.bare, ['chunk-007.json']);
      assert.deepEqual(byScheme.rem, ['chunk-rem-007.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('batches.json is not mistaken for a chunk', () => {
    const dir = schemeDir({
      'batches.json': [chunkNode('worklist', 'notes/live.md')],
      'chunk-rem-001.json': [chunkNode('a', 'notes/live.md')],
    });
    try {
      const { files } = discoverChunkFiles(dir);
      assert.deepEqual(files.map((f) => f.name), ['chunk-rem-001.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unrecognised filename is an ERROR, naming the file and both patterns', () => {
    // Not a skip. A file this function cannot classify is either a naming
    // scheme nobody told it about, or a chunk that would be read by nobody —
    // and the second case is the silent loss the module header argues about.
    const dir = schemeDir({
      'chunk-rem-001.json': [chunkNode('a', 'notes/live.md')],
      'chunk-v2-001.json': [chunkNode('b', 'notes/live.md')],
    });
    try {
      assert.throws(() => discoverChunkFiles(dir), /unrecognised chunk filename/);
      assert.throws(() => discoverChunkFiles(dir), /chunk-v2-001\.json/);
      assert.throws(() => discoverChunkFiles(dir), /chunk-rem-\(\\d\+\)\\\.json\$/, 'the message lists both schemes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every unrecognised filename is named, not just the first', () => {
    const dir = schemeDir({
      'chunk-a.json': [chunkNode('a', 'notes/live.md')],
      'chunk-b.json': [chunkNode('b', 'notes/live.md')],
    });
    try {
      assert.throws(() => discoverChunkFiles(dir), /chunk-a\.json, chunk-b\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the order does not depend on the filesystem returning sorted entries', () => {
    const dir = schemeDir({
      'chunk-rem-010.json': [chunkNode('a', 'notes/live.md')],
      'chunk-rem-002.json': [chunkNode('b', 'notes/live.md')],
      'chunk-003.json': [chunkNode('c', 'notes/live.md')],
    });
    try {
      const first = discoverChunkFiles(dir).files.map((f) => f.name);
      const second = discoverChunkFiles(dir).files.map((f) => f.name);
      assert.deepEqual(first, second);
      // Scheme order is the merge order: `bare` first, because the older pass
      // supplied the nodes a later pass would otherwise only half-fill.
      assert.deepEqual(first, ['chunk-003.json', 'chunk-rem-002.json', 'chunk-rem-010.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadChunks', () => {
  test('keeps a node whose file is under either root', () => {
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [
        chunkNode('from-transcripts', 'notes/live-transcript.md'),
        chunkNode('from-vault', 'notes/live-note.md'),
      ],
    });
    try {
      const { chunks: loaded, report } = loadChunks(chunks, { roots });
      assert.equal(report.nodesUnattributable, 0);
      assert.deepEqual(loaded[0].chunk.nodes.map((n) => n.id), ['from-transcripts', 'from-vault']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('DROPS the nodes of a deleted file, and counts them', () => {
    // Measured on the real corpus: 8 nodes across 4 deleted N8n raw captures.
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [
        chunkNode('survivor', 'notes/live-note.md'),
        chunkNode('gone-1', 'Raw Captures/n8n Docs 26.md'),
        chunkNode('gone-2', 'Raw Captures/Specify user folder path.md'),
        chunkNode('gone-3', 'Raw Captures/n8n Docs 16.md'),
        chunkNode('gone-4', 'Raw Captures/User management SMTP.md'),
      ],
    });
    try {
      const { chunks: loaded, report } = loadChunks(chunks, { roots });
      assert.deepEqual(loaded[0].chunk.nodes.map((n) => n.id), ['survivor'], 'only the attributable node survives');
      assert.equal(report.nodesUnattributable, 4, 'every dropped node is counted, not just files');
      assert.equal(report.unattributableFiles, 4);
      assert.deepEqual(report.unattributableSamples.map((s) => s.node).sort(), ['gone-1', 'gone-2', 'gone-3', 'gone-4']);
      assert.equal(report.unattributableSamples[0].file, 'chunk-rem-001.json', 'the sample names the chunk to look at');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('one deleted file with several nodes is counted per NODE and per FILE', () => {
    // The SMTP/2FA note alone carries four nodes on the real corpus, so
    // conflating the two counts would understate the loss fourfold.
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [
        chunkNode('keep', 'notes/live-note.md'),
        chunkNode('s1', 'Raw Captures/User management SMTP.md'),
        chunkNode('s2', 'Raw Captures/User management SMTP.md'),
        chunkNode('s3', 'Raw Captures/User management SMTP.md'),
        chunkNode('s4', 'Raw Captures/User management SMTP.md'),
      ],
    });
    try {
      const { report } = loadChunks(chunks, { roots });
      assert.equal(report.nodesUnattributable, 4);
      assert.equal(report.unattributableFiles, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('a node missing from BOTH roots is dropped too', () => {
    // Not only the N8n case. Any path that resolves under neither root is
    // unattributable, and the check must not be specific to one deleted
    // directory.
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [chunkNode('nowhere', '03 - Resources/Nothing/ever/filed this.md')],
    });
    try {
      const { chunks: loaded, report } = loadChunks(chunks, { roots });
      assert.deepEqual(loaded[0].chunk.nodes, []);
      assert.equal(report.nodesUnattributable, 1);
      assert.equal(report.unattributableFiles, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('a source_file that escapes every root is not attributed to what it points at', () => {
    // `../../etc/passwd` exists. Attributing a node to it would manufacture a
    // provenance record pointing outside the corpus, which is the same defect
    // as guessing a title during re-attribution.
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [chunkNode('escapee', '../../../etc/passwd')],
    });
    try {
      const { report } = loadChunks(chunks, { roots });
      assert.equal(report.nodesUnattributable, 1, 'an escaping path is not an existing file for this purpose');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('the dropped nodes are gone from the merged graph, and their links are counted once', () => {
    // The end-to-end consequence: a link into a dropped node cannot survive,
    // and the loss is reported by exactly one counter. If loadChunks started
    // pruning links too, this would become two reasons for one dropped edge.
    const { dir, roots } = corpus();
    const chunksDir = schemeDir({
      'chunk-rem-001.json': [
        chunkNode('kept', 'notes/live-note.md'),
        chunkNode('dropped', 'Raw Captures/deleted.md'),
      ],
    });
    const chunksPath = join(chunksDir, 'chunk-rem-001.json');
    writeFileSync(
      chunksPath,
      JSON.stringify({
        nodes: [chunkNode('kept', 'notes/live-note.md'), chunkNode('dropped', 'Raw Captures/deleted.md')],
        links: [link('kept', 'dropped')],
      }),
      'utf8',
    );
    try {
      const { chunks, report } = loadChunks(chunksDir, { roots });
      const { graph, report: merged } = merge(chunks);
      assert.deepEqual(graph.nodes.map((n) => n.id), ['kept']);
      assert.equal(graph.links.length, 0);
      assert.equal(report.nodesUnattributable, 1);
      assert.equal(merged.danglingLinksDropped, 1, 'counted by merge, once, for one reason');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunksDir, { recursive: true, force: true });
    }
  });

  test('an unattributable node is never reported as a validation failure instead', () => {
    // If the drop did not happen, pass 1 would accept the node happily — a
    // repo-relative path is all the validator checks — and the unattributable
    // node would reach graph.json looking like any other. This is the whole
    // reason the drop exists.
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [chunkNode('dropped', 'Raw Captures/deleted.md')],
    });
    try {
      const { chunks: loaded } = loadChunks(chunks, { roots });
      const { report } = merge(loaded);
      assert.equal(report.chunksRejected, 0);
      assert.equal(report.nodes, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('nodes from BOTH schemes reach the merge, so the old pass is not dropped', () => {
    // The regression this pins: an allowlist of `chunk-rem-*` alone would
    // emit a clean graph with these 300 real nodes simply absent.
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [chunkNode('new-pass', 'notes/live-note.md')],
      'chunk-001.json': [chunkNode('old-pass-only', 'notes/live-transcript.md')],
    });
    try {
      const { chunks: loaded, report } = loadChunks(chunks, { roots });
      assert.equal(report.chunkFilesRead, 2);
      assert.deepEqual(report.chunkFilesByScheme.rem, ['chunk-rem-001.json']);
      assert.deepEqual(report.chunkFilesByScheme.bare, ['chunk-001.json']);
      const { graph } = merge(loaded);
      assert.deepEqual(graph.nodes.map((n) => n.id), ['new-pass', 'old-pass-only']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('a node with no source_file is left for the validator, not dropped here', () => {
    // Re-attributing it would invent the provenance this module refuses to
    // invent, and dropping it here would report it under a different counter
    // than the ghost policy that owns it. The validator rejects and names it.
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [{ id: 'no-source', label: 'No Source', file_type: 'concept', source_file: null }],
    });
    try {
      const { chunks: loaded, report } = loadChunks(chunks, { roots });
      assert.equal(report.nodesUnattributable, 0, 'a ghost is not an unattributable node');
      assert.equal(loaded[0].chunk.nodes.length, 1);
      const merged = merge(loaded).report;
      assert.equal(merged.chunksRejected, 1, 'the peer validator still refuses it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('the same path is resolved once, and each node keeps its own source_file', () => {
    const { dir, roots } = corpus();
    const chunks = schemeDir({
      'chunk-rem-001.json': [
        chunkNode('a', 'notes/live-note.md'),
        chunkNode('b', 'notes/live-note.md'),
        chunkNode('c', 'notes/live-note.md'),
      ],
    });
    try {
      const { chunks: loaded } = loadChunks(chunks, { roots });
      assert.deepEqual(
        loaded[0].chunk.nodes.map((n) => n.source_file),
        ['notes/live-note.md', 'notes/live-note.md', 'notes/live-note.md'],
        'attribution resolves the path, it does not rewrite the field',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('the unattributable sample is bounded while the count stays exact', () => {
    const { dir, roots } = corpus();
    const nodes = [];
    for (let i = 0; i < 30; i += 1) nodes.push(chunkNode(`gone-${i}`, `Raw Captures/missing-${i}.md`));
    const chunks = schemeDir({ 'chunk-rem-001.json': nodes });
    try {
      const { report } = loadChunks(chunks, { roots });
      assert.equal(report.nodesUnattributable, 30, 'the count is not sampled');
      assert.equal(report.unattributableFiles, 30);
      assert.equal(report.unattributableSamples.length, 20, 'the evidence is, so the report stays readable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('an empty roots list is refused rather than dropping every node', () => {
    const { dir, roots } = corpus();
    const chunks = schemeDir({ 'chunk-rem-001.json': [chunkNode('a', 'notes/live-note.md')] });
    try {
      assert.throws(() => loadChunks(chunks, { roots: [] }), /roots must be a non-empty array/);
      assert.throws(() => loadChunks(chunks, { roots: roots.slice(0, 0) }), /roots must be a non-empty array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(chunks, { recursive: true, force: true });
    }
  });

  test('a directory with no chunk files is empty, not an error', () => {
    // A first run over a fresh semantic dir has nothing to merge; that is not a
    // defect and must not be reported as one. The roots are throwaway paths:
    // with no chunk files there is nothing to attribute, so nothing is ever
    // looked up under them, and naming real corpus roots would drag the host's
    // env or local.config.json into a test that needs none of it.
    const dir = mkdtempSync(join(tmpdir(), 'vault-merge-empty-'));
    try {
      const { files } = discoverChunkFiles(dir);
      assert.deepEqual(files, []);
      const { chunks, report } = loadChunks(dir, { roots: [join(dir, 'a'), join(dir, 'b')] });
      assert.deepEqual(chunks, []);
      assert.equal(report.chunkFilesRead, 0);
      assert.equal(report.nodesUnattributable, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- 12. the source roots: env first, config second, never a default ----------

// The old DEFAULT_SOURCE_ROOTS constant named two directories on one machine;
// resolveSourceRoots resolves them per call instead: $ARCHIVE_ROOT and
// $VAULT_ROOT first, then local.config.json, and with neither set it throws
// rather than guessing. Everything here passes a configPath into a temp dir
// and manages both env vars explicitly, so the suite never reads the repo's
// own local.config.json and passes on a machine that has none.

describe('resolveSourceRoots', () => {
  // Both variables are managed by every test so a value inherited from the
  // caller's shell cannot flip a case; afterEach restores what was there.
  const envKeys = ['ARCHIVE_ROOT', 'VAULT_ROOT'];
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
    const dir = mkdtempSync(join(tmpdir(), 'vault-merge-roots-'));
    return { configPath: join(dir, 'absent.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test('each root comes from its env var, archive first', () => {
    process.env.ARCHIVE_ROOT = '/tmp/archive-from-env';
    process.env.VAULT_ROOT = '/tmp/vault-from-env';
    const { configPath, cleanup } = absentConfig();
    try {
      assert.deepEqual(resolveSourceRoots({ configPath }), ['/tmp/archive-from-env', '/tmp/vault-from-env']);
    } finally {
      cleanup();
    }
  });

  test('env wins over the config file', () => {
    process.env.ARCHIVE_ROOT = '/env/archive';
    delete process.env.VAULT_ROOT;
    const dir = mkdtempSync(join(tmpdir(), 'vault-merge-roots-'));
    const configPath = join(dir, 'local.config.json');
    writeFileSync(configPath, JSON.stringify({ archiveRoot: '/cfg/archive', vaultRoot: '/cfg/vault' }), 'utf8');
    try {
      const roots = resolveSourceRoots({ configPath });
      assert.equal(roots[0], '/env/archive');
      assert.equal(roots[1], '/cfg/vault', 'the root with no env var still falls back to the config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no env var, both roots fall back to the config file', () => {
    delete process.env.ARCHIVE_ROOT;
    delete process.env.VAULT_ROOT;
    const dir = mkdtempSync(join(tmpdir(), 'vault-merge-roots-'));
    const configPath = join(dir, 'local.config.json');
    writeFileSync(configPath, JSON.stringify({ archiveRoot: '/cfg/archive', vaultRoot: '/cfg/vault' }), 'utf8');
    try {
      assert.deepEqual(resolveSourceRoots({ configPath }), ['/cfg/archive', '/cfg/vault']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no default path: with no env var and no config it throws, naming the env var and the example file', () => {
    delete process.env.ARCHIVE_ROOT;
    delete process.env.VAULT_ROOT;
    const { configPath, cleanup } = absentConfig();
    try {
      // The archive root is resolved first, so with both missing it is the
      // archive's error that surfaces.
      assert.throws(() => resolveSourceRoots({ configPath }), /set ARCHIVE_ROOT/);
      assert.throws(() => resolveSourceRoots({ configPath }), /local\.config\.example\.json/);
      process.env.ARCHIVE_ROOT = '/tmp/archive-from-env';
      assert.throws(() => resolveSourceRoots({ configPath }), /set VAULT_ROOT/);
    } finally {
      cleanup();
    }
  });

  test('the returned pair is frozen', () => {
    process.env.ARCHIVE_ROOT = '/frozen/archive';
    process.env.VAULT_ROOT = '/frozen/vault';
    const { configPath, cleanup } = absentConfig();
    try {
      const roots = resolveSourceRoots({ configPath });
      assert.ok(Object.isFrozen(roots), 'a caller must not be able to reorder or extend the roots');
    } finally {
      cleanup();
    }
  });
});

// ---------- 10. foldLabel ----------
//
// Exported because the vault's own `norm_label` is assigned by a later pass
// that owns different rules, and the corpus carries real accents, hyphens and
// en-dashes. If these foldings ever change, every unique/ambiguous split in
// the report changes with them, silently.

describe('foldLabel', () => {
  test('case, accents and punctuation all collapse', () => {
    assert.equal(foldLabel('AI Tools List'), foldLabel('ai-tools-list'));
    assert.equal(foldLabel('Café Strategy'), foldLabel('cafe  strategy'));
    assert.equal(foldLabel('Done Is Better Than Perfect'), 'done is better than perfect');
  });

  test('an en-dash and a hyphen are the same separator', () => {
    assert.equal(foldLabel('Report (2023) – Sistem Pembayaran'), foldLabel('report (2023) - sistem pembayaran'));
  });

  test('a non-string folds to the empty string, which matches nothing', () => {
    for (const value of [undefined, null, 42, {}, []]) assert.equal(foldLabel(value), '');
  });

  test('a label of pure punctuation folds to the empty string', () => {
    assert.equal(foldLabel('---'), '');
    assert.equal(foldLabel('   '), '');
  });

  test('digits survive, because titles contain years', () => {
    assert.equal(foldLabel('Ebook 2024'), 'ebook 2024');
  });
});
