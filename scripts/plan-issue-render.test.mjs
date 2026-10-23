// scripts/plan-issue-render.test.mjs
//
// How a plan is rendered as an issue: title, body layout, size limits, trailer,
// the layout version, and the plan label. Split out of plan-issue-sync.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitFrontmatter,
  hashOf,
  issueBody,
  issueTitle,
  checklistCounts,
  parseTrailer,
  deriveAction,
  applyAction,
  ISSUE_FORMAT,
} from './plan-issue-sync.mjs';
import { PLAN_REL, plan, stub } from './lib/plan-issue-fixtures.mjs';

// ---------- the body ----------

test('the issue body is a derived header, the plan body verbatim, the folded frontmatter, then the trailer', () => {
  const text = plan('Draft', '\n- [x] first\n- [ ] second');
  const body = issueBody(text, { planId: 'p1', key: PLAN_REL, sourcePath: 'src.md', status: 'Draft' });
  // Everything is the plan's own text or derived from it by a fixed rule: a
  // hand-written summary would drift from the plan the moment the plan changed.
  const { frontmatter, body: prose } = splitFrontmatter(text);
  assert.ok(body.startsWith('> This issue mirrors the plan `docs/code-plan/plans/2026-10-01-add-pr.md`'), 'the header names the source first');
  assert.match(body, /^\| `p1` \| Draft \| 1 of 2 done \|$/m, 'status and progress are read from the plan');
  const at = body.indexOf('# Add PR delivery');
  assert.ok(at > 0 && body.slice(at).startsWith(prose.replace(/^\s*\n/, '').replace(/\s*$/, '')), 'the plan body follows, verbatim');
  const fold = body.indexOf('<details>');
  assert.ok(fold > at, 'the runner frontmatter comes after the prose');
  assert.ok(body.slice(fold).includes(frontmatter.replace(/^\n/, '').replace(/\s*$/, '')), 'the frontmatter is kept verbatim inside the fold');
  assert.ok(body.lastIndexOf('<!-- plan-sync:') > fold, 'the trailer is last');
  assert.equal(parseTrailer(body).format, ISSUE_FORMAT);
});

test('the frontmatter fence is longer than any backtick run inside it', () => {
  const text = plan('Draft').replace('version: 1', 'version: 1\nnote: "```js inside```"');
  const body = issueBody(text, { planId: 'p', key: 'k', sourcePath: 's', status: 'Draft' });
  assert.match(body, /\n````yaml\n/);
});

test('the title is the plan heading, outside code fences, with the plan_id as the fallback', () => {
  assert.equal(issueTitle(plan('Draft'), '2026-10-01-add-pr'), 'Add PR delivery');
  const fenced = '---\nplan_id: x\nstatus: Draft\n---\n\n```md\n# not this\n```\n\n# Real heading\n';
  assert.equal(issueTitle(fenced, 'x'), 'Real heading');
  assert.equal(issueTitle('---\nplan_id: x\nstatus: Draft\n---\n\nno heading\n', 'x'), 'x');
  assert.equal(issueTitle(`---\nstatus: Draft\n---\n\n# ${'y'.repeat(300)}\n`, 'x').length, 256);
});

test('checklist counts ignore boxes quoted in code fences', () => {
  const text = plan('Draft', '\n- [x] a\n- [X] b\n- [ ] c\n```\n- [ ] quoted\n```');
  assert.deepEqual(checklistCounts(text), { done: 2, total: 3 });
});
test('the trailer round-trips so drift is detectable from the issue alone', () => {
  const text = plan('Draft');
  const body = issueBody(text, { planId: '2026-10-01-add-pr', key: 'k.md', sourcePath: 'k.md', status: 'Draft' });
  const t = parseTrailer(body);
  assert.equal(t.plan_id, '2026-10-01-add-pr');
  assert.equal(t.key, 'k.md');
  assert.equal(t.status, 'Draft');
  assert.equal(t.hash, hashOf(text));
});

test('a body with no trailer parses as null instead of throwing', () => {
  // An issue created by hand in the UI has no trailer, and the sync must report
  // that as a fact rather than crash on it.
  assert.equal(parseTrailer('a hand-written issue body'), null);
  assert.equal(parseTrailer(undefined), null);
});

test('the trailer does not disturb a plan that itself contains an HTML comment', () => {
  const text = plan('Draft', '\n<!-- an existing comment -->');
  const body = issueBody(text, { planId: 'p', key: 'k', sourcePath: 's', status: 'Draft' });
  assert.ok(body.includes('<!-- an existing comment -->'));
  assert.equal(parseTrailer(body).key, 'k');
});

// GitHub rejects an issue body over 65,536 characters (measured on Snipset,
// 2026-10-12: "Body is too long (maximum is 65536 characters) (createIssue)").
// Each LF is counted as CRLF here, the most a stored body can grow to.
const GITHUB_BODY_LIMIT = 65536;
const githubLength = (s) => s.length + (s.match(/\n/g) || []).length;
const longPlan = (lines) => plan('Draft', Array.from({ length: lines }, (_, i) => `- step ${i} ${'x'.repeat(48)}`).join('\n'));
const TRUNCATION_MARKER = /^\*\*Truncated:\*\* this issue shows the first (\d+) of (\d+) characters of the plan body, cut at a line boundary to fit GitHub's 65,536-character body limit\. The full plan is `([^`]+)` in the repository\.$/m;

test('a plan too long for one issue body drops the folded frontmatter before cutting any prose', () => {
  const big = Array.from({ length: 1200 }, (_, i) => `  - id: T${i} ${'y'.repeat(48)}`).join('\n');
  const text = plan('Draft').replace('version: 1', `version: 1\ntasks:\n${big}`);
  assert.ok(githubLength(text) > GITHUB_BODY_LIMIT, 'fixture must exceed the GitHub limit');
  const body = issueBody(text, { planId: 'p', key: PLAN_REL, sourcePath: null, status: 'Draft' });
  assert.ok(githubLength(body) <= GITHUB_BODY_LIMIT - 256);
  assert.doesNotMatch(body, /<details>/);
  assert.match(body, /^\*\*Omitted:\*\* the runner frontmatter \(\d+ characters\)/m);
  assert.doesNotMatch(body, /Truncated/, 'the prose fits once the frontmatter is gone');
  assert.ok(body.includes('**Goal:** one thing.'));
  assert.equal(parseTrailer(body).hash, hashOf(text));
});

test('a plan body too long even without its frontmatter keeps the longest verbatim line-boundary prefix', () => {
  const text = longPlan(1400);
  const prose = splitFrontmatter(text).body.replace(/^\s*\n/, '').replace(/\s*$/, '');
  const body = issueBody(text, { planId: 'p', key: PLAN_REL, sourcePath: null, status: 'Draft' });
  assert.ok(githubLength(body) <= GITHUB_BODY_LIMIT - 256, `body counts ${githubLength(body)}, leaving no headroom`);
  const m = body.match(TRUNCATION_MARKER);
  assert.ok(m, 'a truncated body must say so in one explicit line');
  const n = Number(m[1]);
  const start = body.indexOf('# Add PR delivery');
  assert.equal(body.slice(start, start + n), prose.slice(0, n), 'the kept part is the plan verbatim, never a summary');
  assert.equal(prose[n], '\n', 'the cut falls on a line boundary');
  assert.ok(n > 59000, `the prefix is the longest that fits, got ${n}`);
});
test('a truncated body names N of M characters and the plan repository path, then the unchanged trailer', () => {
  const text = longPlan(1400);
  const prose = splitFrontmatter(text).body.replace(/^\s*\n/, '').replace(/\s*$/, '');
  const body = issueBody(text, { planId: 'p', key: PLAN_REL, sourcePath: null, status: 'Draft' });
  const m = body.match(TRUNCATION_MARKER);
  assert.ok(m);
  assert.equal(Number(m[2]), prose.length);
  assert.equal(m[3], PLAN_REL);
  assert.ok(body.indexOf(m[0]) < body.lastIndexOf('<!-- plan-sync:'), 'the marker precedes the trailer');
  const t = parseTrailer(body);
  assert.equal(t.key, PLAN_REL);
  // The hash stays over the FULL plan, so drift detection does not change.
  assert.equal(t.hash, hashOf(text));
});
test('a plan under the limit keeps the whole prose and the folded frontmatter with no marker', () => {
  const text = longPlan(1000);
  assert.ok(text.length > 55000 && githubLength(text) < GITHUB_BODY_LIMIT - 2048);
  const body = issueBody(text, { planId: 'p', key: PLAN_REL, sourcePath: null, status: 'Draft' });
  const prose = splitFrontmatter(text).body.replace(/^\s*\n/, '').replace(/\s*$/, '');
  assert.ok(body.includes(`${prose}\n\n<details>`));
  assert.doesNotMatch(body, /Truncated|Omitted/);
});

test('a version 1 trailer (no format field) parses as format 1', () => {
  const old = '<!-- plan-sync: plan_id=p | key=k | source=s | status=Draft | hash=abcd1234 | by=u/r -->';
  const t = parseTrailer(old);
  assert.equal(t.by, 'u/r');
  assert.equal(t.format, 1);
});

test('an unchanged plan recorded in an older layout is rewritten, then current', () => {
  const text = plan('Draft');
  const base = { number: 7, url: 'u', hash: hashOf(text), state: 'open' };
  const legacy = deriveAction({ entry: base, liveState: 'open', planText: text, status: 'Draft', key: 'k', id: 'p', repo: 'u/r' });
  assert.equal(legacy.kind, 'update-body');
  assert.equal(legacy.title, 'Add PR delivery');
  assert.equal(legacy.format, ISSUE_FORMAT);
  const now = deriveAction({ entry: { ...base, format: ISSUE_FORMAT }, liveState: 'open', planText: text, status: 'Draft', key: 'k', id: 'p', repo: 'u/r' });
  assert.equal(now.kind, 'current');
});

test('creates and edits carry the plan label after making sure it exists', () => {
  const run = stub((args) => (args[0] === 'label'
    ? { ok: false, err: 'label with name "plan" already exists; use `--force` to update its color and description' }
    : { ok: true, url: 'https://github.com/u/r/issues/7' }));
  applyAction({ kind: 'create', repo: 'u/r', title: 't', body: 'b' }, run);
  applyAction({ kind: 'update-body', number: 7, url: 'u', repo: 'u/r', title: 't', body: 'b' }, run);
  const [label, create, label2, edit] = run.calls.map((c) => c.args);
  assert.deepEqual(label.slice(0, 5), ['label', 'create', 'plan', '--repo', 'u/r']);
  assert.ok(!label.includes('--force'), 'a label somebody already styled is kept as it is');
  assert.deepEqual(create.slice(create.indexOf('--label'), create.indexOf('--label') + 2), ['--label', 'plan']);
  assert.equal(label2[0], 'label');
  assert.deepEqual(edit.slice(edit.indexOf('--add-label'), edit.indexOf('--add-label') + 2), ['--add-label', 'plan']);
});

test('a label that cannot be created does not stop the write; the issue goes without it', () => {
  const run = stub((args) => (args[0] === 'label'
    ? { ok: false, err: 'HTTP 403: Resource not accessible by integration' }
    : { ok: true, url: 'https://github.com/u/r/issues/7' }));
  const r = applyAction({ kind: 'create', repo: 'u/r', title: 't', body: 'b' }, run);
  assert.equal(r.ok, true);
  assert.ok(!run.calls[1].args.includes('--label'));
});
