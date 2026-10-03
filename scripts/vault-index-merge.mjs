// scripts/vault-index-merge.mjs
//
// The join. N subagents each read a slice of the vault and emit a chunk of
// nodes and links; this turns those chunks into one graph.json, and the two
// numbers it reports are the only evidence that the join actually worked.
//
// The problem this module exists to solve is not unioning two arrays. It is
// that a parallel extraction cannot see itself. A subagent reading batch A
// encounters a wiki link to a note that lives in batch B. That note is not in
// A's node list, not in A's context window, and may not even be assigned an id
// until B's subagent has finished and its output been written to disk. So the
// link is unresolvable at the moment A emits it, and the two available
// reactions are both silent:
//
//   - Drop it. The relationship between the two notes disappears from the
//     rebuild, permanently, and nothing anywhere records that it was ever
//     claimed. A wiki-link graph that has quietly lost its wiki links is
//     indistinguishable from a corpus that had none.
//   - Write it. The edge goes into graph.json as a well-formed object, and the
//     loader that reads the file back has no signal that separates it from a
//     good edge.
//
// Measured on the real vault graph, 2026-10-02: 6,155 nodes, 5,527 links, and
// 1,415 nodes that are not an endpoint of any edge. The tempting reading of
// that 1,415 is "dangling endpoints", and it is wrong — re-checking by hand,
// 0 of the 10,854 endpoint references in the link array fail to resolve. The
// graph is a forest of disconnected pairs, not one with holes in it. That
// distinction is why `crossChunkDangling` and `crossChunkResolved` are
// separate counters and why this module does not go looking for orphans: a
// dangling endpoint and an unreferenced node are different defects with
// different fixes, and a report that conflates them sends the next person to
// the wrong file to fix the right-sounding problem.
//
// Four decisions are load-bearing. Each is one that survives review and then
// quietly does the wrong thing at 6,000 nodes, which is why the tests pin them
// rather than the comments claiming them:
//
//   1. VALIDATION IS PER CHUNK, AND REJECTION IS TOTAL. Every chunk goes
//      through the peer validator before a single node of it is admitted. A
//      chunk that fails is named and contributes NOTHING — not its good nodes,
//      not its good links. Partial acceptance is the failure mode worth
//      naming: a half-chunk yields a plausible node count, a plausible link
//      count, and a hole where a relationship should be, and nobody reconciles
//      those three numbers against each other afterwards. One confused
//      subagent must not be able to shrink the graph.
//
//   2. THE ID UNION IS BUILT FROM ACCEPTED CHUNKS ONLY. This is the
//      consequence of (1) that is easiest to get backwards. If a rejected
//      chunk's ids entered the union, every other chunk's references to them
//      would resolve onto nodes that are not in the graph: the edge would look
//      perfect and terminate at nothing. Rejection has to remove ids from
//      resolution as well as from the node list, and the test that proves it
//      counts a link to a rejected chunk's node as dangling.
//
//   3. TWO DEDUPE KEYS, AND THEY COUNT DIFFERENT THINGS. Nodes union on `id`;
//      a collision is one surplus record (three chunks declaring `x` is two
//      collisions, not three). Links dedupe on `source|target|relation`, and
//      confidence is deliberately NOT in that key: two extractors rating the
//      same edge differently is a disagreement about certainty, not a second
//      claim that the edge exists. The disagreement is counted on its own
//      (`confidenceDisagreements`) so that dropping the second edge does not
//      also drop the fact that they did not agree. Note the asymmetry with
//      the peer validator, which treats an intra-chunk duplicate as an ERROR
//      and a cross-chunk duplicate as agreement — correctly, because within a
//      chunk one subagent can see both copies, and across chunks nothing can
//      see both until here.
//
//   4. NOTHING IS DERIVED. `confidence_score` and `weight` look derivable from
//      `confidence` and are not: the measured file has EXTRACTED links scoring
//      both 1.0 and 0.9, and AMBIGUOUS links scoring both 0.5 and 1.0. Those
//      fields are the output of a scoring pass that runs after this one, and a
//      value invented here would be indistinguishable from a real one in every
//      downstream read. The same rule governs `built_at_commit`: threaded
//      through from the caller, or from `previous`, or null — never invented,
//      because a fabricated hash reads as provenance to every consumer.
//
// Two smaller choices that are still choices. A dangling link is DROPPED by
// default and counted in `crossChunkDangling` rather than written and
// forgotten, for the reason in the second bullet above; `keepDangling` turns
// that off for a caller who wants to see the whole picture. And the emitted
// arrays are sorted by codepoint, not by `localeCompare`, because ICU collation
// is locale-dependent: two machines can order the same 6,155 ids differently,
// and a serialiser whose output depends on the host's locale cannot support
// the one property the caller needs from it — that two runs on the same input
// produce byte-identical files, which is the cheapest available proof that a
// re-run did not quietly reorder the graph.
//
// The `previous` graph is seeded FIRST, so it wins every conflict and a
// re-extracted node fills gaps in an existing record rather than replacing it.
// The vault already holds 6,155 nodes of accumulated work; reducing them to the
// four fields the validator requires would pass every test in this file that
// counts nodes while discarding author, rationale and source_url from all of
// them. A union that only ever grows is also why the previous graph's
// hyperedges are retained verbatim without re-checking their membership: no
// node id is ever removed from the union, so a member cannot have gone missing
// here.

import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';

import { validateChunk } from './lib/chunk-schema.mjs';
import { resolveConfiguredPath } from './lib/local-config.mjs';

/**
 * Top-level key order of the emitted file.
 *
 * Taken from the measured graph.json, not chosen. A key order is part of a
 * file format in practice — every diff of two graph.json files reads as a diff
 * of whole blocks if the order moves, and a graph file that is 5.7 MB and
 * 161,627 lines is not something anybody wants to diff line by line.
 */
export const TOP_LEVEL_KEY_ORDER = Object.freeze([
  'directed',
  'multigraph',
  'graph',
  'nodes',
  'links',
  'hyperedges',
  'built_at_commit',
]);

/**
 * Node key order. Canonical fields first, in a fixed order; anything a node
 * carries outside this list is appended afterwards in codepoint order, so the
 * serialiser's output never depends on the order the fields were discovered.
 */
export const NODE_KEY_ORDER = Object.freeze([
  'id',
  'label',
  'norm_label',
  'file_type',
  'source_file',
  'source_location',
  'community',
  'community_name',
  '_origin',
]);

/** Link key order. Same rule as {@link NODE_KEY_ORDER}. */
export const LINK_KEY_ORDER = Object.freeze([
  'source',
  'target',
  'relation',
  'confidence',
  'confidence_score',
  'weight',
  '_origin',
  'context',
  'source_file',
  'source_location',
]);

/**
 * How many dangling endpoints `report.danglingSamples` will name.
 *
 * Bounded because the number it accompanies is not bounded. A rebuild where
 * every reference is dangling produces thousands of them, and a report that
 * prints all of them is a report nobody reads to the end — at which point the
 * count is the only thing anyone looks at, which is the outcome this module
 * exists to prevent. The count stays exact; only the evidence is sampled.
 */
const MAX_DANGLING_SAMPLES = 20;

// Joined on a character that cannot appear in a node id, for the same reason
// the peer validator does the same thing: `["ab","c"]` and `["a","bc"]` must not
// collapse into one key.
const KEY_SEP = '\u0000';

/** The two ways a node with no usable `source_file` can be handled. */
export const GHOST_POLICIES = Object.freeze(['drop', 'reattribute']);

/**
 * The default, and the argument for it.
 *
 * `reattribute`, because it is the only one of the two that cannot destroy
 * work. Measured on the real vault graph, 2026-10-02, against the structural
 * layer over its 3,390 notes: of the 1,299 nodes whose `source_file` is null or
 * empty, 402 get a unique same-type label match, 292 are ambiguous and 605 find
 * nothing. `drop` would delete all 1,299 — 21.1% of 6,155 nodes — and orphan
 * 1,454 of the 5,527 links, 26.3% of them, because 1,185 of the 1,299 are an
 * endpoint of some edge. A policy that can lose a quarter of the graph on a
 * defect in one field is not a default; it is a decision that should need
 * saying out loud, which is what `drop` now is.
 *
 * The evidence that `reattribute` is not merely the timid choice: 694 of the
 * 769 `document` ghosts carry a label that appears as some real note title.
 * Ninety percent label overlap with the note corpus is not what garbage looks
 * like — these are note-title nodes that lost their path, and the 402 unique
 * matches are the recoverable subset. The other 605 are left counted and
 * untouched.
 */
export const DEFAULT_GHOST_POLICY = 'reattribute';

/**
 * Fold a label to the form two labels are compared in.
 *
 * Case-folded, accent-stripped, and every run of non-alphanumerics collapsed to
 * one space, so `AI Tools List`, `ai-tools-list`, `AI-Tools-List` and
 * `AI Tools List` are one key. NFKD first, then drop the combining marks it
 * leaves behind, or `Café` and `Cafe` would stay apart on a corpus of 6,155
 * nodes carrying real accents.
 *
 * Deliberately NOT the graph's own `norm_label`: that field is assigned by a
 * later pass that owns its own rules, only 1,269 of the ghosts are known to
 * carry it, and an incoming chunk's node need not have it at all. Comparing two
 * labels through a convention this module does not control is how two things
 * that look equal stop being equal.
 *
 * @param {unknown} label
 * @returns {string} `''` when nothing survives, which matches nothing — the
 *   same treatment `isAbsent` gives an empty `source_file`, so a ghost with a
 *   blank label is reported rather than attributed to the first real title.
 */
export function foldLabel(label) {
  if (typeof label !== 'string') return '';
  return label
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Keys that are never copied off a record. `__proto__` is the real one: an
// object literal with `__proto__:` sets a prototype instead of creating a
// property, so the only way to produce the hazard is JSON.parse — which is
// exactly how a previous graph.json was read. `constructor` and `prototype`
// are here because the cost of also skipping them is zero.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Codepoint comparison. Deliberately not `localeCompare`; see the header. */
function cmp(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Is this field absent in the sense that means "the extractor had nothing"?
 *
 * `0` is a real value — `community: 0` is the first community, and
 * `confidence_score: 0` is a real score. Treating falsy as absent would let a
 * later chunk's zero overwrite a real one, or refuse a legitimate one, and the
 * symptom would be a node in the wrong community with no error anywhere.
 */
function isAbsent(value) {
  return value === undefined || value === null || value === '';
}

/** Copy an object into a plain one, dropping undefined, forbidden and absent values. */
function copyFields(source) {
  const out = {};
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** A non-empty string, or null. `null` means "no usable id", never "no value". */
function filledString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Name this chunk, so a rejection is actionable.
 *
 * A wrapper is anything carrying a `chunk` key, which is what lets a wrapper
 * express `chunk: null` — a subagent that returned the literal `null` instead
 * of a chunk, and the most common real failure there is. A bare chunk is
 * accepted too, and is then named by position, because a caller assembling
 * chunks in memory should not have to wrap them to be mergeable.
 */
function entryName(entry, index) {
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'chunk' in entry) {
    return filledString(entry.name) ?? `chunks[${index}]`;
  }
  return `chunks[${index}]`;
}

/** The chunk itself, unwrapping a wrapper if there is one. */
function entryChunk(entry) {
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'chunk' in entry) return entry.chunk;
  return entry;
}

/** Rebuild a record with `keys` first, in order, then every other key sorted. */
function ordered(record, keys) {
  const out = {};
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  const surplus = Object.keys(record).filter((k) => !keys.includes(k)).sort(cmp);
  for (const key of surplus) out[key] = record[key];
  return out;
}

// ---------------------------------------------------------------------------
// pass 0 — decide which files are inputs, and which nodes can be attributed
// ---------------------------------------------------------------------------

/**
 * The two chunk-naming schemes in `vault-index/semantic/`, matched by name.
 *
 * Matched EXPLICITLY and not by `chunk-*.json`, because the glob is the bug.
 * Measured 2026-10-02: `chunk-rem-NNN.json` is 88 files citing 124 source
 * files, `chunk-NNN.json` is 20 files citing 42, and the intersection of those
 * two source-file sets is ZERO. So the old scheme is not a stale subset of the
 * new one to be tidied away — it is 342 node ids the current pass never saw,
 * 300 of which appear in no `chunk-rem-*` file, covering 38 transcripts that
 * are still on disk (23.4 MB) and that no other pass will ever read, because
 * `batches.json`'s 997-file worklist also intersects the old scheme zero
 * times. An allowlist of `chunk-rem-*` alone therefore discards live,
 * unindexed work while producing a clean node count and no error anywhere.
 *
 * Order is also the merge order, which matters: on a node-id collision the
 * first record wins its non-empty fields, so the two schemes are read in a
 * fixed order rather than in whatever order the filesystem returns.
 */
export const CHUNK_FILE_SCHEMES = Object.freeze([
  Object.freeze({ scheme: 'rem', pattern: /^chunk-rem-(\d+)\.json$/ }),
  Object.freeze({ scheme: 'bare', pattern: /^chunk-(\d+)\.json$/ }),
]);

/**
 * Files in the same directory that are not chunks.
 *
 * Named rather than pattern-matched, because "everything that is not a chunk
 * is skipped" is precisely the rule that hides a third naming scheme. An
 * unrecognised `chunk-*` file is an error in {@link discoverChunkFiles}; this
 * is the short list of things that are knowingly not chunks.
 */
export const NON_CHUNK_FILES = Object.freeze(['batches.json']);

/**
 * The two roots a `source_file` may resolve to, in merge order.
 *
 * Both roots are searched for every path because the corpus straddles them:
 * transcripts live in `conversations-archive` (moved out of the vault on
 * 2026-10-02, so `05 - Conversations` no longer resolves under the vault
 * root), and vault notes resolve under `Obsidian Vault`. Archive first, vault
 * second: first root wins, matching the order `vault-index-rebuild.mjs`
 * assembles for the same corpus.
 *
 * Resolved per call, never at import: `$ARCHIVE_ROOT` and `$VAULT_ROOT` win,
 * then local.config.json's "archiveRoot" and "vaultRoot" (copy
 * local.config.example.json), and with neither set the call throws naming the
 * env var, the config file and the example to copy. That is the same rule
 * `vault-index-rebuild.mjs` applies, for the same reason. A root list that
 * only ever names two directories on one host is a constant pretending to be
 * a convention, and a caller merging a corpus other than this machine's must
 * not have to edit this file.
 *
 * @param {{configPath?: string}} [opts] test-only config file override
 * @returns {string[]} frozen `[archiveRoot, vaultRoot]`
 */
export function resolveSourceRoots({ configPath } = {}) {
  return Object.freeze([
    resolveConfiguredPath({ envVar: 'ARCHIVE_ROOT', configKey: 'archiveRoot', label: 'conversations archive root', configPath }),
    resolveConfiguredPath({ envVar: 'VAULT_ROOT', configKey: 'vaultRoot', label: 'Obsidian vault root', configPath }),
  ]);
}

/**
 * How many dropped nodes `report.unattributableSamples` will name.
 *
 * Same bound, same reasoning as {@link MAX_DANGLING_SAMPLES}: the count stays
 * exact, the evidence is sampled.
 */
const MAX_UNATTRIBUTABLE_SAMPLES = 20;

/** Which scheme a filename belongs to, or null when no scheme claims it. */
function schemeOf(filename) {
  for (const { scheme, pattern } of CHUNK_FILE_SCHEMES) {
    if (pattern.test(filename)) return scheme;
  }
  return null;
}

/**
 * List the chunk files in a directory, in a deterministic order, grouped by
 * scheme.
 *
 * Every `.json` entry must be classified: it is a chunk file, or it is named in
 * {@link NON_CHUNK_FILES}, or it is an error. Non-JSON entries and
 * subdirectories are ignored — they cannot be a chunk, so ignoring them cannot
 * hide one — but a JSON file of unknown shape is refused, because the day
 * somebody invents `chunk-v2-NNN.json` this is the line that stops it being
 * read by nobody.
 *
 * @param {string} dir
 * @returns {{files: Array<{name: string, path: string, scheme: string}>,
 *   byScheme: Record<string, string[]>}}
 * @throws {Error} on an unclassifiable `.json` file, naming the file and the
 *   two patterns that were tried.
 */
export function discoverChunkFiles(dir) {
  const files = [];
  const byScheme = {};
  for (const { scheme } of CHUNK_FILE_SCHEMES) byScheme[scheme] = [];

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort(cmp);

  const unclassified = [];
  for (const name of entries) {
    if (NON_CHUNK_FILES.includes(name)) continue;
    const scheme = schemeOf(name);
    if (scheme === null) {
      unclassified.push(name);
      continue;
    }
    files.push({ name, path: `${dir}/${name}`, scheme });
    byScheme[scheme].push(name);
  }

  if (unclassified.length > 0) {
    const patterns = CHUNK_FILE_SCHEMES.map((s) => s.pattern.source).join(' or ');
    throw new Error(
      `unrecognised chunk filename(s) in ${dir}: ${unclassified.join(', ')}. ` +
        `Known schemes are ${patterns}. A file this function cannot classify is an error, not a skip: ` +
        `naming it as a scheme is one line here, and skipping it silently drops a pass's work.`,
    );
  }

  return { files, byScheme };
}

/**
 * Resolve a `source_file` against the roots, or null when nothing matches.
 *
 * Containment is checked, not just existence. A `source_file` of
 * `../../../etc/passwd` resolves to a file that exists, so a bare
 * `existsSync` would happily attribute a node to it; measured 2026-10-02, no
 * real source_file escapes a root, and the check costs one string comparison
 * per candidate and keeps a future extractor from manufacturing provenance
 * that points outside the corpus.
 */
function resolveUnderRoots(sourceFile, roots) {
  for (const root of roots) {
    const abs = resolvePath(root, sourceFile);
    if (abs !== root && !abs.startsWith(`${root}${sep}`)) continue;
    try {
      if (statSync(abs).isFile()) return abs;
    } catch {
      // Not there. Try the next root.
    }
  }
  return null;
}

/**
 * Read the chunk files and drop the nodes that can no longer be attributed.
 *
 * A node whose `source_file` no longer resolves is DROPPED and counted, and
 * this is the plan's rule rather than a preference (T9 in
 * `docs/code-plan/plans/2026-10-02-subagent-driven-vault-index.md`): the
 * extraction was correct when it was written, and the files were legitimately
 * deleted afterwards — the N8n raw captures went in commit `3a968b2`. Keeping
 * the node re-creates the unattributable-node failure this project exists to
 * remove, except now nobody can even say which note it came from. The count is
 * reported so the deletion is visible instead of inferred from a node count
 * that came out lower than the sum of its inputs.
 *
 * Links are NOT touched here. A link whose endpoint was dropped becomes
 * dangling in `merge`, which already drops those and already counts them in
 * `danglingLinksDropped`; doing it in both places would give the same loss two
 * counters and make the report unable to say which cause applied.
 *
 * @param {string} dir
 * @param {{roots?: string[]}} [opts] `roots` defaults to
 *   {@link resolveSourceRoots}, i.e. the configured corpus roots
 *   ($ARCHIVE_ROOT/$VAULT_ROOT, else local.config.json)
 * @returns {{chunks: Array<{name: string, chunk: object}>, report: object}}
 *   `chunks` is in merge order. `report` carries `chunkFilesByScheme`,
 *   `chunkFilesRead`, `nodesUnattributable`, `unattributableFiles` and
 *   `unattributableSamples`.
 */
export function loadChunks(dir, opts = {}) {
  const roots = opts?.roots ?? resolveSourceRoots();
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new TypeError(`roots must be a non-empty array of directories, got ${JSON.stringify(roots)}`);
  }

  const { files, byScheme } = discoverChunkFiles(dir);

  const chunks = [];
  const report = {
    chunkFilesByScheme: byScheme,
    chunkFilesRead: 0,
    nodesUnattributable: 0,
    unattributableFiles: 0,
    unattributableSamples: [],
  };
  const missingFiles = new Set();
  // One stat per distinct path, not per node: the old scheme alone cites 42
  // paths across 343 nodes, and the worklist scale is 997 files.
  const resolved = new Map();

  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file.path, 'utf8'));
    const kept = [];
    for (const n of parsed?.nodes ?? []) {
      const sourceFile = n !== null && typeof n === 'object' && !Array.isArray(n) ? filledString(n.source_file) : null;
      if (sourceFile === null) {
        // Not an attribution question — the peer validator in pass 1 rejects a
        // missing source_file, and re-attributing one here would invent the
        // very provenance this pass refuses to invent. Let it be rejected and
        // named there.
        kept.push(n);
        continue;
      }
      let hit = resolved.get(sourceFile);
      if (hit === undefined) {
        hit = resolveUnderRoots(sourceFile, roots);
        resolved.set(sourceFile, hit);
      }
      if (hit === null) {
        report.nodesUnattributable += 1;
        missingFiles.add(sourceFile);
        if (report.unattributableSamples.length < MAX_UNATTRIBUTABLE_SAMPLES) {
          report.unattributableSamples.push({ file: file.name, node: filledString(n.id), source_file: sourceFile });
        }
        continue;
      }
      kept.push(n);
    }
    chunks.push({ name: file.name, chunk: { ...parsed, nodes: kept } });
    report.chunkFilesRead += 1;
  }

  report.unattributableFiles = missingFiles.size;
  return { chunks, report };
}

// ---------------------------------------------------------------------------
// pass 1 — validate, and build the node/link unions
// ---------------------------------------------------------------------------

/**
 * Read every chunk once: validate it, and admit its records to the union.
 *
 * The union is seeded from `previous` before the first chunk, so the existing
 * graph wins every conflict and a fresh extraction can only add to it or fill
 * a field it left empty.
 *
 * @returns {{accepted: Array<{index: number, name: string, chunk: object}>,
 *   rejections: Array<{index: number, name: string, errors: string[]}>,
 *   nodeRecords: Map<string, object>, linkRecords: Map<string, object>,
 *   previousLinkKeys: Set<string>, report: object}}
 */
function collect(chunks, previous) {
  const accepted = [];
  const rejections = [];

  const nodeRecords = new Map();
  const linkRecords = new Map();
  // Which of the union's links were already in the graph before this run, so
  // that `linksRetainedFromPrevious` measures survival rather than counting
  // records tagged `_origin: 'previous'` — a tag a chunk could also carry.
  const previousLinkKeys = new Set();
  const report = {
    chunksRead: 0,
    chunksAccepted: 0,
    chunksRejected: 0,
    nodeIdCollisions: 0,
    duplicatesDropped: 0,
    confidenceDisagreements: 0,
    previousNodes: 0,
    previousLinks: 0,
    previousSkipped: 0,
    // Measured on the real vault graph, 2026-10-02: of 6,155 previous nodes,
    // 4,856 have a real `source_file`, 30 have an empty string and 1,269 have
    // the literal `null`. All 1,299 of those fail the peer validator, so a
    // merged graph built on that history will not itself be a valid chunk, and
    // the failure shows up much later as 1,299 validation errors with no
    // indication of where they came from. They are preserved rather than
    // dropped — silently deleting a fifth of the vault's nodes is a far worse
    // outcome than a count — and the count is published so the defect is
    // somebody's to fix instead of the next run's surprise.
    previousNodesUnusableSourceFile: 0,
  };

  // `previous` first. Its records are not re-validated: it is the graph that
  // already exists, and holding 6,155 nodes to the chunk contract would reject
  // the history rather than merge it. What IS checked is the minimum needed to
  // be referenceable — a node with no usable id can be neither found by an
  // incoming link nor resolved by an incoming one, and silently keeping such a
  // record is exactly the quiet loss this module is arguing against. Those are
  // counted in `previousSkipped` rather than dropped in silence.
  const prevNodes = previous && Array.isArray(previous.nodes) ? previous.nodes : [];
  for (const n of prevNodes) {
    const id = n !== null && typeof n === 'object' && !Array.isArray(n) ? filledString(n.id) : null;
    if (id === null) {
      report.previousSkipped += 1;
      continue;
    }
    if (nodeRecords.has(id)) {
      report.nodeIdCollisions += 1;
      mergeInto(nodeRecords.get(id), n);
    } else {
      nodeRecords.set(id, copyFields(n));
    }
    if (isAbsent(n.source_file)) report.previousNodesUnusableSourceFile += 1;
    report.previousNodes += 1;
  }

  const prevLinks = previous && Array.isArray(previous.links) ? previous.links : [];
  for (const l of prevLinks) {
    const source = l !== null && typeof l === 'object' && !Array.isArray(l) ? filledString(l.source) : null;
    const target = source === null ? null : filledString(l.target);
    if (source === null || target === null) {
      report.previousSkipped += 1;
      continue;
    }
    const key = linkKey(source, target, l.relation);
    if (linkRecords.has(key)) {
      report.duplicatesDropped += 1;
    } else {
      linkRecords.set(key, copyFields(l));
    }
    previousLinkKeys.add(key);
    report.previousLinks += 1;
  }

  chunks.forEach((entry, index) => {
    report.chunksRead += 1;
    const name = entryName(entry, index);
    const chunk = entryChunk(entry);

    // No `knownNodeIds` here, on purpose. The union does not exist yet, and a
    // link to a node in another chunk is the normal case rather than a defect —
    // handing the validator the empty base would reject exactly the links this
    // module exists to rescue. Endpoint resolution is pass 2's job, and it is
    // a count, not a gate.
    const verdict = validateChunk(chunk);
    if (!verdict.ok) {
      report.chunksRejected += 1;
      rejections.push({ index, name, errors: verdict.errors });
      return;
    }
    report.chunksAccepted += 1;
    accepted.push({ index, name, chunk });

    for (const n of chunk.nodes) {
      const existing = nodeRecords.get(n.id);
      if (existing === undefined) {
        nodeRecords.set(n.id, copyFields(n));
      } else {
        report.nodeIdCollisions += 1;
        mergeInto(existing, n);
      }
    }
    for (const l of chunk.links) {
      const key = linkKey(l.source, l.target, l.relation);
      const existing = linkRecords.get(key);
      if (existing === undefined) {
        linkRecords.set(key, copyFields(l));
        continue;
      }
      report.duplicatesDropped += 1;
      // The first record wins; the disagreement is recorded separately so that
      // preferring one does not also erase the fact they differed.
      if (existing.confidence !== l.confidence) report.confidenceDisagreements += 1;
    }
  });

  return { accepted, rejections, nodeRecords, linkRecords, previousLinkKeys, report };
}

/**
 * Fill the gaps of an already-admitted node with fields a later record has and
 * it does not. First non-absent value wins, so the record that arrived first
 * keeps what it supplied.
 */
function mergeInto(target, incoming) {
  for (const key of Object.keys(incoming)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (isAbsent(target[key]) && !isAbsent(incoming[key])) target[key] = incoming[key];
  }
}

function linkKey(source, target, relation) {
  return [source, target, String(relation)].join(KEY_SEP);
}

// ---------------------------------------------------------------------------
// pass 2 — resolve every endpoint against the union
// ---------------------------------------------------------------------------

/**
 * Count the endpoints that left their chunk, and the ones that left the corpus.
 *
 * The counters come from the peer validator rather than from a second
 * membership test written here, so there is one definition of "cross-chunk" in
 * the codebase. The sample list is built by walking the links directly, because
 * the validator's errors are prose and a report wants ids. The test asserts the
 * two agree, which is what keeps the duplicate scan honest.
 *
 * Counted in ENDPOINTS, not links: a link with both ends in other chunks
 * contributes 2. A link count would understate precisely the batch that only
 * ever references the rest of the corpus — the batch with the most to lose and
 * the one most likely to be dropped for looking empty.
 */
function resolveEndpoints(accepted, unionIds) {
  let crossChunkResolved = 0;
  let crossChunkDangling = 0;
  const danglingSamples = [];

  for (const { name, chunk } of accepted) {
    const verdict = validateChunk(chunk, { knownNodeIds: unionIds });
    crossChunkResolved += verdict.stats.crossChunk;
    crossChunkDangling += verdict.stats.dangling;

    chunk.links.forEach((l, i) => {
      for (const end of ['source', 'target']) {
        const value = l[end];
        if (filledString(value) === null || unionIds.has(value)) continue;
        if (danglingSamples.length < MAX_DANGLING_SAMPLES) {
          danglingSamples.push({ chunk: name, end, endpoint: value, source: l.source, target: l.target, relation: l.relation, linkIndex: i });
        }
      }
    });
  }

  return { crossChunkResolved, crossChunkDangling, danglingSamples };
}

// ---------------------------------------------------------------------------
// pass 3 — decide the fate of every node with no usable source_file
// ---------------------------------------------------------------------------

/**
 * `drop` or `reattribute` the nodes whose `source_file` is null or empty.
 *
 * Both return the same shape so a caller reading the report does not have to
 * know which ran: the other mode's counters read zero rather than being absent,
 * because a missing key and a zero are different answers to "did anything go
 * missing" and this report exists so that question has one.
 *
 * A node is a ghost when `source_file` is null, undefined or empty — the three
 * shapes the real graph uses, measured at 1,269 `null` and 30 `""`. `0` and
 * `false` are not ghosts: `isAbsent` says so for the same reason it refuses to
 * treat `community: 0` as a value to overwrite.
 *
 * Only nodes that came from `previous` can be ghosts, because an accepted
 * chunk's nodes have all been through the peer validator, which rejects a
 * missing `source_file` as a path problem. That is why the pool is taken from
 * `previous` explicitly and why a chunk cannot smuggle one in.
 *
 * @param {Map<string, object>} nodeRecords the union, mutated in place.
 * @param {Map<string, object>} linkRecords the link union, read-only here.
 * @param {{nodes?: object[]}|undefined} previous
 * @param {Set<string>} unionIds ids of every node in the union, including
 *   ones an accepted chunk has already filled in.
 * @param {'drop'|'reattribute'} policy
 * @returns {{dropped: number, orphanedLinks: number, reattributed: number,
 *   ambiguous: number, unmatched: number, ghostIds: Set<string>}}
 */
function resolveGhosts(nodeRecords, linkRecords, previous, unionIds, policy) {
  const prevNodes = previous !== null && typeof previous === 'object' && !Array.isArray(previous) && Array.isArray(previous.nodes)
    ? previous.nodes
    : [];

  const ghosts = [];
  for (const n of prevNodes) {
    if (n === null || typeof n !== 'object' || Array.isArray(n)) continue;
    const id = filledString(n.id);
    if (id === null) continue;
    // A node id that an accepted chunk has since supplied is not a ghost any
    // more: the union holds the union's record, and that record has a path.
    if (!isAbsent(nodeRecords.get(id)?.source_file)) continue;
    ghosts.push(id);
  }

  const out = { dropped: 0, orphanedLinks: 0, reattributed: 0, ambiguous: 0, unmatched: 0, ghostIds: new Set(ghosts) };
  if (ghosts.length === 0) return out;

  if (policy === 'drop') {
    for (const id of ghosts) {
      if (!nodeRecords.delete(id)) continue;
      unionIds.delete(id);
      out.dropped += 1;
    }
    // Counted here rather than left to the dangling pass, because a link lost
    // this way is a different fact from a link that was already dangling: this
    // one was well-formed a moment ago and this run broke it. `merge` also
    // counts these in `danglingLinksDropped`, so the two counters describe the
    // two reasons and neither hides the total cost of the choice.
    for (const key of linkRecords.keys()) {
      const [source, target] = key.split(KEY_SEP);
      if (out.ghostIds.has(source) || out.ghostIds.has(target)) out.orphanedLinks += 1;
    }
    return out;
  }

  // `reattribute`. The candidate pool is the union's records that HAVE a usable
  // source_file, keyed by file_type AND folded label. Both halves of the key are
  // load-bearing:
  //
  //   - file_type, because the measured structural layer emits `document` and
  //     nothing else, so a type-free key would offer a `concept` ghost a
  //     document's title as its origin. 460 of the ghosts are concepts.
  //   - folded label, because "AI Tools List" and "ai-tools-list" are the same
  //     note title written twice.
  //
  // Candidates come from the union rather than from `previous` alone, so a
  // re-extraction this run is the first thing with a path on a record also
  // counts as evidence about which note it is.
  const index = new Map();
  for (const record of nodeRecords.values()) {
    if (isAbsent(record.source_file)) continue;
    const key = `${String(record.file_type)}${KEY_SEP}${foldLabel(record.label)}`;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [record.id]);
    else bucket.push(record.id);
  }

  for (const id of ghosts) {
    const record = nodeRecords.get(id);
    const key = `${String(record.file_type)}${KEY_SEP}${foldLabel(record.label)}`;
    const hits = index.get(key);
    // No key, or a key whose every candidate was itself deleted, is the same
    // answer: nothing to attach to.
    if (hits === undefined || hits.length === 0) {
      out.unmatched += 1;
      continue;
    }
    if (hits.length > 1) {
      // Not guessed. Two notes carry this title, and the graph has no way to
      // say which of them a concept came from; picking the first would
      // manufacture a provenance record indistinguishable from an extracted one,
      // which is the exact failure the module header is about.
      out.ambiguous += 1;
      continue;
    }
    record.source_file = nodeRecords.get(hits[0]).source_file;
    out.reattributed += 1;
  }

  return out;
}

// ---------------------------------------------------------------------------
// the merge
// ---------------------------------------------------------------------------

/**
 * Union a list of extraction chunks into one graphify-shaped graph.
 *
 * Never throws on chunk data: a malformed chunk is rejected, named, and counted,
 * and the rest of the merge proceeds. A `previous` that is not an object is
 * treated as absent rather than raising, because it came off disk and the
 * caller has no way to know it was malformed until after the merge it was going
 * to feed. The one thing that does raise is `chunks` not being an array, which
 * is a harness bug rather than extracted data.
 *
 * @param {Array<object>} chunks Each entry is either a chunk
 *   (`{nodes, links}`) or a wrapper (`{name, chunk}`). A wrapper is how a
 *   chunk of `null` can be named, which is a real subagent failure.
 * @param {{previous?: {nodes?: object[], links?: object[], hyperedges?: object[]},
 *   builtAtCommit?: string|null, keepDangling?: boolean,
 *   ghostPolicy?: 'drop'|'reattribute'}} [opts]
 * @returns {{graph: object, report: object}}
 */
export function merge(chunks, opts = {}) {
  if (!Array.isArray(chunks)) throw new TypeError(`chunks must be an array, got ${typeof chunks}`);

  const { previous, builtAtCommit, keepDangling = false, ghostPolicy = DEFAULT_GHOST_POLICY } = opts ?? {};
  if (!GHOST_POLICIES.includes(ghostPolicy)) {
    throw new TypeError(`ghostPolicy must be one of ${GHOST_POLICIES.join(', ')}, got ${JSON.stringify(ghostPolicy)}`);
  }
  const { accepted, rejections, nodeRecords, linkRecords, previousLinkKeys, report } = collect(chunks, previous);
  const unionIds = new Set(nodeRecords.keys());

  // Before endpoint resolution, because `drop` removes ids from `unionIds` and
  // the resolution below is what turns the links that referenced them into
  // dangling ones. Running it after would report a drop as a pre-existing
  // defect, which is the conflation this module is written against.
  const ghosts = resolveGhosts(nodeRecords, linkRecords, previous, unionIds, ghostPolicy);

  const { crossChunkResolved, crossChunkDangling, danglingSamples } = resolveEndpoints(accepted, unionIds);

  // Dangling edges are removed by default. Written, they are indistinguishable
  // from good edges to every downstream reader, which is the silent failure this
  // module spends its comment header on; counted, they are the loudest number
  // in the report. `keepDangling` exists so a caller can get the whole picture
  // back, at the cost of re-introducing the thing it just counted.
  let danglingLinksDropped = 0;
  const keptLinkKeys = [];
  for (const [key, record] of linkRecords) {
    const [source, target] = key.split(KEY_SEP);
    if (!keepDangling && (!unionIds.has(source) || !unionIds.has(target))) {
      danglingLinksDropped += 1;
      continue;
    }
    keptLinkKeys.push(key);
  }
  const keptRecords = keptLinkKeys.map((key) => linkRecords.get(key));
  const keptByKey = new Map(keptLinkKeys.map((key, i) => [key, keptRecords[i]]));
  keptRecords.sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(String(a.relation), String(b.relation)));

  const nodes = [...nodeRecords.values()].sort((a, b) => cmp(a.id, b.id));
  const hyperedges = readHyperedges(previous);

  // Retained without re-checking membership: a union only ever grows, so a node
  // id present when the hyperedges were written is still present here.
  const graph = {
    // Measured on the real vault graph, both false. Not a default chosen for
    // tidiness — `directed` changes how a consumer reads every edge, and
    // `multigraph` changes whether two edges between the same pair are two
    // facts or a contradiction. Both are fixed by the format being written.
    directed: false,
    multigraph: false,
    graph: { hyperedges },
    nodes: nodes.map((n) => ordered(n, NODE_KEY_ORDER)),
    links: keptRecords.map((l) => ordered(l, LINK_KEY_ORDER)),
    // Threaded, never invented. A null is honest about not knowing; a
    // fabricated hash is provenance-shaped noise that no consumer can audit.
    built_at_commit: resolveCommit(builtAtCommit, previous),
    hyperedges,
  };

  const previousIds = new Set(
    (previous !== null && typeof previous === 'object' && !Array.isArray(previous) && Array.isArray(previous.nodes) ? previous.nodes : [])
      .map((n) => (n !== null && typeof n === 'object' && !Array.isArray(n) ? filledString(n.id) : null))
      .filter((id) => id !== null),
  );
  let nodesRetainedFromPrevious = 0;
  for (const id of previousIds) if (unionIds.has(id)) nodesRetainedFromPrevious += 1;
  let linksRetainedFromPrevious = 0;
  for (const key of previousLinkKeys) if (keptByKey.has(key)) linksRetainedFromPrevious += 1;

  return {
    graph,
    report: {
      ...report,
      nodes: graph.nodes.length,
      links: graph.links.length,
      ghostPolicy,
      ghostNodes: ghosts.ghostIds.size,
      ghostNodesDropped: ghosts.dropped,
      linksOrphanedByGhosts: ghosts.orphanedLinks,
      ghostNodesReattributed: ghosts.reattributed,
      ambiguousReattribution: ghosts.ambiguous,
      unmatchedReattribution: ghosts.unmatched,
      crossChunkResolved,
      crossChunkDangling,
      danglingLinksDropped,
      danglingSamples,
      hyperedges: hyperedges.length,
      nodesRetainedFromPrevious,
      linksRetainedFromPrevious,
      rejections,
    },
  };
}

/**
 * `built_at_commit`, preferring the caller's value, then the previous graph's,
 * then null.
 */
function resolveCommit(builtAtCommit, previous) {
  if (filledString(builtAtCommit) !== null) return builtAtCommit;
  if (previous !== null && typeof previous === 'object' && !Array.isArray(previous)) {
    const fromPrevious = filledString(previous.built_at_commit);
    if (fromPrevious !== null) return fromPrevious;
  }
  return null;
}

/** Previous hyperedges, from the top-level key or the nested copy. */
function readHyperedges(previous) {
  if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) return [];
  if (Array.isArray(previous.hyperedges)) return [...previous.hyperedges];
  if (previous.graph !== null && typeof previous.graph === 'object' && Array.isArray(previous.graph.hyperedges)) {
    return [...previous.graph.hyperedges];
  }
  return [];
}

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

const ESCAPES = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * JSON string escaping, done by hand.
 *
 * The control characters below U+0020 use the \\u form on purpose rather than
 * the short escapes JSON also permits: a node id containing U+0007 would
 * otherwise serialise to a raw BEL, and a raw BEL inside a 5.7 MB file is
 * invisible in a diff and unopenable in some editors. Anything above U+001F
 * passes through as a literal, which is correct for JSON and keeps the 6,155
 * accented labels in the vault readable in the file rather than escaped.
 */
function jsonString(value) {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ESCAPES[ch] !== undefined) out += ESCAPES[ch];
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Pretty-print a value in the measured file's format: 2-space indent, trailing newline. */
function pretty(value, indent) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => inner + pretty(v, indent + 1)).join(',\n')}\n${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const body = keys.map((k) => `${inner}${jsonString(k)}: ${pretty(value[k], indent + 1)}`).join(',\n');
    return `{\n${body}\n${pad}}`;
  }
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return jsonString(String(value));
}

/**
 * Serialise a graph with a fixed key order, so two runs on the same input
 * produce byte-identical output.
 *
 * This is the property the caller uses to prove idempotency, and it is the
 * reason the key order is written out in the constants above rather than left
 * to `Object.keys`. Node and link arrays arrive already sorted by codepoint and
 * each record is rebuilt in canonical order, so nothing here depends on the
 * order the records were discovered in — which for a fan-out over parallel
 * subagents is not a property anything can promise.
 *
 * Format matches the measured graph.json exactly: 2-space indent, trailing
 * newline, and no HTML escaping. A 5.7 MB graph is only reviewable by diffing
 * it, and a diff is only reviewable if the format does not move.
 *
 * @param {object} graph
 * @returns {string}
 */
export function serializeGraph(graph) {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new TypeError(`graph must be an object, got ${typeof graph}`);
  }
  const out = {};
  for (const key of TOP_LEVEL_KEY_ORDER) {
    if (graph[key] !== undefined) out[key] = graph[key];
  }
  for (const key of Object.keys(graph).filter((k) => !TOP_LEVEL_KEY_ORDER.includes(k)).sort(cmp)) {
    if (graph[key] !== undefined) out[key] = graph[key];
  }
  return `${pretty(out, 0)}\n`;
}

/**
 * Write a graph to disk and hand back exactly the bytes that were written.
 *
 * Returning the text as well as the path is not convenience — it is what lets
 * the idempotency test compare two runs without reading the filesystem, and
 * what lets a caller log exactly what landed rather than re-deriving it.
 *
 * @param {object} graph
 * @param {string} path
 * @returns {{path: string, text: string, bytes: number}}
 */
export function writeGraph(graph, path) {
  const text = serializeGraph(graph);
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(path, text, 'utf8');
  return { path, text, bytes: Buffer.byteLength(text, 'utf8') };
}
