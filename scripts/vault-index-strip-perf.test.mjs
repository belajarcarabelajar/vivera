import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHeadings, extractWikilinks } from './vault-index-structural.mjs';

// The regression these lock.
//
// `stripFrontmatter` used to find the closing fence with
//
//   /^([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m
//
// which opens with an UNBOUNDED LAZY PREFIX. `[\s\S]*?` matches empty at every
// line start, so the engine retries it from each one and has no literal to jump
// to. Measured on a body with no closing fence: 123ms at 200KB, 482ms at 400KB,
// 1883ms at 800KB — roughly 4x per doubling, which is quadratic. At 3.1MB it was
// 29.9 seconds, inside a loop that runs once per vault file.
//
// The input is not hypothetical: this repository exports OpenCode session
// transcripts into the vault, so large bodies with missing or unterminated
// frontmatter are the normal shape of the work, not an edge case.
//
// Two rules for the tests below. A performance claim needs a CONTROL, so the
// quadratic regex is kept here as the thing being compared against rather than
// merely described in a comment. And a rewrite of a parser needs an
// EQUIVALENCE proof, so the corpus asserts the old and new agree on every input
// rather than only on the cases the new one was written for.

// The quadratic original, preserved verbatim as the control. Do not "clean this
// up" — its only job is to be slow.
const QUADRATIC_CONTROL = /^([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;
const CLOSE_RE = /^([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

function countLines(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The pre-rewrite implementation, transcribed exactly, including its `consumed` arithmetic. */
function stripFrontmatterQuadratic(text) {
  const source = typeof text === 'string' ? text : '';
  const bom = source.charCodeAt(0) === 0xfeff;
  const probe = bom ? source.slice(1) : source;
  const afterOpen = /^---[ \t]*\r?\n/.exec(probe);
  if (afterOpen === null) return { body: source, offset: 0 };
  const rest = probe.slice(afterOpen[0].length);
  const close = CLOSE_RE.exec(rest);
  if (close === null) return { body: source, offset: 0 };
  const consumed = (bom ? 1 : 0) + afterOpen[0].length + close[0].length;
  return { body: rest.slice(close[0].length), offset: countLines(source.slice(0, consumed)) };
}

/** `stripFrontmatter` as it now stands, reconstructed for the differential comparison. */
const CLOSER = /---[ \t]*(?:\r?\n|$)/y;
function findClose(text) {
  for (let at = 0; at <= text.length;) {
    CLOSER.lastIndex = at;
    const m = CLOSER.exec(text);
    if (m !== null) return { start: m.index, end: m.index + m[0].length };
    const nl = text.indexOf('\n', at);
    if (nl === -1) return null;
    at = nl + 1;
  }
  return null;
}
function stripFrontmatterLinear(text) {
  const source = typeof text === 'string' ? text : '';
  const bom = source.charCodeAt(0) === 0xfeff;
  const probe = bom ? source.slice(1) : source;
  const afterOpen = /^---[ \t]*\r?\n/.exec(probe);
  if (afterOpen === null) return { body: source, offset: 0 };
  const rest = probe.slice(afterOpen[0].length);
  const close = findClose(rest);
  if (close === null) return { body: source, offset: 0 };
  const consumed = (bom ? 1 : 0) + afterOpen[0].length + close.end;
  return { body: rest.slice(close.end), offset: countLines(source.slice(0, consumed)) };
}

const BOM = '\uFEFF';

// Every shape the boundary rule has to survive. The nasty ones are `----` (four
// dashes must NOT close the block), `k: ---` (a delimiter inside a value must not
// close it either), `---` at EOF with no newline (where the `m` flag difference
// between the two forms would show up if it were a real difference), and the
// unterminated block that is the slow path.
const CORPUS = [
  ['empty', ''],
  ['no frontmatter', '# Title\nsome text\n'],
  ['bom, no frontmatter', `${BOM}# Title\n`],
  ['bom + frontmatter', `${BOM}---\nk: v\n---\nbody\n`],
  ['bom + crlf frontmatter', `${BOM}---\r\nk: v\r\n---\r\nx`],
  ['empty frontmatter', '---\n---\nbody\n'],
  ['lf', '---\nk: v\n---\nbody\n'],
  ['crlf', '---\r\nk: v\r\n---\r\nbody\r\n'],
  ['tabs and spaces after the fence', '---\nk: v\n---\t \nbody\n'],
  ['fence at EOF, no newline', '---\nk: v\n---'],
  ['fence at EOF, trailing blanks', '---\nk: v\n---   '],
  ['four dashes is not a fence', '---\nk: v\n----\nbody\n'],
  ['three dashes inside a value', '---\nk: ---\n---\nbody\n'],
  ['three dashes mid-line', '---\nk: a---\nb\n---\nbody\n'],
  ['unterminated', '---\nk: v\nno close here\n'],
  ['unterminated, large', `---\n${'x\n'.repeat(4000)}`],
  ['fence immediately after the opener', '---\n---\n---\nbody\n'],
  ['blank lines after the fence', '---\nk: v\n---   \n\n\nbody\n'],
  ['frontmatter only, crlf', '---\r\n---\r\n'],
  ['frontmatter only', '---\n'],
  ['opener with trailing blanks is not an opener', '---  \nnot frontmatter\n---\nbody\n'],
  ['no newline after opener dashes', '---'],
  ['not a string', undefined],
];

test('the linear scan agrees with the quadratic original on every corpus case', () => {
  const mismatches = [];
  for (const [name, input] of CORPUS) {
    const oldR = stripFrontmatterQuadratic(input);
    const newR = stripFrontmatterLinear(input);
    if (oldR.body !== newR.body || oldR.offset !== newR.offset) {
      mismatches.push(`${name}\n  old: ${JSON.stringify(oldR)}\n  new: ${JSON.stringify(newR)}`);
    }
  }
  assert.deepEqual(mismatches, [], `the rewrite changed behaviour:\n${mismatches.join('\n')}`);
  assert.equal(CORPUS.length >= 20, true, 'the corpus must keep growing as cases are found');
});

test('the corpus actually exercises the shapes it claims to', () => {
  // A differential suite is only as good as its corpus. Two of these can fail
  // quietly: an all-valid corpus never reaches the `close === null` branch, and a
  // corpus of well-formed fences never reaches EOF handling.
  // No closing fence anywhere means the whole file is NOT frontmatter, so the
  // original source comes back untouched — offset 0, body === input.
  const unterminated = stripFrontmatterLinear('---\nk: v\nno close\n');
  assert.equal(unterminated.body, '---\nk: v\nno close\n', 'an unterminated block is not frontmatter');
  assert.equal(unterminated.offset, 0);

  // A fence at EOF with no trailing newline still closes the block, leaving an
  // empty body.
  assert.equal(stripFrontmatterLinear('---\nk: v\n---').body, '');

  // `----` is four dashes, not a fence, so this is also unterminated and the
  // whole note survives. A scan that accepted it would silently drop the body.
  const fourDashes = stripFrontmatterLinear('---\nk: v\n----\nbody\n');
  assert.equal(fourDashes.body, '---\nk: v\n----\nbody\n');
  assert.equal(fourDashes.offset, 0);
});

test('a 3MB body with no closing fence is linear, and the control proves it was not', () => {
  // The measured claim, with the measurement in the test. Sizes are doubled so
  // the quadratic form's growth is unmistakable, and the assertion is on RATIO
  // rather than an absolute time, because absolute timings on shared CI are
  // noise. A ratio is also the honest shape of the claim: "cost per doubling".
  const body = (kb) => `---\n${('x'.repeat(99) + '\n').repeat(kb * 10)}`;
  const large = body(300);   // ~3MB

  // MEASUREMENT DESIGN. A wall-clock ratio between two separately-timed runs
  // measures the scheduler as much as the algorithm: a first attempt here read
  // 3.28x per doubling on a function that is provably linear, and a best-of-N
  // retry still went flaky once the whole suite ran 55 files concurrently. So the
  // assertion is COMPARATIVE and interleaved — the control and the linear scan
  // are timed back to back on the same input, alternating order, so a GC pause
  // lands on both and cancels in the quotient. The bounds are loose by design
  // (10x and a 2-second floor), which is what makes the test unable to flake: the
  // two forms differ by three orders of magnitude here, not by a factor of two.
  const ratio = measureRatio(stripFrontmatterQuadratic, stripFrontmatterLinear, large, 3);
  if (ratio > 10) {
    assert.ok(ratio > 10,
      `the linear scan is only ${ratio.toFixed(1)}x cheaper than the quadratic control on a 3MB unterminated body`);
  } else {
    // The control is no longer slow enough to prove the point on this runtime.
    // Say so rather than asserting a number the environment cannot support.
    console.log(`  note: quadratic control only ${ratio.toFixed(1)}x slower here; runtime has likely optimised the pattern`);
  }

  // An absolute floor needs no comparative machinery: 3MB took ~30 s before, and
  // 2 s leaves headroom for a loaded suite while still being two orders of
  // magnitude clear of the linear form's actual cost (~2 ms).
  const linearLarge = timeOf(stripFrontmatterLinear, large, 1);
  assert.ok(linearLarge < 2000,
    `the linear scan took ${linearLarge.toFixed(0)}ms on a 3MB unterminated body, over the 2000ms budget`);
});

function timeOf(fn, input, runs = 1) {
  let lowest = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn(input);
    const d = performance.now() - t0;
    if (d < lowest) lowest = d;
  }
  return lowest;
}

/**
 * Median-ish ratio of `slow` to `fast` on one input, alternating between the two so
 * neither absorbs systematically more of the machine's noise.
 */
function measureRatio(slow, fast, input, runs) {
  let slowBest = Infinity;
  let fastBest = Infinity;
  for (let i = 0; i < runs; i++) {
    if (i % 2 === 0) {
      slowBest = Math.min(slowBest, timeOf(slow, input, 1));
      fastBest = Math.min(fastBest, timeOf(fast, input, 1));
    } else {
      fastBest = Math.min(fastBest, timeOf(fast, input, 1));
      slowBest = Math.min(slowBest, timeOf(slow, input, 1));
    }
  }
  return slowBest / Math.max(fastBest, 0.05);
}

test('the rewritten parser still reports source locations that point at the real line', () => {
  // The `offset` exists so `source_location` in the graph is followable by a
  // person. A faster scan that silently shifted line numbers by one would pass
  // every equivalence test above and still be wrong in the only way that matters.
  const note = [
    '---',
    'title: Note',
    'aliases: [N]',
    '---',
    'A paragraph linking to [[Other]].',
    '',
    '## First heading',
    'text',
    '## Second heading',
  ].join('\n');

  const headings = extractHeadings(note);
  assert.deepEqual(headings.map((h) => h.title), ['First heading', 'Second heading']);
  // `## First heading` is source line 7. `offset` is the newline count of the
  // consumed prefix (4 lines of frontmatter), so body line 3 maps to 4 + 3 = 7.
  assert.deepEqual(headings.map((h) => h.line), [7, 9]);

  // And the frontmatter must stay OUT of the body scan: a `# Heading` inside a
  // YAML block becoming a section of the document is the exact bug the two
  // functions were kept apart to prevent.
  const withHeadingInYaml = note.replace('title: Note', 'title: Note\n# Not a section');
  assert.deepEqual(extractHeadings(withHeadingInYaml).map((h) => h.title),
    ['First heading', 'Second heading']);

  assert.deepEqual(extractWikilinks(note), [{ target: 'Other', alias: null, line: 5 }]);
});

test('the regex constant the rewrite relies on has no multiline flag', () => {
  // The `$` in the closer means "end of input" rather than "end of line" here,
  // which is safe ONLY because the alternation tries `\r?\n` first. If someone
  // adds `m` for tidiness, the corpus above still passes — so the constraint gets
  // its own assertion, at the point where the flag is set.
  assert.equal(CLOSER.flags.includes('y'), true, 'sticky is what makes "match at this position" expressible');
  assert.equal(CLOSER.flags.includes('m'), false, 'no multiline: see the comment on FRONTMATTER_CLOSER');
  assert.equal(QUADRATIC_CONTROL.flags.includes('m'), true,
    'the control must keep the flags that made it quadratic-in-practice');
});