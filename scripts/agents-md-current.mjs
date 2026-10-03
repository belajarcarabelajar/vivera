// scripts/agents-md-current.mjs
//
// Does a repo's `## graphify` section still say what the INSTALLED graphify says?
//
// This exists because of a specific, measured falsehood. Two repos on this
// machine — ai-skills and the Obsidian vault — carry an always-on block that
// opens with:
//
//     No knowledge graph has been built in this directory yet: `graphify-out/`
//     does not exist. The graph is built on demand, so never assume one is
//     present — check `test -f graphify-out/graph.json` before relying on it.
//
// Both of those repos DO have a graph: 644 KB in ai-skills (with
// `built_at_commit` equal to HEAD) and 5.7 MB in the vault. The sentence is
// stale text from an older graphify release that no reinstall removed, and the
// installed 0.9.73 ships wording which correctly says the project HAS a graph.
// Nothing about the graph itself is wrong. What is wrong is the instruction an
// agent session reads before it decides whether to open the graph at all.
//
// The failure is silent and one-directional, which is why it needs a detector
// rather than a reminder. A MISSING block is self-correcting: no instruction, so
// the agent asks or falls back to grep. A STALE block is worse than missing —
// the agent reads confident prose asserting the graph is absent, skips
// `graphify query`, and answers from grep with no indication that a documented
// capability was skipped. Every part of that looks like success.
//
// So the comparison has to be against the installed file, byte for byte, and the
// extraction has to be byte-for-byte compatible with the thing that writes it.
// graphify's `_replace_or_append_section` owns the definition of "the section":
// from a line that IS exactly the marker heading to the line before the next
// line starting with `## `, with the LAST exact heading winning. Two edges of
// that rule have already cost something upstream and are reproduced here rather
// than re-derived:
//
//   1. The marker matches a WHOLE LINE (compared after strip), never as a
//      substring. An unanchored match inside a bullet once anchored the replace
//      on that mention and deleted every line from there to the next heading —
//      hand-written content, gone, no error (#1688).
//   2. The boundary is `line.startswith('## ')` on the RAW line, no strip. A
//      checker that strips before testing ends the section at an indented `## `
//      inside an example block, truncates it mid-body, and then reports drift
//      for a section that the installer would leave alone.
//
// A checker whose span differs from the installer's is worse than no checker: it
// invents drift where there is none, and a false alarm is how a real one gets
// ignored.
//
// Two states are reported distinctly because they have opposite repairs: no
// `## graphify` heading at all (graphify never ran here) versus a heading whose
// body disagrees with the installed block (graphify ran, and its output is
// behind). Both are `current: false`; only the `reason` distinguishes them, and
// `reason` is the part a human reads.
//
// Revert: delete this file and its test. Nothing else imports them yet; the fix
// itself is `graphify install`, not this module.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Fallback location of the packaged always-on block.
 *
 * Tied to the uv tool layout under the machine home (`~/.local/share/uv/tools/
 * <tool>/lib/python<XY>/site-packages`), so it needs updating whenever graphifyy
 * is reinstalled against a different interpreter version: a reinstall into
 * python3.15 moves this path without any other visible sign. It is a fallback,
 * not the primary: the real
 * lookup is `discoverAlwaysOnBlock()`, which derives the path from the resolved
 * `graphify` executable and so survives a version bump. Kept exported because a
 * test wants to be able to say where it looked.
 */
export const UV_TOOL_SITE_PACKAGES = path.join(
  os.homedir(),
  '.local/share/uv/tools/graphifyy/lib/python3.14/site-packages',
);

/**
 * Locate the packaged `agents-md.md`, i.e. the exact bytes a repo's `## graphify`
 * section is supposed to be.
 *
 * Discovered rather than hardcoded wherever possible. `graphify` is a uv tool
 * install, so its real path is `<tool>/bin/graphify`; two levels up is `<tool>`,
 * and the package sits under `<tool>/lib/python<XY>/site-packages/graphify/`. The
 * `python<XY>` segment is enumerated rather than interpolated because the
 * interpreter minor version is uv's choice, not ours.
 *
 * `which` rather than a hardcoded `$HOME/.local/bin`: the symlink target is what
 * matters, and `readlink -f` on it is the only step that gets past the shim.
 *
 * @returns {string} an existing path if one was found, else the fallback — never
 *   null, so a caller can report the path it tried instead of crashing on a
 *   missing file before it has a sentence to report.
 */
export function discoverAlwaysOnBlock() {
  const found = [];

  const which = spawnSync('which', ['graphify'], { encoding: 'utf8' });
  const shim = String(which.stdout ?? '').split('\n')[0]?.trim();
  if (shim) {
    let exe = shim;
    try {
      exe = fs.realpathSync(shim);
    } catch {
      // A dangling or unreadable shim is not fatal: the fallback below may still
      // be right, and a crash here would hide the very path we want to report.
    }
    const toolRoot = path.dirname(path.dirname(exe));
    let pythonDirs = [];
    try {
      pythonDirs = fs.readdirSync(path.join(toolRoot, 'lib'));
    } catch {
      pythonDirs = [];
    }
    for (const dir of pythonDirs.filter((d) => /^python\d/.test(d)).sort().reverse()) {
      found.push(path.join(toolRoot, 'lib', dir, 'site-packages', 'graphify', 'always_on', 'agents-md.md'));
    }
  }

  found.push(path.join(UV_TOOL_SITE_PACKAGES, 'graphify', 'always_on', 'agents-md.md'));
  return found.find((p) => fs.existsSync(p)) ?? found[found.length - 1];
}

/**
 * Path to the installed always-on block, resolved at import.
 *
 * Exported so tests and reports can name the file they compared against — a
 * drift verdict that does not say which reference it used is not reproducible.
 */
export const ALWAYS_ON_BLOCK = discoverAlwaysOnBlock();

/**
 * Line-ending and whitespace normalisation, for COMPARISON only.
 *
 * Three things are collapsed, and the list is short on purpose:
 *
 *   - CRLF and lone CR onto LF. git's `core.autocrlf` is per-machine, so without
 *     this the same repository is "current" on Linux and drifting on Windows,
 *     which trains everyone to ignore the signal.
 *   - Trailing whitespace per line. Invisible in a diff, and the thing an editor
 *     leaves behind when it touches a block it never meant to change.
 *   - Blank padding at the start and end, which is the blank-line separator the
 *     installer writes around the section.
 *
 * Interior blank lines are NOT collapsed, and a non-string returns ''. Both are
 * refusals. Collapsing interior blank lines would make a block that lost a
 * paragraph compare equal to one that kept it — the silent-drift case this whole
 * module exists to catch. Throwing on `null` would take the check down over a
 * file read that produced nothing, which is containment failure.
 *
 * Idempotent by construction, because a report here gets rendered, summarised
 * and re-diffed, and each of those steps may run it again.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalise(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Extract the marker-anchored section, mirroring graphify's
 * `_replace_or_append_section` exactly.
 *
 * The rule, and the reason it is copied rather than approximated:
 *
 *   - Split on `\n` and collect every index whose line, AFTER `trim()`, IS the
 *     marker. A line that merely contains the marker text is not an anchor
 *     (#1688). `trim()` on the anchor but NOT on the boundary is not an
 *     oversight — that asymmetry is what the installer does, and matching it is
 *     the point.
 *   - Take the LAST such index, because graphify appends its section and a
 *     pre-#1688 install can leave more than one behind.
 *   - Walk forward for the first line that `startsWith('## ')` on the RAW line.
 *     That index is the exclusive end. If none exists the section runs to EOF,
 *     which is the ai-skills layout and the vault's (its `## graphify` is the last
 *     H2 of 125 lines, at 111).
 *
 * Trailing blank lines inside the span are dropped so the result compares equal
 * to `new_section.strip()`, which is what the installer writes.
 *
 * @param {string} content whole file text
 * @param {string} [marker] the heading line, `## graphify` by default
 * @returns {string|null} the section including its heading line, or null when no
 *   exact heading exists — a state that is NOT "unchanged".
 */
export function extractSection(content, marker = '## graphify') {
  if (typeof content !== 'string') return null;

  const lines = content.split('\n');
  const starts = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === marker) starts.push(i);
  }
  if (starts.length === 0) return null;

  const start = starts[starts.length - 1];
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j += 1) {
    if (lines[j].startsWith('## ')) {
      end = j;
      break;
    }
  }

  return lines.slice(start, end).join('\n').replace(/\s+$/, '');
}

/**
 * The false claim both repos carry, as a pattern.
 *
 * Matched loosely on purpose — `graphify-out/` and `does not exist` need not be
 * on the same line, and the wording will drift again with the next release. What
 * it must not do is fire on ordinary prose, or the "first differing line" reason
 * below would be replaced by a misdiagnosis.
 */
const STALE_CLAIM = /no knowledge graph has been built|graphify-out\/`?\s*does\s*\n?\s*not exist/i;

/** Named in a failure message so a thrown error says which module threw. */
const TAG = 'agents-md-current';

/**
 * Why the two texts differ, in one sentence a human can act on.
 *
 * The known false claim is named as such, and — only when `graphify-out/graph.json`
 * is actually on disk under the repo — the claim is named as contradicted. Saying
 * "while graphify-out/graph.json is present" about a repo that has no graph would
 * be this module inventing evidence, which is the same failure class it exists to
 * catch.
 *
 * Everything else falls back to the first differing line, because "differs" is a
 * shrug and a line number is a position.
 */
function describeDifference(found, expected, hasGraph) {
  if (STALE_CLAIM.test(found)) {
    const claim = 'the section claims no knowledge graph has been built here, i.e. graphify-out/ is absent';
    return hasGraph
      ? `${claim}, but graphify-out/graph.json is present on disk`
      : `${claim}, and there is no graph here, so the installed block would be wrong too`;
  }

  const a = found.split('\n');
  const b = expected.split('\n');
  const at = Math.max(a.length, b.length);
  for (let i = 0; i < at; i += 1) {
    if (a[i] !== b[i]) {
      const got = a[i] === undefined ? '(section ends)' : a[i].trim();
      const want = b[i] === undefined ? '(installed block ends)' : b[i].trim();
      return `line ${i + 1} differs: the repo says ${JSON.stringify(got)} where the installed block says ${JSON.stringify(want)}`;
    }
  }
  return 'the texts differ only in whitespace that survived normalisation';
}

/**
 * Compare a repo's `## graphify` section against the installed block.
 *
 * @param {string} repoRoot directory containing the AGENTS.md
 * @param {object} [opts]
 * @param {string} [opts.fileName] defaults to `AGENTS.md`; the same block is
 *   written into CLAUDE.md and friends by other platforms.
 * @param {string} [opts.marker] defaults to `## graphify`.
 * @param {string} [opts.expectedPath] defaults to the installed block; a caller
 *   passes this to compare against a fixture.
 * @returns {{current: boolean, found: string|null, expected: string, reason: string}}
 */
export function checkAgentsMd(repoRoot, opts = {}) {
  const expectedPath = opts.expectedPath ?? ALWAYS_ON_BLOCK;

  // Read the reference BEFORE looking at the repo. An unreadable reference is
  // environment breakage, not drift, and reporting it as drift points the repair
  // at the wrong repository entirely.
  let expected;
  try {
    expected = fs.readFileSync(expectedPath, 'utf8');
  } catch (err) {
    throw new Error(`${TAG}: cannot read the expected graphify block at ${expectedPath}: ${err.message}`, { cause: err });
  }

  const fileName = opts.fileName ?? 'AGENTS.md';
  const file = path.join(repoRoot, fileName);
  if (!fs.existsSync(file)) {
    return {
      current: false,
      found: null,
      expected,
      reason: `${fileName} does not exist in ${repoRoot}, so there is no graphify block to compare`,
    };
  }

  const found = extractSection(fs.readFileSync(file, 'utf8'), opts.marker ?? '## graphify');
  if (found === null) {
    return {
      current: false,
      found: null,
      expected,
      reason: `no \`${opts.marker ?? '## graphify'}\` heading found in ${fileName}, so the always-on graphify block is absent entirely`,
    };
  }

  const same = normalise(found) === normalise(expected);
  if (same) {
    return { current: true, found, expected, reason: 'the section matches the installed graphify block' };
  }

  const hasGraph = fs.existsSync(path.join(repoRoot, 'graphify-out', 'graph.json'));
  return { current: false, found, expected, reason: describeDifference(normalise(found), normalise(expected), hasGraph) };
}