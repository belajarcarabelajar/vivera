// scripts/validate-lib.mjs
//
// Pure, importable subset of scripts/validate-skill.mjs, plus renderMermaidBatch,
// which spawns the mmdc it is given so tests can inject a fake one.
//
// validate-skill.mjs is a 900-line gate script with top-level side effects
// (execSync, process.exit, minutes-long mmdc render), so it cannot be imported
// by a unit test. The check logic below is extracted here verbatim so tests can
// pin it: a check that cannot fail is not a check.
//
// validate-skill.mjs must import from this module rather than redefining the
// same constants. scripts/validate-skill.test.mjs asserts that wiring so the
// two copies cannot drift apart.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export const SUBAGENT_CONTRACT_TERMS = [
  'SUBAGENT-FIRST',
  'TASK-CHUNKING',
  'BATCH MANIFEST',
  'HIGH FAN-OUT FLOOR',
  'NON-OVERLAPPING',
  'NESTED FAN-OUT',
  'GATHER & SYNTHESIZE',
  'PARENT DIFF AUDIT GATE',
  'subagent-contract-template.md',
];

export const TINYFISH_LADDER_NEED = ['TinyFish', 'search', 'fetch_content'];

export const BANNED_RUNTIME_SNIPPETS = ['node scripts/', 'npm install', 'npm test', 'npx '];

// Per-snippet phase terms. Every snippet drives delegated work, so the fan-out
// terms above are shared; these extras make each snippet's own phase
// enforceable. orkestrasi-pr-review.md was missing here until 2026-10-01:
// it was tracked in snippets.manifest.json but bypassed every content check.
export const SNIPPET_CONTRACTS = {
  'orkestrasi-ngoding-plan.md': [
    'KEEP THE TO-DO LIST IN THE PLAN FILE',
    'plan-issue-sync.mjs',
    'session-learning-ledger-template.md',
    'MEMORY.md',
    'graphify:sync',
  ],
  'orkestrasi-debugging.md': [
    'KEEP THE TO-DO LIST IN THE PLAN FILE',
    'plan-issue-sync.mjs',
    'session-learning-ledger-template.md',
    'MEMORY.md',
    'graphify:sync',
  ],
  'orkestrasi-pr.md': [
    'KEEP THE TO-DO LIST IN THE PLAN FILE',
    'pr-registry.mjs claim',
    'worktree add',
    'GIT WRITES ARE PARENT-ONLY',
    'pull-request-template.md',
    '--body-file',
    'pr-registry.mjs order',
    'pr-review-template.md',
    'plan-issue-sync.mjs', // the plan's issue closes after the debt sweep, not before
    'session-learning-ledger-template.md',
    'MEMORY.md',
    'graphify:sync',
    'merged | closed',
  ],
  'orkestrasi-pr-review.md': [
    'KEEP THE TO-DO LIST IN THE PLAN FILE',
    'pr-review-template.md',
    'code-review-template.md',
    'gh pr diff',
    'gh pr checks',
    'graphify:sync',
    // The review target arrives by clipboard substitution, so the contract has to
    // pin the resolver and its stop rule. Without these terms a later edit could
    // quietly drop TARGET RESOLUTION and leave `#{clipboard}` unhandled in the
    // snippet an agent actually receives.
    '#{clipboard}',
    'TARGET RESOLUTION RUNS FIRST',
    'Never guess a nearby PR number',
    // Single AND batch are both required paths; the batch terms are what stop a
    // multi-PR expansion from collapsing into "review them all, merge them all".
    'BATCH BEHAVIOUR',
    'One verdict per PR, never one verdict for the batch',
    'Merges stay strictly sequential even when reviews were parallel',
    // The `--admin` exception. These terms are pinned because the exception is
    // the one part of this snippet that grants itself permission, and a later
    // edit that trimmed the four measurements would re-create a silent
    // authority to skip a review. Pinning the heading keeps the rule and its
    // conditions from being separable.
    'THE ADMIN\'S OWN APPROVAL ALWAYS PASSES',
    'gh api repos/<o>/<r>/collaborators --jq length',
    'Review Can not approve your own pull request',
  ],
  'orkestrasi-brainstorm.md': [
    'KEEP THE TO-DO LIST IN THE PLAN FILE',
    'brainstorm-intent-template.md',
    'question',
    'graphify:sync',
  ],
  // Unattended run. The plan arrives by clipboard substitution, so the resolver
  // and its stop rule are pinned like the review target in orkestrasi-pr-review.md.
  // The NEVER list and the retry budget are the parts that replace a human, so
  // a later edit that trimmed them would leave nobody watching and nothing limiting.
  'orkestrasi-overnight.md': [
    'KEEP THE TO-DO LIST IN THE PLAN FILE',
    'pr-registry.mjs claim',
    'GIT WRITES ARE PARENT-ONLY',
    'pull-request-template.md',
    '--body-file',
    'graphify:sync',
    '#{clipboard}',
    'ENTRY GATE RUNS FIRST',
    'THE HANDOFF IS THE RUN RECORD',
    'the first file you write is the handoff',
    'Rewrite `Last update` each time',
    'A failed entry check still writes nothing',
    'replace `Result: running` with the result',
    'before any code is written',
    'RETRY BUDGET',
    'A TURN WITH NO TOOL CALL IS A REPORT',
    'Refuse four endings while work is owed',
    'After three re-prompts',
    'a deadline recorded in the plan has passed',
    'none of this relaxes the NEVER list below',
    'NEVER, WHATEVER HAPPENS DURING THE NIGHT',
    'merge into the base branch',
    'no follow-up executes unselected',
    'overnight-handoff.md',
  ],
};

// The short cmd-* command snippets. They are not phase triggers, so the fan-out
// terms and the TinyFish ladder do not apply; each pins only the phrases that
// make it what it is, taken from its own text.
export const COMMAND_SNIPPET_CONTRACTS = {
  'cmd-approved.md': ['Carry this to completion', 'without asking again', 'destructive or hard-to-reverse'],
  'cmd-audit.md': ['Read-only audit', 'Do not edit, install, delete, commit', 'ranked list of proposed changes'],
  'cmd-cleanup.md': ['git merge-base --is-ancestor', 'git branch -d', 'never `-D`', 'Never `rm -rf`', 'Leave remote branches alone'],
  'cmd-done-verify.md': ['Verify it yourself, read-only', 'positive control', 'not verified'],
  'cmd-error-continue.md': ['At most 2 attempts per chunk', '--no-verify', 'shared cause'],
  'cmd-fallback.md': ['Do not loop on it', 'run_web_automation', 'do not substitute a local run'],
  'cmd-merge.md': ['nothing else', '--admin', 'bun scripts/pr-registry.mjs state <session> merged', 'Do not deploy, publish, or delete branches or worktrees'],
  'cmd-resume.md': ['Resume this session from its plan file', 'skip_if', 'where you resumed'],
  'cmd-review-merge.md': ['Pre-authorized: review and merge if safe', 'AUTO-MERGE gate'],
  'cmd-status.md': ['Status check, read-only', 'bun scripts/pr-registry.mjs status', 'do not poll in a loop'],
};

export const REQUIRED_SNIPPETS = Object.keys(SNIPPET_CONTRACTS);

/** Terms from `terms` absent in `body` (substring match, same as validator). */
export function findMissingTerms(body, terms) {
  return terms.filter((term) => !body.includes(term));
}

/** All missing contract terms for a snippet body (shared + phase-specific). */
export function checkSnippetContract(body, extraTerms) {
  return findMissingTerms(body, [...SUBAGENT_CONTRACT_TERMS, ...extraTerms]);
}

export function checkTinyFishLadder(body) {
  return findMissingTerms(body, TINYFISH_LADDER_NEED);
}

export function checkBannedRuntime(body) {
  return BANNED_RUNTIME_SNIPPETS.filter((needle) => body.includes(needle));
}

// --- mermaid fence (strict, shared with scripts/render-diagrams.sh) ---------
//
// The renderer extracts with awk `/^```mermaid[ \t]*$/` (open) and
// `/^```[ \t]*$/` (close). The validator previously used loose
// `/```mermaid[\s\S]*?```/`, which accepts fences the renderer never extracts
// (e.g. ```mermaid {extra}) — a block that validates but never renders.
// These patterns implement the strict form both sides must agree on.

// String forms of the awk patterns in render-diagrams.sh, for the agreement test.
export const RENDERER_OPEN_AWK = '/^```mermaid[ \\t]*$/';
export const RENDERER_CLOSE_AWK = '/^```[ \\t]*$/';

const STRICT_OPEN_RE = /^```mermaid[ \t]*$/;
const STRICT_CLOSE_RE = /^```[ \t]*$/;

/** True when content holds at least one strict renderer-compatible fence. */
export function hasStrictMermaidFence(content) {
  return content.split('\n').some((line) => STRICT_OPEN_RE.test(line));
}

/**
 * Extract strict fence bodies, mirroring the awk extraction in
 * render-diagrams.sh: open line must be exactly ```mermaid (+ trailing
 * spaces/tabs), close line exactly ``` (+ trailing spaces/tabs).
 * Unclosed blocks are dropped, same as awk (buf never flushed).
 */
export function extractMermaidBlocksStrict(content) {
  const blocks = [];
  let inside = false;
  let buf = [];
  for (const line of content.split('\n')) {
    if (!inside && STRICT_OPEN_RE.test(line)) {
      inside = true;
      buf = [];
      continue;
    }
    if (inside && STRICT_CLOSE_RE.test(line)) {
      blocks.push(buf.join('\n').trim());
      inside = false;
      continue;
    }
    if (inside) buf.push(line);
  }
  return blocks;
}

// --- batched mermaid render ---------------------------------------------------

function firstStderrLine(res) {
  return res.stderr?.toString().trim().split('\n')[0] || res.error?.message || 'unknown error';
}

/**
 * Render every block with one mmdc call (one Chromium launch) by feeding mmdc a
 * markdown file; mmdc writes <out>-<n>.svg in block order. A failing batch does
 * not say which block broke, so on a non-zero exit or a missing SVG the set is
 * split in two and each half rendered as its own batch, recursing until a set
 * of one is rendered alone and reports its own error. One broken block in n
 * costs about 1 + 2*log2(n) calls instead of 1 + n.
 * Returns { results: [{ ok: true, svg } | { ok: false, error }], calls }.
 */
export function renderMermaidBatch(blocks, { mmdc, args = [], tmpDir }) {
  let calls = 0;
  let sets = 0;
  const run = (input, output) => {
    calls++;
    return spawnSync(mmdc, [...args, '-i', input, '-o', output], { stdio: 'pipe' });
  };
  // Every set gets its own directory: halves reuse the names out-1.svg and up,
  // so a shared directory would let a half read an SVG left by another half.
  const freshDir = () => {
    const dir = path.join(tmpDir, `set-${++sets}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const renderOne = (block) => {
    const dir = freshDir();
    const input = path.join(dir, 'block.mmd');
    const output = path.join(dir, 'block.svg');
    fs.writeFileSync(input, block);
    const res = run(input, output);
    if (res.status !== 0 || !fs.existsSync(output)) return { ok: false, error: firstStderrLine(res) };
    return { ok: true, svg: fs.readFileSync(output, 'utf8') };
  };

  const renderSet = (set) => {
    if (set.length === 0) return [];
    if (set.length === 1) return [renderOne(set[0])];
    const dir = freshDir();
    const batchIn = path.join(dir, 'batch.md');
    fs.writeFileSync(batchIn, set.map((b) => '```mermaid\n' + b + '\n```\n').join('\n'));
    const batch = run(batchIn, path.join(dir, 'out.md'));
    if (batch.status === 0) {
      const svgPaths = set.map((_, i) => path.join(dir, `out-${i + 1}.svg`));
      if (svgPaths.every((p) => fs.existsSync(p))) {
        return svgPaths.map((p) => ({ ok: true, svg: fs.readFileSync(p, 'utf8') }));
      }
    }
    const mid = Math.ceil(set.length / 2);
    return [...renderSet(set.slice(0, mid)), ...renderSet(set.slice(mid))];
  };

  const results = renderSet(blocks);
  return { results, calls };
}

// --- gate catalog shape -------------------------------------------------------

// The Claude Code question tool rejects a header longer than 12 characters.
const GATE_HEADER_MAX = 12;
const GATE_ROWS_MIN = 10;
// Rows whose action is risky: the safe option comes first, so none of them may
// mark an option (Recommended), which would make Enter accept the action.
const GATE_RISKY_HEADERS = new Set(['Publish', 'Merge', 'Destructive', 'Promote']);
// Rows that are not a fixed two-option question: Blocked lists one option per way
// forward, Follow-ups is a multi-select.
const GATE_UNMARKED_HEADERS = new Set(['Blocked', 'Follow-ups']);
// Matches the first three columns only, so a table that lost its Basis column is still
// found and reported as missing that column instead of as "not found".
const GATE_TABLE_HEAD_RE = /^\|\s*Gate\s*\|\s*Header\s*\|\s*Options, in order\s*\|/;

/**
 * Check the shape of the gate catalog table in skills/sucp-rules/SKILL.md.
 * Options are not counted: labels contain commas ("Cancel, do nothing"), so a
 * split would be unreliable. The fourth column, Basis, must exist and be non-empty
 * in every row. Returns problem strings; empty means fine.
 */
export function checkGateCatalog(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => GATE_TABLE_HEAD_RE.test(line));
  if (start === -1) return ['table: the gate catalog (| Gate | Header | Options, in order |) was not found'];

  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

  // Line start + 1 is the separator; the table ends at the first line that is not a row.
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    rows.push(splitRow(lines[i]));
  }

  const problems = [];
  if (rows.length < GATE_ROWS_MIN) {
    problems.push(`table: ${rows.length} data rows found, at least ${GATE_ROWS_MIN} are required`);
  }

  // Without the column every row would also lack the cell, so only the table is reported.
  const hasBasis = splitRow(lines[start])[3] === 'Basis';
  if (!hasBasis) problems.push('table: the header has no Basis column');

  const seen = new Set();
  rows.forEach((cells, index) => {
    const header = (cells[1] ?? '').replace(/`/g, '').trim();
    const options = cells[2] ?? '';
    const label = header || `row ${index + 1}`;

    const expectedCells = hasBasis ? 4 : 3;
    if (cells.length < 3) {
      problems.push(`${label}: row has ${cells.length} cells, expected ${expectedCells}`);
      return;
    }
    // A pipe inside a cell splits it, so a long Basis would otherwise be read as its first part only.
    if (hasBasis && cells.length > expectedCells) {
      problems.push(`${label}: row has ${cells.length} cells, expected ${expectedCells}`);
    }
    if (!header) problems.push(`${label}: header is empty`);
    if (header.length > GATE_HEADER_MAX) {
      problems.push(`${label}: header is ${header.length} characters, the limit is ${GATE_HEADER_MAX}`);
    }
    if (header && seen.has(header)) problems.push(`${label}: duplicate header`);
    seen.add(header);
    if (hasBasis && !(cells[3] ?? '')) problems.push(`${label}: the Basis cell is empty`);
    if (!options) {
      problems.push(`${label}: options cell is empty`);
      return;
    }

    const marked = options.includes('(Recommended)');
    if (GATE_RISKY_HEADERS.has(header)) {
      if (marked) problems.push(`${label}: risky row must not carry (Recommended), safe-option-first rule`);
    } else if (!GATE_UNMARKED_HEADERS.has(header) && !marked) {
      problems.push(`${label}: options must mark one (Recommended)`);
    }
  });
  return problems;
}
