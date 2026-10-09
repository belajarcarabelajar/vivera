// scripts/plan-closeout.test.mjs
//
// Guards for the close-out gap check behind `pr-registry state <session> merged`.
// Local files only: no gh, no network. Every fixture lives in a temp directory.

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeoutGaps, checkCloseout } from './plan-closeout.mjs';

const PLAN = 'docs/code-plan/plans/demo.md';
const closedEntry = { number: 7, url: 'https://github.com/o/r/issues/7', state: 'closed', status: 'Complete', repo: 'o/r' };
const codes = (gaps) => gaps.map((g) => g.code);

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function repo({ planText, config } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-'));
  dirs.push(root);
  if (planText !== undefined) {
    mkdirSync(path.join(root, 'docs/code-plan/plans'), { recursive: true });
    writeFileSync(path.join(root, PLAN), planText);
  }
  if (config !== undefined) {
    writeFileSync(path.join(root, 'plan.issues.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return root;
}

const plan = (status) => `---\nplan_id: demo\n${status === null ? '' : `status: ${status}\n`}---\n\n# Demo\n`;
const cfgWith = (entry, projects = { vivera: 'o/r' }) => ({
  version: 1,
  projects,
  issues: entry ? { [PLAN]: entry } : {},
});

test('Complete with no entry has no gaps', () => {
  expect(closeoutGaps({ status: 'Complete', entry: null, planPath: PLAN, project: 'vivera' })).toEqual([]);
  expect(closeoutGaps({ status: 'Complete', entry: undefined, planPath: PLAN, project: 'vivera' })).toEqual([]);
});

test('Complete with a closed, current entry has no gaps', () => {
  expect(closeoutGaps({ status: 'Complete', entry: closedEntry, planPath: PLAN, project: 'vivera' })).toEqual([]);
});

test('Verification status raises PLAN_NOT_COMPLETE with the literal plan path in the fix', () => {
  const gaps = closeoutGaps({ status: 'Verification', entry: null, planPath: PLAN, project: 'vivera' });
  expect(codes(gaps)).toEqual(['PLAN_NOT_COMPLETE']);
  expect(gaps[0].message).toContain('Verification');
  expect(gaps[0].fix).toBe(
    `set "status: Complete" in ${PLAN}, then run: bun scripts/plan-publish.mjs ${PLAN} && bun scripts/plan-issue-sync.mjs --project vivera ${PLAN}`,
  );
});

test('null status raises PLAN_NOT_COMPLETE and says no status is declared', () => {
  const gaps = closeoutGaps({ status: null, entry: null, planPath: PLAN, project: 'vivera' });
  expect(codes(gaps)).toEqual(['PLAN_NOT_COMPLETE']);
  expect(gaps[0].message).toContain('no status');
});

test('an open issue raises ISSUE_NOT_CLOSED naming the number and url', () => {
  const entry = { ...closedEntry, state: 'open' };
  const gaps = closeoutGaps({ status: 'Complete', entry, planPath: PLAN, project: 'vivera' });
  expect(codes(gaps)).toEqual(['ISSUE_NOT_CLOSED']);
  expect(gaps[0].message).toContain('7');
  expect(gaps[0].message).toContain(entry.url);
  expect(gaps[0].fix).toBe(`bun scripts/plan-issue-sync.mjs --project vivera ${PLAN}`);
});

test('a stale entry raises ISSUE_STALE when the recorded status differs', () => {
  const entry = { ...closedEntry, status: 'Verification' };
  const gaps = closeoutGaps({ status: 'Complete', entry, planPath: PLAN, project: 'vivera' });
  expect(codes(gaps)).toEqual(['ISSUE_STALE']);
  expect(gaps[0].fix).toContain(PLAN);
});

test('open entry at Verification reports all three gaps in fixed order', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Verification' };
  const gaps = closeoutGaps({ status: 'InProgress', entry, planPath: PLAN, project: 'vivera' });
  expect(codes(gaps)).toEqual(['PLAN_NOT_COMPLETE', 'ISSUE_NOT_CLOSED', 'ISSUE_STALE']);
});

test('open entry whose status matches a Verification plan skips ISSUE_STALE only', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Verification' };
  const gaps = closeoutGaps({ status: 'Verification', entry, planPath: PLAN, project: 'vivera' });
  expect(codes(gaps)).toEqual(['PLAN_NOT_COMPLETE', 'ISSUE_NOT_CLOSED']);
});

test('every gap carries code, message, and fix strings', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Verification' };
  for (const g of closeoutGaps({ status: null, entry, planPath: PLAN, project: 'vivera' })) {
    expect(typeof g.code).toBe('string');
    expect(typeof g.message).toBe('string');
    expect(typeof g.fix).toBe('string');
  }
});

test('checkCloseout: missing plan file is skipped, no gaps', () => {
  const root = repo();
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  expect(r.gaps).toEqual([]);
  expect(r.skipped).toBe(
    `no plan file at ${path.join(root, PLAN)} (a one-task change has no plan file)`,
  );
});

test('checkCloseout: Complete plan with a closed current entry is clean and not skipped', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(closedEntry) });
  expect(checkCloseout({ repoRoot: root, planSlug: 'demo' })).toEqual({ skipped: null, gaps: [] });
});

test('checkCloseout: Verification plan with an open entry reports gaps and the project key', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Verification' };
  const root = repo({ planText: plan('Verification'), config: cfgWith(entry) });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  expect(r.skipped).toBeNull();
  expect(codes(r.gaps)).toEqual(['PLAN_NOT_COMPLETE', 'ISSUE_NOT_CLOSED']);
  expect(r.gaps[0].fix).toContain('--project vivera');
  expect(r.gaps[0].fix).toContain(PLAN);
  expect(r.gaps[1].fix).toBe(`bun scripts/plan-issue-sync.mjs --project vivera ${PLAN}`);
});

test('checkCloseout: stale entry on a Complete plan reports ISSUE_STALE', () => {
  const entry = { ...closedEntry, status: 'Verification' };
  const root = repo({ planText: plan('Complete'), config: cfgWith(entry) });
  expect(codes(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps)).toEqual(['ISSUE_STALE']);
});

test('checkCloseout: plan without a status line reports PLAN_NOT_COMPLETE', () => {
  const root = repo({ planText: plan(null), config: cfgWith(null) });
  expect(codes(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps)).toEqual(['PLAN_NOT_COMPLETE']);
});

test('checkCloseout: missing config on a Complete plan is skipped, no gaps', () => {
  const root = repo({ planText: plan('Complete') });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  expect(r.gaps).toEqual([]);
  expect(r.skipped).toBe(`plan.issues.json not found at ${path.join(root, 'plan.issues.json')}, issue not checked`);
});

test('checkCloseout: missing config still returns the plan gap', () => {
  const root = repo({ planText: plan('Verification') });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  expect(codes(r.gaps)).toEqual(['PLAN_NOT_COMPLETE']);
  expect(r.skipped).toContain('plan.issues.json');
  expect(r.gaps[0].fix).toContain('--project <project>');
});

test('checkCloseout: config present but no record for the plan is information, not a gap', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(null) });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  expect(r.gaps).toEqual([]);
  expect(r.skipped).toBe('plan has no issue record, nothing to close');
});

test('checkCloseout: malformed config gives CONFIG_UNREADABLE and is not skipped', () => {
  const root = repo({ planText: plan('Complete'), config: '{not json' });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  expect(r.skipped).toBeNull();
  expect(codes(r.gaps)).toEqual(['CONFIG_UNREADABLE']);
  expect(r.gaps[0].message).toContain('cannot parse');
  expect(r.gaps[0].fix).toBe(`repair ${path.join(root, 'plan.issues.json')}`);
});

test('checkCloseout: a config that fails validation is also CONFIG_UNREADABLE', () => {
  const root = repo({ planText: plan('Complete'), config: { version: 2, projects: {} } });
  expect(codes(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps)).toEqual(['CONFIG_UNREADABLE']);
});

test('checkCloseout: unreadable config does not hide the plan gap', () => {
  const root = repo({ planText: plan('Verification'), config: '{not json' });
  expect(codes(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps)).toEqual(['PLAN_NOT_COMPLETE', 'CONFIG_UNREADABLE']);
});

test('checkCloseout: project key is looked up by entry.repo, with a placeholder fallback', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Complete', repo: 'o/other' };
  const root = repo({
    planText: plan('Complete'),
    config: cfgWith(entry, { vivera: 'o/r', other: 'o/other' }),
  });
  expect(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps[0].fix).toContain('--project other');

  const orphan = repo({ planText: plan('Complete'), config: cfgWith({ ...entry, repo: 'x/unknown' }) });
  expect(checkCloseout({ repoRoot: orphan, planSlug: 'demo' }).gaps[0].fix).toContain('--project <project>');
});

test('checkCloseout: configPath override is honored', () => {
  const root = repo({ planText: plan('Complete') });
  const alt = path.join(root, 'alt.json');
  writeFileSync(alt, JSON.stringify(cfgWith(null)));
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo', configPath: alt });
  expect(r).toEqual({ skipped: 'plan has no issue record, nothing to close', gaps: [] });
});
