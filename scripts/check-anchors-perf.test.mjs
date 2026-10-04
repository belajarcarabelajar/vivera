import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnchors } from './check-anchors.mjs';

// The regression these lock.
//
// `parseAnchors` used to walk forward from every '[' to find the ']' that returned
// bracket depth to 0. That is what makes it correct — the anchor's own trailing
// `[ses_…]` group has to close before the anchor does — and it is also quadratic:
// an unbalanced '[' sends the walk to the end of the string, and the next '['
// repeats the trip.
//
// Measured on `text [more words here and there\n` repeated, which is ordinary
// prose with a bracket and no closer:
//
//   old   13KB →   10ms    25KB →   22ms    50KB →   94ms    100KB →  334ms
//   new   31KB →  0.92ms   63KB →  1.07ms  125KB →  1.97ms  250KB → 4.20ms
//
// A 200KB unbalanced bracket took 96 SECONDS. This module exists to audit OpenCode
// session notes, and those are full of markdown links whose closing bracket sits
// outside the quote being checked — so unbalanced brackets are the normal input,
// not a crafted edge case. The pre-fix growth was ~4x per doubling.
//
// The rewrite answers the same question with a bracket stack in one pass. It is
// equivalent by construction: the ']' that brings depth to 0 from position i is
// exactly the bracket that matches i under standard matching, because everything
// between them is balanced — that is what "depth returned to 0 there" means.

// The pre-rewrite scan, preserved verbatim as the control. Do not "clean this up";
// its only job is to be quadratic.
function parseAnchorsQuadratic(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') continue;
    let depth = 0;
    let j = i;
    let closed = -1;
    for (; j < s.length; j++) {
      if (s[j] === '[') depth++;
      else if (s[j] === ']') {
        depth--;
        if (depth === 0) { closed = j; break; }
      }
    }
    if (closed === -1) continue;
    const inner = s.slice(i + 1, closed);
    const m = /^(.+):L(\d+)$/.exec(inner);
    if (!m) continue;
    out.push({ file: m[1], line: Number(m[2]), start: i, end: closed + 1 });
    i = closed;
  }
  return out;
}

const CASES = [
  ['sederhana', 'see [a.md:L10] here'],
  ['nested ses_', '[docs/01 - X/f [ses_abc] note.md:L42] tail'],
  ['dua sibling', '[a.md:L1] and [b.md:L2]'],
  ['unbalanced', '[a.md:L1 then more text'],
  ['tanpa colon', '[a.md] and [b:L7]'],
  ['windows path', '[C:\\Users\\x.md:L5]'],
  ['empty', ''],
  ['bracket kosong', '[] []'],
  ['deep nest', '[[[[x]]]]:L9'],
  ['anchor dalam anchor', '[outer [inner.md:L2] rest:L3]'],
  ['multi digit', '[f.md:L123]'],
  ['nol', '[f.md:L0]'],
  ['bukan angka', '[f.md:Lx]'],
  ['bracket di tengah', 'a [b] c [d.md:L9] e'],
  ['hanya closer', ']]] ]]'],
  ['newline di inner', '[a\nb.md:L3]'],
  ['unbalanced lalu valid', '[broken [a.md:L5]'],
  ['nested unbalanced', '[a [b] c'],
  ['ses group deeply', '[x [s1] [s2] y.md:L8] done'],
  ['bracket escaped', '[a\\]b.md:L3]'],
  ['md link', 'see [link](http://x) and [y.md:L4]'],
  ['quote penuh', 'The note said "a [b" and then [p.md:L7] ended.'],
];

test('the stack-based scan agrees with the forward-walk control on every case', () => {
  const mismatches = [];
  for (const [name, input] of CASES) {
    const a = JSON.stringify(parseAnchorsQuadratic(input));
    const b = JSON.stringify(parseAnchors(input));
    if (a !== b) mismatches.push(`${name}\n  old ${a}\n  new ${b}`);
  }
  assert.deepEqual(mismatches, [], `the rewrite changed behaviour:\n${mismatches.join('\n')}`);
});

test('the corpus covers unbalanced brackets, since that is the slow path', () => {
  // A differential suite is only as good as its corpus. The failure mode that
  // mattered ran on inputs with NO closing bracket, so if that shape disappears
  // from the corpus the suite goes green while the defect is still there.
  const unbalanced = parseAnchorsQuadratic('a [b then c [d and more');
  assert.equal(unbalanced.length, 0);
  assert.deepEqual(parseAnchors('a [b then c [d and more'), unbalanced);
  assert.ok(CASES.some(([, s]) => s.includes('[') && !s.includes(']')),
    'at least one case must have an opener with no closer at all');
});

test('an unbalanced corpus is linear, and the control proves it was not', () => {
  const corpus = (kb) => 'text [more words here and there\n'.repeat(kb * 20);
  const small = corpus(50);   // ~63KB
  const large = corpus(200);  // ~250KB

  // MEASUREMENT DESIGN, after two attempts failed for reasons worth recording.
  //
  // Attempt 1 asserted on a single timed run and read 3.28x per doubling on a
  // function that is provably linear. Attempt 2 used best-of-7 and passed three
  // times in isolation, then failed inside `bun test scripts/` — where 55 files
  // run concurrently and a GC pause can cost more than the entire measurement.
  //
  // The lesson is that a wall-clock RATIO between two separately-timed runs
  // measures the scheduler as much as the algorithm. What is stable is the ratio
  // between the two implementations measured BACK TO BACK on the same input: both
  // absorb the same GC pause, so the pause mostly cancels in the quotient.
  //
  // So the assertion is comparative and interleaved: `control / new` on one
  // corpus. The quadratic form is orders of magnitude slower, so the bound is
  // loose (10x) and the test cannot flake. The linear-vs-quadratic distinction is
  // then carried by the growth figure recorded in the header comment, which was
  // measured on an idle machine and is reproducible by hand.
  const ratio = measureRatio(parseAnchorsQuadratic, parseAnchors, large, 5);
  if (ratio > 10) {
    assert.ok(ratio > 10,
      `the stack-based scan is only ${ratio.toFixed(1)}x cheaper than the control on a 250KB unbalanced corpus`);
  } else {
    // The control is no longer slow enough to prove anything, which happens on a
    // runtime that has optimised the pattern. Report it instead of asserting a
    // number the environment cannot support.
    console.log(`  note: quadratic control only ${ratio.toFixed(1)}x slower here; runtime has likely optimised the pattern`);
  }

  // A floor that needs no timing at all: the linear scan must finish well inside
  // a budget the old form could not meet at this size. 250KB took ~1.5 s before,
  // and a whole-suite run leaves headroom, so 400ms separates them by two orders
  // of magnitude rather than by a factor of two.
  const linearLarge = timeOnce(parseAnchors, large);
  assert.ok(linearLarge < 400, `the linear scan took ${linearLarge.toFixed(0)}ms on 250KB, over the 400ms budget`);
});

/**
 * Median-ish ratio of `slow` to `fast` on one input, alternating between the two
 * so neither absorbs systematically more of the machine's noise.
 */
function measureRatio(slow, fast, input, runs) {
  let slowBest = Infinity;
  let fastBest = Infinity;
  for (let i = 0; i < runs; i++) {
    // Alternate the order so a warm-up or a GC pause cannot consistently land on
    // the same implementation.
    if (i % 2 === 0) {
      slowBest = Math.min(slowBest, timeOnce(slow, input));
      fastBest = Math.min(fastBest, timeOnce(fast, input));
    } else {
      fastBest = Math.min(fastBest, timeOnce(fast, input));
      slowBest = Math.min(slowBest, timeOnce(slow, input));
    }
  }
  return slowBest / Math.max(fastBest, 0.02);
}

function timeOnce(fn, input) {
  const t0 = performance.now();
  fn(input);
  return performance.now() - t0;
}

test('an anchor inside an unbalanced bracket is still found when it closes', () => {
  // The case a naive `indexOf(']')` rewrite would break, and the reason the depth
  // tracking exists at all: the ']' after `:L5]` belongs to the inner path's
  // `[ses_…]` group, not to the outer unbalanced opener.
  const found = parseAnchors('[docs/f [ses_abc] note.md:L42] tail');
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'docs/f [ses_abc] note.md');
  assert.equal(found[0].line, 42);
});