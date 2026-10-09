// scripts/plan-closeout.test.mjs
//
// Guards for the close-out gap check behind `pr-registry state <session> merged`.
// Local files only: no gh, no network. Every fixture lives in a temp directory.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeoutGaps, checkCloseout as checkCloseoutRaw } from './plan-closeout.mjs';

// The mirror check reads the machine's publish config by default, so the issue
// tests stub it as fresh and only the mirror tests below choose a verdict.
const mirror = (state, detail = '') => () => ({ applicable: state !== 'NOT-APPLICABLE', state, detail });
const checkCloseout = (opts) => checkCloseoutRaw({ freshness: mirror('OK'), ...opts });

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
  assert.deepEqual(closeoutGaps({ status: 'Complete', entry: null, planPath: PLAN, project: 'vivera' }), []);
  assert.deepEqual(closeoutGaps({ status: 'Complete', entry: undefined, planPath: PLAN, project: 'vivera' }), []);
});

test('Complete with a closed, current entry has no gaps', () => {
  assert.deepEqual(closeoutGaps({ status: 'Complete', entry: closedEntry, planPath: PLAN, project: 'vivera' }), []);
});

test('a trailing comment on the status line is not part of the status', () => {
  const commented = { ...closedEntry, status: 'Complete   # Draft|Approved|Complete' };
  assert.deepEqual(closeoutGaps({ status: 'Complete   # done', entry: commented, planPath: PLAN, project: 'vivera' }), []);
  assert.deepEqual(codes(closeoutGaps({ status: 'Verification  # still open', entry: null, planPath: PLAN, project: 'vivera' })), ['PLAN_NOT_COMPLETE']);
});

test('checkCloseout reads a Complete plan whose status line carries a comment', () => {
  const root = repo({ planText: plan('Complete            # Draft|Approved|Complete'), config: cfgWith(closedEntry) });
  assert.deepEqual(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps, []);
});

test('Verification status raises PLAN_NOT_COMPLETE with the literal plan path in the fix', () => {
  const gaps = closeoutGaps({ status: 'Verification', entry: null, planPath: PLAN, project: 'vivera' });
  assert.deepEqual(codes(gaps), ['PLAN_NOT_COMPLETE']);
  assert.ok(gaps[0].message.includes('Verification'));
  assert.equal(gaps[0].fix,
    `set "status: Complete" in ${PLAN}, then run: bun scripts/plan-publish.mjs ${PLAN} && bun scripts/plan-issue-sync.mjs --project vivera ${PLAN}`,
  );
});

test('null status raises PLAN_NOT_COMPLETE and says no status is declared', () => {
  const gaps = closeoutGaps({ status: null, entry: null, planPath: PLAN, project: 'vivera' });
  assert.deepEqual(codes(gaps), ['PLAN_NOT_COMPLETE']);
  assert.ok(gaps[0].message.includes('no status'));
});

test('an open issue raises ISSUE_NOT_CLOSED naming the number and url', () => {
  const entry = { ...closedEntry, state: 'open' };
  const gaps = closeoutGaps({ status: 'Complete', entry, planPath: PLAN, project: 'vivera' });
  assert.deepEqual(codes(gaps), ['ISSUE_NOT_CLOSED']);
  assert.ok(gaps[0].message.includes('7'));
  assert.ok(gaps[0].message.includes(entry.url));
  assert.equal(gaps[0].fix, `bun scripts/plan-issue-sync.mjs --project vivera ${PLAN}`);
});

test('a stale entry raises ISSUE_STALE when the recorded status differs', () => {
  const entry = { ...closedEntry, status: 'Verification' };
  const gaps = closeoutGaps({ status: 'Complete', entry, planPath: PLAN, project: 'vivera' });
  assert.deepEqual(codes(gaps), ['ISSUE_STALE']);
  assert.ok(gaps[0].fix.includes(PLAN));
});

test('open entry at Verification reports all three gaps in fixed order', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Verification' };
  const gaps = closeoutGaps({ status: 'InProgress', entry, planPath: PLAN, project: 'vivera' });
  assert.deepEqual(codes(gaps), ['PLAN_NOT_COMPLETE', 'ISSUE_NOT_CLOSED', 'ISSUE_STALE']);
});

test('open entry whose status matches a Verification plan skips ISSUE_STALE only', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Verification' };
  const gaps = closeoutGaps({ status: 'Verification', entry, planPath: PLAN, project: 'vivera' });
  assert.deepEqual(codes(gaps), ['PLAN_NOT_COMPLETE', 'ISSUE_NOT_CLOSED']);
});

test('every gap carries code, message, and fix strings', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Verification' };
  for (const g of closeoutGaps({ status: null, entry, planPath: PLAN, project: 'vivera' })) {
    assert.equal(typeof g.code, 'string');
    assert.equal(typeof g.message, 'string');
    assert.equal(typeof g.fix, 'string');
  }
});

test('checkCloseout: missing plan file is skipped, no gaps', () => {
  const root = repo();
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  assert.deepEqual(r.gaps, []);
  assert.equal(r.skipped,
    `no plan file at ${path.join(root, PLAN)} (a one-task change has no plan file)`,
  );
});

test('checkCloseout: Complete plan with a closed current entry is clean and not skipped', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(closedEntry) });
  assert.deepEqual(checkCloseout({ repoRoot: root, planSlug: 'demo' }), { skipped: null, gaps: [] });
});

test('checkCloseout: Verification plan with an open entry reports gaps and the project key', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Verification' };
  const root = repo({ planText: plan('Verification'), config: cfgWith(entry) });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  assert.equal(r.skipped, null);
  assert.deepEqual(codes(r.gaps), ['PLAN_NOT_COMPLETE', 'ISSUE_NOT_CLOSED']);
  assert.ok(r.gaps[0].fix.includes('--project vivera'));
  assert.ok(r.gaps[0].fix.includes(PLAN));
  assert.equal(r.gaps[1].fix, `bun scripts/plan-issue-sync.mjs --project vivera ${PLAN}`);
});

test('checkCloseout: stale entry on a Complete plan reports ISSUE_STALE', () => {
  const entry = { ...closedEntry, status: 'Verification' };
  const root = repo({ planText: plan('Complete'), config: cfgWith(entry) });
  assert.deepEqual(codes(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps), ['ISSUE_STALE']);
});

test('checkCloseout: plan without a status line reports PLAN_NOT_COMPLETE', () => {
  const root = repo({ planText: plan(null), config: cfgWith(null) });
  assert.deepEqual(codes(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps), ['PLAN_NOT_COMPLETE']);
});

test('checkCloseout: missing config on a Complete plan is skipped, no gaps', () => {
  const root = repo({ planText: plan('Complete') });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  assert.deepEqual(r.gaps, []);
  assert.equal(r.skipped, `plan.issues.json not found at ${path.join(root, 'plan.issues.json')}, issue not checked`);
});

test('checkCloseout: missing config still returns the plan gap', () => {
  const root = repo({ planText: plan('Verification') });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  assert.deepEqual(codes(r.gaps), ['PLAN_NOT_COMPLETE']);
  assert.ok(r.skipped.includes('plan.issues.json'));
  assert.ok(r.gaps[0].fix.includes('--project <project>'));
});

test('checkCloseout: config present but no record for the plan is information, not a gap', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(null) });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  assert.deepEqual(r.gaps, []);
  assert.equal(r.skipped, 'plan has no issue record, nothing to close');
});

test('checkCloseout: malformed config gives CONFIG_UNREADABLE and is not skipped', () => {
  const root = repo({ planText: plan('Complete'), config: '{not json' });
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  assert.equal(r.skipped, null);
  assert.deepEqual(codes(r.gaps), ['CONFIG_UNREADABLE']);
  assert.ok(r.gaps[0].message.includes('cannot parse'));
  assert.equal(r.gaps[0].fix, `repair ${path.join(root, 'plan.issues.json')}`);
});

test('checkCloseout: a config that fails validation is also CONFIG_UNREADABLE', () => {
  const root = repo({ planText: plan('Complete'), config: { version: 2, projects: {} } });
  assert.deepEqual(codes(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps), ['CONFIG_UNREADABLE']);
});

test('checkCloseout: unreadable config does not hide the plan gap', () => {
  const root = repo({ planText: plan('Verification'), config: '{not json' });
  assert.deepEqual(codes(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps), ['PLAN_NOT_COMPLETE', 'CONFIG_UNREADABLE']);
});

test('checkCloseout: project key is looked up by entry.repo, with a placeholder fallback', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Complete', repo: 'o/other' };
  const root = repo({
    planText: plan('Complete'),
    config: cfgWith(entry, { vivera: 'o/r', other: 'o/other' }),
  });
  assert.ok(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps[0].fix.includes('--project other'));

  const orphan = repo({ planText: plan('Complete'), config: cfgWith({ ...entry, repo: 'x/unknown' }) });
  assert.ok(checkCloseout({ repoRoot: orphan, planSlug: 'demo' }).gaps[0].fix.includes('--project <project>'));
});

test('checkCloseout: configPath override is honored', () => {
  const root = repo({ planText: plan('Complete') });
  const alt = path.join(root, 'alt.json');
  writeFileSync(alt, JSON.stringify(cfgWith(null)));
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo', configPath: alt });
  assert.deepEqual(r, { skipped: 'plan has no issue record, nothing to close', gaps: [] });
});

test('mirror: a fresh mirror adds no gap and no skipped note', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(closedEntry) });
  assert.deepEqual(checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: mirror('OK') }), { skipped: null, gaps: [] });
});

for (const state of ['DRIFT', 'MISSING', 'REFUSED', 'NO-SOURCE']) {
  test(`mirror: ${state} raises MIRROR_STALE with the publish command as the fix`, () => {
    const root = repo({ planText: plan('Complete'), config: cfgWith(closedEntry) });
    const r = checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: mirror(state, 'why it is not current') });
    assert.deepEqual(codes(r.gaps), ['MIRROR_STALE']);
    assert.ok(r.gaps[0].message.includes(state));
    assert.ok(r.gaps[0].message.includes('why it is not current'));
    assert.equal(r.gaps[0].fix, `bun scripts/plan-publish.mjs ${PLAN}`);
    assert.equal(r.skipped, null);
  });
}

test('mirror: a plan outside any mirror is a skipped note, not a gap', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(closedEntry) });
  const r = checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: mirror('NOT-APPLICABLE', 'no project owns it') });
  assert.deepEqual(r.gaps, []);
  assert.equal(r.skipped, 'vault mirror not checked: plan is not covered by a mirror (no project owns it)');
});

test('mirror: an unloadable publish config is a skipped note carrying the reason, not a gap', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(closedEntry) });
  const r = checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: mirror('UNROUTABLE', 'cannot load plan publish config: missing') });
  assert.deepEqual(r.gaps, []);
  assert.equal(r.skipped, 'vault mirror not checked: cannot load plan publish config: missing');
});

test('mirror: the check receives the absolute plan path and the publish config', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(closedEntry) });
  const seen = [];
  checkCloseoutRaw({
    repoRoot: root,
    planSlug: 'demo',
    publishConfig: '/tmp/publish.json',
    freshness: (p, opts) => { seen.push([p, opts]); return { applicable: true, state: 'OK', detail: '' }; },
  });
  assert.deepEqual(seen, [[path.join(root, PLAN), { config: '/tmp/publish.json' }]]);
});

test('mirror: it is also checked when plan.issues.json is missing, and the notes are joined', () => {
  const root = repo({ planText: plan('Complete') });
  const r = checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: mirror('DRIFT', 'hash differs') });
  assert.deepEqual(codes(r.gaps), ['MIRROR_STALE']);
  assert.ok(r.skipped.includes('plan.issues.json not found'));
});

test('mirror: it is also checked when plan.issues.json is unreadable', () => {
  const root = repo({ planText: plan('Complete'), config: '{ not json' });
  const r = checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: mirror('MISSING', 'no mirror') });
  assert.deepEqual(codes(r.gaps), ['CONFIG_UNREADABLE', 'MIRROR_STALE']);
});

test('mirror: a missing plan file skips everything, including the mirror check', () => {
  const root = repo();
  let called = false;
  const r = checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: () => { called = true; return { state: 'OK' }; } });
  assert.equal(called, false);
  assert.deepEqual(r.gaps, []);
});
