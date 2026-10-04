#!/usr/bin/env bun
// scripts/check-anchors.mjs — parent-side anchor audit for vault-index chunks.
//
// Why this exists, in the order the defects were measured:
//
//  1. The parser. `\[([^\]]+):L(\d+)\]` matches ZERO anchors in this corpus,
//     because every path ends in [ses_…] so a `]` precedes the `:L<n>`. It
//     reports success while verifying nothing. Plain greedy `\[(.+):L(\d+)\]`
//     over-consumes across sibling anchors and reports phantom files. Nine
//     subagents hit this across waves 24-26. The scan below is bracket-balanced
//     and PRINTS the parsed count: zero-parsed and zero-failed are different
//     results, and only the first is the silent failure.
//
//  2. The verdict. A checker that scores by keyword overlap passes a quote that
//     appears nowhere in the corpus. Measured on rem-162: a subagent reported
//     "32 anchors, 0 failures" for a quote — "Probe stayed in
//     `/tmp/opencode/f4d/`." — that exists in none of that file's 5,272 lines,
//     nor in any other. The only verdict that binds is a verbatim substring
//     test of the quoted span against the cited line.
//
//  3. The padding. A transcript can carry a `session-event: synthetic` block
//     holding another note's full text (often a whole AGENTS.md). Anything
//     sourced from inside one is harness padding, not the note's own words.
//
//  4. Where the quote sits. §4a: commentary BEFORE the bracket, the note's own
//     words AFTER it. The span from an anchor's closing bracket to the next
//     anchor (or end of string) is the quote.
//
// Legacy chunks (before §4a) put prose where the note's own words belong and
// sometimes carry a bare `[file:Lnnn]` placeholder instead of a path. Those are
// reported as ordinary failures, because the verbatim test does catch them and
// because they need a re-read rather than a mechanical line-number fix.
//
// Usage:
//   ./scripts/check-anchors.mjs rem-154          one chunk, exit 1 on any failure
//   ./scripts/check-anchors.mjs --all            every chunk, report only
//   ./scripts/check-anchors.mjs --all --quiet    only chunks with failures
//
// Exit: 0 clean, 1 hard failure, 2 usage error.
import fs from 'node:fs';
import path from 'node:path';

import { resolveConfiguredPath } from './lib/local-config.mjs';

/**
 * The corpus roots a chunk's `source_file` and its anchor paths resolve against
 * by default: $ARCHIVE_ROOT and $VAULT_ROOT, else local.config.json's
 * "archiveRoot" and "vaultRoot" (copy local.config.example.json); with neither
 * set, the call throws. Resolved per call, never at import, matching
 * `vault-index-rebuild.mjs`, so importing this module cannot throw and a
 * changed env var is picked up on the next call. Any caller may instead pass
 * explicit `roots`, so auditing a corpus other than this machine's never
 * requires editing this file, and a unit test can point at a temp fixture root
 * instead of the real vault (which may not even exist off this host).
 *
 * @param {{configPath?: string}} [opts] test-only config file override
 * @returns {string[]} corpus root paths, archive first
 */
export function resolveDefaultRoots({ configPath } = {}) {
  return [
    resolveConfiguredPath({ envVar: 'ARCHIVE_ROOT', configKey: 'archiveRoot', label: 'conversations archive root', configPath }),
    resolveConfiguredPath({ envVar: 'VAULT_ROOT', configKey: 'vaultRoot', label: 'Obsidian vault root', configPath }),
  ];
}
const DIR = 'vault-index/semantic';

/** Locate a real file by repo-relative path across the vault roots. */
export function resolveFile(rel, roots = resolveDefaultRoots()) {
  for (const r of roots) {
    const p = path.join(r, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

// The ']' that closes each '[', computed in ONE pass.
//
// WHY THIS EXISTS, measured rather than assumed.
//
// The scan used to walk forward from every '[' looking for the ']' that returned
// depth to 0. That is correct and it is quadratic: an unbalanced '[' makes the
// inner walk reach the end of the string, and the next '[' does the same again.
// Measured on `text [more words here and there\n` repeated, which is ordinary
// prose containing a bracket and no closer — not a crafted input:
//
//    13KB →  10ms     25KB →  22ms     50KB →  94ms     100KB → 334ms
//
// Roughly 4x per doubling, on the same real corpus this module was built to
// audit: OpenCode session notes full of markdown links whose closing bracket is
// beyond the quote being checked. A 200KB unbalanced bracket ran for 96 SECONDS.
//
// A stack answers the same question in linear time and is equivalent by
// construction: the ']' that brings depth to 0 from position i is exactly the
// bracket that matches i under standard matching, because every bracket between
// them is balanced — that is what "depth returned to 0 at that point" means.
//
// The map is keyed by open index and stores the close index. An unmatched '[' or
// a stray ']' simply has no entry, which is the same outcome the forward walk
// reached by running off the end.
function matchBrackets(s) {
  const closeOf = new Map();
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') stack.push(i);
    else if (c === ']' && stack.length) closeOf.set(stack.pop(), i);
  }
  return closeOf;
}

// The anchor's own ':L<n>' suffix. Greedy `.+` is safe HERE and only here,
// because `inner` is already bracket-balanced: it cannot span into a sibling
// anchor, which was the original defect (see the header).
const ANCHOR_INNER = /^(.+):L(\d+)$/;

/**
 * Bracket-balanced anchor scan. Tracks [ ] depth from each '[' forward and
 * accepts ':L<n>' only when depth returns to 0 — i.e. the ']' that closes the
 * path's own trailing [ses_…] group. Never lets `.+` run past a sibling anchor.
 */
export function parseAnchors(s) {
  const out = [];
  const closeOf = matchBrackets(s);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') continue;
    const closed = closeOf.get(i);
    if (closed === undefined) continue;
    const inner = s.slice(i + 1, closed);
    const m = ANCHOR_INNER.exec(inner);
    if (!m) continue;
    out.push({ file: m[1], line: Number(m[2]), start: i, end: closed + 1 });
    i = closed; // do not re-scan inside an accepted anchor
  }
  return out;
}

/**
 * session-event padding blocks. A block runs from its `## [seq N]
 * session-event:` heading to the next `## [seq N]` heading of any kind, which
 * is what actually bounds it — not the next `session-event`, and not a
 * hardcoded range. Measured on rem-162: assuming the event ends where the
 * next event begins flagged 9 good nodes, because a `system` event's payload
 * runs long past its own successor and the real report follows it.
 */
export function paddingRanges(lines) {
  const ranges = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## \[seq \d+\] session-event:/.test(lines[i])) {
      if (open !== -1) ranges.push([open + 1, i]);
      open = i;
    } else if (open !== -1 && /^## \[seq \d+\]/.test(lines[i])) {
      ranges.push([open + 1, i]);
      open = -1;
    }
  }
  if (open !== -1) ranges.push([open + 1, lines.length]);
  return ranges;
}

/**
 * Candidate renderings of a quoted span, most faithful first. A subagent
 * transcribing a quote wraps it in double quotes and JSON-escapes the note's own
 * inner quotes; the note's line has neither. Testing only the raw string
 * reported 1,424 of 2,294 anchors as broken while the spans matched exactly.
 */
function unquoteForms(q) {
  const out = [q];
  const unesc = q.replace(/\\(["'\\])/g, '$1');
  if (unesc !== q) out.push(unesc);
  const stripped = unesc.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
  if (stripped && stripped !== unesc) out.push(stripped);
  const both = q.replace(/\\(["'\\])/g, '$1').replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
  if (both && !out.includes(both)) out.push(both);
  return [...new Set(out.filter((s) => s.length >= 4))];
}

// An earlier version carried a `legacyShape` counter that tried to spot pre-§4a
// rationales by their prose layout. It was deleted after two false readings, and
// the reason is worth keeping: there is no text after the LAST anchor in a
// well-formed string, because that text is the quote itself — so any rule keyed
// on "text following the quote" fires on every anchor. Layout cannot be probed
// this way. The verbatim test below already fails every legacy case that matters
// (rem-118's `[file:L2500]` placeholders fail the path check; its quotes fail the
// substring test), so a separate shape heuristic would only add noise.

export function checkChunk(chunkPath, opts = {}) {
  const roots = opts?.roots ?? resolveDefaultRoots();
  const chunk = JSON.parse(fs.readFileSync(chunkPath, 'utf8'));
  const cache = new Map();
  const get = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const p = resolveFile(rel, roots);
    if (!p) { cache.set(rel, null); return null; }
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    // LONE-CR HAZARD. 29 transcripts contain a \r that is not followed by \n,
    // because a line of the agent's own code — `split(/\r?\n/)` — survived into
    // the note. Node, Bun and awk agree on the line count; PYTHON TEXT MODE
    // DOES NOT, because universal-newline translation folds a lone \r into a
    // line break and every line after the first one shifts. Measured: one
    // transcript reads 28,561 lines here and 29,340 in Python text mode.
    //
    // So `split('\n')` below is the canonical definition, and any ad-hoc check
    // run through python3 must pass newline='' to disagree with it honestly
    // rather than silently. Anchors past the first lone CR are counted so the
    // blast radius is visible instead of assumed.
    const firstLoneCR = lines.findIndex((l) => l.endsWith('\r'));
    const v = { path: p, lines, pad: paddingRanges(lines), crAt: firstLoneCR + 1 || 0 };
    cache.set(rel, v);
    return v;
  };

  const t = {
    nodes: 0, anchorsParsed: 0, anchorsChecked: 0,
    anchorsFailed: 0, anchorsInPadding: 0,
    locOutOfRange: 0, fileMissing: 0, pastLoneCR: 0,
  };
  const failures = [];

  for (const n of chunk.nodes || []) {
    t.nodes++;
    const sf = n.source_file;
    const f = sf ? get(sf) : null;
    if (!f) {
      t.fileMissing++;
      failures.push(`${n.id}: source_file not on disk: ${sf}`);
      continue;
    }
    // source_location must be a real line number inside the real file.
    const mLoc = /^L(\d+)$/.exec(String(n.source_location || ''));
    if (!mLoc) {
      failures.push(`${n.id}: source_location ${JSON.stringify(n.source_location)} is not L<n>`);
    } else {
      const ln = Number(mLoc[1]);
      if (ln < 1 || ln > f.lines.length) {
        t.locOutOfRange++;
        failures.push(`${n.id}: source_location L${ln} out of range (${sf} has ${f.lines.length} lines)`);
      } else if (f.pad.some(([a, b]) => ln >= a && ln <= b)) {
        t.anchorsInPadding++;
        failures.push(`${n.id}: source_location L${ln} is inside a session-event padding block`);
      }
      if (f.crAt && ln > f.crAt) t.pastLoneCR++;
    }

    const r = n.rationale;
    if (typeof r !== 'string' && !Array.isArray(r)) continue;

    for (const p of (Array.isArray(r) ? r : [r])) {
      const anchors = parseAnchors(p);
      t.anchorsParsed += anchors.length;
      if (anchors.length === 0) {
        failures.push(`${n.id}: rationale contains ZERO parsed anchors: ${JSON.stringify(p.slice(0, 120))}`);
        continue;
      }
      for (let k = 0; k < anchors.length; k++) {
        const a = anchors[k];
        t.anchorsChecked++;
        const stop = k + 1 < anchors.length ? anchors[k + 1].start : p.length;
        const quoted = p.slice(a.end, stop).trim();
        if (quoted === '') {
          t.anchorsFailed++;
          failures.push(`${n.id}: anchor L${a.line} has an empty quoted span`);
          continue;
        }

        const af = get(a.file);
        if (!af) {
          t.anchorsFailed++;
          failures.push(`${n.id}: anchor path not on disk: ${a.file}`);
          continue;
        }
        if (a.line < 1 || a.line > af.lines.length) {
          t.anchorsFailed++;
          failures.push(`${n.id}: anchor L${a.line} out of range (${a.file} has ${af.lines.length} lines)`);
          continue;
        }
        if (af.crAt && a.line > af.crAt) t.pastLoneCR++;
        if (af.pad.some(([lo, hi]) => a.line >= lo && a.line <= hi)) {
          t.anchorsFailed++;
          t.anchorsInPadding++;
          failures.push(`${n.id}: anchor L${a.line} falls inside a session-event padding block`);
          continue;
        }
        // The verdict that binds: the cited line must CONTAIN the quoted span,
        // byte for byte. A keyword score cannot tell a real quote from a
        // plausible one.
        const hay = af.lines[a.line - 1];
        // A subagent writing `"the note said this"` puts the wrapping quotes
        // inside the rationale string, and the note's own inner quotes arrive
        // JSON-escaped. Both are the subagent's transcription, not the note's
        // words, so strip them before testing. Without this the check reports
        // 1,424 of 2,294 anchors as failing while quoting spans that match the
        // cited line exactly.
        const forms = unquoteForms(quoted);
        const hit = forms.find((f) => hay.includes(f));
        if (hit === undefined) {
          t.anchorsFailed++;
          failures.push(
            `${n.id}: anchor L${a.line} does NOT contain the quoted span verbatim\n` +
            `    quoted: ${JSON.stringify(quoted.slice(0, 150))}\n` +
            `    line  : ${JSON.stringify(hay.slice(0, 150))}`,
          );
        }
      }
    }
  }
  return { ...t, failures };
}
if (!import.meta.main) {
  // Imported for its functions (a subagent or another script reusing
  // parseAnchors). Bun runs this file top-level, so guard the CLI.
} else {
const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: check-anchors.mjs <batch-id> | --all [--quiet]');
  process.exit(2);
}
const all = argv[0] === '--all';
const quiet = argv.includes('--quiet');
if (!all && argv.length !== 1) {
  console.error('usage: check-anchors.mjs <batch-id> | --all [--quiet]');
  process.exit(2);
}

const names = all
  ? fs.readdirSync(DIR).filter((n) => /^chunk(-rem)?-\d+\.json$/.test(n)).sort()
  : [`chunk-${argv[0]}.json`];

let totParsed = 0, totChecked = 0, totFailed = 0, totPad = 0, totPastCR = 0, totNodes = 0;
let bad = 0, unparseable = 0, worst = null;

for (const name of names) {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) { console.error(`MISSING ${p}`); unparseable++; continue; }
  let r;
  try { r = checkChunk(p); } catch (e) {
    console.error(`UNPARSEABLE ${name}: ${e.message}`);
    unparseable++;
    continue;
  }
  totParsed += r.anchorsParsed; totChecked += r.anchorsChecked;
  totFailed += r.anchorsFailed; totPad += r.anchorsInPadding;
  totNodes += r.nodes; totPastCR += r.pastLoneCR;
  if (r.anchorsFailed > 0) { bad++; if (!worst || r.anchorsFailed > worst.n) worst = { name, n: r.anchorsFailed }; }
  if (r.anchorsFailed > 0 || !quiet || !all) {
    const flag = r.anchorsFailed > 0 ? 'FAIL' : r.anchorsParsed === 0 ? 'ZERO' : ' ok ';
    console.log(
      `${flag} ${name.replace(/\.json$/, '').padEnd(18)} ` +
      `${String(r.nodes).padStart(3)} nodes  ` +
      `${String(r.anchorsParsed).padStart(3)} parsed  ` +
      `${String(r.anchorsChecked).padStart(3)} checked  ` +
      `${String(r.anchorsFailed).padStart(3)} failed  ` +
      `${String(r.anchorsInPadding).padStart(3)} in-pad  ` +
      `${String(r.pastLoneCR).padStart(3)} past-CR`,
    );
    for (const f of r.failures.slice(0, all ? 3 : 20)) console.log('      ' + f.replace(/\n/g, '\n      '));
    if (all && r.failures.length > 3) console.log(`      … and ${r.failures.length - 3} more`);
  }
}

console.log(
  `\n${all ? 'CORPUS' : 'CHUNK'}: ${totNodes} nodes, ${totParsed} anchors parsed, ` +
  `${totChecked} checked, ${totFailed} failed, ${totPad} in padding, ${totPastCR} anchors past a lone CR`,
);
if (all) console.log(`${names.length - bad - unparseable}/${names.length} chunks clean` + (worst ? `, worst ${worst.name} at ${worst.n}` : ''));
if (unparseable > 0) console.log(`${unparseable} file(s) missing or unparseable`);
process.exit(totFailed > 0 || unparseable > 0 ? 1 : 0);
}
