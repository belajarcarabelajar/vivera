// scripts/validate-lib.mjs
//
// Pure, importable subset of scripts/validate-skill.mjs.
//
// validate-skill.mjs is a 900-line gate script with top-level side effects
// (execSync, process.exit, minutes-long mmdc render), so it cannot be imported
// by a unit test. The check logic below is extracted here verbatim so tests can
// pin it: a check that cannot fail is not a check.
//
// validate-skill.mjs must import from this module rather than redefining the
// same constants. scripts/validate-skill.test.mjs asserts that wiring so the
// two copies cannot drift apart.

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
    'todowrite',
    'plan-issue-sync.mjs',
    'session-learning-ledger-template.md',
    'MEMORY.md',
    'graphify:sync',
  ],
  'orkestrasi-debugging.md': [
    'todowrite',
    'plan-issue-sync.mjs',
    'session-learning-ledger-template.md',
    'MEMORY.md',
    'graphify:sync',
  ],
  'orkestrasi-pr.md': [
    'todowrite',
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
    'todowrite',
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
  ],
  'orkestrasi-brainstorm.md': [
    'todowrite',
    'brainstorm-intent-template.md',
    'question',
    'graphify:sync',
  ],
};

export const REQUIRED_SNIPPETS = Object.keys(SNIPPET_CONTRACTS);

// --- generic helpers -------------------------------------------------------

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
