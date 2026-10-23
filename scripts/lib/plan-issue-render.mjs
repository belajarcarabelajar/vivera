// scripts/lib/plan-issue-render.mjs
//
// How a plan is rendered as a GitHub issue: the title, the body, and the machine
// trailer. Split out of scripts/plan-issue-sync.mjs, which re-exports everything
// here, so callers and tests keep importing from the old path. Pure functions
// only: nothing here reads a file or talks to GitHub.

// dup-defs: allow moved unchanged from plan-issue-sync.mjs; the issue mirror keeps its own frontmatter split, independent of the vault publisher
export function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: text };
  return { frontmatter: text.slice(3, end), body: text.slice(end + 4) };
}

// dup-defs: allow moved unchanged from plan-issue-sync.mjs; the issue trailer hash is its own change detector, independent of the vault source_hash
export function hashOf(text) {
  // FNV-1a. This is a change detector, not a security primitive: it only has to
  // answer "is this byte-identical to what the issue body was built from".
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------- the issue title and body ----------

// The layout version of the rendered issue. It is recorded in the sidecar and in
// the trailer, so a change to how the issue is rendered rewrites every recorded
// issue on its next sync even when the plan text did not change. Version 1 (no
// `format=` in the trailer) was the raw plan with its frontmatter on top and the
// plan_id as the title.
export const ISSUE_FORMAT = 2;

// The label every plan issue carries, so plan mirrors can be filtered apart from
// hand-written issues.
export const PLAN_LABEL = 'plan';
export const PLAN_LABEL_COLOR = '5319E7';
export const PLAN_LABEL_DESCRIPTION = 'Mirror of a plan file, written by plan-issue-sync';

// GitHub caps an issue title at 256 characters.
const TITLE_LIMIT = 256;

// Lines outside fenced code blocks, so a `# heading` or a `- [ ]` quoted inside a
// code example is not read as the plan's own.
function proseLines(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (fence === null) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence === null) out.push(line);
  }
  return out;
}

// The title is the plan's own first-level heading: a reader scanning the issue
// list sees what the plan does, not a date slug. The plan_id stays in the header
// and the trailer, which is where identity is checked. A plan with no heading
// keeps the plan_id.
export function issueTitle(planText, id) {
  const { body } = splitFrontmatter(planText);
  const h1 = proseLines(body).find((l) => /^#\s+\S/.test(l));
  const title = h1 ? h1.replace(/^#\s+/, '').replace(/\s+#+\s*$/, '').trim() : id;
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
}

// Checkbox progress, counted from the plan text itself, so it can never disagree
// with the plan the way a hand-written status line could.
export function checklistCounts(planText) {
  const { body } = splitFrontmatter(planText);
  let done = 0;
  let total = 0;
  for (const line of proseLines(body)) {
    const m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s/);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

// A fence longer than any backtick run inside the text, so the frontmatter can
// never close its own block early.
function fenceFor(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

// The body is the plan, rendered for a human reader. Everything in it is either
// the plan's own text, verbatim, or derived from that text by a fixed rule, so
// there is still no second source of truth that can drift. A hand-written
// summary stays banned. The order:
//   1. a derived header: what this issue is, where the plan lives, its status
//      and checklist progress (all read from the plan, so covered by its hash);
//   2. the plan body after the frontmatter, verbatim;
//   3. the runner frontmatter, verbatim, folded in <details>, because it is
//      machine input and used to fill the first screens of the issue;
//   4. the machine trailer.
// Field-name prefixes in the trailer, not bare positional values. A bare
// `key=<value>` is indistinguishable from a value that happens to contain
// `key=`, and the prefixes are what make the trailer readable to a human
// scanning the raw issue.
export function issueBody(planText, { planId: id, key, sourcePath, status, generatedBy }) {
  const trailer = [
    '---',
    '',
    `<!-- plan-sync: plan_id=${id} | key=${key} | source=${sourcePath} | status=${status ?? 'unknown'} | hash=${hashOf(planText)} | by=${generatedBy ?? 'plan-issue-sync'} | format=${ISSUE_FORMAT} -->`,
    '',
  ].join('\n');

  const { frontmatter, body } = splitFrontmatter(planText);
  const text = body.replace(/^\s*\n/, '').replace(/\s*$/, '');
  const fm = frontmatter.replace(/^\n/, '').replace(/\s*$/, '');
  const { done, total } = checklistCounts(planText);
  const header = [
    `> This issue mirrors the plan \`${key}\` and is rewritten from it on every sync. `
      + 'Edit the plan, not this issue; use comments for discussion.',
    '',
    '| Plan ID | Status | Checklist |',
    '|---|---|---|',
    `| \`${id}\` | ${status ?? 'unknown'} | ${total ? `${done} of ${total} done` : 'none'} |`,
    '',
    '',
  ].join('\n');
  const fence = fenceFor(fm);
  const folded = fm
    ? `\n\n<details>\n<summary>Runner frontmatter (machine input)</summary>\n\n${fence}yaml\n${fm}\n${fence}\n\n</details>\n`
    : '\n';

  const full = `${header}${text}${folded}${trailer}`;
  if (githubLength(full) <= ISSUE_BODY_BUDGET) return full;

  // Too long: the folded frontmatter goes first, because it is machine input that
  // lives in the plan file anyway, and the prose a reader came for stays whole.
  const omitted = fm
    ? `\n\n**Omitted:** the runner frontmatter (${fm.length} characters) to fit GitHub's 65,536-character body limit. It is in \`${key}\` in the repository.\n`
    : '\n';
  const lean = `${header}${text}${omitted}`;
  if (githubLength(`${lean}${trailer}`) <= ISSUE_BODY_BUDGET) return `${lean}${trailer}`;

  // Still the plan, never a summary: the longest verbatim prefix of the body that
  // fits, an explicit marker, and the trailer whose hash covers the FULL plan, so
  // drift detection is unchanged. The marker is sized with M in place of N
  // because N <= M, which makes the room an upper bound.
  const marker = (n) => `**Truncated:** this issue shows the first ${n} of ${text.length} characters of the plan body, `
    + `cut at a line boundary to fit GitHub's 65,536-character body limit. The full plan is \`${key}\` in the repository.`;
  const tail = (n) => `${omitted}\n${marker(n)}\n\n${trailer}`;
  const room = ISSUE_BODY_BUDGET - githubLength(header) - githubLength(tail(text.length));
  // githubLength(text.slice(0, i)) is i plus the newlines before i, tracked as `lines`.
  let cut = 0;
  let lines = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i + lines <= room; i = text.indexOf('\n', i + 1)) {
    cut = i;
    lines++;
  }
  if (cut === 0) {
    cut = room;
    if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
  }
  return `${header}${text.slice(0, cut)}${tail(cut)}`;
}

// GitHub caps an issue body at 65,536 characters. A stored body may have its
// line endings normalized to CRLF, so each LF counts twice, and the headroom
// absorbs any remaining difference in how GitHub counts.
const ISSUE_BODY_LIMIT = 65536;
const ISSUE_BODY_BUDGET = ISSUE_BODY_LIMIT - 512;

function githubLength(s) {
  let n = s.length;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

export function parseTrailer(body) {
  // The last one: issueBody appends the trailer, so an earlier match is plan text quoting an example.
  // `format=` is optional: a version 1 trailer has none, and reads as format 1.
  const all = [...(body || '').matchAll(/<!--\s*plan-sync:\s*plan_id=(.*?)\s*\|\s*key=(.*?)\s*\|\s*source=(.*?)\s*\|\s*status=(.*?)\s*\|\s*hash=(.*?)\s*\|\s*by=(.*?)(?:\s*\|\s*format=(\d+))?\s*-->/g)];
  const m = all.at(-1);
  if (!m) return null;
  return {
    plan_id: m[1].trim(),
    key: m[2].trim(),
    source: m[3].trim(),
    status: m[4].trim(),
    hash: m[5].trim(),
    by: m[6].trim(),
    format: m[7] ? Number(m[7]) : 1,
  };
}
