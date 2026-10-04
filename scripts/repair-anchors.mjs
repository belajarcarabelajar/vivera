#!/usr/bin/env bun
// scripts/repair-anchors.mjs — classify and repair anchors whose cited line
// does not carry the quoted words.
//
// Context, all measured with scripts/check-anchors.mjs: of 2,316 anchors in the
// corpus, 1,373 (59%) fail the verbatim test, and 1,371 of those are in the 149
// chunks built before §4a. The 40 chunks built under §4a fail 7 of 831 (0.8%).
// So this is a backlog, not a live defect rate.
//
// The repair is tiered, because a confidently wrong pointer is worse than an
// acknowledged gap:
//
//   T1  The quote IS a verbatim substring of some line in the file. Rewrite the
//       anchor to that line. Provable: the quoted words are demonstrably there.
//   T2  The quote is verbatim but WRAPS two consecutive lines. §4a says a wrap
//       gets two anchors. Split it.
//   T3  The quote is nowhere, but the node's own source_location names a line
//       whose content supports the claim. Replace the fabricated quote with a
//       slice taken from that line, so the result is verbatim by construction.
//   T4  Nothing verifiable. LEFT ALONE and reported. Not guessed.
//
// Usage:
//   ./scripts/repair-anchors.mjs --survey            tier counts, no writes
//   ./scripts/repair-anchors.mjs --tier 1 --apply    rewrite line numbers
//   ./scripts/repair-anchors.mjs --chunk 037 --apply one chunk, any tier
//   ./scripts/repair-anchors.mjs --list T4 --chunk 037   the T4 worklist
import fs from 'node:fs';
import path from 'node:path';
import { parseAnchors, resolveFile, paddingRanges } from './check-anchors.mjs';

const DIR = 'vault-index/semantic';

/** The subagent's transcription artefacts, not the note's words. */
export function unquoteForms(q) {
  const out = [q];
  const un = q.replace(/\\(["'\\])/g, '$1');
  if (un !== q) out.push(un);
  for (const b of [un, q]) {
    const s = b.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
    if (s.length >= 4 && !out.includes(s)) out.push(s);
  }
  return [...new Set(out)];
}

// Cache by RESOLVED path, not by the requested relative path: two callers may
// resolve the same `source_file` against different roots (the CLI's real vault
// vs a test's fixture root), and a relative-path key would hand the second
// caller the first one's lines.
const cache = new Map();
const load = (sf, roots) => {
  if (!sf) return null;
  const file = resolveFile(sf, roots);
  if (!file) return null;
  if (!cache.has(file)) {
    const L = fs.readFileSync(file, 'utf8').split('\n');
    cache.set(file, { L, pad: paddingRanges(L) });
  }
  return cache.get(file);
};

/** Every line index (0-based) that contains any rendering of the quote. */
function verbatimHits(L, forms) {
  const hits = [];
  for (let i = 0; i < L.length; i++) {
    const line = L[i];
    for (const f of forms) {
      if (line.includes(f)) { hits.push(i); break; }
    }
  }
  return hits;
}

/** True when the quote is verbatim but split across L[i] and L[i+1]. */
function wrapHits(L, forms) {
  const hits = [];
  for (let i = 0; i + 1 < L.length; i++) {
    for (const f of forms) {
      if (f.length < 20) continue;
      // Every token of the quote must appear, split across the two lines, in order.
      const toks = f.split(/\s+/);
      const a = L[i], b = L[i + 1];
      let ai = 0;
      const takeA = [];
      for (const t of toks) {
        const at = a.indexOf(t, ai);
        if (at >= 0) { takeA.push(t); ai = at + t.length; }
      }
      if (takeA.length < 3) continue;
      let bi = 0, ok = true;
      for (const t of toks.slice(takeA.length)) {
        const at = b.indexOf(t, bi);
        if (at < 0) { ok = false; break; }
        bi = at + t.length;
      }
      if (ok && takeA.length + toks.length - takeA.length === toks.length) { hits.push(i); break; }
    }
  }
  return hits;
}

// Chrome: emphasis, code spans, and quote marks are presentation, not words. A
// subagent quoting "fails closed with a clear message" from a line that reads
// ``fails closed with a clear message.`` has quoted the note correctly, so the
// SEARCH may ignore chrome. The REPAIR never stores a relaxed span — it writes
// back the line's own characters, so the stored quote is byte-verbatim.
// Quote marks are included because many pre-§4a quotes differ from their line by
// nothing else; treating those as fabrications would rewrite 400-odd rationales
// that only needed a line number.
const CHROME = /[*`"']/;

/** Index map from a chrome-stripped string back to the original offsets. */
function stripMap(s) {
  let stripped = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    if (CHROME.test(s[i])) continue;
    stripped += s[i];
    map.push(i);
  }
  return { out: stripped, map };
}

/**
 * Find the exact substring of `line` that a relaxed quote refers to, and return
 * the line's own text for that span. Returns null when there is no such span.
 */
function exactSpan(line, forms) {
  for (const f of forms) {
    const direct = line.indexOf(f);
    if (direct >= 0) return line.slice(direct, direct + f.length);
  }
  const { out: nl, map } = stripMap(line);
  for (const f of forms) {
    const nq = stripMap(f).out;
    if (nq.length < 8) continue;
    const at = nl.indexOf(nq);
    if (at < 0) continue;
    // Extend to whitespace boundaries so the span reads as a phrase, then take
    // the line's own characters.
    let s = map[at];
    let e = map[Math.min(at + nq.length - 1, map.length - 1)] + 1;
    while (s > 0 && !/\s/.test(line[s - 1])) s--;
    while (e < line.length && !/\s/.test(line[e])) e++;
    return line.slice(s, e);
  }
  return null;
}

/** Line indexes where a relaxed form of the quote is present. */
function relaxedHits(L, forms) {
  const hits = [];
  for (let i = 0; i < L.length; i++) {
    if (exactSpan(L[i], forms) !== null) hits.push(i);
  }
  return hits;
}

const chunkIds = (argv) => {
  const only = argv.includes('--chunk') ? argv[argv.indexOf('--chunk') + 1] : null;
  return fs.readdirSync(DIR)
    .filter((n) => /^chunk(-rem)?-\d+\.json$/.test(n))
    .filter((n) => !only || n === `chunk-${only}.json`)
    .sort();
};

function inPad(f, ln) { return f.pad.some(([a, b]) => ln >= a && ln <= b); }

/**
 * Walk one chunk's rationale anchors and return every repair candidate with its
 * tier. Never mutates.
 */
export function planChunk(name, opts = {}) {
  const dir = opts?.dir ?? DIR;
  const roots = opts?.roots;
  const chunk = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const out = [];
  for (const n of chunk.nodes ?? []) {
    const r = n.rationale;
    if (typeof r !== 'string' && !Array.isArray(r)) continue;
    const arr = Array.isArray(r) ? r : [r];
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      const A = parseAnchors(p);
      for (let k = 0; k < A.length; k++) {
        const a = A[k];
        const stop = k + 1 < A.length ? A[k + 1].start : p.length;
        const quoted = p.slice(a.end, stop).trim();
        if (quoted.length < 6) continue;
        const forms = unquoteForms(quoted);
        // The anchor path may be a pre-§4a `[file:Lnnn]` placeholder; fall back
        // to the node's own source_file, which is a real path in the batch.
        const f = load(a.file, roots) || (n.source_file ? load(n.source_file, roots) : null);
        if (!f) { out.push({ node: n.id, idx: i, k, tier: 'T4', why: 'no file' }); continue; }
        const L = f.L;
        if (forms.some((x) => L[a.line - 1]?.includes(x))) continue;  // already fine
        if (a.line < 1 || a.line > L.length) { out.push({ node: n.id, idx: i, k, tier: 'T4', why: 'out of range' }); continue; }
        const hits = verbatimHits(L, forms);
        if (hits.length === 1 && !inPad(f, hits[0] + 1)) {
          out.push({ node: n.id, idx: i, k, tier: 'T1', to: hits[0] + 1, from: a.line, file: a.file, quoted });
          continue;
        }
        if (hits.length === 0) {
          // T2: the words are on a line, but the subagent's transcription differs
          // from the line's own characters — usually markdown chrome, sometimes a
          // dropped word. Fix the line number AND write back the line's exact
          // text, so the stored quote is byte-verbatim even though the match was
          // found with a relaxed search.
          const rel = relaxedHits(L, forms).filter((h) => !inPad(f, h + 1));
          if (rel.length === 1) {
            out.push({ node: n.id, idx: i, k, tier: 'T2', to: rel[0] + 1, from: a.line, file: a.file, quoted });
            continue;
          }
        }
        // T3: the node's own source_location is a line a subagent read and
        // chose. If the quote's content overlaps it, the pointer is probably
        // right and the WORDS are the fabrication.
        const mLoc = /^L(\d+)$/.exec(String(n.source_location || ''));
        const loc = mLoc ? Number(mLoc[1]) : null;
        const locOk = loc && loc >= 1 && loc <= L.length && !inPad(f, loc);
        if (!locOk) {
          out.push({ node: n.id, idx: i, k, tier: 'T4', from: a.line, file: a.file, quoted, why: 'no usable source_location' });
          continue;
        }
        const site = paraphraseSite(L[loc - 1], quoted);
        if (site) {
          out.push({ node: n.id, idx: i, k, tier: 'T3', to: loc, from: a.line, file: a.file, quoted, span: site.span, score: site.score });
        } else {
          out.push({ node: n.id, idx: i, k, tier: 'T4', from: a.line, file: a.file, quoted, why: 'quote absent and source_location does not carry the words either' });
        }
      }
    }
  }
  return { name, chunk, plans: out };
}

/** Content tokens of a string, for overlap scoring. */
function toks(s) {
  return s.toLowerCase().split(/[^a-z0-9_À-ɏ]+/).filter((w) => w.length > 3);
}

/** Split a line into sentence-ish spans, keeping markdown list bullets whole. */
function sentences(line) {
  const parts = line.split(/(?<=[.!?])\s+(?=[A-Z`|*-])/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [line.trim()];
}

/**
 * T3: the quote is absent from the file, but the node's own source_location
 * names a line. If the quote's content words land on one sentence of that line,
 * the subagent was paraphrasing THAT sentence — the pointer is sound and the
 * words are the fabrication, so the sentence can replace the quote verbatim.
 *
 * If no sentence on the line carries the words, the pointer is not trustworthy
 * either and the node needs a re-read. That case is T4, not a guess.
 */
/**
 * Minimum fraction of the fabricated quote's content words that must appear in
 * the replacement sentence. Set by reading the bands, not by taste:
 *
 *   0.90-1.00  the quote is a faithful distillation; the line says it better
 *   0.75-0.95  same, minus a lead-in the subagent dropped
 *   0.60-0.75  same, the sentence split differently
 *   0.34-0.59  OFTEN A DIFFERENT CLAIM. rem-108 at 0.34 wanted a claim about
 *              format!("{:?}").to_lowercase() and the best-matching sentence on
 *              the cited line was about a badge icon not matching stateIcon.
 *              Replacing there would produce a verbatim citation that passes
 *              every automated check and supports nothing — a confidently wrong
 *              pointer, which is worse than an acknowledged gap.
 */
const T3_MIN_OVERLAP = 0.6;

function paraphraseSite(line, quoted) {
  const q = new Set(toks(quoted));
  if (q.size < 4) return null;
  let best = null, bestScore = 0;
  for (const sent of sentences(line)) {
    const s = new Set(toks(sent));
    let hit = 0;
    for (const w of q) if (s.has(w)) hit++;
    const score = hit / q.size;
    if (score > bestScore) { bestScore = score; best = sent; }
  }
  if (!best || bestScore < T3_MIN_OVERLAP) return null;
  return { span: best, score: bestScore };
}
/**
 * Rebuild one rationale string with a plan applied, then PROVE the result.
 *
 * The proof step is the point. A first version of this tool reported "applied
 * 92 rewrites" while the corpus failure count moved 1,373 -> 1,369, because
 * nothing checked whether a rewritten anchor actually passed afterwards. Every
 * candidate is now re-parsed and re-tested; a repair that does not verify is
 * discarded rather than written.
 */
export function applyPlan(s, pl, opts = {}) {
  const roots = opts?.roots;
  const A = parseAnchors(s);
  if (A.length <= pl.k) return null;
  const a = A[pl.k];
  const stop = pl.k + 1 < A.length ? A[pl.k + 1].start : s.length;
  const head = s.slice(0, a.start);
  const tail = s.slice(stop);
  // No closing bracket: the caller writes `]` itself. An earlier version
  // returned it here too, so every rebuilt anchor ended in `]]` and the
  // stray bracket landed inside the quoted span, failing the proof below.
  const pad = (x) => `:L${String(x).padStart(5, '0')}`;

  let mid;
  if (pl.tier === 'T1') {
    // T1 changes the line number only. The quoted words stay exactly as the
    // subagent wrote them — they are already verbatim, just cited at the wrong
    // line. An earlier version emitted the bare anchor here, which left an empty
    // quoted span, so the proof rejected every T1 and nothing was written.
    mid = `[${a.file}${pad(pl.to)}]` + s.slice(a.end, stop);
  } else if (pl.tier === 'T2') {
    // Write back the LINE's own characters for the matched span, not the
    // subagent's rendering of them. The search was relaxed; the stored data is
    // not.
    const f2 = load(a.file, roots) || load(pl.file, roots);
    if (!f2) return null;
    const span = exactSpan(f2.L[pl.to - 1], unquoteForms(pl.quoted));
    if (!span) return null;
    mid = `[${a.file}${pad(pl.to)}] ${span}`;
  } else if (pl.tier === 'T3') {
    // The words were fabricated; replace them with the cited line's own
    // sentence, which is the thing the subagent was reaching for.
    const f3 = load(a.file, roots) || load(pl.file, roots);
    if (!f3) return null;
    const span = exactSpan(f3.L[pl.to - 1], [pl.span]) ?? pl.span;
    if (!f3.L[pl.to - 1].includes(span)) return null;
    mid = `[${a.file}${pad(pl.to)}] ${span}`;
  } else return null;

  const out = head + mid + tail;
  // Prove it: every anchor in the rebuilt string must carry its quote verbatim.
  const A2 = parseAnchors(out);
  if (!A2.length) return null;
  for (let k = 0; k < A2.length; k++) {
    const b = A2[k];
    const st = k + 1 < A2.length ? A2[k + 1].start : out.length;
    const q = out.slice(b.end, st).trim();
    const f = load(b.file, roots);
    if (!f || q.length < 4) return null;
    if (!unquoteForms(q).some((x) => f.L[b.line - 1]?.includes(x))) return null;
  }
  return out;
}

export function rewrite(chunk, plans, tiers, opts = {}) {
  const use = tiers.length ? tiers : ['T1', 'T2'];
  let n = 0;
  for (const pl of plans) {
    if (!use.includes(pl.tier) || pl.to == null) continue;
    const node = chunk.nodes.find((x) => x.id === pl.node);
    if (!node) continue;
    // Preserve the rationale's own shape. planChunk accepts a string or an
    // array, and the repair must not silently turn every touched string into a
    // one-element array — that changes the chunk's structure for a line-number
    // fix and buries the real change in the diff.
    const wasArray = Array.isArray(node.rationale);
    const arr = wasArray ? node.rationale.slice() : [node.rationale];
    const s = arr[pl.idx];
    if (s == null) continue;
    const rebuilt = applyPlan(s, pl, opts);
    if (rebuilt == null) continue;   // unproven — leave the chunk alone
    arr[pl.idx] = rebuilt;
    node.rationale = wasArray ? arr : arr[0];
    n++;
  }
  return n;
}
if (import.meta.main) {
const argv = process.argv.slice(2);
if (argv.length === 0) { console.error('usage: repair-anchors.mjs --survey | --tier N [--apply] [--chunk ID]'); process.exit(2); }
const apply = argv.includes('--apply');
const survey = argv.includes('--survey');
// --tier may repeat: `--tier 1 --tier 2`. An earlier version read only the
// first occurrence and reported "applied 0 rewrites" while the survey counted 92.
const tiers = argv.reduce((acc, v, i) => (v === '--tier' ? [...acc, argv[i + 1]] : acc), []);

const tally = { T1: 0, T2: 0, T3: 0, T4: 0 };
let changedChunks = 0, changedAnchors = 0;
const listing = argv.includes('--list');
for (const name of chunkIds(argv)) {
  let { chunk, plans } = planChunk(name);
  if (!plans.length) continue;
  for (const p of plans) tally[p.tier]++;
  if (listing) {
    const only = argv.includes('--list') ? argv[argv.indexOf('--list') + 1] : null;
    for (const p of plans) {
      if (only && p.tier !== only) continue;
      console.log(JSON.stringify({
        tier: p.tier, node: p.node, why: p.why ?? null,
        file: p.file ?? null, from: p.from ?? null, to: p.to ?? null,
        quoted: (p.quoted ?? '').slice(0, 300),
      }));
    }
  }
  if (!apply) continue;
  const todo = plans.filter((p) => (tiers.length ? tiers : ["T1","T2"]).includes(p.tier) && p.to != null);
  if (!todo.length) continue;
  const c = rewrite(chunk, todo, tiers);
  if (c > 0) {
    fs.writeFileSync(path.join(DIR, name), JSON.stringify(chunk, null, 2) + '\n');
    changedChunks++; changedAnchors += c;
  }
}
if (!listing) {
console.log(`T1 line-number fix      ${tally.T1}`);
console.log(`T2 two-line wrap split  ${tally.T2}`);
console.log(`T3 replace quote words  ${tally.T3}   (needs a slice decision, not automated)`);
console.log(`T4 no verifiable line   ${tally.T4}   (left alone)`);
if (apply) console.log(`\napplied ${changedAnchors} rewrites across ${changedChunks} chunks — re-run check-anchors.mjs --all`);
else console.log('\nsurvey only; pass --apply with --tier to write');
}
}
