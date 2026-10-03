// scripts/vault-index-structural.mjs
//
// The structural layer of the vault knowledge-graph rebuild: the part of a note
// that is decidable by a parser, and therefore should never cost a model call.
//
// A 200-note sample measured on 2026-10-02 found YAML frontmatter in 100% of
// notes, headings in 98%, wikilinks in 60% and code fences in 48%. Four
// independent measurements over the whole corpus on the same day sharpen that:
// 4,138 eligible `.md` files, 4,119 with frontmatter, 317,070 headings, 7,964
// wikilink targets. None of those four numbers is a judgement call. A subagent
// asked to "extract the structure" of a note will spend tokens rediscovering
// what a line scan determines exactly, and will disagree with itself about
// whether `# comment` inside a fence is a heading. This module removes the
// question, and the tests pin every decision below against the measurements that
// produced it.
//
// A dry run over the whole corpus, in 28 batches of 150 and merged, is the
// end-to-end evidence that the decisions hold together rather than individually:
// 4,138 files in 7.5 s, 26,702 nodes, 22,564 `contains` and 3,388 `references`,
// 294,486 scaffolding headings skipped, 0 batches rejected, 0 dangling endpoints,
// 0 dropped edges, 0 node id collisions, and 0 nodes whose `source_file` is empty,
// absolute or traversing. The same run before decision 8 existed emitted 321,188
// nodes and 317,050 `contains` from the same 4,138 files, and every one of the
// 22,564 heading ids still emitted is byte-identical to the id emitted then —
// checked file by file across all 28 batches, not argued.
//
// WHAT THE LAYER EMITS. Exactly two relations: `contains` and `references`.
// A `document` node per file, a heading node per ATX heading in the body that
// is not session-transcript scaffolding, and a `references` edge per resolvable
// wikilink. No `concept` nodes and no `rationale_for` edges — those are a
// different task with a different justification, and mixing them in would put
// unattributable nodes into the one layer whose entire argument is that every
// node it emits is checkable.
//
// The heading count is worth stating plainly, because it is the number that
// decides whether this layer is usable. Measured over the whole corpus: 317,050
// ATX headings, of which 294,486 — 92.9% — are the session renderer's own
// structure rather than any writer's outline, and 294,437 of those sit in
// `05 - Conversations/`, which is a directory of rendered transcripts. Emitting
// them would put 59,385 nodes labelled `input` and 59,410 labelled `output` into
// the graph, and a graph with that many identical labels has neither communities
// nor a betweenness signal — the fragmentation this rebuild exists to remove.
// After the filter 22,564 heading nodes remain, these being real sections, and
// the 294,486 removed ones are counted in `report.scaffoldingSkipped` rather
// than dropped without a trace. A structural layer that reported 4,138 documents
// and no sections would be reporting a fiction, and one that reported 317,050
// sections would be reporting the renderer's fiction. Both rungs are kept; the
// noise between them is not. A caller who wants a document-level graph should
// read `node_kind`, which is on every node for exactly that reason.
//
// THE ONE PROPERTY THIS MODULE EXISTS TO HOLD.
//
//   Every node it emits carries a `source_file` naming a real file, relative to
//   the vault root.
//
//   The graph being replaced has 6,155 nodes, of which 1,299 carry a null or
//   empty `source_file` — measured on `graphify-out/graph.json`, and the reason
//   this rebuild is happening at all rather than an incremental patch. Those
//   nodes cannot be checked against disk by anyone, ever: there is nothing to
//   check them against. Every downstream decision made on them is a decision
//   about a claim. So this layer adds zero of them, and the property is
//   enforced at four separate points rather than trusted to review:
//
//     - `sourceFileFor()` returns null for anything outside the root, and the
//       caller emits nothing for such a file.
//     - A node whose `source_file` would be blank is not emitted at all.
//     - The frontmatter's own `source_path:` is parsed as data and NEVER used as
//       a `source_file`. 320 real notes carry one, and they point at
//       `~/Proyek/...`, absolute, outside the vault, and
//       exactly the shape that produced the 1,299. Honouring it would reintroduce
//       the defect in a form that looks deliberate.
//     - `report.noSourceFile` counts anything that got through, and a test
//       asserts it is 0.
//
//   The second half of the property is that unresolved things are REPORTED.
//   Silent absence and counted absence are different artefacts, and only one of
//   them can be acted on.
//
// EIGHT DECISIONS, each forced by a measurement rather than chosen for taste.
//
//   1. A HEADING ID CARRIES ITS ANCESTOR CHAIN AND AN OCCURRENCE COUNTER.
//      Because duplicates are the norm, not the edge case. `#### input` appears
//      112 times in one session transcript; `### tool · shell` 76 times in the
//      same file. 1,092 corpus files repeat a heading title within themselves,
//      197,643 times in total. A `docId + slug(title)` id therefore collides
//      constantly, and a duplicate id is a validator ERROR rather than a warning
//      — it rejects the entire chunk, so one repeated `## Summary` would take a
//      1,000-file batch down with it. Parent path separates same-titled headings
//      under different parents; the counter separates siblings under one parent.
//      Both mechanisms are needed and both are tested.
//
//   2. FENCE CLOSING IS LENGTH-AWARE, AND THE NAIVE RULE COSTS 35,364 HEADINGS.
//      A fence opened with four backticks legitimately contains three-backtick
//      lines; the vault's session transcripts do exactly this to embed prompts
//      that themselves contain fences. "Any run of backticks closes the fence" is
//      wrong in 217 corpus files and changes the heading count by 35,364 —
//      measured both ways, not estimated. The rule is CommonMark's: same
//      character, at least as long, and nothing else on the line. Under it, 2
//      corpus files end inside an open fence, and those run to EOF, because a
//      truncated transcript's tail is not structure.
//
//   3. FRONTMATTER IS NOT BODY, AND IS NOT YAML.
//      Only a `---` on the very first line opens frontmatter; a `---` three
//      paragraphs into a note is a horizontal rule, and reading it as
//      frontmatter would delete those paragraphs from the body scan. The value
//      grammar is the subset the corpus actually uses — scalars, flow arrays
//      `["a", "b"]`, and block sequences — because 414 files write `related:` as
//      a flow array and 116 as a block sequence, and supporting only the first
//      form loses every one of the second. Values stay strings: `status: Draft`
//      and `status: 2026-09-14` are both labels to a graph, and a YAML type
//      coercion is a silent change of meaning. And `__proto__:` is a key an
//      Obsidian user can type, so the result object is built with a null
//      prototype the caller cannot pollute through.
//
//   4. `#tag` IS NOT A HEADING, AND `#######` IS NOT A HEADING.
//      2,689 corpus notes carry tags. A hash with no space after it is a tag;
//      seven hashes are not an ATX heading. Both are common enough in the corpus
//      that getting either wrong inflates the node count by thousands.
//
//   5. 41% OF WIKILINK TARGETS DO NOT RESOLVE, AND NO PLACEHOLDER NODE IS
//      EMITTED FOR THEM.
//
//      Measured over the whole corpus: of 7,964 targets, 3,806 resolve to a file
//      and 3,294 resolve to nothing. Inspection of the residue shows it is
//      largely bash `[[ ... ]]` conditional syntax pasted out of transcripts
//      (129 measured occurrences of patterns like `-n "$kver"`), plus links to
//      PNG attachments. It is not a graph of broken links between notes.
//
//      A placeholder `document` node is not available anyway, and the reason is
//      the property above: a node must name a real file, and there is no file
//      for `[[nowhere]]`. Each of the three workarounds fails differently.
//      Pointing the placeholder at the CITING file claims the node is derived
//      from a note that does not contain it — the 1,299-node defect under a new
//      name. Pointing it at the vault root gives every phantom the same
//      `source_file` and none of them meaning. Inventing `virtual/foo.md` is the
//      trap, because it PASSES the validator: the path check can tell an absolute
//      path from a relative one and cannot tell a synthetic one from a real one.
//
//      So the target is counted in `report.unresolvedTargets` with a bounded
//      sample naming it, and no edge and no node is emitted. A caller that later
//      learns where `nowhere` lives has a report telling it to look; a caller
//      that does not has a count it can compare against the corpus.
//
//   6. AN AMBIGUOUS BASENAME IS REPORTED, NOT GUESSED. 431 stems in the corpus
//      map to more than one file and 735 measured target occurrences land on
//      one. Choosing the first by sort order would manufacture an edge
//      indistinguishable from a real one at every consumer. The count is
//      reported separately from the unresolved count, because "no such note" and
//      "four notes, pick one" call for different fixes.
//
//   7. RESOLUTION CONFIDENCE REFLECTS HOW THE TARGET WAS FOUND. A match on the
//      full vault-relative path or on an authored `aliases:` entry is EXTRACTED.
//      A match on a bare basename is INFERRED, because a future file can
//      collide with that stem and silently invalidate the edge — and 3,655 of
//      4,541 resolved targets resolve that way, so writing them all EXTRACTED
//      would overstate 80% of the references in the graph.
//
//   8. 92.9% OF THE HEADINGS ARE THE RENDERER'S, NOT A WRITER'S, AND ARE NOT
//      NODES. 294,486 of the corpus's 317,050 ATX headings are session-
//      transcript scaffolding: `input` 59,385, `output` 59,410, `reasoning`
//      33,365, `tool · shell` 30,802, `assistant text` 15,002, `event data`
//      4,287, and so on, with 294,437 of the 294,486 inside
//      `05 - Conversations/`. Roughly half the corpus is rendered transcripts
//      whose heading hierarchy belongs to the renderer — every tool call gets an
//      `#### input` and an `#### output`. Emitting those as nodes would put 89%
//      noise into the graph and re-create the fragmentation the rebuild exists
//      to fix, and a graph in which `input` appears 59,385 times has no
//      communities at all.
//
//      The mechanism is a TITLE rule, not a path rule, because a path rule only
//      works where the transcripts happen to be filed and a transcript pasted
//      into a project folder would then be indexed as though it were an outline.
//      The matched set is `SCAFFOLDING_HEADING_TITLES` (whole-title, exact,
//      case-insensitive) and `SCAFFOLDING_HEADING_PREFIXES` (start-anchored
//      regexps for `tool · …`, `[seq N] …` and `[prose fenced] …`), both
//      exported so a caller can read the decisions rather than infer them.
//
//      ANCHORED, NOT SUBSTRING, and both alternatives were measured against the
//      corpus rather than argued. A substring rule additionally swallows 776 real
//      headings — `user input` (42), `reasoning lenses` (5), `use system
//      prompts`, `5. output format`, and `editor toolbar`, which contains
//      `tool` inside `toolbar`. A prefix rule is subtler and just as damaging,
//      because it deletes the headings that make a note a note: `output format`,
//      `output formats`, `input modalities`, `system message`, `event details`.
//      `tools` (4 measured) and `Tooling` are why the `tool` prefix requires a
//      separator after it. The whole measured cost of the rule is 49 headings
//      outside `05 - Conversations/`, against 294,437 kept out of the graph.
//
//      THE COST THAT IS NOT AVOIDABLE. `## Output` in a note documenting a CLI
//      and `## Output` in a rendered transcript are the same string, and 26 real
//      corpus headings are the former. They are filtered anyway, because every
//      exemption has to be keyed on something other than the title — the path
//      (rejected above), the heading level (matched scaffolding sits at h2
//      56,742, h3 114,659, h4 123,085, which are the depths real notes use), or an
//      occurrence count (which re-admits the scaffolding in every short excerpt
//      and makes the question unanswerable from the heading alone). One node is
//      dropped, its text stays on disk, the document node is untouched — the
//      filter drops a NODE, it does not rename the note — and the drop is counted.
//
//      THREE PROPERTIES THIS HAS TO KEEP, each of which is a test.
//
//        Ids do not move. A heading id embeds its ancestors' ids, so a filtered
//        heading still occupies its slot in the chain and still holds its id in
//        `usedIds`. T9 unions chunks by id, so a changed id is a node that
//        silently disappears from the merged graph. Verified across the whole
//        corpus: all 22,564 surviving heading ids byte-identical to the pre-filter
//        run, 0 document ids changed, 0 non-scaffolding headings lost.
//
//        Children are not orphaned. A surviving section whose parent was
//        filtered is PROMOTED to the nearest ancestor that did emit a node,
//        rather than emitted with a flattened path: promotion moves no id at all,
//        whereas a flattened path makes a section's id depend on how much
//        scaffolding happened to sit above it, so deleting one tool call would
//        renumber everything under it. The walk starts only when the immediate
//        parent slot was filtered, so the 6,658 measured headings that sit under
//        a level their document never used are not re-parented as a side effect.
//
//        No edge points at nothing. A wikilink under a filtered heading is
//        attributed to the nearest SURVIVING heading. Filtering the node while
//        leaving the line-to-id map populated by every parsed heading is a
//        dangling-endpoint factory, and the merge would discover it 28 batches
//        later. Two links that used to be distinct edges because they sat under
//        different `#### input` headings are now one edge and the difference is
//        visible in `referencesFolded`, which rose from 114 to 149 on the dry
//        run above.
//
// TWO THINGS THAT ARE NOT DECISIONS BUT WOULD LOOK LIKE THEM.
//
//   A `[[Foo]]` pointing into another subagent's batch. The target's node id is
//   computable from its path alone, so the edge is emitted and the node is left
//   to the batch that owns the file — which is precisely the cross-chunk case
//   `vault-index-merge.mjs` exists to resolve. But the caller has to DECLARE the
//   corpus (`opts.knownPaths`); this module will not enumerate the vault itself,
//   because T2 owns enumeration and a second walk would disagree with it. With
//   no declaration, a cross-batch target is unresolved, and that is the honest
//   default rather than a fallback.
//
//   Two files whose paths slug to the same id. `Quickstart.md` and
//   `quickstart.md` sit in the same directory of the real vault, so this is
//   measured rather than hypothetical. `slugFor` is a pure function of one path
//   and cannot see the other; the disambiguation is the pass that holds the whole
//   file list, it appends a short deterministic hash of the full path to every
//   member of a colliding group (not to one of them — privileging a member by
//      sort order is the guess this module refuses to make elsewhere), and it
//      counts the collision in `report.idCollisions`.
//
// PURITY. No network, no clock, no randomness, no `graphify` import. Reading
// files is the only I/O, and a file that cannot be read is counted in
// `report.filesUnreadable` rather than thrown: 2,360 files go through this
// function and one that vanished between enumeration and read must not take the
// other 2,359 with it. The one throw is for a `files` argument that is not an
// array of path strings, which is a harness bug rather than extracted data — the
// same distinction `chunk-schema.mjs` and `vault-index-merge.mjs` draw.
//
// DETERMINISM IS A REQUIREMENT, NOT A TIDINESS. The merge is a union keyed on
// node id across ~334 independently-dispatched chunks, and the only way a person
// can prove a re-run did not quietly reorder or reshape the graph is that two
// runs on the same input produce byte-identical output. So arrays are sorted by
// codepoint rather than by `localeCompare` — ICU collation is locale-dependent,
// and two machines can order the same ids differently — and the sort key is
// written out rather than inherited from `Array.prototype.sort` stability, which
// is an implementation property and not a contract. Document ids that collide are
// disambiguated by the group's own sorted membership, so the outcome does not
// depend on which file was read first.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Shortest slug a node id may take before it is hashed down. Part of the API. */
export const NODE_ID_MAX = 200;

/**
 * How many unresolved targets `report.unresolvedSample` will name.
 *
 * Bounded because the number it accompanies is not: a rebuild over the whole
 * corpus produces thousands, and a report that prints all of them is one nobody
 * reads to the end — at which point only the count is looked at, which is the
 * outcome the bound exists to prevent. The COUNT stays exact; only the evidence
 * is sampled. Same rule, and for the same reason, as `MAX_DANGLING_SAMPLES` in
 * `vault-index-merge.mjs`.
 */
export const MAX_UNRESOLVED_SAMPLES = 20;

// Joined on a character that cannot appear in a slug, so `["ab","c"]` and
// `["a","bc"]` cannot collapse into one dedupe key. Same constant, same reason,
// as the peer modules.
const KEY_SEP = '\u0000';

// Keys that must never be assigned onto a returned object. `__proto__` is the
// real one: frontmatter is text a person typed in Obsidian, and
// `out[key] = value` on a plain object with a `__proto__` key sets the
// prototype instead of creating a property. `constructor` and `prototype` are
// here because the cost of also skipping them is zero, and
// `vault-index-merge.mjs` already carries the identical set for the same
// reason.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Everything outside [a-z0-9] is a separator. A negated character class IS the
// enumeration, exhaustively, and it is also why `..` cannot survive into an id:
// dots are punctuation long before they could name a parent directory.
const UNSAFE = /[^a-z0-9]+/g;
const UNDERSCORE_RUNS = /_+/g;
const UNDERSCORE_EDGES = /^_+|_+$/g;

/**
 * Titles that are session-transcript scaffolding, matched WHOLE and case-insensitively.
 *
 * A CORPUS-MEASURED LIST, not a guess. Every entry is a title the session
 * renderer actually emits, counted over all 4,138 `.md` files of the real vault
 * on 2026-10-02: `output` 59,410, `input` 59,385, `reasoning` 33,365,
 * `assistant text` 15,002, `event data` 4,287, `idle` 2,852, `prompt` 2,703,
 * `synthetic` 1,053, `system` 299, `user` 8. `session-event` has 0 measured
 * occurrences and is here because the contract names it — a list that grows when
 * a renderer grows is the point; a list that shrinks when a measurement shifts is
 * not.
 *
 * WHY EXACT MATCH AND NOT A SUBSTRING OR A PREFIX. Both were measured against
 * the corpus, and both eat real notes:
 *
 *   A SUBSTRING rule (`/input|output|tool/`) additionally swallows 776 real
 *   headings, and the residue is not marginal — `user input` (42), `reasoning
 *   lenses` (5), `use system prompts`, `5. output format`, and `editor toolbar`,
 *   which contains the substring `tool` in `toolbar` and is a heading about a UI
 *   rather than about a session.
 *
 *   A PREFIX rule (`/^output/`) is subtler and just as bad, because it deletes
 *   the headings that make a note a note: `output format` (measured 2), `output
 *   formats`, `output format types`, `input modalities`, `system message`, `event
 *   details`, `session checkpoint`, `user management`. A prefix rule cannot
 *   distinguish `output` from `output format` without becoming a word-boundary
 *   rule, and a word-boundary rule on a title that is a sentence does not help
 *   either.
 *
 * So the marker titles are matched WHOLE. Anchoring is the other half of the
 * same decision: a title that merely CONTAINS a marker is never scaffolding, and
 * `The output of the command` survives.
 *
 * Lowercase because {@link isScaffoldingHeading} lowercases before looking. A set
 * holding `Output`, tested against `output`, silently never matches and the
 * counter reads zero while the constant looks correct.
 *
 * @type {readonly string[]}
 */
export const SCAFFOLDING_HEADING_TITLES = Object.freeze([
  'input',
  'output',
  'reasoning',
  'assistant text',
  'prompt',
  'user',
  'system',
  'session-event',
  'event data',
  'idle',
  'synthetic',
]);

/**
 * Title PREFIXES that are session-transcript scaffolding. Start-anchored.
 *
 * The `tool` rule is the one that needs the lookahead. The renderer writes
 * `tool · shell`, `tool · read`, `tool · edit`, `tool · grep`, `tool · execute`,
 * `tool · write`, `tool · subagent`, `tool · glob`, `tool · webfetch`,
 * `tool · bash`, `tool · question` and `tool · websearch` — 59,387 measured
 * occurrences, and the separator is always there. Matching `tool` alone as a
 * prefix would also take `tools` (4 measured) and `Tooling`, which are real
 * headings; requiring a separator character or the end of the title is what keeps
 * them. `Tooling` is the sharpest case: it is one letter from the marker and is a
 * heading about tooling in the ordinary sense.
 *
 * The bracket forms are the transcript's own turn delimiters: `[seq 4] user`
 * (1,040 measured) and `[seq N] assistant` in the hundreds, plus
 * `[prose fenced]` notes. They are anchored on `[` so an authored heading that
 * merely mentions a sequence in prose is untouched.
 *
 * NOT `/g`. A global regexp carries `lastIndex` between `.test()` calls, which
 * would make the answer depend on call order — the opposite of the determinism
 * this module is built to guarantee, and the kind of bug that passes a suite run
 * once and fails the next.
 *
 * @type {readonly RegExp[]}
 */
export const SCAFFOLDING_HEADING_PREFIXES = Object.freeze([
  // `tool` then a separator or the end of the title. The dash sits last in the
  // class so it is a literal rather than a range.
  /^tool(?:$|[\s·:—–|/-])/i,
  // `[seq N] …` and `[prose fenced] …`.
  /^\[(?:seq|prose fenced)/i,
]);

// Lookup form of the title list. Built once from the exported constant so the
// two cannot disagree.
const SCAFFOLDING_TITLE_SET = new Set(SCAFFOLDING_HEADING_TITLES);

/**
 * Is this heading title session-transcript scaffolding rather than a section?
 *
 * The whole of the filter, and it is a PURE FUNCTION OF ONE STRING because that
 * is what makes it correct: it works on any transcript wherever it lives, so a
 * session pasted into a project folder is filtered and a genuine note titled
 * `Output` is filtered by the same rule with no way to tell them apart. See
 * {@link SCAFFOLDING_HEADING_TITLES} for the measurement behind that trade.
 *
 * A non-string, and the empty string, answer `false` rather than throwing. This
 * runs on parser output inside a loop over 317,050 corpus headings, and a throw
 * there would take a whole 2,360-file batch down and report it as a zero-node
 * success.
 *
 * @param {unknown} title an ATX heading title, or anything else.
 * @returns {boolean} true when no node should be emitted for it.
 */
export function isScaffoldingHeading(title) {
  if (typeof title !== 'string') return false;
  const key = title.trim().toLowerCase();
  if (key === '') return false;
  if (SCAFFOLDING_TITLE_SET.has(key)) return true;
  for (const re of SCAFFOLDING_HEADING_PREFIXES) {
    if (re.test(key)) return true;
  }
  return false;
}

/** Codepoint comparison. Deliberately not `localeCompare`; see the header. */
function cmp(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Lowercase, ASCII-fold, underscore-join. Returns '' when nothing survives.
 *
 * The empty string is a real answer for `🎓.md` and `---.md`, both of which occur
 * in the corpus, and callers must handle it — a node id may not be empty and a
 * path is not a reason to invent one.
 */
function slugify(text) {
  return String(text)
    // NFKD splits accented Latin into base + combining mark; the marks are then
    // not in [a-z0-9] and vanish. `Café` -> `cafe`, not `caf`.
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(UNSAFE, '_')
    .replace(UNDERSCORE_RUNS, '_')
    .replace(UNDERSCORE_EDGES, '');
}

/**
 * A short, stable, content-derived disambiguator.
 *
 * FNV-1a rather than `node:crypto` for two reasons: it is a few lines instead of
 * an import, and it is deterministic across engines by construction because the
 * arithmetic is written out here. A cryptographic digest would be equally
 * deterministic and would also be a dependency for a job this small. The only
 * requirement is that two different paths do not produce the same 8 hex digits
 * often, and the inputs are file paths, not adversarial data.
 */
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // 16777619, the FNV prime, as a multiply kept inside 32 bits.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The node id for a vault-relative path.
 *
 * Stable and content-derived: the same path gives the same id on any machine, in
 * any order, in any process. The `.md` extension is dropped and the directory
 * path is KEPT, because the vault holds an `index.md` under more than one
 * project and a basename-only id would merge them into one node.
 *
 * Not injective, and that is not fixable here: this is a pure function of one
 * path and cannot see its siblings. `03 - Resources/LLM Wiki/sources/Quickstart.md`
 * and `.../quickstart.md` are two real files in the corpus that produce the same
 * id; `structural()` is where the whole file list is available and where the
 * collision is resolved and counted. Exporting it as a single pure function is
 * what lets a caller compute the id of a note in ANOTHER batch — which is the
 * whole basis for emitting a cross-batch `references` edge to a node this chunk
 * does not own.
 *
 * @param {string} p a vault-relative path, with or without the `.md` extension.
 * @returns {string} never empty; `'untitled'` when nothing survives the slug.
 */
export function slugFor(p) {
  const withoutExt = String(p).replace(/\.md$/i, '');
  const slug = slugify(withoutExt);
  if (slug !== '') return slug;
  // Nothing survived: an emoji-only or punctuation-only filename. Returning ''
  // would be rejected by the validator, and returning a constant would merge
  // every such note into one node, so the path's own hash stands in.
  return `untitled_${shortHash(withoutExt)}`;
}

/**
 * Shorten an id to {@link NODE_ID_MAX}, appending a hash of the full text.
 *
 * Measured: the longest real heading title is 1,817 characters, a subtitle line
 * that a transcript renderer promoted to a heading, and the deepest ancestor
 * chain in a conversation note stacks four levels on a 221-character document id.
 * Unbounded, that is a 2,059-character node id in a 5.7 MB JSON file that people
 * review by diffing.
 *
 * The LABEL is never truncated. A truncated label loses text a person reads; the
 * id only has to be unique, and the hash of the full text keeps it so.
 */
function boundId(id) {
  if (id.length <= NODE_ID_MAX) return id;
  return `${id.slice(0, NODE_ID_MAX - 9)}_${shortHash(id)}`;
}

/**
 * Strip one layer of matching quotes, and drop a trailing `# comment`.
 *
 * A trailing comment is only a comment when the `#` is preceded by whitespace,
 * which is YAML's rule and the reason `title: Issue #12` keeps its `#12` while
 * `status: Draft # wip` does not.
 */
function scalar(raw) {
  let v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1);
  }
  if (!v.startsWith('"') && !v.startsWith("'")) {
    const hash = /(^|\s)#/.exec(v);
    if (hash !== null) v = v.slice(0, hash.index).trim();
  }
  return v;
}

/**
 * Split a flow array body into its elements, respecting quotes.
 *
 * Commas inside a quoted element are common in this corpus: `related` values are
 * wikilinks whose targets are paths like `01 - Projects/Snipset/index`, and a
 * naive `split(',')` is only saved by the surrounding brackets. Quoted elements
 * with a comma inside them also occur, so the scan tracks quote state rather than
 * assuming the bracket is the only thing to respect.
 */
function splitFlowArray(body) {
  const out = [];
  let current = '';
  let quote = null;
  for (const ch of body) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '') out.push(current);
  return out.map(scalar).filter((s) => s !== '');
}

/**
 * The YAML frontmatter of a note, as a flat object of strings and string arrays.
 *
 * The grammar is the subset the corpus uses and no more: `key: scalar`,
 * `key: [a, b]`, and `key:` followed by `- item` lines. Nested maps are not
 * supported and no corpus file has one at the top level; a nested key arrives
 * indented and is skipped, which is the same treatment a `| block scalar` gets.
 * 328 files have an indented line inside their frontmatter and none of them is a
 * nested map, so a full YAML parser would be a dependency bought for nothing.
 *
 * A null-prototype result. The input is a text file somebody edits in Obsidian,
 * so `__proto__: anything` is reachable input, and on a plain object it assigns
 * the prototype instead of creating a property — the caller then reads
 * `Object.prototype` properties as if they were the note's frontmatter.
 *
 * @param {string} text the WHOLE file. Frontmatter is only recognised on line 1.
 * @returns {Record<string, string|string[]>} empty when there is no frontmatter.
 */
export function parseFrontmatter(text) {
  const out = Object.create(null);
  if (typeof text !== 'string' || !text.startsWith('---')) return out;

  // Tolerate a UTF-8 BOM: editors add one, and a note that starts with one is a
  // note with frontmatter, not a note without.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const afterOpen = /^---[ \t]*\r?\n/.exec(body);
  if (afterOpen === null) return out;

  const lines = body.slice(afterOpen[0].length).split(/\r?\n/);
  let closed = false;
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^---[ \t]*$/.test(line)) { closed = true; break; }
    if (/^\s/.test(line)) continue; // nested, or a continuation: not supported, skipped

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = kv[1];
    if (FORBIDDEN_KEYS.has(key)) continue;
    const rest = kv[2].trim();

    if (rest.startsWith('[')) {
      // A flow array. The closing bracket is taken on the LAST `]` so that a
      // wikilink target containing a bracket (there are 27 measured links with a
      // `#` anchor, and bracket-bearing targets occur) does not truncate it.
      const close = rest.lastIndexOf(']');
      const inner = close === -1 ? rest.slice(1) : rest.slice(1, close);
      out[key] = splitFlowArray(inner);
      continue;
    }

    if (rest !== '') { out[key] = scalar(rest); continue; }

    // `key:` with no inline value: a block sequence if the following lines are
    // `- item`, otherwise an empty scalar. 116 corpus files use the block form
    // for `related` and 1,521 for `tags` or `aliases`.
    const items = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(lines[j]);
      if (item === null) break;
      const v = scalar(item[1]);
      if (v !== '') items.push(v);
    }
    if (items.length > 0) { out[key] = items; i = j - 1; } else { out[key] = ''; }
  }

  // An unterminated block is not frontmatter. Treating the rest of the file as
  // YAML would delete it from the body scan, and there is no closing `---` to say
  // the author meant it that way.
  if (!closed) return Object.create(null);
  return out;
}

/**
 * Strip the frontmatter block, returning the body and the line the body starts on.
 *
 * Kept separate from {@link parseFrontmatter} because the two consumers want
 * opposite things: the frontmatter parser wants the text, the body scanners want
 * it GONE. Sharing one function between them is how a `# Heading` inside a YAML
 * block becomes a section of the document.
 *
 * @returns {{ body: string, offset: number}} `offset` is the number of lines
 *   consumed, so a line number found in `body` maps back to the original file by
 *   addition. That mapping is what makes `source_location` followable.
 */
function stripFrontmatter(text) {
  const source = typeof text === 'string' ? text : '';
  const bom = source.charCodeAt(0) === 0xfeff;
  const probe = bom ? source.slice(1) : source;
  const afterOpen = /^---[ \t]*\r?\n/.exec(probe);
  if (afterOpen === null) return { body: source, offset: 0 };
  const rest = probe.slice(afterOpen[0].length);
  const close = /^([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (close === null) return { body: source, offset: 0 };
  const consumed = (bom ? 1 : 0) + afterOpen[0].length + close[0].length;
  return { body: rest.slice(close[0].length), offset: countLines(source.slice(0, consumed)) };
}

/** Newline count, tolerant of CRLF. A line number is 1-based and this counts them. */
function countLines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * The fence state a line leaves behind, or null if the line is not a fence marker.
 *
 * Length-aware, and the length is the whole point. See decision 2 in the header:
 * the char-only rule mis-parses 217 corpus files by 35,364 headings. Backticks
 * and tildes are tracked separately because ``` does not close a ~~~ block, and
 * the vault has 53 files using tilde fences.
 *
 * An opening fence's info string is anything; a CLOSING fence must be the marker
 * alone, which is what stops a prose line carrying a language tag from ending a
 * code block early.
 */
function fenceTransition(line, open) {
  const m = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (m === null) return open;
  // Four or more leading spaces is an indented code block containing a fence
  // string, not a fence. 510 measured occurrences; honouring them as fences
  // swallows the rest of the section.
  if (m[1].length >= 4) return open;
  const marker = m[2][0];
  const length = m[2].length;
  const tail = m[3].trim();
  if (open === null) return { marker, length };
  if (open.marker === marker && length >= open.length && tail === '') return null;
  return open;
}

/** The line's body with any trailing `###` run removed, per CommonMark's ATX rule. */
function atxTitle(raw) {
  return raw.replace(/^[ \t]*/,'').replace(/[ \t]+#+[ \t]*$/,'').trim();
}

/**
 * Every ATX heading in the body of a note.
 *
 * Body only: the frontmatter is stripped before scanning, so a `# Heading` used
 * as a YAML value is data and stays data. Fenced regions are skipped, with an
 * unclosed fence running to EOF — a truncated transcript's tail is not structure.
 *
 * `#tag` is not a heading (a space is required after the hashes) and neither is
 * a run of seven or more hashes. Both occur in the corpus in volume: 2,689 notes
 * carry tags, and treating a tag as a section would invent thousands of nodes.
 *
 * @param {string} text the WHOLE file, frontmatter included.
 * @returns {Array<{level: number, title: string, line: number}>} `line` is 1-based
 *   into the ORIGINAL file, because `source_location` is a thing a person follows.
 */
export function extractHeadings(text) {
  const { body, offset } = stripFrontmatter(text);
  const lines = body.split(/\r?\n/);
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    fence = fenceTransition(lines[i], fence);
    if (fence !== null) continue;
    const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(lines[i]);
    if (m === null) continue;
    const title = atxTitle(m[2] ?? '');
    if (title === '') continue;
    out.push({ level: m[1].length, title, line: offset + i + 1 });
  }
  return out;
}

/**
 * Every wikilink in the body of a note.
 *
 * Body only, and fences excluded, for the same two reasons as headings. The
 * `[[ ]]` shell conditional is not special-cased: 129 measured corpus
 * occurrences of `-n "$kver"` and friends resolve to no note and are reported
 * unresolved, which is a truer description of them than a heuristic that guesses
 * at intent. A target containing a newline is rejected outright, because a regex
 * that spans lines invents targets out of two adjacent ones and every invented
 * target is nonsense by construction.
 *
 * `[[a|b]]` splits into target and alias. The alias is `null` when absent rather
 * than `''`: the merge treats null and empty identically, so a consumer could not
 * otherwise tell "no alias" from "a blank alias", and choosing `''` makes that
 * distinction unrecoverable downstream.
 *
 * @param {string} text the WHOLE file, frontmatter included.
 * @returns {Array<{target: string, alias: string|null, line: number}>}
 */
export function extractWikilinks(text) {
  const { body, offset } = stripFrontmatter(text);
  const lines = body.split(/\r?\n/);
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    fence = fenceTransition(lines[i], fence);
    if (fence !== null) continue;
    const line = lines[i];
    for (const m of line.matchAll(/\[\[([^\][\n]+)\]\]/g)) {
      const pipe = m[1].indexOf('|');
      const rawTarget = (pipe === -1 ? m[1] : m[1].slice(0, pipe)).trim();
      const alias = pipe === -1 ? null : m[1].slice(pipe + 1).trim();
      if (rawTarget === '') continue;
      // The anchor goes: 27 measured links carry one. `[[Note#Section]]` points
      // at a note, and this layer resolves notes. Keeping the anchor would make
      // every anchored link unresolved for a reason that has nothing to do with
      // the corpus.
      const hash = rawTarget.indexOf('#');
      const target = (hash === -1 ? rawTarget : rawTarget.slice(0, hash)).trim();
      if (target === '') continue;
      out.push({ target, alias: alias === '' ? null : alias, line: offset + i + 1 });
    }
  }
  return out;
}

/**
 * The repo-relative `source_file` for an input path, or null if it is not one.
 *
 * THE GATE. Everything this module emits passes through here, and a null return
 * means the caller emits nothing for that file. T2 hands over absolute paths
 * from `find`, so the absolute case is the NORMAL case and must be relativised;
 * the traversal case is the attack, and `path.relative` produces a `..`-bearing
 * string rather than throwing, so it has to be rejected explicitly rather than
 * assumed impossible.
 *
 * @param {string} root the vault root, absolute.
 * @param {string} file an absolute path inside it, or a path relative to it.
 * @returns {string|null} POSIX-separated, relative, with no `..` segment.
 */
export function sourceFileFor(root, file) {
  if (typeof root !== 'string' || root === '' || typeof file !== 'string' || file === '') return null;
  let rel;
  if (path.isAbsolute(file)) {
    rel = path.relative(root, file);
  } else {
    rel = file;
  }
  if (rel === '' || rel === '.') return null;
  const posix = rel.split(path.sep).join('/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return null;
  // Segments, not the two-character substring: `a..b.md` is a real filename and
  // must pass, for the same reason chunk-schema.mjs checks it that way. A check
  // that rejects a real path while catching nothing new is a check somebody
  // eventually deletes to make the noise stop.
  if (posix.split('/').includes('..')) return null;
  return posix;
}

/**
 * The label for a document node: frontmatter title, then first H1, then filename.
 *
 * The order is the order of decreasing authority over what the note is called. A
 * frontmatter `title` was typed by the note's author; an H1 is what the note
 * renders as its heading; the filename is a last resort that is still better than
 * an empty label, which the validator rejects outright and whose rejection would
 * take the whole chunk with it.
 *
 * Measured on the corpus: 2,561 of 4,138 notes carry `title:`, 1,606 have an
 * H1, and the remainder — 19 notes with no frontmatter at all, plus notes whose
 * frontmatter has neither key — are exactly the set the third rung exists for.
 *
 * @param {Record<string, unknown>} fm parsed frontmatter.
 * @param {Array<{title: string}>} headings headings from the body, in order.
 * @param {string} sourceFile repo-relative path, used for the filename fallback.
 * @returns {string} never empty.
 */
export function documentLabel(fm, headings, sourceFile) {
  const title = fm.title;
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  const h1 = headings.find((h) => h.level === 1 && h.title.trim() !== '');
  if (h1 !== undefined) return h1.title.trim();
  const base = path.basename(sourceFile).replace(/\.md$/i, '');
  const fromName = base.trim();
  if (fromName !== '') return fromName;
  return sourceFile;
}

/**
 * Build the resolution index: how a wikilink target becomes a node id.
 *
 * Three tiers, in the order Obsidian itself resolves them, and the tier decides
 * the confidence of the resulting edge (decision 7):
 *
 *   byPath   the target IS a vault-relative path, extension optional. EXTRACTED.
 *   byStem   the target's last segment names a file. INFERRED.
 *   byAlias  the target is an `aliases:` entry. EXTRACTED.
 *
 * `byStem` is INFERRED because 431 corpus stems map to more than one file and a
 * future file can collide with the stem and silently invalidate the edge. An
 * ambiguous stem resolves to NOTHING rather than to the first match: 735
 * measured target occurrences land on one, and picking by sort order would
 * manufacture edges indistinguishable from real ones at every consumer.
 *
 * `knownPaths` lets a caller declare the whole corpus while extracting a slice
 * of it, which is what makes a cross-batch `references` edge possible: the
 * target's id is computable from its path alone, so the edge can point at a node
 * this chunk does not own and the merge can resolve it. Without the declaration
 * the target is unresolved, and that is the honest default — enumerating the
 * vault here would duplicate T2's job and eventually disagree with it.
 *
 * The declared corpus feeds `byStem` as well as `byPath`, and that is a
 * correction rather than a nicety. A dry run over the full corpus measured 1,265
 * resolved references with `byPath` alone and 5,825 unresolved; the same corpus
 * with every path visible resolved 3,422 and left 3,619. The 2,157-link
 * difference is bare-basename links pointing at notes in OTHER batches — 3,655 of
 * the corpus's 7,964 targets resolve by basename, and with a per-batch stem index
 * almost none of them can. The graph would have kept roughly a third of the
 * vault's wiki links and reported the rest as unresolved, which is exactly the
 * "a wiki-link graph that has quietly lost its wiki links" outcome
 * `vault-index-merge.mjs` opens its header with. The target is a real path the
 * caller declared, so the edge points at a real node — one another chunk emits and
 * the merge resolves — and the tier still marks it INFERRED.
 *
 * `idByRel` is passed in rather than recomputed here, because the ids must be the
 * SAME assignment the emitter used. Letting this function fall back to a raw
 * `slugFor` for a declared path that the emitter had disambiguated produces an
 * edge to an id nobody emits, which is a dangling endpoint created by a collision
 * fix.
 *
 * @param {Array<{rel: string, id: string, aliases: string[]}>} files the batch.
 * @param {Iterable<string>} [knownPaths] the full corpus, as repo-relative paths.
 * @param {Map<string, string>} [idByRel] the corpus-wide id assignment.
 * @returns {{ byPath: Map<string,string>, byStem: Map<string,string[]>,
 *   byAlias: Map<string,string>, ownIds: Set<string> }}
 */
function buildIndex(files, knownPaths, idByRel) {
  const byPath = new Map();
  const byStem = new Map();
  const byAlias = new Map();
  const ownIds = new Set();

  const addStem = (stem, id) => {
    if (!byStem.has(stem)) byStem.set(stem, []);
    const list = byStem.get(stem);
    // Idempotent: the same path arrives twice — once from the batch, once from
    // the declared list — and a duplicate entry would make every basename look
    // ambiguous, silently reporting the whole corpus unresolved.
    if (!list.includes(id)) list.push(id);
  };

  for (const f of files) {
    byPath.set(f.rel, f.id);
    byPath.set(f.rel.replace(/\.md$/i, ''), f.id);
    addStem(path.posix.basename(f.rel).replace(/\.md$/i, ''), f.id);
    ownIds.add(f.id);
    for (const a of f.aliases) {
      if (typeof a === 'string' && a.trim() !== '') byAlias.set(a.trim().toLowerCase(), f.id);
    }
  }

  if (knownPaths !== undefined && knownPaths !== null) {
    for (const raw of knownPaths) {
      if (typeof raw !== 'string' || raw === '') continue;
      const rel = sourceFileFor('/', raw);
      if (rel === null) continue;
      const id = idByRel?.get(rel) ?? slugFor(rel);
      if (!byPath.has(rel)) byPath.set(rel, id);
      if (!byPath.has(rel.replace(/\.md$/i, ''))) byPath.set(rel.replace(/\.md$/i, ''), id);
      addStem(path.posix.basename(rel).replace(/\.md$/i, ''), id);
    }
  }

  return { byPath, byStem, byAlias, ownIds };
}

/**
 * Resolve one wikilink target to a node id.
 *
 * @returns {{id: string, confidence: string, crossChunk: boolean}|null} null when
 *   the target is unknown, and `{ambiguous: true}`-shaped null is reported
 *   separately by the caller so the two reasons stay distinguishable.
 */
function resolveTarget(target, index) {
  const withExt = target.endsWith('.md') ? target : `${target}.md`;
  const exact = index.byPath.get(target) ?? index.byPath.get(withExt);
  if (exact !== undefined) {
    return { id: exact, confidence: 'EXTRACTED', crossChunk: !index.ownIds.has(exact) };
  }
  const lower = target.toLowerCase();
  const alias = index.byAlias.get(lower);
  if (alias !== undefined) {
    return { id: alias, confidence: 'EXTRACTED', crossChunk: !index.ownIds.has(alias) };
  }
  const stem = path.posix.basename(target).replace(/\.md$/i, '');
  const candidates = index.byStem.get(stem);
  if (candidates !== undefined) {
    if (candidates.length === 1) {
      // `crossChunk` is tested against `ownIds` here too, exactly as on the path
      // and alias tiers. Hardcoding it false — which an earlier version did —
      // undercounts cross-batch references by every bare-basename link, and the
      // stem tier is the common one: 3,655 of the corpus's resolvable targets
      // resolve this way against 845 by path.
      return { id: candidates[0], confidence: 'INFERRED', crossChunk: !index.ownIds.has(candidates[0]) };
    }
    return null;
  }
  return null;
}

/**
 * Read a slice of the vault and emit its structural chunk.
 *
 * Never throws on file CONTENT. A file that cannot be read — deleted between
 * enumeration and read, unreadable, or replaced by a directory — is counted in
 * `report.filesUnreadable` and skipped, because 2,360 files go through here and
 * one bad path must not take the rest of the batch down and report a zero-node
 * result as a success. The one throw is for a `files` argument that is not an
 * array of path STRINGS, which is a harness bug rather than extracted data —
 * the same distinction `chunk-schema.mjs` draws when it throws on a
 * `knownNodeIds` that is not a Set, because degrading from a harness bug would
 * produce a plausible-looking report built from a call nobody intended.
 *
 * Nodes are emitted in sorted id order and links in sorted
 * (source, target, relation) order, so two runs on the same input produce
 * byte-identical output and the merge's union sees a stable shape.
 *
 * @param {string} root vault root, absolute.
 * @param {string[]} files repo-relative or absolute paths, ending in `.md`.
 * @param {{ knownPaths?: Iterable<string> }} [opts] `knownPaths` declares the
 *   full corpus so cross-batch targets resolve. See {@link buildIndex}.
 * @returns {{chunk: {nodes: object[], links: object[]}, report: object}}
 */
export function structural(root, files, opts = {}) {
  if (!Array.isArray(files)) {
    throw new TypeError(`files must be an array of path strings, got ${typeof files}`);
  }

  const report = {
    files: 0,
    filesRead: 0,
    filesUnreadable: 0,
    filesOutsideRoot: 0,
    nodes: 0,
    headings: 0,
    scaffoldingSkipped: 0,
    contains: 0,
    references: 0,
    referencesFolded: 0,
    crossChunkReferences: 0,
    selfReferences: 0,
    unresolvedTargets: 0,
    ambiguousTargets: 0,
    unresolvedSample: [],
    noFrontmatter: 0,
    noSourceFile: 0,
    idCollisions: 0,
    headingIdCollisions: 0,
  };

  if (files.length === 0) {
    return { chunk: { nodes: [], links: [] }, report };
  }

  // ---- pass 1: read, parse, and give every file its document id -----------
  //
  // Ids are assigned before anything is emitted, because the id of a file can
  // depend on the ids of the OTHER files in the batch. Two real notes,
  // `Quickstart.md` and `quickstart.md`, slug to the same value, and resolving
  // that needs the whole list.
  const parsed = [];
  for (const file of files) {
    // Validated here rather than skipped, because a non-string is a harness bug
    // and this is the one place it can be told apart from a file that merely
    // failed to read. Skipping it would count it as unreadable and report a
    // batch of 2,360 files as a batch of 2,359, with nothing saying why.
    if (typeof file !== 'string' || file === '') {
      throw new TypeError(`files must contain non-empty path strings, got ${JSON.stringify(file) ?? typeof file}`);
    }
    report.files += 1;
    const rel = sourceFileFor(root, file);
    if (rel === null) {
      report.filesOutsideRoot += 1;
      continue;
    }
    let text;
    try {
      text = readFileSync(path.join(root, rel), 'utf8');
    } catch {
      report.filesUnreadable += 1;
      continue;
    }
    report.filesRead += 1;

    const fm = parseFrontmatter(text);
    // `Object.keys` rather than a truthiness test on the object: a file with no
    // frontmatter yields an empty null-prototype object, which is truthy, and
    // `hasOwnProperty` is the only honest question.
    if (Object.keys(fm).length === 0) report.noFrontmatter += 1;

    const headings = extractHeadings(text);
    const aliases = [];
    const rawAliases = fm.aliases ?? fm.alias;
    for (const a of Array.isArray(rawAliases) ? rawAliases : [rawAliases]) {
      if (typeof a === 'string' && a.trim() !== '') aliases.push(a.trim());
    }

    parsed.push({ rel, text, fm, headings, aliases, base: slugFor(rel) });
  }

  // ---- pass 2: disambiguate colliding document ids ------------------------
  //
  // Every member of a colliding group gets a hash suffix, not just the losers.
  // Naming one member the winner is the same guess this module refuses to make
  // for an ambiguous wikilink stem, and it would make the survivor's id depend
  // on which file happened to be read first.
  //
  // The group is found over the DECLARED CORPUS, not over this batch, and that
  // is a correction rather than a detail. A dry run over all 4,138 files in
  // batches of 150 produced 15 node ids claimed twice, and every one of them
  // descended from the single real collision in the corpus —
  // `Quickstart.md` and `quickstart.md` in `03 - Resources/LLM Wiki/sources/`
  // — which a 150-file batch boundary happened to split. Detecting the collision
  // only within the batch gave the two files the same id, the merge folded one
  // into the other, and 14 of the 15 lost records were HEADINGS: one of the two
  // notes vanished from the graph along with its entire section tree, silently,
  // in a run whose every individual report said it had succeeded. Worse, the
  // outcome depended on where the batch boundary fell, which breaks the
  // determinism the header promises in the only way that is actually dangerous:
  // two runs of the same corpus with different batch sizes produce different
  // graphs.
  //
  // The assignment therefore covers every declared path, not just the ones this
  // call read, and the resolution index is built from the SAME assignment. An
  // earlier version disambiguated only the batch and then let the declared corpus
  // fall back to the raw `slugFor`, which left a `[[.../quickstart]]` resolving to
  // the un-suffixed id while the owning batch emitted the suffixed one — two
  // dangling endpoints in the merged graph, created by the fix for a different
  // bug. One assignment, used by both, is the only way they cannot disagree.
  //
  // Without a declared corpus the batch is all there is, and the fallback is
  // honest rather than merely convenient: a caller who does not say what the
  // corpus is cannot be protected against a collision with a file they did not
  // mention.
  const idByRel = new Map();
  for (const p of parsed) idByRel.set(p.rel, p.base);
  if (opts.knownPaths !== undefined && opts.knownPaths !== null) {
    for (const raw of opts.knownPaths) {
      if (typeof raw !== 'string' || raw === '') continue;
      const rel = sourceFileFor('/', raw);
      if (rel === null || idByRel.has(rel)) continue;
      idByRel.set(rel, slugFor(rel));
    }
  }
  const corpusGroups = new Map();
  for (const [rel, base] of idByRel) {
    if (!corpusGroups.has(base)) corpusGroups.set(base, []);
    corpusGroups.get(base).push(rel);
  }
  for (const group of corpusGroups.values()) {
    if (group.length < 2) continue;
    // Sorted by exact path so the assignment depends on neither read order nor
    // which batch a member landed in.
    for (const rel of group.slice().sort(cmp)) idByRel.set(rel, `${idByRel.get(rel)}_${shortHash(rel)}`);
    // Counted only when this call read a member, and as SURPLUS RECORDS among the
    // members it read: three files claiming one id is two collisions, which is the
    // arithmetic `vault-index-merge.mjs` already uses for `nodeIdCollisions`, so
    // the two numbers mean the same thing in a report that quotes both. A
    // collision the corpus has but this batch does not touch is the corpus's
    // count to report, not this call's, or 28 batches would each claim it.
    const inBatch = group.filter((rel) => parsed.some((p) => p.rel === rel)).length;
    if (inBatch > 0) report.idCollisions += inBatch > 1 ? inBatch - 1 : 1;
  }
  for (const p of parsed) p.id = idByRel.get(p.rel);

  // ---- pass 3: build the resolution index ---------------------------------
  const index = buildIndex(parsed, opts.knownPaths, idByRel);

  // ---- pass 4: emit -------------------------------------------------------
  const nodes = [];
  const links = [];
  const linkKeys = new Set();
  const unresolved = new Map();

  for (const p of parsed.slice().sort((a, b) => cmp(a.id, b.id))) {
    const label = documentLabel(p.fm, p.headings, p.rel);
    if (typeof label !== 'string' || label.trim() === '') {
      // Unreachable via documentLabel, and kept anyway: a node with an empty
      // label is rejected by the validator, which rejects the WHOLE chunk, so the
      // counter has to be able to say "this is the bug" rather than the run
      // failing with an error that names neither the file nor the cause.
      report.noSourceFile += 1;
      continue;
    }

    nodes.push({
      id: p.id,
      label,
      file_type: 'document',
      source_file: p.rel,
      node_kind: 'document',
    });

    // The heading chain, built as a stack rather than searched for.
    //
    // `stack[level - 1]` is the id of the open heading at that level, so the
    // ancestry of the current heading is the stack truncated to its own level —
    // which is what puts a `### Summary` under `## Part One` at a different id
    // from the same title under `## Part Two`, with no search at all. A previous
    // draft walked `p.headings.indexOf(h)` backwards per heading, which is
    // quadratic over a 597-heading transcript and, worse, finds the nearest
    // ancestor by scanning for a LEVEL rather than by depth, so a document that
    // skips from `##` to `####` produces a wrong parent that no test on a
    // well-formed document would catch.
    //
    // `live[level - 1]` runs alongside it and says whether the heading at that
    // level actually EMITTED a node. The two are separate arrays because the
    // filter needs both answers at once and they disagree for 294,486 measured
    // headings: a filtered heading still has an id (its descendants' ids embed
    // it) but has no node to be a parent of. See decision 8 in the header.
    const stack = [];
    const live = [];
    const headingIds = new Map();
    const usedIds = new Set([p.id]);

    for (const h of p.headings) {
      // Truncating first is what makes a level jump back up (a `##` after a
      // `####`) reuse the id of the enclosing `##` rather than nesting under it.
      stack.length = Math.max(0, h.level - 1);
      live.length = stack.length;
      const chain = stack.slice();
      const segment = slugify(h.title);
      chain[h.level - 1] = segment === '' ? `h${shortHash(h.title)}` : segment;
      const base = boundId(`${p.id}_${chain.join('_')}`);

      // The counter separates siblings: two `## Summary` under one parent share
      // both ancestry and title, so only an occurrence number tells them apart.
      // 197,643 measured in-file duplicates in the corpus make this the common
      // case, not the edge case.
      let id = base;
      let n = 1;
      while (usedIds.has(id)) {
        n += 1;
        id = boundId(`${base}_${n}`);
      }
      if (n > 1) report.headingIdCollisions += 1;
      usedIds.add(id);
      // The slot is filled for EVERY heading, filtered or not. A heading id embeds
      // its ancestors' ids, so emptying this slot for a filtered heading would
      // change the id of every heading beneath it — and T9 unions chunks by id, so
      // a changed id is a node that silently vanishes from the merged graph. The
      // id is also left in `usedIds` and counted in `headingIdCollisions` for the
      // same reason: both describe id ASSIGNMENT, and assignment is unchanged.
      stack[h.level - 1] = id;

      const scaffolding = isScaffoldingHeading(h.title);
      live[h.level - 1] = !scaffolding;
      if (scaffolding) {
        // Counted, never silently dropped — see decision 8 in the header. A
        // filter whose size nobody can see is indistinguishable from a bug.
        report.scaffoldingSkipped += 1;
        continue;
      }
      headingIds.set(h.line, id);

      // contains: the nearest open ancestor, or the document for a top-level
      // heading. A flat document-to-every-heading fan would pass any count check
      // and lose the section structure that is the only reason a heading node is
      // worth having.
      //
      // PROMOTION. When the would-be parent is scaffolding there is no node to
      // point at, so the parent walks DOWN to the nearest ancestor that did
      // emit one, and to the document if there is none. The alternative —
      // emitting the section with a flattened path — was rejected: it makes the
      // id depend on how much scaffolding happened to sit above the heading, so
      // deleting a tool call from a transcript would renumber everything under
      // it, and promotion moves no id at all. Promotion is also what the corpus
      // needs rather than what the fixture would like: 2,794 measured headings
      // have a filtered parent, and 2,636 of those have a filtered level below
      // too, so the walk has to cross a chain of them rather than step once.
      //
      // The walk starts ONLY when the immediate parent slot is filtered. A slot
      // that was never filled is not a filter case, and treating it as one would
      // quietly re-parent the 6,658 measured headings that simply sit under a
      // level their document never used.
      let parentId;
      if (h.level === 1) {
        parentId = p.id;
      } else {
        const at = h.level - 2;
        parentId = stack[at] ?? p.id;
        if (live[at] === false) {
          // `live[lv] === true` strictly: an unfilled slot is `undefined`, and
          // skipping it is what lets a `##### Section` under a filtered `####
          // tool · shell` land on the `## Setup` two levels up rather than on the
          // document.
          for (let lv = at - 1; lv >= 0; lv--) {
            if (live[lv] === true) {
              parentId = stack[lv];
              break;
            }
          }
        }
      }
      if (parentId !== undefined && parentId !== id) {
        const key = [parentId, id, 'contains'].join(KEY_SEP);
        if (!linkKeys.has(key)) {
          linkKeys.add(key);
          links.push({ source: parentId, target: id, relation: 'contains', confidence: 'EXTRACTED', source_file: p.rel, source_location: `L${h.line}` });
          report.contains += 1;
        }
      }

      nodes.push({
        id,
        label: h.title,
        file_type: 'document',
        source_file: p.rel,
        source_location: `L${h.line}`,
        node_kind: 'heading',
        heading_level: h.level,
      });
      report.headings += 1;
    }

    // references. Body links plus the frontmatter's `related` array — the latter
    // because `extractWikilinks` is body-only by contract, and 414 corpus files
    // write `related` as a flow array and 116 as a block sequence. Missing the
    // block form would lose every one of those 116 silently.
    const bodyLinks = extractWikilinks(p.text);
    const related = p.fm.related;
    const frontLinks = [];
    const relatedItems = Array.isArray(related) ? related : typeof related === 'string' && related !== '' ? [related] : [];
    for (const item of relatedItems) {
      for (const m of String(item).matchAll(/\[\[([^\][\n]+)\]\]/g)) {
        frontLinks.push({ target: m[1].split('|')[0].split('#')[0].trim(), line: 1 });
      }
    }

    // A link is attributed to the nearest preceding heading, which is free
    // precision: without it every reference in a 600-heading transcript attaches
    // to the document and the section that made the reference is lost.
    //
    // The walk is over EMITTED headings, not over every heading the parser found.
    // Those are different lists once the filter is on, and using the raw one is a
    // dangling-endpoint factory: `headingIds` has no entry for a filtered line, so
    // `best` becomes `undefined` and the edge points at a node nobody emitted. The
    // merge's `crossChunkDangling` would catch it 28 batches later, which is the
    // wrong place to learn about it.
    const emitted = [...headingIds.entries()].sort((a, b) => a[0] - b[0]);
    const sourceFor = (line) => {
      let best = p.id;
      for (let i = 0; i < emitted.length; i++) {
        if (emitted[i][0] <= line) best = emitted[i][1];
        else break;
      }
      return best;
    };

    for (const w of [...frontLinks, ...bodyLinks]) {
      if (w.target === '') continue;
      const hit = resolveTarget(w.target, index);
      if (hit === null) {
        const stem = path.posix.basename(w.target).replace(/\.md$/i, '');
        const ambiguous = (index.byStem.get(stem) ?? []).length > 1;
        if (ambiguous) report.ambiguousTargets += 1;
        report.unresolvedTargets += 1;
        if (!unresolved.has(w.target)) {
          unresolved.set(w.target, { target: w.target, count: 0, ambiguous, from: p.rel });
          if (unresolved.size <= MAX_UNRESOLVED_SAMPLES) {
            report.unresolvedSample.push({ target: w.target, count: 0, ambiguous, from: p.rel });
          }
        }
        unresolved.get(w.target).count += 1;
        const sampled = report.unresolvedSample.find((u) => u.target === w.target);
        if (sampled !== undefined) sampled.count += 1;
        continue;
      }

      // Compared against the FILE's document id, not against the edge's source.
      // A link under an H1 is attributed to the heading node, so `source ===
      // hit.id` is almost never true and the counter would read 0 on a note that
      // plainly links to itself — which is exactly the silent-zero this module
      // argues against everywhere else. The fact being counted is "this note
      // points at itself", and the node that can be pointed at is the document.
      if (hit.id === p.id) report.selfReferences += 1;
      const source = sourceFor(w.line);
      if (hit.crossChunk) report.crossChunkReferences += 1;

      const key = [source, hit.id, 'references'].join(KEY_SEP);
      if (linkKeys.has(key)) {
        // A note that links the same note nine times is normal, and the validator
        // treats a repeated triple as an ERROR. Folding is counted rather than
        // silent, because "the note mentions it once, the graph says once" and
        // "the note mentions it once" must not read the same in a report.
        report.referencesFolded += 1;
        continue;
      }
      linkKeys.add(key);
      links.push({ source, target: hit.id, relation: 'references', confidence: hit.confidence, source_file: p.rel, source_location: `L${w.line}` });
      report.references += 1;
    }
  }

  // Sorted by codepoint for byte-identical reruns; see the header.
  nodes.sort((a, b) => cmp(a.id, b.id));
  links.sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(String(a.relation), String(b.relation)));
  report.unresolvedSample.sort((a, b) => cmp(a.target, b.target));

  report.nodes = nodes.length;
  report.contains = links.filter((l) => l.relation === 'contains').length;
  report.references = links.filter((l) => l.relation === 'references').length;

  return { chunk: { nodes, links }, report };
}
