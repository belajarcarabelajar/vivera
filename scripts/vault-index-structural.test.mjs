// C7 — the structural layer of the vault knowledge-graph rebuild, and the tests
// that hold it to the contract the other chunks are written against.
//
// What this file is defending is narrower than "the parser works". It is that
// every node this module emits can be pointed at on disk. The graph this rebuild
// replaces carries 1,299 nodes whose `source_file` is null or empty — measured
// on `graphify-out/graph.json` — and that number is the reason the rebuild
// exists. An extractor that emits one more unattributable node has not made the
// problem smaller; it has made the number on the next audit 1,300. So the
// assertions that matter most here are the boring-looking ones: every node has a
// non-empty repo-relative `source_file`, no `source_file` is absolute, none
// contains `..`, and the whole chunk survives `validateChunk` with zero dangling
// endpoints. Those four are the deliverable. The fence and duplicate-heading
// tests are about not corrupting the graph with nodes that are merely wrong
// rather than absent.
//
// The corpus shaped the design in five places that a description of the task
// would not have predicted, and each is pinned by a test below:
//
//   1. DUPLICATE HEADINGS ARE THE NORM, NOT THE EDGE CASE. `#### input` appears
//      112 times in one conversation transcript; `### tool · shell` 76 times in
//      the same file. Across the corpus 1,092 files repeat a heading title
//      within themselves, 197,643 times. A heading id of `docId + slug(title)`
//      therefore collides constantly, and the validator reports a duplicate id
//      as an error that REJECTS THE WHOLE CHUNK. The id carries the ancestor
//      chain plus an occurrence counter, and `duplicate headings in one file do
//      not collide` is the test that keeps that from regressing.
//
//   2. FENCE CLOSING IS LENGTH-AWARE, AND GETTING IT WRONG COSTS 35,364
//      HEADINGS. A ````-backtick fence opened with four backticks legitimately
//      contains three-backtick lines; the vault's session transcripts do this to
//      embed prompts that themselves contain fences. Treating any backtick run
//      as a closer ends the fence early, and 217 files then parse differently —
//      measured, not estimated. The rule is the CommonMark one: same character,
//      at least as long, nothing else on the line.
//
//   3. 41% OF WIKILINK TARGETS DO NOT RESOLVE, AND MOST OF THEM ARE NOT NOTES.
//      Of 7,964 targets measured across the corpus, 3,806 resolve to a file and
//      3,294 resolve to nothing. Inspection shows the residue is largely bash
//      `[[ ... ]]` test syntax pasted out of transcripts plus links to PNG
//      attachments, not broken links between notes. That number is the reason
//      this module emits no placeholder nodes; see the `unresolved wikilink`
//      tests for the full argument.
//
//   4. BASENAMES ARE AMBIGUOUS IN 431 CASES. `quickstart.md` exists under more
//      than one directory, and 735 measured target occurrences hit such a stem.
//      Picking one arbitrarily would be fabricating an edge, so an ambiguous
//      stem is reported unresolved rather than guessed.
//
//   5. 92.9% OF ALL HEADINGS ARE SESSION-TRANSCRIPT SCAFFOLDING, AND EMITTING
//      THEM WOULD RE-CREATE THE FRAGMENTATION. 294,486 of 317,050, with
//      294,437 of those inside `05 - Conversations/`: `input` 59,385, `output`
//      59,410, `reasoning` 33,365, `tool · shell` 30,802, `assistant text`
//      15,002. A graph holding 59,385 nodes labelled `input` has no communities.
//      The filter is a title rule rather than a path rule so it works on a
//      transcript wherever it is filed, and the scaffolding tests pin the three
//      things that is easy to get wrong — that real sections under a filtered
//      heading are promoted rather than orphaned, that no surviving id moves, and
//      that `output format`, `user input` and `tools` are not collateral.
//
// Fixture convention: every test writes real files into a fresh temp directory.
// Nothing here reads the real vault. A test that depended on 4,138 files nobody
// controls would fail on a Tuesday for reasons unrelated to what it asserts, and
// the corpus measurements are recorded as numbers in the comments above instead
// — which is the property the audit trail actually needs, because the numbers
// can be re-measured and the fixtures cannot drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  slugFor,
  parseFrontmatter,
  extractHeadings,
  extractWikilinks,
  structural,
  isScaffoldingHeading,
  SCAFFOLDING_HEADING_TITLES,
  SCAFFOLDING_HEADING_PREFIXES,
  NODE_ID_MAX,
} from './vault-index-structural.mjs';
import { validateChunk } from './lib/chunk-schema.mjs';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

/**
 * A fresh temp root, with the files written into it, and a cleanup.
 *
 * `t.after` rather than a bare `rmSync` at the end of each test: an assertion
 * failure throws, and a cleanup that only runs on the happy path leaks a
 * directory per red test. Over a few hundred runs that is real disk.
 */
function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'vault-structural-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

/**
 * A note carrying the frontmatter shape measured across the real corpus.
 *
 * `related` is ON by default because 414 real files write it and the structural
 * layer has to harvest it. Tests about body links pass `{related: false}` so
 * their counts are about the links they put in the body and not about this
 * helper — otherwise every such assertion is off by one and nobody can tell
 * which number is wrong.
 */
function note(body, { related = true, extra = [] } = {}) {
  return [
    '---',
    'title: Snipset Desktop (Windows) i18n Completeness Implementation Plan',
    'type: note',
    'para: project',
    'status: Draft',
    'project: Snipset',
    ...(related ? ['related: ["[[01 - Projects/Snipset/index]]"]'] : []),
    'source_path: /home/testuser/Proyek/Snipset/docs/code-plan/plans/....md',
    'source_hash: 67f1d26b3b8a',
    ...extra,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

/** Ids of every node in a chunk, as a Set, for endpoint resolution. */
function ids(chunk) {
  return new Set(chunk.nodes.map((n) => n.id));
}

/** Every relation present in a chunk, in emission order. */
function relations(chunk) {
  return chunk.links.map((l) => l.relation);
}

/**
 * Assert the four properties this module exists to guarantee.
 *
 * Written once and called from every structural test rather than asserted
 * ad-hoc, because the failure mode being defended is precisely the one where a
 * test author looks at a chunk, sees 40 nodes, and does not think to check the
 * 40th one's `source_file`.
 */
function assertAttributable(chunk) {
  for (const n of chunk.nodes) {
    assert.equal(typeof n.source_file, 'string', `node ${n.id} has no source_file`);
    assert.notEqual(n.source_file.trim(), '', `node ${n.id} has an empty source_file`);
    assert.ok(!n.source_file.startsWith('/'), `node ${n.id} source_file is absolute: ${n.source_file}`);
    assert.ok(!/^[A-Za-z]:/.test(n.source_file), `node ${n.id} source_file is a drive path: ${n.source_file}`);
    assert.ok(
      !n.source_file.split(/[\\/]+/).includes('..'),
      `node ${n.id} source_file traverses: ${n.source_file}`,
    );
  }
  const verdict = validateChunk(chunk, { knownNodeIds: ids(chunk) });
  assert.deepEqual(verdict.errors, [], 'the chunk must validate with zero dangling endpoints');
  assert.equal(verdict.stats.dangling, 0);
}

// ---------------------------------------------------------------------------
// slugFor
// ---------------------------------------------------------------------------

test('slugFor is a pure function of the path, with no filesystem access', () => {
  const p = '01 - Projects/Snipset/plans/2026-09-11-winget-vcruntime-fix.md';
  assert.equal(slugFor(p), slugFor(p));
  // Accents fold rather than vanish into a separator run: `Café` -> `cafe`,
  // matching the allowlist in lib/note-name.mjs so a slug means the same thing
  // in both modules.
  assert.equal(slugFor('03 - Resources/Café Notes.md'), '03_resources_cafe_notes');
  assert.equal(slugFor('a//b\\\\c.md'), 'a_b_c');
  assert.equal(slugFor('--leading and trailing--.md'), 'leading_and_trailing');
});

test('slugFor drops the .md extension but keeps the directory path', () => {
  // The directory is part of the identity: the vault holds two `index.md` files
  // under different projects, and a basename-only id would merge them.
  assert.equal(slugFor('01 - Projects/Snipset/index.md'), '01_projects_snipset_index');
  assert.equal(slugFor('01 - Projects/ram-audit/index.md'), '01_projects_ram_audit_index');
});

test('slugFor is not injective, and structural() is what resolves that', () => {
  // Measured: `Quickstart.md` and `quickstart.md` sit in the same directory of
  // the real vault, so this is a fact about the corpus and not a synthetic edge
  // case. `slugFor` is a pure function of one path and cannot see the other one;
  // the disambiguation belongs to the pass that has the whole file list.
  assert.equal(slugFor('03 - Resources/LLM Wiki/sources/Quickstart.md'), slugFor('03 - Resources/LLM Wiki/sources/quickstart.md'));
});

test('slugFor survives a path that reduces to nothing', () => {
  // Emoji-only and punctuation-only filenames are in the corpus. An empty id is
  // rejected by the validator, so this must not return ''.
  for (const p of ['🎓.md', '---.md', '.md', '🎓💡.md']) {
    const id = slugFor(p);
    assert.notEqual(id, '', `slugFor(${JSON.stringify(p)}) returned an empty id`);
  }
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

test('parseFrontmatter reads the scalar shape measured across the corpus', () => {
  const fm = parseFrontmatter(note('body'));
  assert.equal(fm.title, 'Snipset Desktop (Windows) i18n Completeness Implementation Plan');
  assert.equal(fm.type, 'note');
  assert.equal(fm.para, 'project');
  assert.equal(fm.status, 'Draft');
  // Values are left as strings, including things YAML would type. A `status` of
  // `Draft` and a `status` of `2026-09-14` must both come back as text, because
  // the consumer is a label, not a type switch.
  assert.equal(typeof fm.status, 'string');
});

test('parseFrontmatter reads a flow array of wikilinks', () => {
  const fm = parseFrontmatter(note('body'));
  assert.deepEqual(fm.related, ['[[01 - Projects/Snipset/index]]']);
});

test('parseFrontmatter reads a block sequence, which 116 real files use for related', () => {
  const text = [
    '---',
    'title: Block sequence',
    'related:',
    '  - "[[Claude]]"',
    '  - "[[Learn]]"',
    'tags:',
    '  - wiki/entities/claude',
    '---',
    'body',
  ].join('\n');
  const fm = parseFrontmatter(text);
  assert.deepEqual(fm.related, ['[[Claude]]', '[[Learn]]']);
  assert.deepEqual(fm.tags, ['wiki/entities/claude']);
});

test('parseFrontmatter unwraps single and double quotes, and unquotes inside arrays', () => {
  const fm = parseFrontmatter([
    '---',
    "title: 'Single quoted'",
    'type: "Double quoted"',
    'related: ["[[a]]", \'[[b]]\']',
    '---',
    'body',
  ].join('\n'));
  assert.equal(fm.title, 'Single quoted');
  assert.equal(fm.type, 'Double quoted');
  assert.deepEqual(fm.related, ['[[a]]', '[[b]]']);
});

test('parseFrontmatter returns an empty object for a file with no frontmatter', () => {
  // `Object.keys`, not `deepEqual`: the result has a NULL prototype on purpose,
  // so that a `__proto__:` key in somebody's frontmatter cannot reach
  // `Object.prototype`. `assert.deepEqual` with `node:assert/strict` is
  // `deepStrictEqual`, which compares prototypes and would fail on a correct
  // result for a reason that has nothing to do with the frontmatter.
  assert.deepEqual(Object.keys(parseFrontmatter('# Just a heading\n\ntext\n')), []);
  assert.deepEqual(Object.keys(parseFrontmatter('')), []);
  assert.deepEqual(Object.keys(parseFrontmatter(null)), []);
  assert.equal(Object.getPrototypeOf(parseFrontmatter('x')), null);
});

test('parseFrontmatter ignores a `---` that is not on the first line', () => {
  // A horizontal rule three paragraphs into a note is not frontmatter. Reading it
  // as frontmatter would delete the first three paragraphs from the body scan.
  const text = 'intro paragraph\n\n---\ntitle: not frontmatter\n---\n\n# Real heading\n';
  assert.deepEqual(Object.keys(parseFrontmatter(text)), []);
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['Real heading']);
});

test('parseFrontmatter stops at the closing `---` and does not swallow the body', () => {
  const text = note('# H1\n\nbody text\n');
  const fm = parseFrontmatter(text);
  assert.equal(fm.status, 'Draft');
  // `source_path:` holds an absolute path; it is a VALUE here and must never
  // become a `source_file`. Asserting the value survives proves it was parsed
  // as data, and the `source_file` assertions elsewhere prove it was not used
  // as one.
  assert.equal(fm.source_path, '/home/testuser/Proyek/Snipset/docs/code-plan/plans/....md');
});

test('parseFrontmatter does not let a `__proto__` key reach the prototype', () => {
  // Frontmatter is document-authored text, and a naive `out[key] = value` on a
  // plain object with a `__proto__` key assigns the prototype instead of
  // creating a property. vault-index-merge.mjs hit this same hazard reading
  // graph.json; here the input is a note someone edited in Obsidian.
  const fm = parseFrontmatter(['---', '__proto__: polluted', 'title: Safe', '---', 'body'].join('\n'));
  assert.equal(fm.title, 'Safe');
  // The prototype is NULL, not Object.prototype. That is the fix: a null-prototype
  // object has no `__proto__` setter to be reached through, so a key of that name
  // is inert whether or not the parser bothers to skip it. Asserting
  // `Object.prototype` here would assert the vulnerability.
  assert.equal(Object.getPrototypeOf(fm), null);
  assert.equal({}.polluted, undefined);
  assert.equal(fm.polluted, undefined);
});

test('parseFrontmatter is pure: it returns a new object every call', () => {
  const text = note('body');
  const a = parseFrontmatter(text);
  const b = parseFrontmatter(text);
  assert.notEqual(a, b);
  a.title = 'mutated';
  assert.equal(parseFrontmatter(text).title, b.title);
});

// ---------------------------------------------------------------------------
// extractHeadings — fences
// ---------------------------------------------------------------------------

test('a `#` line inside a ``` fence is not a heading', () => {
  const text = ['# Real H1', '', '```bash', '# not a heading', '## not a subheading', '```', '', '## After the fence', ''].join('\n');
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['Real H1', 'After the fence']);
});

test('a `#` line inside a ~~~ fence is not a heading', () => {
  // 53 real files use tilde fences. Handling ``` only would extract every
  // comment inside them as document structure.
  const text = ['# Real H1', '', '~~~', '# not a heading', '~~~', '', '## After', ''].join('\n');
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['Real H1', 'After']);
});

test('a fence opened with four backticks is not closed by three', () => {
  // The measured case: session transcripts embed prompts that contain their own
  // three-backtick fences, wrapped in four so the embed survives. A char-only
  // rule ends the fence at the inner run and re-opens it at the next one; across
  // 217 corpus files that mis-parses 35,364 headings.
  const text = [
    '# Real H1',
    '',
    '````text',
    '```bash',
    '# inside the inner fence',
    '```',
    '# still inside the outer fence',
    '````',
    '',
    '## After the outer fence',
    '',
  ].join('\n');
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['Real H1', 'After the outer fence']);
});

test('an unclosed fence suppresses headings to end of file', () => {
  // Measured: 2 corpus files end inside an open fence under length-aware
  // closing. Treating the rest of the file as prose would add fabricated
  // structure to the tail of a truncated transcript.
  const text = ['# Real H1', '', '```python', '# not a heading', '', '## also not a heading', ''].join('\n');
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['Real H1']);
});

test('a closing fence must not carry an info string', () => {
  // ```python OPENS a fence; a bare ``` closes it; the second ```python OPENS one
  // again rather than closing. CommonMark's rule, and the one that keeps a prose
  // line carrying a language tag from ending a code block early — after which
  // every heading in the rest of the note would be extracted from inside what is
  // still, syntactically, a code block.
  const text = ['# H1', '', '```python', '# a', '```', '# b', '```python', '# c', '', '## tail', ''].join('\n');
  // `# b` is real prose between two fences. `## tail` is not: the second
  // ```python re-opened the fence and nothing closed it.
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['H1', 'b']);
});

test('a `#` line inside frontmatter is not a heading', () => {
  // Rule 3 of the contract. A `# Heading` as a YAML value is data; extracting it
  // invents a section the note does not have.
  const text = ['---', 'title: Has a hash', 'summary: "# Not A Heading"', '---', '', '# The real heading', ''].join('\n');
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['The real heading']);
});

test('a `#` with no space after the hashes is not a heading', () => {
  // `#tag` is a tag, and the corpus has 2,689 notes carrying tags in
  // frontmatter. Treating the hash as an ATX marker would turn every tagged line
  // into a heading.
  const text = ['# Real H1', '', '#hashtag is not a heading', '####### seven hashes is not either', ''].join('\n');
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['Real H1']);
});

test('headings report level, title and 1-based line, and closing hashes are stripped', () => {
  const text = note('# Title\n\n## Sub ##\n\n### Deep\n');
  const hs = extractHeadings(text);
  assert.deepEqual(hs.map((h) => [h.level, h.title]), [[1, 'Title'], [2, 'Sub'], [3, 'Deep']]);
  // Line numbers are into the ORIGINAL file, frontmatter included, because
  // `source_location` is what a person follows to check the extraction.
  const lines = text.split('\n');
  for (const h of hs) assert.equal(lines[h.line - 1].trim().startsWith('#'), true, `line ${h.line} is not the heading`);
  // Line 12: the fixture's frontmatter is 9 keys plus the two `---` fences, then
  // a blank line, then the body. Asserted as an exact number rather than a
  // relative one because an off-by-one here is invisible in every other
  // assertion in this file — `source_location` is the one field a person
  // follows to check the extraction, so it is the one that has to be right.
  assert.equal(hs[0].line, 12);
  assert.deepEqual(hs.map((h) => h.line), [12, 14, 16]);
});

test('an ATX heading deeper than six hashes is not a heading', () => {
  const text = ['###### six is fine', '####### seven is not', ''].join('\n');
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['six is fine']);
});

test('extractHeadings is pure: no shared state between calls', () => {
  const text = ['# A', '', '```', '# B', '```', '', '# C', ''].join('\n');
  assert.deepEqual(extractHeadings(text), extractHeadings(text));
  assert.deepEqual(extractHeadings(text).map((h) => h.title), ['A', 'C']);
});

// ---------------------------------------------------------------------------
// extractWikilinks
// ---------------------------------------------------------------------------

test('a `[[link]]` inside a fence is not a wikilink', () => {
  const text = ['See [[real]].', '', '```md', 'not a [[link]] here', '```', '', 'Also [[second]].', ''].join('\n');
  assert.deepEqual(extractWikilinks(text).map((w) => w.target), ['real', 'second']);
});

test('a `[[link]]` inside a ~~~ fence is not a wikilink', () => {
  const text = ['[[real]]', '', '~~~', '[[nope]]', '~~~', '', '[[yes]]', ''].join('\n');
  assert.deepEqual(extractWikilinks(text).map((w) => w.target), ['real', 'yes']);
});

test('an unclosed fence suppresses wikilinks to end of file', () => {
  const text = ['[[real]]', '', '```', '[[nope]]', '[[also nope]]', ''].join('\n');
  assert.deepEqual(extractWikilinks(text).map((w) => w.target), ['real']);
});

test('`[[a|b]]` yields target `a` and alias `b`', () => {
  const text = 'See [[01 - Projects/Snipset/index|the Snipset hub]] for detail.\n';
  const links = extractWikilinks(text);
  assert.equal(links.length, 1);
  assert.equal(links[0].target, '01 - Projects/Snipset/index');
  assert.equal(links[0].alias, 'the Snipset hub');
});

test('a link with no alias reports a null alias rather than an empty string', () => {
  // `null` and `''` are different answers: the merge module treats them the
  // same way, so a consumer cannot tell "no alias" from "an alias that is
  // blank", and picking '' makes that distinction unrecoverable.
  const [withAlias, without] = extractWikilinks('[[a|b]] and [[c]]\n');
  assert.equal(withAlias.alias, 'b');
  assert.equal(without.alias, null);
  assert.equal(without.target, 'c');
});

test('a heading anchor is stripped from the target and a block ref too', () => {
  // 27 measured corpus links carry a `#` anchor. `[[Note#Section]]` points at a
  // note, and the structural layer resolves notes, not sections — keeping the
  // anchor in the target would make every one of them unresolved.
  const links = extractWikilinks('[[Note#Section]] [[Other#^blockid]]\n');
  assert.deepEqual(links.map((w) => w.target), ['Note', 'Other']);
});

test('an embedded `![[image.png]]` is captured, because it is still a reference', () => {
  // 308 measured embeds. The target resolves to nothing — it is an attachment,
  // not a note — so it belongs in the unresolved report, not in a dropped
  // bucket. Silently discarding embeds would make the report understate the
  // real link count.
  const links = extractWikilinks('![[diagram.png]]\n');
  assert.equal(links.length, 1);
  assert.equal(links[0].target, 'diagram.png');
});

test('a wikilink reports a 1-based line into the original file', () => {
  const text = note('para one\n\npara two with [[a link]]\n');
  const [link] = extractWikilinks(text);
  const lines = text.split('\n');
  assert.ok(lines[link.line - 1].includes('[[a link]]'));
});

test('a `[[wikilink]]` spanning two lines is not a link', () => {
  // Regexes that allow newlines inside the brackets invent targets out of two
  // adjacent lines, and the target they invent is nonsense by construction.
  assert.deepEqual(extractWikilinks('[[un\nclosed]]\n'), []);
});

test('extractWikilinks is pure and does not include frontmatter links', () => {
  // The contract says body only. Frontmatter `related:` arrays are harvested by
  // structural() instead, so this function's output means exactly one thing.
  const text = note('body with [[body link]]\n');
  assert.deepEqual(extractWikilinks(text).map((w) => w.target), ['body link']);
});

// ---------------------------------------------------------------------------
// structural — the chunk
// ---------------------------------------------------------------------------

test('a note with frontmatter, an H1 and ## subheadings produces one document and the right contains edges', (t) => {
  const root = fixture(t, {
    '01 - Projects/Snipset/index.md': note([
      '# Snipset',
      '',
      'Intro paragraph.',
      '',
      '## Goal',
      '',
      'Text.',
      '',
      '### Detail',
      '',
      'More text.',
      '',
      '## Status',
      '',
      'Draft.',
    ].join('\n')),
  });
  const { chunk, report } = structural(root, ['01 - Projects/Snipset/index.md']);

  const docs = chunk.nodes.filter((n) => n.file_type === 'document' && n.node_kind !== 'heading');
  assert.equal(docs.length, 1, 'exactly one document node');
  assert.equal(docs[0].label, 'Snipset Desktop (Windows) i18n Completeness Implementation Plan');
  assert.equal(docs[0].source_file, '01 - Projects/Snipset/index.md');

  // Sorted by `source_location`, because `chunk.nodes` is sorted by ID for
  // determinism and a heading's id encodes its ancestry rather than its position.
  // Asserting document order here against an id-sorted array would be asserting
  // that two different orderings coincide.
  const headings = chunk.nodes
    .filter((n) => n.node_kind === 'heading')
    .sort((a, b) => Number(a.source_location.slice(1)) - Number(b.source_location.slice(1)));
  assert.deepEqual(headings.map((h) => h.label), ['Snipset', 'Goal', 'Detail', 'Status']);
  assert.deepEqual(headings.map((h) => h.source_location), ['L12', 'L16', 'L20', 'L24']);

  // contains edges: document -> H1, H1 -> Goal, Goal -> Detail, H1 -> Status.
  // The hierarchy is asserted by label, not just by count, because a flat
  // document-to-every-heading fan would pass a count check and lose the section
  // structure that is the only reason a heading node is worth having.
  const byId = new Map(chunk.nodes.map((n) => [n.id, n]));
  const containsFrom = (id) => chunk.links
    .filter((l) => l.relation === 'contains' && l.source === id)
    .map((l) => byId.get(l.target).label)
    .sort();
  assert.deepEqual(containsFrom(docs[0].id), ['Snipset']);
  assert.deepEqual(containsFrom(headings[0].id), ['Goal', 'Status']);
  assert.deepEqual(containsFrom(headings[1].id), ['Detail'], 'Detail nests under Goal, not under the document');
  assert.deepEqual(containsFrom(headings[3].id), [], 'a leaf heading contains nothing');
  assert.equal(report.contains, 4);
  assert.equal(report.headings, 4);
  assert.deepEqual([...new Set(relations(chunk))].sort(), ['contains', 'references']);
  assertAttributable(chunk);
});

test('the document label falls back title -> H1 -> filename, and all three are tested', (t) => {
  // Measured on the corpus: 2,561 of 4,138 notes carry `title:`, and 1,606 have
  // an H1. Neither covers the set, so the third rung is load-bearing rather than
  // decorative.
  const root = fixture(t, {
    'a-title.md': ['---', 'title: From frontmatter', '---', '', '# From H1', ''].join('\n'),
    'b-h1.md': ['# From H1 only', '', 'body', ''].join('\n'),
    'c-neither.md': ['Just prose, no heading and no title.', ''].join('\n'),
  });
  const { chunk } = structural(root, ['a-title.md', 'b-h1.md', 'c-neither.md']);
  const labelOf = (rel) => chunk.nodes.find((n) => n.source_file === rel && n.node_kind !== 'heading').label;
  assert.equal(labelOf('a-title.md'), 'From frontmatter');
  assert.equal(labelOf('b-h1.md'), 'From H1 only');
  assert.equal(labelOf('c-neither.md'), 'c-neither');
  assertAttributable(chunk);
});

test('a blank or non-string frontmatter title falls through instead of becoming an empty label', (t) => {
  // The validator rejects an empty label outright, which would reject the whole
  // chunk. A note with `title:` and nothing after it is a real thing to write.
  const root = fixture(t, {
    'blank.md': ['---', 'title:', '---', '', '# Fallback H1', ''].join('\n'),
    'quoted.md': ['---', 'title: "  padded  "', '---', '', 'body', ''].join('\n'),
  });
  const { chunk } = structural(root, ['blank.md', 'quoted.md']);
  const labelOf = (rel) => chunk.nodes.find((n) => n.source_file === rel && n.node_kind !== 'heading').label;
  assert.equal(labelOf('blank.md'), 'Fallback H1');
  assert.equal(labelOf('quoted.md'), 'padded');
  assertAttributable(chunk);
});

test('duplicate headings in one file do not collide', (t) => {
  // THE Obsidian trap, and the reason heading ids carry an ancestor chain and an
  // occurrence counter. 1,092 corpus files repeat a heading title; one
  // transcript repeats `#### input` 112 times. A duplicate id is a validator
  // ERROR, not a warning, so a collision would reject a 1,000-file chunk.
  const body = [
    '# Report',
    '',
    '## Summary',
    '',
    'First summary.',
    '',
    '## Part One',
    '',
    '### Summary',
    '',
    'Nested summary.',
    '',
    '## Part Two',
    '',
    '### Summary',
    '',
    'Nested summary again.',
    '',
    '## Summary',
    '',
    'Second top-level summary.',
  ].join('\n');
  const root = fixture(t, { 'dup.md': note(body) });
  const { chunk, report } = structural(root, ['dup.md']);

  const headings = chunk.nodes
    .filter((n) => n.node_kind === 'heading')
    .sort((a, b) => Number(a.source_location.slice(1)) - Number(b.source_location.slice(1)));
  assert.equal(headings.length, 7);
  assert.deepEqual(headings.map((h) => h.label), ['Report', 'Summary', 'Part One', 'Summary', 'Part Two', 'Summary', 'Summary']);
  // Four headings are titled `Summary`. They must be four distinct nodes.
  const summaries = headings.filter((h) => h.label === 'Summary');
  assert.equal(summaries.length, 4);
  assert.equal(new Set(summaries.map((h) => h.id)).size, 4, 'the four Summary headings share an id');

  // The two `### Summary` headings sit under different parents and so differ by
  // ancestry alone. The two `## Summary` headings share a parent AND a title, so
  // only the occurrence counter separates them — which is what
  // `headingIdCollisions` counts, and it must be 1 rather than 0 for this file.
  const idAt = (line) => headings.find((h) => h.source_location === line).id;
  assert.notEqual(idAt('L20'), idAt('L26'), 'same title under different parents must differ');
  assert.notEqual(idAt('L14'), idAt('L30'), 'sibling duplicates under one parent must differ');
  assert.equal(report.headingIdCollisions, 1, 'exactly one heading needed the occurrence counter');
  assertAttributable(chunk);
  // Seven headings, seven contains edges — one per heading, always. The count is
  // a tautology and therefore worth almost nothing on its own; the structure is
  // what matters, and it is asserted by label: the document holds `Report`, which
  // holds `Part One`, `Part Two` and the first `Summary`, and each Part holds its
  // own `Summary`.
  assert.equal(report.contains, 7);
  const doc = chunk.nodes.find((n) => n.node_kind === 'document');
  const labelOf = (id) => chunk.nodes.find((n) => n.id === id).label;
  const childrenOf = (id) => chunk.links
    .filter((l) => l.relation === 'contains' && l.source === id)
    .map((l) => labelOf(l.target))
    .sort();
  assert.deepEqual(childrenOf(doc.id), ['Report']);
  // Both top-level `## Summary` headings hang off `Report` — same parent, same
  // title, two distinct children. Reading the two Summaries under one parent as
  // a bug in the test is exactly the misreading this whole test exists to
  // prevent, which is why the structure is spelled out rather than counted.
  assert.deepEqual(childrenOf(idAt('L12')), ['Part One', 'Part Two', 'Summary', 'Summary']);
  assert.deepEqual(childrenOf(idAt('L18')), ['Summary']);
  assert.deepEqual(childrenOf(idAt('L24')), ['Summary']);
});

test('a heading id stays bounded even when a real heading title is enormous', (t) => {
  // Measured: the longest real heading title in the corpus is 1,817 characters,
  // a subtitle line that a transcript renderer promoted. Unbounded, that is a
  // 2,059-character node id in a JSON file that people diff.
  const long = 'A'.repeat(1817);
  const root = fixture(t, { 'long.md': note(`## ${long}\n`) });
  const { chunk } = structural(root, ['long.md']);
  const heading = chunk.nodes.find((n) => n.node_kind === 'heading');
  assert.ok(heading.id.length <= NODE_ID_MAX, `heading id is ${heading.id.length} chars, cap is ${NODE_ID_MAX}`);
  // The label keeps the full title: truncating the LABEL would lose information
  // a person reads, while the id only has to be unique.
  assert.equal(heading.label, long);
  assertAttributable(chunk);
});

test('two runs over the same input produce deep-equal output', (t) => {
  const root = fixture(t, {
    'a.md': note('# A\n\n## B\n\n### C\n\nLink to [[b]] and [[missing]].\n'),
    'nested/b.md': ['---', 'title: B', 'related: ["[[a]]"]', '---', '', '# B', '', '## B sub', ''].join('\n'),
  });
  const files = ['a.md', 'nested/b.md'];
  const first = structural(root, files);
  const second = structural(root, files);
  assert.deepEqual(second.chunk, first.chunk);
  assert.deepEqual(second.report, first.report);
  // And byte-identical, which is the property the merge's union depends on.
  assert.equal(JSON.stringify(second.chunk), JSON.stringify(first.chunk));
});

test('node and link order does not depend on the order files were listed', (t) => {
  // The merge unions on node id, so order only matters for the byte-identical
  // claim. Emitting in caller's file order would make two runs differ for a
  // reason no one can see.
  const root = fixture(t, {
    'z.md': note('# Z\n\n[[a]]\n'),
    'a.md': note('# A\n\n[[z]]\n'),
  });
  const forward = structural(root, ['a.md', 'z.md']);
  const reverse = structural(root, ['z.md', 'a.md']);
  assert.equal(JSON.stringify(reverse.chunk), JSON.stringify(forward.chunk));
  assert.deepEqual(reverse.report, forward.report);
});

test('an empty file list returns an empty chunk and a zeroed report, not a throw', () => {
  const { chunk, report } = structural('/nonexistent-root', []);
  assert.deepEqual(chunk, { nodes: [], links: [] });
  for (const key of ['files', 'nodes', 'contains', 'references', 'unresolvedTargets', 'noFrontmatter', 'noSourceFile', 'headings']) {
    assert.equal(report[key], 0, `report.${key} should be 0 on an empty run`);
  }
  assert.deepEqual(validateChunk(chunk).errors, []);
});

test('a file that is not an array argument throws, because that is a harness bug', () => {
  // The one throw. Extracted data is never thrown at; a wrong call shape is a
  // different class of problem and must not degrade into a zero-node report.
  assert.throws(() => structural('/tmp', 'not-an-array'), TypeError);
  assert.throws(() => structural('/tmp', [42]), TypeError);
});

test('an unreadable file is counted, not thrown, and does not stop the run', (t) => {
  // 2,360 files go through here. One file that vanished between enumeration and
  // read must not take the other 2,359 down with it, and must not be silently
  // absent from the report either.
  //
  // A directory standing in for a note, rather than a chmod-000 file: this suite
  // may run as a user for whom the mode bits are advisory, and a test that
  // silently stops testing anything when run as root is worse than no test. A
  // directory is unreadable as a file for every user, and `readFileSync` on one
  // raises EISDIR, which is the same code path a vanished file takes.
  const root = fixture(t, { 'good.md': note('# Good\n', { related: false }) });
  mkdirSync(path.join(root, 'locked.md'), { recursive: true });

  const { chunk, report } = structural(root, ['good.md', 'locked.md', 'missing.md']);
  assert.equal(report.files, 3);
  assert.equal(report.filesRead, 1);
  assert.equal(report.filesUnreadable, 2, 'both the unreadable and the missing file are counted');
  assert.deepEqual(chunk.nodes.filter((n) => n.node_kind !== 'heading').map((n) => n.source_file), ['good.md']);
  assertAttributable(chunk);
});

test('a file outside the root is refused rather than emitted with a traversing source_file', (t) => {
  const root = fixture(t, { 'inside.md': note('# Inside\n') });
  const outside = fixture(t, { 'secret.md': note('# Secret\n') });
  const { chunk, report } = structural(root, ['inside.md', path.join(outside, 'secret.md'), '../escape.md']);
  assert.equal(report.files, 3);
  assert.equal(report.filesOutsideRoot, 2, 'the outside path and the traversing path are both refused');
  assert.deepEqual([...new Set(chunk.nodes.map((n) => n.source_file))], ['inside.md']);
  assertAttributable(chunk);
});

test('an absolute path inside the root is made repo-relative, not emitted absolute', (t) => {
  // T2 hands over absolute paths from `find`. Emitting them verbatim would put
  // `/home/<user>/Dokumen/...` into 300,000 source_file values and
  // every one of them would fail the validator.
  const root = fixture(t, { '01 - Projects/Snipset/index.md': note('# S\n', { related: false }) });
  const abs = path.join(root, '01 - Projects/Snipset/index.md');
  const { chunk } = structural(root, [abs]);
  // Every node, heading included, not just the document: the document node
  // carrying a relative path while its heading sibling carries an absolute one
  // would be a worse bug than either being absolute throughout.
  assert.deepEqual([...new Set(chunk.nodes.map((n) => n.source_file))], ['01 - Projects/Snipset/index.md']);
  assertAttributable(chunk);
});

test('a source_path in the frontmatter is never used as a source_file', (t) => {
  // The measured frontmatter carries `source_path: /home/<user>/
  // Proyek/Snipset/...` — an ABSOLUTE path to a file outside the vault. It is
  // provenance metadata about where the note was published from. Using it would
  // produce exactly the 1,299 unverifiable nodes the rebuild exists to remove,
  // and would do it in a form that looks deliberate.
  const root = fixture(t, { 'plan.md': note('# Plan\n') });
  const { chunk } = structural(root, ['plan.md']);
  for (const n of chunk.nodes) {
    assert.notEqual(n.source_file, '/home/testuser/Proyek/Snipset/docs/code-plan/plans/....md');
    assert.ok(!n.source_file.includes('source_path'));
  }
  assertAttributable(chunk);
});

// ---------------------------------------------------------------------------
// structural — references
// ---------------------------------------------------------------------------

test('a link inside the related: frontmatter array IS captured', (t) => {
  // The contract calls this out separately from body links because the two come
  // from different code paths: `extractWikilinks` is body-only by design, so
  // frontmatter links are harvested by structural() from the parsed object.
  const root = fixture(t, {
    'plan.md': note('# Plan\n\nNo body link here.\n'),
    '01 - Projects/Snipset/index.md': ['---', 'title: Snipset', '---', '', '# Snipset', ''].join('\n'),
  });
  const { chunk, report } = structural(root, ['plan.md', '01 - Projects/Snipset/index.md']);
  const refs = chunk.links.filter((l) => l.relation === 'references');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].source_file, 'plan.md');
  assert.equal(report.references, 1);
  assertAttributable(chunk);
});

test('a link in a block-sequence related array IS captured too', (t) => {
  // 116 real files write `related:` as a block sequence rather than a flow array.
  // Supporting only the flow form would silently lose every one of them.
  const root = fixture(t, {
    'plan.md': ['---', 'title: P', 'related:', '  - "[[target]]"', '---', '', 'body', ''].join('\n'),
    'target.md': ['# T', ''].join('\n'),
  });
  const { chunk } = structural(root, ['plan.md', 'target.md']);
  assert.equal(chunk.links.filter((l) => l.relation === 'references').length, 1);
  assertAttributable(chunk);
});

test('a link resolved by full path is EXTRACTED, and one resolved by bare basename is INFERRED', (t) => {
  // The distinction is not cosmetic. 845 measured targets resolve by path and
  // 3,655 by basename, and a basename match is a guess that a future file
  // colliding on that stem could invalidate. Writing both as EXTRACTED overstates
  // 82% of the references in the graph.
  // Two separate sections, because both links point at the same node: with one
  // source line they would fold into a single edge and only one confidence
  // would survive to be asserted.
  const root = fixture(t, {
    'src.md': note('# S\n\n## By path\n\n[[deep/nested/hub]]\n\n## By stem\n\n[[hub]]\n', { related: false }),
    'deep/nested/hub.md': ['---', 'title: Hub', '---', '', '# Hub', ''].join('\n'),
  });
  const { chunk } = structural(root, ['src.md', 'deep/nested/hub.md']);
  const refs = chunk.links.filter((l) => l.relation === 'references');
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map((l) => l.confidence), ['EXTRACTED', 'INFERRED']);
  assert.equal(refs[0].target, 'deep_nested_hub');
  assert.equal(refs[1].target, 'deep_nested_hub');
  assertAttributable(chunk);
});

test('a link resolved by a frontmatter alias is EXTRACTED', (t) => {
  // 144 real notes declare `aliases:`, and 7 measured targets resolve only that
  // way. An alias is an authored name for the note, so a match on it is a
  // deliberate identity rather than a guess.
  const root = fixture(t, {
    'src.md': note('# S\n\n[[Snipset Hub]]\n'),
    'hub.md': ['---', 'title: Hub', 'aliases:', '  - Snipset Hub', '---', '', '# Hub', ''].join('\n'),
  });
  const { chunk } = structural(root, ['src.md', 'hub.md']);
  const [ref] = chunk.links.filter((l) => l.relation === 'references');
  assert.equal(ref.confidence, 'EXTRACTED');
  assertAttributable(chunk);
});

test('a link is attributed to the nearest enclosing heading', (t) => {
  // Free precision: the containing section is already known, so the edge can say
  // which section made the reference. Without this, every reference in a
  // 600-heading transcript attaches to the document and the section is lost.
  const root = fixture(t, {
    'src.md': note('# Doc\n\nintro [[a]]\n\n## Section\n\nbody [[b]]\n'),
    'a.md': ['# A', ''].join('\n'),
    'b.md': ['# B', ''].join('\n'),
  });
  const { chunk } = structural(root, ['src.md', 'a.md', 'b.md']);
  const labels = new Map(chunk.nodes.map((n) => [n.id, n.label]));
  const refs = chunk.links.filter((l) => l.relation === 'references');
  assert.equal(labels.get(refs[0].source), 'Doc');
  assert.equal(labels.get(refs[1].source), 'Section');
  assertAttributable(chunk);
});

test('repeated links from one source to one target collapse to one edge', (t) => {
  // The validator reports a repeated source/target/relation triple as an ERROR,
  // and a note that links the same note nine times is normal. The report says
  // how many were folded, so the drop is visible rather than silent.
  const root = fixture(t, {
    'src.md': note('# S\n\n[[t]] [[t|alias]] [[t]]\n'),
    't.md': ['# T', ''].join('\n'),
  });
  const { chunk, report } = structural(root, ['src.md', 't.md']);
  assert.equal(chunk.links.filter((l) => l.relation === 'references').length, 1);
  assert.equal(report.referencesFolded, 2);
  assertAttributable(chunk);
});

test('a self-link is emitted and counted, not silently dropped', (t) => {
  // A note that links to itself is a real (if odd) fact. Whether the graph wants
  // it is a merge-time policy; deciding it here and saying nothing is how a
  // relationship disappears without a trace.
  // The link sits under the H1, so the edge runs heading -> document rather than
  // being a self-LOOP. The counter reports the note pointing at ITSELF, which is
  // the fact a merge-time policy would want to act on; a literal self-loop is a
  // different (and rarer) shape, so both are asserted separately rather than
  // conflating them.
  const root = fixture(t, { 'self.md': note('# S\n\n[[self]]\n', { related: false }) });
  const { chunk, report } = structural(root, ['self.md']);
  assert.equal(report.selfReferences, 1);
  assert.equal(chunk.links.filter((l) => l.relation === 'references').length, 1);
  const doc = chunk.nodes.find((n) => n.node_kind === 'document');
  assert.equal(chunk.links.find((l) => l.relation === 'references').target, doc.id);
  assertAttributable(chunk);

  // And a note with no heading at all does produce a literal self-loop.
  const bare = fixture(t, { 'bare.md': ['---', 'title: Bare', '---', '', 'see [[bare]]', ''].join('\n') });
  const bareRun = structural(bare, ['bare.md']);
  assert.equal(bareRun.report.selfReferences, 1);
  assert.equal(bareRun.chunk.links.filter((l) => l.source === l.target).length, 1);
  assertAttributable(bareRun.chunk);
});

// ---------------------------------------------------------------------------
// unresolved wikilinks — the decision, pinned
// ---------------------------------------------------------------------------

test('an unresolved target is reported and emits no edge and no placeholder node', (t) => {
  // THE DECISION, and the reason it is a test rather than a comment.
  //
  // A `[[Foo]]` that matches no file cannot be given a node, because a node must
  // carry a `source_file` naming a real file beside the notes it describes, and
  // there is no such file for Foo. The three ways to emit one anyway all fail:
  //
  //   - Point the placeholder at the CITING file. The node then claims to be
  //     derived from a note that does not contain it, which is precisely the
  //     unverifiable-node defect (1,299 of them) this rebuild exists to remove.
  //     It would be reintroduced under a new name.
  //   - Point it at the vault root. One node for every unresolved target, all
  //     sharing a source_file, none meaning anything.
  //   - Invent a synthetic path. The validator would accept `virtual/foo.md` —
  //     it is repo-relative and has no `..` — and that is the trap: the check
  //     cannot tell a synthetic path from a real one, so the graph would grow
  //     documents that no one can open.
  //
  // And the measurement says the placeholders would not even be worth having.
  // Of 7,964 targets, 3,294 resolve to nothing, and inspection shows the residue
  // is largely bash `[[ ... ]]` test syntax pasted out of session transcripts
  // plus links to PNG attachments. Placeholder `document` nodes for those are
  // documents that never existed, pointing at files that are not notes.
  //
  // So: report, do not emit. The count is exact, a bounded sample names them,
  // and nothing claims a file that is not there.
  const root = fixture(t, {
    'src.md': note('# S\n\n[[nowhere]] [[also/nowhere]]\n', { related: false }),
  });
  const { chunk, report } = structural(root, ['src.md']);
  assert.equal(chunk.links.filter((l) => l.relation === 'references').length, 0);
  assert.equal(report.unresolvedTargets, 2);
  assert.deepEqual(report.unresolvedSample.map((u) => u.target).sort(), ['also/nowhere', 'nowhere']);
  // No node was invented for either target.
  assert.equal(chunk.nodes.filter((n) => n.label === 'nowhere' || n.label === 'also/nowhere').length, 0);
  assertAttributable(chunk);
});

test('the unresolved sample is bounded, and the count stays exact past the bound', (t) => {
  // A report that prints 3,294 lines is a report nobody reads to the end, at
  // which point only the count is looked at — which is the outcome the bound
  // exists to prevent. The COUNT is never sampled; only the evidence is.
  const many = Array.from({ length: 60 }, (_, i) => `[[missing-${i}]]`).join('\n');
  const root = fixture(t, { 'src.md': note(`# S\n\n${many}\n`, { related: false }) });
  const { report } = structural(root, ['src.md']);
  assert.equal(report.unresolvedTargets, 60);
  assert.ok(report.unresolvedSample.length <= 20, `sample is ${report.unresolvedSample.length} long`);
  assertAttributable(structural(root, ['src.md']).chunk);
});

test('a bash `[[ ... ]]` test is reported as unresolved, not resolved to a note', (t) => {
  // 129 measured corpus occurrences are shell conditional syntax sitting in
  // transcript prose. There is no note named `-d "/usr/lib/modules/${kver}"`,
  // and resolving one would be a coincidence, so the honest answer is the
  // unresolved bucket — where it is at least visible.
  const root = fixture(t, {
    'transcript.md': note('# T\n\n```bash\nif [[ -n "$kver" ]]; then\n```\n\nRun `[[ -d /usr/lib ]]` to check.\n', { related: false }),
    'decoy.md': ['# Decoy', ''].join('\n'),
  });
  const files = ['transcript.md', 'decoy.md'];
  const { chunk, report } = structural(root, files);
  assert.equal(chunk.links.filter((l) => l.relation === 'references').length, 0);
  assert.equal(report.unresolvedTargets, 1);
  assertAttributable(chunk);
});

test('an ambiguous basename is reported unresolved rather than guessed', (t) => {
  // 431 stems in the corpus map to more than one file, and 735 measured target
  // occurrences land on one. Choosing the first match by sort order would be a
  // fabricated edge that looks exactly like a real one to every consumer.
  const root = fixture(t, {
    'a/notes/hub.md': ['# A hub', ''].join('\n'),
    'b/notes/hub.md': ['# B hub', ''].join('\n'),
    'src.md': note('# S\n\n[[hub]]\n', { related: false }),
  });
  const { chunk, report } = structural(root, ['a/notes/hub.md', 'b/notes/hub.md', 'src.md']);
  assert.equal(chunk.links.filter((l) => l.relation === 'references').length, 0);
  assert.equal(report.unresolvedTargets, 1);
  assert.equal(report.ambiguousTargets, 1);
  assertAttributable(chunk);
});

test('a link to a note in another chunk resolves when the caller declares the corpus', (t) => {
  // The parallel-extraction problem vault-index-merge.mjs documents: a note in
  // batch B is not in batch A's file list, but the EDGE should still be emitted,
  // because the target's node id is computable from its path alone. Without the
  // declared corpus the target is unresolvable, and every cross-batch link in
  // the rebuild would land in the unresolved bucket — the wiki-link graph would
  // quietly lose its wiki links.
  const root = fixture(t, {
    'batch-a/note.md': note('# A\n\n[[01 - Projects/Snipset/index]]\n', { related: false }),
    'batch-b/index.md': ['---', 'title: Snipset', '---', '', '# Snipset', ''].join('\n'),
  });
  const { chunk, report } = structural(root, ['batch-a/note.md'], {
    knownPaths: ['01 - Projects/Snipset/index.md'],
  });
  const refs = chunk.links.filter((l) => l.relation === 'references');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, '01_projects_snipset_index');
  assert.equal(refs[0].confidence, 'EXTRACTED');
  assert.equal(report.unresolvedTargets, 0);
  assert.equal(report.crossChunkReferences, 1);
  // The target node is NOT emitted here — it belongs to batch B — so the chunk
  // validates without it only because endpoint resolution is the merge's job.
  assert.equal(chunk.nodes.some((n) => n.id === '01_projects_snipset_index'), false);
  assert.deepEqual(validateChunk(chunk).errors, []);
});

test('without a declared corpus a cross-batch target is unresolved', (t) => {
  // The honest default, and the reason the option above exists. Resolving to a
  // path the caller never mentioned would be inventing knowledge of the corpus.
  const root = fixture(t, { 'batch-a/note.md': note('# A\n\n[[somewhere/else]]\n', { related: false }) });
  const { report } = structural(root, ['batch-a/note.md']);
  assert.equal(report.unresolvedTargets, 1);
});

// ---------------------------------------------------------------------------
// collisions in the corpus
// ---------------------------------------------------------------------------

test('two files whose slugs collide both get nodes, and the collision is counted', (t) => {
  // Measured: `Quickstart.md` and `quickstart.md` sit in the same directory of
  // the real vault. A duplicate id is a validator error that rejects the entire
  // chunk, so one of these two notes would otherwise take the other down with
  // it — and picking a winner would drop a real note from the graph.
  const root = fixture(t, {
    '03 - Resources/LLM Wiki/sources/Quickstart.md': ['---', 'title: Upper', '---', '', '# Upper', ''].join('\n'),
    '03 - Resources/LLM Wiki/sources/quickstart.md': ['---', 'title: Lower', '---', '', '# Lower', ''].join('\n'),
  });
  const { chunk, report } = structural(root, [
    '03 - Resources/LLM Wiki/sources/Quickstart.md',
    '03 - Resources/LLM Wiki/sources/quickstart.md',
  ]);
  assert.equal(report.idCollisions, 1);
  const docs = chunk.nodes.filter((n) => n.node_kind !== 'heading');
  assert.equal(docs.length, 2, 'neither colliding note may be dropped');
  assert.equal(new Set(docs.map((n) => n.id)).size, 2);
  assert.deepEqual(docs.map((n) => n.label).sort(), ['Lower', 'Upper']);
  assertAttributable(chunk);
});

test('a slug collision between two files in DIFFERENT batches is still resolved', (t) => {
  // Found by a dry run over all 4,138 corpus files in batches of 150, not by a
  // test written first. The corpus has exactly one colliding pair —
  // `Quickstart.md` and `quickstart.md` — and a 150-file batch boundary split
  // them. Detecting collisions only within the batch gave both the same id, the
  // merge folded one record into the other, and 14 of the 15 lost records were
  // HEADINGS: one real note disappeared from the graph along with its whole
  // section tree, in a run whose every individual report said it succeeded.
  //
  // Worse, and this is the part that makes it a correctness bug rather than a
  // data-quality one: the outcome depended on where the batch boundary fell, so
  // two runs of the same corpus with different batch sizes produced different
  // graphs. That breaks the determinism this module exists to guarantee, in the
  // only way that is actually dangerous.
  const root = fixture(t, {
    'Quickstart.md': ['---', 'title: Upper', '---', '', '# Upper', '', '## Step One', '', 'text', ''].join('\n'),
    'quickstart.md': ['---', 'title: Lower', '---', '', '# Lower', '', '## Step One', '', 'text', ''].join('\n'),
  });
  const knownPaths = ['Quickstart.md', 'quickstart.md'];

  // Each file extracted alone, in its own call, as two separate batches would be.
  const upper = structural(root, ['Quickstart.md'], { knownPaths });
  const lower = structural(root, ['quickstart.md'], { knownPaths });

  const ids = [upper.chunk.nodes[0].id, lower.chunk.nodes[0].id];
  assert.notEqual(ids[0], ids[1], 'two batches must not emit the same document id');
  assert.equal(new Set([...upper.chunk.nodes, ...lower.chunk.nodes].map((n) => n.id)).size,
    upper.chunk.nodes.length + lower.chunk.nodes.length, 'no id is claimed by both batches');

  // Every heading survives too — 14 of the 15 records the dry run lost were
  // headings, so a fix that only disambiguated the document ids would still have
  // lost the section trees. Two headings per file here, four in total.
  const allNodes = [...upper.chunk.nodes, ...lower.chunk.nodes];
  assert.equal(allNodes.filter((n) => n.node_kind === 'heading').length, 4);
  assert.equal(new Set(allNodes.map((n) => n.id)).size, allNodes.length);

  // The same two files in ONE call produce byte-identical ids, so slicing the
  // corpus differently cannot change the graph.
  const together = structural(root, knownPaths, { knownPaths });
  assert.equal(together.chunk.nodes.find((n) => n.source_file === 'Quickstart.md').id, ids[0]);
  assert.equal(together.chunk.nodes.find((n) => n.source_file === 'quickstart.md').id, ids[1]);
  assertAttributable(upper.chunk);
  assertAttributable(lower.chunk);
});

test('a link to a slug-colliding note resolves to the same id the owning batch emits', (t) => {
  // The second half of the fix above, and the reason the id assignment is shared
  // between the emitter and the resolution index rather than computed twice. An
  // earlier version disambiguated the batch and then let the declared corpus fall
  // back to a raw `slugFor`, so a link to `quickstart` resolved to the
  // un-suffixed id while the batch owning it emitted the suffixed one — a
  // dangling endpoint manufactured by a collision fix. Measured on the real
  // corpus: 2 dangling endpoints, both of this shape.
  const root = fixture(t, {
    'Quickstart.md': ['---', 'title: Upper', '---', '', '# Upper', ''].join('\n'),
    'quickstart.md': ['---', 'title: Lower', '---', '', '# Lower', ''].join('\n'),
    'src.md': ['---', 'title: S', '---', '', 'see [[quickstart]]', ''].join('\n'),
  });
  const knownPaths = ['Quickstart.md', 'quickstart.md', 'src.md'];

  // The owning batch emits the target; a different batch emits the link.
  const owner = structural(root, ['quickstart.md'], { knownPaths });
  const linker = structural(root, ['src.md'], { knownPaths });

  const target = owner.chunk.nodes.find((n) => n.node_kind === 'document').id;
  const ref = linker.chunk.links.find((l) => l.relation === 'references');
  assert.notEqual(ref, undefined, 'the link must resolve');
  assert.equal(ref.target, target, 'the link points at the id the owner emits');

  // The union is what the merge will build, so this is the check that would have
  // caught the dangling endpoint.
  const union = new Set([...owner.chunk.nodes, ...linker.chunk.nodes].map((n) => n.id));
  const verdict = validateChunk(linker.chunk, { knownNodeIds: union });
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.stats.crossChunk, 1);
});

test('a cross-batch link resolved by BARE BASENAME is emitted, not reported unresolved', (t) => {
  // Found by the same dry run, and the largest single defect it caught. With a
  // per-batch stem index, a bare-basename link to a note in another batch could
  // not resolve: the full corpus measured 1,265 resolved references and 5,825
  // unresolved, against 3,422 and 3,619 once every declared path was visible.
  // 3,655 of the corpus's 7,964 targets resolve by basename, so the graph would
  // have kept roughly a third of the vault's wiki links and reported the rest as
  // unresolved — indistinguishable, downstream, from a corpus that had none.
  //
  // The confidence stays INFERRED even though the target is real: a stem match is
  // a guess, and the declared corpus does not make it less of one.
  const root = fixture(t, {
    'batch-a/src.md': [
      '---', 'title: S', '---', '',
      '## By path', '', '[[batch-b/notes]]', '',
      '## By stem', '', '[[notes]]', '',
    ].join('\n'),
    'batch-b/notes.md': ['---', 'title: Notes', '---', '', '# Notes', ''].join('\n'),
  });

  // Both tiers at once: the path form resolves EXTRACTED, the bare stem resolves
  // INFERRED, and neither is reported unresolved. They sit in different sections
  // so they are two edges rather than one folded edge — without the section split
  // they would share a source, a target and a relation, and the second would be
  // counted in `referencesFolded` instead.
  const { chunk, report } = structural(root, ['batch-a/src.md'], { knownPaths: ['batch-a/src.md', 'batch-b/notes.md'] });
  assert.equal(report.unresolvedTargets, 0);
  assert.equal(report.ambiguousTargets, 0);
  assert.equal(report.referencesFolded, 0);
  assert.equal(report.crossChunkReferences, 2);
  const refs = chunk.links.filter((l) => l.relation === 'references');
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map((l) => l.confidence).sort(), ['EXTRACTED', 'INFERRED']);
  assert.deepEqual(refs.map((l) => l.target), ['batch_b_notes', 'batch_b_notes']);
  // NOT assertAttributable, deliberately. That helper validates with this chunk's
  // own ids, and these two targets are in another batch by construction — the
  // whole point of the test. Supplying the owning batch's nodes resolves them,
  // which is what the merge will do.
  const union = new Set([...chunk.nodes.map((n) => n.id), 'batch_b_notes']);
  const verdict = validateChunk(chunk, { knownNodeIds: union });
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.stats.crossChunk, 2);
  for (const n of chunk.nodes) assert.ok(n.source_file.trim() !== '' && !n.source_file.startsWith('/') && !n.source_file.split('/').includes('..'));
});

test('the collision count is reported once per affected batch, not once per batch in the run', (t) => {
  // 28 batches each seeing a corpus-wide collision and each claiming it would
  // report 28 collisions for one. The count belongs to the files a call actually
  // read, because a collision it did not touch changes nothing it emitted.
  //
  // Both files in ONE directory, because that is the only way their slugs
  // collide: `a/Quickstart.md` and `b/quickstart.md` slug to different ids and
  // would test nothing.
  const root = fixture(t, {
    'src/Quickstart.md': ['# U', ''].join('\n'),
    'src/quickstart.md': ['# L', ''].join('\n'),
    'other/unrelated.md': ['# X', ''].join('\n'),
  });
  const knownPaths = ['src/Quickstart.md', 'src/quickstart.md', 'other/unrelated.md'];
  assert.equal(structural(root, ['src/Quickstart.md', 'src/quickstart.md'], { knownPaths }).report.idCollisions, 1);
  assert.equal(structural(root, ['other/unrelated.md'], { knownPaths }).report.idCollisions, 0);
  assert.equal(structural(root, ['src/Quickstart.md'], { knownPaths }).report.idCollisions, 1,
    'one member of a colliding pair is still a collision this call had to resolve around');
});

// ---------------------------------------------------------------------------
// the report and the round trip
// ---------------------------------------------------------------------------

test('the report carries every key the contract names', (t) => {
  const root = fixture(t, {
    'a.md': note('# A\n\n## Sub\n\n[[b]] [[ghost]]\n', { related: false }),
    'b.md': ['---', 'title: B', '---', '', '# B', ''].join('\n'),
    'plain.md': 'no frontmatter, no title, no heading\n',
  });
  const { report } = structural(root, ['a.md', 'b.md', 'plain.md']);
  for (const key of ['files', 'nodes', 'contains', 'references', 'unresolvedTargets', 'noFrontmatter', 'noSourceFile']) {
    assert.equal(typeof report[key], 'number', `report.${key} must be a number`);
  }
  assert.equal(report.files, 3);
  assert.equal(report.noFrontmatter, 1, 'plain.md has no frontmatter block');
  assert.equal(report.noSourceFile, 0, 'and this layer adds zero unattributable nodes — the whole point');
  assert.equal(report.unresolvedTargets, 1);
  // The counts in the report and the arrays in the chunk must agree, or one of
  // them is lying and nobody downstream can tell which.
  const { chunk } = structural(root, ['a.md', 'b.md', 'plain.md']);
  assert.equal(report.nodes, chunk.nodes.length);
  assert.equal(report.contains, chunk.links.filter((l) => l.relation === 'contains').length);
  assert.equal(report.references, chunk.links.filter((l) => l.relation === 'references').length);
});

test('this layer emits only the contains and references relations', (t) => {
  // Concepts and rationale are a different task. Emitting them here would put
  // unvalidated, unattributed nodes into a layer whose entire justification is
  // that every node it emits is checkable.
  const root = fixture(t, {
    'a.md': note('# A\n\n## Sub\n\n[[b]]\n'),
    'b.md': ['# B', ''].join('\n'),
  });
  const { chunk } = structural(root, ['a.md', 'b.md']);
  assert.deepEqual([...new Set(relations(chunk))].sort(), ['contains', 'references']);
  assert.equal(chunk.nodes.every((n) => n.file_type === 'document'), true);
});

test('a full multi-file chunk round-trips through validateChunk with zero errors', async (t) => {
  // The round-trip guarantee. Everything above asserts a property of one
  // extractor call; this asserts the shape the merge will actually accept, with
  // endpoint resolution supplied, which is the only way a dangling edge can be
  // caught before it reaches graph.json.
  const root = fixture(t, {
    '01 - Projects/Snipset/index.md': note('# Snipset\n\n## Goal\n\nSee [[01 - Projects/Snipset/plans/plan]] and [[ghost]].\n'),
    '01 - Projects/Snipset/plans/plan.md': ['---', 'title: Plan', 'related: ["[[01 - Projects/Snipset/index]]"]', '---', '', '# Plan', '', '## Step', '', '## Step', ''].join('\n'),
    '05 - Conversations/t.md': ['# T', '', '```', '[[not a link]]', '```', '', '## Summary', '', '### Summary', ''].join('\n'),
  });
  const { chunk } = structural(root, [
    '01 - Projects/Snipset/index.md',
    '01 - Projects/Snipset/plans/plan.md',
    '05 - Conversations/t.md',
  ]);
  const verdict = validateChunk(chunk, { knownNodeIds: ids(chunk) });
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.stats.dangling, 0);
  assert.equal(verdict.stats.byRelation.contains > 0, true);
  // Three references, and all three are deliberate: index.md's own `related`
  // points at itself, plan.md's `related` points back at index.md, and index.md's
  // body points at plan.md. `[[ghost]]` in index.md's body is the fourth target
  // and contributes no edge, which is the unresolved decision this chunk exists to
  // demonstrate inside a chunk that is otherwise entirely ordinary.
  assert.equal(verdict.stats.byRelation.references, 3, 'the two frontmatter links and the one body link');
  assert.deepEqual(verdict.stats.byFileType, { document: verdict.stats.nodes });

  // And it survives being handed to the merge unchanged, which is the actual
  // downstream consumer. `crossChunkDangling` must be 0: a structural layer that
  // emits edges into the void is the failure the merge's whole header is about.
  const { merge } = await import('./vault-index-merge.mjs');
  const { graph, report } = merge([{ name: 'c7', chunk }], { builtAtCommit: 'test' });
  assert.equal(report.chunksRejected, 0);
  assert.equal(report.crossChunkDangling, 0);
  assert.equal(graph.links.length, chunk.links.length);
  assert.equal(graph.nodes.length, chunk.nodes.length);
});

// ---------------------------------------------------------------------------
// structural — the scaffolding filter
// ---------------------------------------------------------------------------
//
// THE FIFTH CORPUS FACT, and the one that decides whether this layer is usable
// at all. Measured over the whole vault on 2026-10-02: 317,050 ATX headings, of
// which 294,486 — 92.9% — are session-transcript scaffolding. The most repeated
// titles in the corpus are `output` (59,410), `input` (59,385), `reasoning`
// (33,365), `tool · shell` (30,802), `assistant text` (15,002) and so on;
// 294,437 of the 294,486, or 99.98%, sit inside `05 - Conversations/`, which is a
// directory of RENDERED session transcripts whose heading hierarchy belongs to
// the renderer rather than to the writer. Every tool call gets an `#### input`
// and an `#### output`.
//
// A graph holding 59,385 nodes labelled `input` has no communities, no betweenness
// signal and no path worth following, and it re-creates the exact fragmentation
// this rebuild exists to fix. So a heading whose title is a tool-call marker
// emits no node and no `contains` edge, and the count lands in
// `report.scaffoldingSkipped` rather than vanishing.
//
// The tests below pin the three things a filter like this usually gets wrong:
// that it does not orphan the real sections nested under what it removed, that it
// does not change the id of anything it keeps — T9 merges by id, so a moved id
// is a lost node — and that it does not eat real headings whose titles merely
// start with the same letters.

/** Titles the renderer actually produces, measured over the corpus 2026-10-02. */
const MEASURED_SCAFFOLDING = [
  'output', 'input', 'reasoning', 'tool · shell', 'assistant text', 'tool · read',
  'tool · edit', 'event data', 'tool · grep', 'idle', 'prompt', 'tool · execute',
  'tool · write', 'synthetic', '[seq 4] user', 'tool · subagent',
];

/** Real headings present in the corpus that a looser rule would have eaten. */
const REAL_HEADINGS_THAT_MUST_SURVIVE = [
  'related', 'description', 'text', 'documentation', 'example',
  'output format', 'output formats', 'user input', 'input modalities',
  'reasoning lenses', 'prompt-based hooks', 'system message', 'user management',
  'event details', 'session checkpoint', 'tools', 'Tooling', 'editor toolbar',
];

test('#### input and #### output produce no node, and no contains edge', (t) => {
  // The largest pair in the corpus: 59,385 + 59,410 = 118,795 headings between
  // them. One node each is 37% of the entire graph.
  const root = fixture(t, {
    't.md': note([
      '# Session',
      '',
      '## Setup',
      '',
      '#### input',
      '',
      '```json',
      '{"cmd":"ls"}',
      '```',
      '',
      '#### output',
      '',
      '```text',
      'a.md  b.md',
      '```',
      '',
      '## Findings',
    ].join('\n'), { related: false }),
  });
  const { chunk, report } = structural(root, ['t.md']);
  const labels = chunk.nodes.map((n) => n.label);
  assert.equal(labels.includes('input'), false, '`input` must not become a node');
  assert.equal(labels.includes('output'), false, '`output` must not become a node');
  // Not merely relabelled: no surviving node carries either id.
  assert.equal(chunk.nodes.some((n) => /__(input|output)$/.test(n.id)), false);
  // And the sections around them are untouched, which is the part a naive filter
  // gets wrong — dropping the node must not drop the note's real outline.
  assert.deepEqual(
    chunk.nodes.filter((n) => n.node_kind === 'heading').map((n) => n.label).sort(),
    ['Findings', 'Session', 'Setup'],
  );
  assert.equal(report.scaffoldingSkipped, 2);
  assert.equal(report.headings, 3, 'three surviving headings, not five');
  assertAttributable(chunk);
});

test('### tool · shell produces no node, and neither does any other tool marker', (t) => {
  // 59,387 measured corpus headings start with `tool` followed by a separator.
  // The separator is the point: `tools` and `Tooling` are real headings and the
  // corpus contains four occurrences of the first.
  const root = fixture(t, {
    't.md': note([
      '# Session',
      '',
      '## Turn one',
      '',
      '### tool · shell',
      '',
      '### tool · read',
      '',
      '### tool · edit',
      '',
      '### tool · grep',
      '',
      '### tool · execute',
      '',
      '### tool · write',
      '',
      '### tool · subagent',
      '',
      '### tool · glob',
      '',
      '## Turn two',
    ].join('\n'), { related: false }),
  });
  const { chunk, report } = structural(root, ['t.md']);
  const labels = chunk.nodes.map((n) => n.label);
  for (const tool of ['shell', 'read', 'edit', 'grep', 'execute', 'write', 'subagent', 'glob']) {
    assert.equal(labels.includes(`tool · ${tool}`), false, `tool · ${tool} must not become a node`);
  }
  assert.deepEqual(
    chunk.nodes.filter((n) => n.node_kind === 'heading').map((n) => n.label).sort(),
    ['Session', 'Turn one', 'Turn two'],
  );
  assert.equal(report.scaffoldingSkipped, 8);
  assertAttributable(chunk);
});

test('a real heading whose title merely STARTS with a marker word is not filtered', (t) => {
  // The false-positive guard, anchored rather than substring for a measured
  // reason. Every title below occurs in the real vault, and a prefix or substring
  // rule on the bare word would delete it:
  //
  //   `output format` (measured) vs `output`           — a prefix rule loses this
  //   `user input` (42 measured) vs `user`             — likewise
  //   `reasoning lenses` (5), `prompt-based hooks` (4)
  //   `event details`, `system message`, `user management`, `session checkpoint`
  //   `tools` (4) vs `tool · shell`                    — needs the separator
  //
  // `editor toolbar` is here because it CONTAINS the substring `tool`, and it is
  // the clearest single argument against substring matching anywhere in a title.
  const body = [
    '# Guide',
    '',
    '## related',
    '',
    '## description',
    '',
    '## text',
    '',
    '## documentation',
    '',
    '## example',
    '',
    '## output format',
    '',
    '## user input',
    '',
    '## reasoning lenses',
    '',
    '## prompt-based hooks',
    '',
    '## event details',
    '',
    '## system message',
    '',
    '## tools',
    '',
    '## Tooling',
    '',
    '## editor toolbar',
  ].join('\n');
  const root = fixture(t, { 'guide.md': note(body, { related: false }) });
  const { chunk, report } = structural(root, ['guide.md']);
  // Sorted, because `chunk.nodes` is sorted by ID — a heading's id encodes its
  // ancestry, not its position — so document order is not recoverable from the
  // array and asserting it here would be asserting a coincidence.
  assert.deepEqual(
    chunk.nodes.filter((n) => n.node_kind === 'heading').map((n) => n.label).sort(),
    [
      'Guide', 'description', 'documentation', 'editor toolbar', 'event details',
      'example', 'output format', 'prompt-based hooks', 'reasoning lenses',
      'related', 'system message', 'text', 'Tooling', 'tools', 'user input',
    ].sort(),
  );
  assert.equal(report.scaffoldingSkipped, 0, 'a real note must skip nothing');
  assertAttributable(chunk);
});

test('`## Output` in a non-transcript note IS filtered, and the corpus says that is the right trade', (t) => {
  // THE AMBIGUITY, decided rather than dodged. `## Output` in a note documenting a
  // CLI and `## Output` in a rendered transcript are the same string, and there is
  // nothing in the title to tell them apart. So the question is which error to
  // accept, and the corpus answers it with measured numbers:
  //
  //   COST OF FILTERING IT: 26 real headings corpus-wide — the 26 `## Output`
  //     headings living OUTSIDE `05 - Conversations/`. That is the entire measured
  //     false-positive budget of the whole exact-title set, and it buys the
  //     removal of 294,437 scaffolding headings. Roughly six thousand headings
  //     removed per false positive.
  //   COST OF EXEMPTING IT: the exemption must be keyed on something OTHER than
  //     the title, because the title is exhausted. Every available key is worse
  //     than the 26 it saves:
  //       - the path (`05 - Conversations/`) is the mechanism this task rejects,
  //         and it is wrong on its own terms too: a transcript pasted anywhere, or
  //         a genuine note that happens to live in that folder, breaks it;
  //       - heading depth is not a discriminator — the matched scaffolding sits at
  //         h2 56,742, h3 114,659, h4 123,085, which are the depths real notes
  //         use;
  //       - an occurrence-count heuristic (filter only the second `## Output` in a
  //         file) lets the scaffolding back into every short excerpt, which is
  //         precisely the fragmentation being removed, and makes "is this heading
  //         scaffolding?" unanswerable from the heading alone.
  //
  // The loss is bounded and recoverable: one node is dropped, its text is still on
  // disk, the document node is unaffected, and the drop is counted in
  // `report.scaffoldingSkipped` — 26 in total, against 294,437 kept out.
  const root = fixture(t, {
    'cli.md': note([
      '# some-tool',
      '',
      '## Usage',
      '',
      '## Output',
      '',
      'Prints one line per file.',
      '',
      '## Exit codes',
    ].join('\n'), { related: false }),
  });
  const { chunk, report } = structural(root, ['cli.md']);
  const labels = chunk.nodes.map((n) => n.label);
  assert.equal(labels.includes('Output'), false, 'the documented decision: it is filtered');
  assert.deepEqual(
    chunk.nodes.filter((n) => n.node_kind === 'heading').map((n) => n.label).sort(),
    ['Exit codes', 'Usage', 'some-tool'],
    'the other three sections all survive, so the note keeps a usable outline',
  );
  assert.equal(report.scaffoldingSkipped, 1);
  // The document node is untouched, so the note is still in the graph and still
  // findable by name.
  const doc = chunk.nodes.find((n) => n.node_kind === 'document');
  assert.equal(doc.source_file, 'cli.md');
  assertAttributable(chunk);
});

test('a document label can still come from a heading the filter removed', (t) => {
  // `documentLabel` reads the RAW heading list, not the emitted one, and that is
  // deliberate: the filter drops a NODE, it does not rename the note. Measured on
  // the corpus this costs nothing in practice — zero matched headings are at
  // level 1, so no document label changes — but the decoupling is the difference
  // between "this heading is not a section" and "this note has no name".
  const root = fixture(t, { 'a.md': ['# output', '', 'body', ''].join('\n') });
  const { chunk, report } = structural(root, ['a.md']);
  const doc = chunk.nodes.find((n) => n.node_kind === 'document');
  assert.equal(doc.label, 'output', 'the H1 still names the document');
  assert.equal(chunk.nodes.filter((n) => n.node_kind === 'heading').length, 0);
  assert.equal(report.scaffoldingSkipped, 1);
  assertAttributable(chunk);
});

test('a surviving section under a filtered heading is emitted AND reachable', (t) => {
  // THE ORPHANING QUESTION. The answer is: promote to the nearest surviving
  // ancestor, with the filtered heading's own id still occupying its slot in the
  // descendant's id chain. Both halves are load-bearing — see the module header
  // for why the id half is what protects T9.
  //
  // The shape is measured, not invented: 2,794 corpus headings have a filtered
  // parent slot, and in 2,636 of them the level below is filtered too, so the
  // promotion has to walk a CHAIN rather than step once.
  const root = fixture(t, {
    't.md': note([
      '# Session',
      '',
      '## Findings',
      '',
      '### tool · shell',
      '',
      '#### input',
      '',
      '#### output',
      '',
      '##### Real Section',
      '',
      'The one part of this transcript a person wrote.',
      '',
      '### reasoning',
      '',
      '#### prompt',
      '',
      '##### Second Real Section',
    ].join('\n'), { related: false }),
  });
  const { chunk, report } = structural(root, ['t.md']);

  const headings = chunk.nodes
    .filter((n) => n.node_kind === 'heading')
    .sort((a, b) => Number(a.source_location.slice(1)) - Number(b.source_location.slice(1)));
  assert.deepEqual(
    headings.map((h) => h.label),
    ['Session', 'Findings', 'Real Section', 'Second Real Section'],
    'the two real sections survive and nothing else at that depth does',
  );
  assert.equal(report.scaffoldingSkipped, 5, 'tool · shell, input, output, reasoning, prompt');

  // Reachability, asserted by walking the `contains` edges from the document
  // rather than by checking that a node exists. A promoted node that is present
  // but unreachable is still an orphan, and it is the failure this test exists to
  // catch: invisible to a node-count assertion, and invisible to
  // `assertAttributable`, which only proves every endpoint is IN the chunk.
  const byId = new Map(chunk.nodes.map((n) => [n.id, n.label]));
  const childrenOf = (id) => chunk.links
    .filter((l) => l.relation === 'contains' && l.source === id)
    .map((l) => byId.get(l.target))
    .sort();
  const doc = chunk.nodes.find((n) => n.node_kind === 'document');
  const session = headings.find((h) => h.label === 'Session');
  const findings = headings.find((h) => h.label === 'Findings');
  assert.deepEqual(childrenOf(doc.id), ['Session'], 'the document holds only the H1');
  assert.deepEqual(childrenOf(session.id), ['Findings']);
  assert.deepEqual(
    childrenOf(findings.id),
    ['Real Section', 'Second Real Section'],
    'both sections are promoted to the nearest SURVIVING ancestor — `## Findings`',
  );

  // And the promotion is transitive: document -> Session -> Findings -> section.
  const reach = new Set([doc.id]);
  for (let pass = 0; pass < chunk.nodes.length; pass++) {
    for (const l of chunk.links) {
      if (l.relation === 'contains' && reach.has(l.source)) reach.add(l.target);
    }
  }
  for (const h of headings) assert.ok(reach.has(h.id), `${h.label} is unreachable from the document`);
  assertAttributable(chunk);
});

test('the skipped-scaffolding counter is exact, and emitted + skipped is every heading found', (t) => {
  // Exact, never sampled — the same rule as `unresolvedTargets`, and for the same
  // reason: the count is what a caller compares against the corpus, and a sampled
  // count is not comparable to anything.
  const transcriptBody = [
    '# Session',
    '',
    '## Turn',
    '',
    '#### input',
    '',
    '#### output',
    '',
    '### tool · shell',
    '',
    '#### [seq 4] user',
    '',
    '#### reasoning',
    '',
    '#### event data',
    '',
    '#### idle',
    '',
    '#### synthetic',
    '',
    '#### assistant text',
    '',
    '#### session-event',
    '',
    '#### system',
    '',
    '#### prompt',
    '',
    '#### [prose fenced] whatever',
    '',
    '#### user',
  ].join('\n');
  const root = fixture(t, {
    'a.md': note(transcriptBody, { related: false }),
    'b.md': note('# Clean note\n\n## related\n\n## description\n', { related: false }),
  });
  const { chunk, report } = structural(root, ['a.md', 'b.md']);

  // 14 scaffolding in a.md: input, output, tool · shell, [seq 4] user, reasoning,
  // event data, idle, synthetic, assistant text, session-event, system, prompt,
  // [prose fenced] whatever, user.
  assert.equal(report.scaffoldingSkipped, 14);
  assert.equal(report.headings, 5, 'Session, Turn, Clean note, related, description');
  // The invariant that makes the counter checkable: emitted plus skipped is every
  // heading the parser found, with nothing unaccounted for.
  const found = extractHeadings(note(transcriptBody, { related: false })).length
    + extractHeadings(note('# Clean note\n\n## related\n\n## description\n', { related: false })).length;
  assert.equal(report.headings + report.scaffoldingSkipped, found);
  assert.equal(report.nodes, chunk.nodes.length);
  assertAttributable(chunk);
});

test('a filtered heading still reserves its id, so the headings that survive keep theirs', (t) => {
  // THE ID CONTRACT. T9 unions chunks by node id, so an id that MOVES is a node
  // silently dropped and re-created elsewhere. Three things therefore have to
  // hold, and this is where they are pinned:
  //
  //   1. A filtered heading's id is still computed and still occupies its slot in
  //      the ancestor chain of its descendants. Drop the slot and every id below
  //      it changes.
  //   2. A filtered heading still consumes its occurrence counter, so two
  //      identical `#### input` siblings cannot let a later heading reuse the
  //      first one's id.
  //   3. `headingIdCollisions` therefore does not move, because it counts ids
  //      ASSIGNED rather than nodes EMITTED.
  const root = fixture(t, {
    't.md': note([
      '# Session',
      '',
      '## Setup',
      '',
      '#### input',
      '',
      '#### input',
      '',
      '## Findings',
    ].join('\n'), { related: false }),
  });
  const { chunk, report } = structural(root, ['t.md']);
  const setup = chunk.nodes.find((n) => n.label === 'Setup');
  const findings = chunk.nodes.find((n) => n.label === 'Findings');
  // The second `#### input` needed the occurrence counter before the filter ran,
  // so the counter is still spent and still reported.
  assert.equal(report.headingIdCollisions, 1);
  // `## Findings` follows the two filtered siblings and is unaffected by them: its
  // id is its own ancestry, and two removed siblings do not appear in it.
  assert.equal(findings.id, 't_t_session_findings');
  assert.equal(chunk.nodes.filter((n) => n.label === 'input').length, 0);
  assert.notEqual(setup.id, findings.id);
  assertAttributable(chunk);
});

test('ids of surviving headings are byte-identical to the pre-filter module', (t) => {
  // Recorded on 2026-10-02 by running this fixture through the module BEFORE the
  // filter existed, then pasted here verbatim. This is the strongest form of the
  // claim: not "the ids have the same shape" but "these exact strings, which a
  // previous version emitted, are what this version emits".
  //
  // The fixture is shaped to make the id mechanism visible. A heading's id embeds
  // its ancestors' IDS — not merely their slugs — so `Deep Real`, nested under a
  // filtered `#### input`, has that input's WOULD-BE id baked into its own. An
  // implementation that dropped the filtered heading from the chain would produce
  // a different, shorter string here and this test would fail on the hash.
  const root = fixture(t, {
    '05 - Conversations/p.md': [
      '---', 'title: Session transcript', '---', '',
      '# Session', '',
      '## Setup', '',
      '#### input', '',
      '##### Deep Real', '',
      '## Findings', '',
      '## Wrap up', '',
    ].join('\n'),
  });
  const { chunk } = structural(root, ['05 - Conversations/p.md']);

  // Recorded from the unfiltered module.
  const RECORDED = [
    '05_conversations_p',
    '05_conversations_p_session',
    '05_conversations_p_05_conversations_p_session_setup',
    '05_conversations_p_05_conversations_p_session_setup__input',
    '05_conversations_p_05_conversations_p_session_05_conversations_p_05_conversations_p_session_setup__05_conversations_p_05_conversations_p_session_05_conversations_p_05_conversations_p_session__d1c33fe1',
    '05_conversations_p_05_conversations_p_session_findings',
    '05_conversations_p_05_conversations_p_session_wrap_up',
  ];
  const REMOVED = RECORDED[3];
  const emitted = chunk.nodes.map((n) => n.id).sort();

  assert.equal(emitted.includes(REMOVED), false, 'the `#### input` node is gone');
  assert.deepEqual(
    emitted,
    RECORDED.filter((id) => id !== REMOVED).sort(),
    'every other id is byte-identical to what the pre-filter module emitted',
  );
  // Spelled out individually too, because one deep-equal over sorted arrays
  // reports "arrays differ" and not WHICH id moved — and which id moved is the
  // entire content of the claim.
  const deepReal = chunk.nodes.find((n) => n.label === 'Deep Real');
  assert.equal(deepReal.id, RECORDED[4], 'the descendant of a filtered heading keeps its exact id');
  assert.equal(deepReal.id.length, NODE_ID_MAX, 'and it is still the bounded form the pre-filter module produced');
  // Promoted to the nearest surviving ancestor: `## Setup` at level 2, past the
  // filtered level 4 and past the level-3 slot the writer never filled.
  assert.equal(
    chunk.links.find((l) => l.relation === 'contains' && l.target === deepReal.id).source,
    chunk.nodes.find((n) => n.label === 'Setup').id,
  );
  assertAttributable(chunk);
});

test('a reference under a filtered heading attaches to the nearest SURVIVING heading', (t) => {
  // The failure this guards against is not a wrong label, it is a DANGLING
  // ENDPOINT. The attribution helper maps a line to the nearest preceding heading,
  // and if that heading was filtered the map has no entry for it — so an
  // implementation that filters the node but not the lookup emits a `references`
  // edge whose source is `undefined`. `assertAttributable` catches it, and so does
  // the merge's `crossChunkDangling` counter, but only if somebody runs the chunk.
  const root = fixture(t, {
    'src.md': note([
      '# Doc',
      '',
      '## Section',
      '',
      '#### input',
      '',
      'This is the part that matters. See [[target]].',
      '',
      '## After',
    ].join('\n'), { related: false }),
    'target.md': ['# Target', ''].join('\n'),
  });
  const { chunk, report } = structural(root, ['src.md', 'target.md']);
  const labels = new Map(chunk.nodes.map((n) => [n.id, n.label]));
  const refs = chunk.links.filter((l) => l.relation === 'references');
  assert.equal(refs.length, 1);
  assert.equal(labels.get(refs[0].source), 'Section', 'attributed past the filtered heading, not to it');
  // The literal failure: an edge whose source is not a node in this chunk.
  for (const l of chunk.links) {
    assert.ok(labels.has(l.source), `edge source ${l.source} is not a node in this chunk`);
  }
  assert.equal(report.scaffoldingSkipped, 1);
  assertAttributable(chunk);
});

test('filtering does not change determinism, and the filtered chunk still merges', async (t) => {
  // Two runs byte-identical with a filter in the path, plus file-order
  // independence, which is the other half: a filter keyed on a per-document
  // heading stack is per-file state and cannot see the batch. A non-deterministic
  // filter would produce a different graph on every re-run, which is the failure
  // the whole module header is written against.
  const root = fixture(t, {
    '05 - Conversations/t.md': note([
      '# Session', '', '## Turn', '', '#### input', '', '#### output', '',
      '### tool · shell', '', '#### reasoning', '', '## Real', '', '### Real Two',
    ].join('\n'), { related: false }),
    'hub.md': ['---', 'title: Hub', '---', '', '# Hub', ''].join('\n'),
  });
  const files = ['05 - Conversations/t.md', 'hub.md'];
  const first = structural(root, files);
  const second = structural(root, files);
  assert.equal(JSON.stringify(second.chunk), JSON.stringify(first.chunk));
  assert.deepEqual(second.report, first.report);
  const reverse = structural(root, files.slice().reverse());
  assert.equal(JSON.stringify(reverse.chunk), JSON.stringify(first.chunk));
  assert.deepEqual(reverse.report, first.report);
  assert.equal(first.report.scaffoldingSkipped, 4);

  const { merge } = await import('./vault-index-merge.mjs');
  const { report } = merge([{ name: 'c7', chunk: first.chunk }], { builtAtCommit: 'test' });
  assert.equal(report.chunksRejected, 0);
  assert.equal(report.crossChunkDangling, 0);
});

test('isScaffoldingHeading matches every measured transcript title and no real heading', () => {
  for (const title of MEASURED_SCAFFOLDING) {
    assert.equal(isScaffoldingHeading(title), true, `${JSON.stringify(title)} should be scaffolding`);
  }
  // Case-insensitively: a renderer that capitalises is the same renderer.
  for (const title of ['Input', 'OUTPUT', 'Tool · Shell', 'Reasoning', '[SEQ 4] User']) {
    assert.equal(isScaffoldingHeading(title), true, `${JSON.stringify(title)} should be scaffolding`);
  }
  // Anchoring, not containment. Each title below is a real heading measured in the
  // corpus, and every one of them CONTAINS a marker word.
  for (const title of REAL_HEADINGS_THAT_MUST_SURVIVE) {
    assert.equal(isScaffoldingHeading(title), false, `${JSON.stringify(title)} is a real heading`);
  }
  // Defensive, and they matter: a non-string and an empty title must be ANSWERED
  // rather than thrown on, because this runs on parser output inside a loop over
  // 317,050 headings and a throw would take the whole batch down.
  for (const bad of [null, undefined, 42, {}, [], '', '   ']) {
    assert.equal(isScaffoldingHeading(bad), false, `${JSON.stringify(bad)} is not a heading`);
  }
  // Pure: the answer does not depend on call order or on prior calls.
  const first = MEASURED_SCAFFOLDING.map((t) => isScaffoldingHeading(t));
  MEASURED_SCAFFOLDING.map(() => isScaffoldingHeading('some unrelated title'));
  assert.deepEqual(MEASURED_SCAFFOLDING.map((t) => isScaffoldingHeading(t)), first);
});

test('the matched set is exported, frozen, and covers the whole measured marker list', () => {
  // Part of the API, not an implementation detail. A caller that disagrees with a
  // decision needs to read WHICH decisions were made, and the number it compares
  // against its own corpus has to be the number the code used.
  assert.equal(Object.isFrozen(SCAFFOLDING_HEADING_TITLES), true);
  assert.equal(Object.isFrozen(SCAFFOLDING_HEADING_PREFIXES), true);
  for (const required of [
    'input', 'output', 'reasoning', 'assistant text', 'prompt', 'user', 'system',
    'session-event', 'event data', 'idle', 'synthetic',
  ]) {
    assert.ok(SCAFFOLDING_HEADING_TITLES.includes(required), `the exact set must contain ${required}`);
  }
  // Lowercase, because the predicate lowercases before looking. A set holding
  // `Output` tested against `output` would never match, and the counter would
  // read zero while the constant looked perfectly right.
  for (const t of SCAFFOLDING_HEADING_TITLES) {
    assert.equal(t, t.toLowerCase(), `${t} must be stored lowercase`);
    assert.equal(t.trim(), t, `${t} must be stored trimmed`);
  }
  // The prefix half, asserted through the predicate rather than through the regex
  // source: what matters is the behaviour, and a source-text assertion would pass
  // on a pattern that no longer means the same thing.
  for (const p of SCAFFOLDING_HEADING_PREFIXES) {
    assert.equal(p instanceof RegExp, true, 'prefixes are RegExps');
    assert.equal(p.global, false, 'a /g prefix regexp carries lastIndex between calls and would become order-dependent');
  }
  assert.equal(isScaffoldingHeading('tool · shell'), true);
  assert.equal(isScaffoldingHeading('tool: grep'), true);
  assert.equal(isScaffoldingHeading('tool - read'), true);
  assert.equal(isScaffoldingHeading('[seq 12] assistant'), true);
  assert.equal(isScaffoldingHeading('[prose fenced] note'), true);
  assert.equal(isScaffoldingHeading('tools'), false, 'the separator is what distinguishes them');
  assert.equal(isScaffoldingHeading('tooling'), false);
  // A title that merely ENDS with a marker word is not scaffolding either.
  assert.equal(isScaffoldingHeading('the output of the command'), false);
  assert.equal(isScaffoldingHeading('Handling user input'), false);
});

test('the report carries the skipped counter at zero on an empty run', () => {
  // A key that only appears once something has been skipped is a key that reads
  // `undefined` in a summary, and `undefined` is not a number anybody can add up
  // across 28 batches.
  const { report } = structural('/nonexistent-root', []);
  assert.equal(report.scaffoldingSkipped, 0);
  for (const k of ['files', 'nodes', 'headings', 'scaffoldingSkipped', 'contains', 'references']) {
    assert.equal(typeof report[k], 'number', `report.${k} must be a number`);
  }
});
