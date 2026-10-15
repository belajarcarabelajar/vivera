// scripts/plan-closeout.test.mjs
//
// Guards for the close-out gap check behind `pr-registry state <session> merged`.
// Local files only: no gh, no network. Every fixture lives in a temp directory.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as closeout from './plan-closeout.mjs';
import { tickSteps } from './plan-mark-done.mjs';

const { closeoutGaps } = closeout;

// The default store is the machine's real one, so every test points at the
// plan.issues.json inside its own temp repo unless it names another path.
const checkCloseoutRaw = (opts) =>
  closeout.checkCloseout({ configPath: path.join(opts.repoRoot, 'plan.issues.json'), ...opts });

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

// The repository is resolved from the directory name the way plan-issue-sync
// resolves it, so the default name is the project cfgWith maps.
function repo({ planText, config, name = 'vivera' } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'plan-closeout-'));
  dirs.push(base);
  const root = path.join(base, name);
  mkdirSync(root);
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
    `check bun scripts/plan-closeout.mjs --readiness ${PLAN}, then set "status: Complete" in ${PLAN} and run: bun scripts/plan-publish.mjs ${PLAN} && bun scripts/plan-issue-sync.mjs --project vivera ${PLAN}`,
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

test('checkCloseout: an unresolved repository looks the project key up by entry.repo, with a placeholder fallback', () => {
  const entry = { ...closedEntry, state: 'open', status: 'Complete', repo: 'o/other' };
  const root = repo({
    name: 'unmapped',
    planText: plan('Complete'),
    config: cfgWith(entry, { vivera: 'o/r', other: 'o/other' }),
  });
  assert.ok(checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps[0].fix.includes('--project other'));

  const orphan = repo({ name: 'unmapped', planText: plan('Complete'), config: cfgWith({ ...entry, repo: 'x/unknown' }) });
  assert.ok(checkCloseout({ repoRoot: orphan, planSlug: 'demo' }).gaps[0].fix.includes('--project <project>'));
});

test('checkCloseout: configPath override is honored', () => {
  const root = repo({ planText: plan('Complete') });
  const alt = path.join(root, 'alt.json');
  writeFileSync(alt, JSON.stringify(cfgWith(null)));
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo', configPath: alt });
  assert.deepEqual(r, { skipped: 'plan has no issue record, nothing to close', gaps: [] });
});

test('checkCloseout: a record filed for another repository is a gap, not a pass', () => {
  const root = repo({ planText: plan('Complete') });
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/me/this-repo.git\n');
  const alt = path.join(root, 'store.json');
  writeFileSync(alt, JSON.stringify(cfgWith({ ...closedEntry, repo: 'other/repo' }, { other: 'other/repo', mine: 'me/this-repo' })));
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo', configPath: alt });
  assert.deepEqual(codes(r.gaps), ['ISSUE_OTHER_REPO']);
  assert.ok(r.gaps[0].message.includes('other/repo'), r.gaps[0].message);
  assert.ok(r.gaps[0].message.includes('me/this-repo'), r.gaps[0].message);
  // syncOne refuses the colliding key under any --project, so only a rename helps.
  assert.ok(r.gaps[0].fix.includes('rename'), r.gaps[0].fix);
  assert.ok(!r.gaps[0].fix.includes('--project'), r.gaps[0].fix);
});

test('checkCloseout: a record differing only in case from this repository is not foreign', () => {
  const root = repo({ planText: plan('Complete') });
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/me/this-repo.git\n');
  const alt = path.join(root, 'store.json');
  writeFileSync(alt, JSON.stringify(cfgWith({ ...closedEntry, repo: 'Me/This-Repo' }, { mine: 'me/this-repo' })));
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo', configPath: alt });
  assert.ok(!codes(r.gaps).includes('ISSUE_OTHER_REPO'), JSON.stringify(r));
});

const withOrigin = (root, url) => {
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
};

test('checkCloseout: a fork whose origin is not configured resolves by directory name and passes', () => {
  const root = repo({ planText: plan('Complete') });
  withOrigin(root, 'https://github.com/fork/a.git');
  writeFileSync(path.join(root, 'plan.issues.json'), JSON.stringify(cfgWith({ ...closedEntry, repo: 'u/a' }, { [path.basename(root)]: 'u/a' })));
  assert.deepEqual(checkCloseout({ repoRoot: root, planSlug: 'demo' }), { skipped: null, gaps: [] });
});

test('checkCloseout: an ambiguous repository skips the foreign-record check instead of guessing', () => {
  const root = repo({ planText: plan('Complete') });
  withOrigin(root, 'https://github.com/u/b.git');
  writeFileSync(
    path.join(root, 'plan.issues.json'),
    JSON.stringify(cfgWith({ ...closedEntry, repo: 'u/a' }, { [path.basename(root)]: 'u/a', other: 'u/b' })),
  );
  const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
  assert.ok(!codes(r.gaps).includes('ISSUE_OTHER_REPO'), JSON.stringify(r));
  assert.match(r.skipped ?? '', /not resolved/);
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

test('mirror: a multi-line config error is reduced to its first line in the skipped note', () => {
  const root = repo({ planText: plan('Complete'), config: cfgWith(closedEntry) });
  const r = checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: mirror('UNROUTABLE', 'cannot load: missing\n\nCopy the template\n  cp a b') });
  assert.equal(r.skipped, 'vault mirror not checked: cannot load: missing');
});

describe('closeout readiness', () => {
  const t = (id, state) => ({ id, state });
  const verdict = (tasks, openNow = 0) => closeout.readinessVerdict({ tasks, openNow });

  test('readiness: every task DONE and no open NOW row is READY with exit 0', () => {
    const r = verdict([t('T1', 'DONE'), t('T2', 'DONE')]);
    assert.equal(r.verdict, 'READY');
    assert.equal(r.exit, 0);
    assert.deepEqual(r.counts, { DONE: 2, OPEN: 0, UNREAD: 0, UNPROVEN: 0 });
  });

  test('readiness: an OPEN task is NOT-READY with exit 1, even beside UNPROVEN', () => {
    const r = verdict([t('T1', 'DONE'), t('T2', 'OPEN'), t('T3', 'UNPROVEN')]);
    assert.equal(r.verdict, 'NOT-READY');
    assert.equal(r.exit, 1);
  });

  test('readiness: an UNREAD task is NOT-READY, a timeout is not proof', () => {
    const r = verdict([t('T1', 'DONE'), t('T2', 'UNREAD')]);
    assert.equal(r.verdict, 'NOT-READY');
    assert.equal(r.exit, 1);
  });

  test('readiness: UNPROVEN with nothing OPEN is NEEDS-HUMAN with exit 3', () => {
    const r = verdict([t('T1', 'DONE'), t('T2', 'UNPROVEN')]);
    assert.equal(r.verdict, 'NEEDS-HUMAN');
    assert.equal(r.exit, 3);
  });

  test('readiness: an open NOW row forces NOT-READY when every task is DONE', () => {
    const r = verdict([t('T1', 'DONE')], 1);
    assert.equal(r.verdict, 'NOT-READY');
    assert.equal(r.exit, 1);
  });

  test('readiness: an open NOW row beats NEEDS-HUMAN', () => {
    assert.equal(verdict([t('T1', 'UNPROVEN')], 2).verdict, 'NOT-READY');
  });

  test('readiness: zero tasks is NEEDS-HUMAN with exit 3, nothing was measured', () => {
    const r = verdict([]);
    assert.equal(r.verdict, 'NEEDS-HUMAN');
    assert.equal(r.exit, 3);
  });

  test('readiness: zero tasks with an open NOW row is still NOT-READY', () => {
    assert.equal(verdict([], 1).verdict, 'NOT-READY');
  });

  const fixturePlan = (tasks) => [
    '---',
    'schema: ultra-plan/v1',
    'plan_id: demo',
    'status: Verification',
    'tasks:',
    ...tasks.flatMap(({ id, skipIf }) => [
      `  - id: ${id}`,
      '    depends_on: []',
      ...(skipIf === undefined ? [] : [`    skip_if: ${JSON.stringify(skipIf)}`]),
      '    run:',
      `      - cmd: "run-step-${id}"`,
      '        expect_exit: 0',
    ]),
    '---',
    '',
    '# Demo',
    '',
  ].join('\n');

  function fakeRun(results) {
    const calls = [];
    const run = (cmd, opts) => {
      calls.push({ cmd, opts });
      return results[cmd] ?? { exit: 0, timedOut: false };
    };
    return { run, calls };
  }

  test('readiness: skip_if exit 0 is DONE, non-zero OPEN, timeout UNREAD', () => {
    const text = fixturePlan([
      { id: 'T1', skipIf: 'probe-done' },
      { id: 'T2', skipIf: 'probe-open' },
      { id: 'T3', skipIf: 'probe-slow' },
    ]);
    const { run, calls } = fakeRun({
      'probe-open': { exit: 1, timedOut: false },
      'probe-slow': { exit: null, timedOut: true },
    });
    const rows = closeout.taskReadiness(text, { run, cwd: '/repo', timeoutMs: 1234 });
    assert.deepEqual(rows.map((r) => [r.id, r.state, r.skipIf]), [
      ['T1', 'DONE', 'probe-done'],
      ['T2', 'OPEN', 'probe-open'],
      ['T3', 'UNREAD', 'probe-slow'],
    ]);
    assert.deepEqual(calls[0].opts, { cwd: '/repo', timeoutMs: 1234 });
  });

  test('failure output: taskReadiness adds the stderr tail, or stdout when stderr is empty', () => {
    const text = fixturePlan([
      { id: 'T1', skipIf: 'probe-err' },
      { id: 'T2', skipIf: 'probe-out' },
      { id: 'T3', skipIf: 'false' },
    ]);
    const { run } = fakeRun({
      'probe-err': { exit: 1, timedOut: false, stdout: 'ignored\n', stderr: 'e1\n\ne2\n' },
      'probe-out': { exit: 0, timedOut: false, stdout: 'o1\n', stderr: '' },
    });
    const rows = closeout.taskReadiness(text, { run, cwd: '/repo', timeoutMs: 1000 });
    assert.deepEqual(rows.map((r) => r.tail), [['e1', 'e2'], ['o1'], undefined]);
  });

  test('failure output: outputTail keeps the last 5 lines, each cut to 200 chars', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`);
    lines[11] = 'x'.repeat(500);
    const tail = closeout.outputTail({ stdout: '', stderr: lines.join('\n') });
    assert.equal(tail.length, 5);
    assert.equal(tail[0], 'line8');
    assert.ok(tail[4].length <= 201, `last line is ${tail[4].length} chars`);
    assert.deepEqual(closeout.outputTail({ stdout: '', stderr: '' }), []);
  });

  test('readiness: the false sentinel and a missing skip_if are UNPROVEN and never executed', () => {
    const text = fixturePlan([{ id: 'T1', skipIf: 'false' }, { id: 'T2' }, { id: 'T3', skipIf: '' }]);
    const { run, calls } = fakeRun({});
    const rows = closeout.taskReadiness(text, { run, cwd: '/repo', timeoutMs: 1000 });
    assert.deepEqual(rows.map((r) => r.state), ['UNPROVEN', 'UNPROVEN', 'UNPROVEN']);
    assert.equal(calls.length, 0);
  });

  test('readiness: run[] steps are never executed', () => {
    const text = fixturePlan([{ id: 'T1', skipIf: 'probe-done' }]);
    const { run, calls } = fakeRun({});
    closeout.taskReadiness(text, { run, cwd: '/repo', timeoutMs: 1000 });
    assert.deepEqual(calls.map((c) => c.cmd), ['probe-done']);
  });

  test('readiness: openNowRows counts rows with a NOW cell and an OPEN cell', () => {
    const body = [
      '| Item | Class | State |',
      '|---|---|---|',
      '| a | NOW | OPEN |',
      '| b | `NOW` | ` OPEN ` |',
      '| c | NOW | DONE |',
      '| d | LATER | OPEN |',
      '| NOW is mentioned in OPEN prose | x | y |',
    ].join('\n');
    assert.equal(closeout.openNowRows(body), 2);
  });

  test('readiness: openNowRows counts NOW and OPEN cells followed by prose', () => {
    const body = [
      '| Item | Class | State |',
      '|---|---|---|',
      '| a | `NOW` bila sempat | OPEN |',
      '| b | `NOW` untuk Produk | OPEN, menunggu pemilik |',
      '| c | NOW | `OPEN` sejak T3 |',
    ].join('\n');
    assert.equal(closeout.openNowRows(body), 3);
  });

  test('readiness: openNowRows ignores NOW and OPEN that only appear later in prose', () => {
    const body = [
      '| Item | Class | State |',
      '|---|---|---|',
      '| a | later, NOW maybe | still OPEN |',
      '| b | NOWHERE | OPENED |',
      '| c | NOW | DONE, was OPEN |',
    ].join('\n');
    assert.equal(closeout.openNowRows(body), 0);
  });
});

describe('closeout audit', () => {
  const s = (session, plan, state, repo) => ({ session, plan, state, ...(repo ? { repo } : {}) });
  const statusFrom = (map) => (session) => (session.plan in map ? map[session.plan] : null);

  test('audit: all sessions terminal with one merged and the plan not Complete is debt', () => {
    const rows = closeout.auditCloseout({
      sessions: [s('a', 'p1', 'merged', '/r'), s('b', 'p1', 'closed', '/r')],
      planStatusOf: statusFrom({ p1: 'Verification' }),
    });
    assert.deepEqual(rows, [{ plan: 'p1', status: 'Verification', sessions: ['a', 'b'], repo: '/r' }]);
  });

  test('audit: a plan with a session still open is not debt', () => {
    const rows = closeout.auditCloseout({
      sessions: [s('a', 'p1', 'merged'), s('b', 'p1', 'active')],
      planStatusOf: statusFrom({ p1: 'Verification' }),
    });
    assert.deepEqual(rows, []);
  });

  test('audit: a Complete plan is not debt', () => {
    const rows = closeout.auditCloseout({
      sessions: [s('a', 'p1', 'merged')],
      planStatusOf: statusFrom({ p1: 'Complete' }),
    });
    assert.deepEqual(rows, []);
  });

  test('audit: a plan with only closed sessions is not debt', () => {
    const rows = closeout.auditCloseout({
      sessions: [s('a', 'p1', 'closed')],
      planStatusOf: statusFrom({ p1: 'Verification' }),
    });
    assert.deepEqual(rows, []);
  });

  test('audit: a missing plan file is debt with status null', () => {
    const rows = closeout.auditCloseout({
      sessions: [s('a', 'gone', 'merged')],
      planStatusOf: statusFrom({}),
    });
    assert.deepEqual(rows, [{ plan: 'gone', status: null, sessions: ['a'], repo: null }]);
  });
});

describe('closeout CLI', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
  const cli = (args) => Bun.spawnSync(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe' });

  test('readiness CLI: unknown arguments print usage on stderr and exit 2', () => {
    const r = cli(['--bogus']);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr.toString(), /usage/i);
  });

  test('readiness CLI: a missing plan file exits 2 with a message, not a stack trace', () => {
    const r = cli(['--readiness', path.join(tmpdir(), 'plan-closeout-no-such-plan.md')]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr.toString(), /cannot read plan/);
    assert.doesNotMatch(r.stderr.toString(), /at readinessCli/);
  });

  test('readiness CLI: runs skip_if in --cwd and prints rows, open NOW count and verdict', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
    dirs.push(root);
    writeFileSync(path.join(root, 'marker'), '');
    const file = path.join(root, 'plan.md');
    writeFileSync(file, [
      '---', 'schema: ultra-plan/v1', 'plan_id: demo', 'tasks:',
      '  - id: T1', '    depends_on: []', '    skip_if: "test -f marker"',
      '---', '', '| Item | Class | State |', '|---|---|---|', '| x | NOW | DONE |', '',
    ].join('\n'));
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10']);
    assert.equal(r.stdout.toString(), 'T1\tDONE\ttest -f marker\nopen NOW follow-ups: 0\nopen step boxes: 0\nother open boxes: 0 (outside task sections; tick by hand with evidence, not counted)\nreadiness: READY\n');
    assert.equal(r.exitCode, 0);
  });

  const planWith = (root, tasks) => {
    const file = path.join(root, 'plan.md');
    writeFileSync(file, [
      '---', 'schema: ultra-plan/v1', 'plan_id: demo', 'tasks:',
      ...tasks.flatMap(({ id, skipIf }) => [`  - id: ${id}`, '    depends_on: []', `    skip_if: ${JSON.stringify(skipIf)}`]),
      '---', '',
    ].join('\n'));
    return file;
  };
  const tmpRoot = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
    dirs.push(root);
    return root;
  };

  test('failure output: an OPEN task prints its stderr tail under its row', () => {
    const root = tmpRoot();
    const file = planWith(root, [
      { id: 'T1', skipIf: 'echo from-stdout; echo from-stderr >&2; exit 1' },
      { id: 'T2', skipIf: 'exit 1' },
    ]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10']);
    const out = r.stdout.toString().split('\n');
    const i = out.findIndex((l) => l.startsWith('T1\tOPEN\t'));
    assert.ok(i >= 0, r.stdout.toString());
    assert.equal(out[i + 1], '    T1> from-stderr');
    assert.ok(out[i + 2].startsWith('T2\tOPEN\t'), r.stdout.toString());
    assert.equal(out[i + 3], '    T2> (no output)');
    assert.doesNotMatch(r.stdout.toString(), /> from-stdout/);
    assert.equal(r.exitCode, 1);
  });

  test('failure output: an UNREAD task prints what it wrote before the timeout', () => {
    const root = tmpRoot();
    const file = planWith(root, [{ id: 'T1', skipIf: 'echo started >&2; exec sleep 5' }]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '1']);
    assert.match(r.stdout.toString(), /^T1\tUNREAD\t.*\n    T1> started\n/);
  });

  test('failure output: a DONE task prints nothing extra', () => {
    const root = tmpRoot();
    const file = planWith(root, [{ id: 'T1', skipIf: 'echo noisy; echo noisy-err >&2; true' }]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10']);
    assert.equal(r.stdout.toString(), `T1\tDONE\techo noisy; echo noisy-err >&2; true\nopen NOW follow-ups: 0\nopen step boxes: 0\nother open boxes: 0 (outside task sections; tick by hand with evidence, not counted)\nreadiness: READY\n`);
  });

  test('failure output: a task printing many lines shows at most 5', () => {
    const root = tmpRoot();
    const file = planWith(root, [{ id: 'T1', skipIf: 'for i in $(seq 1 40); do echo err$i >&2; done; exit 2' }]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10']);
    const shown = r.stdout.toString().split('\n').filter((l) => l.startsWith('    T1> '));
    assert.deepEqual(shown, ['err36', 'err37', 'err38', 'err39', 'err40'].map((l) => `    T1> ${l}`));
  });

  test('failure output: --log writes one file per executed task and prints the dir once', () => {
    const root = tmpRoot();
    const logDir = path.join(root, 'logs', 'nested');
    const file = planWith(root, [
      { id: 'T1', skipIf: 'echo one-out; echo one-err >&2; exit 1' },
      { id: 'T2', skipIf: 'echo two-out' },
      { id: 'T3', skipIf: 'false' },
    ]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10', '--log', logDir]);
    assert.deepEqual(readdirSync(logDir).sort(), ['T1.log', 'T2.log']);
    const one = readFileSync(path.join(logDir, 'T1.log'), 'utf8');
    assert.match(one, /one-out/);
    assert.match(one, /one-err/);
    assert.match(readFileSync(path.join(logDir, 'T2.log'), 'utf8'), /two-out/);
    assert.equal(r.stdout.toString().split('\n').filter((l) => l === `log: ${logDir}`).length, 1);
  });

  test('readiness CLI: a timed-out skip_if is UNREAD and leaves no child process alive', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
    dirs.push(root);
    const file = path.join(root, 'plan.md');
    writeFileSync(file, [
      '---', 'schema: ultra-plan/v1', 'plan_id: demo', 'tasks:',
      '  - id: T1', '    depends_on: []', `    skip_if: ${JSON.stringify('sleep 7 & echo $! > child.pid; wait')}`,
      '---', '',
    ].join('\n'));
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '1']);
    const pid = Number(readFileSync(path.join(root, 'child.pid'), 'utf8'));
    assert.ok(pid > 0);
    // A killed child is a zombie until init reaps it, and signal 0 still finds a zombie.
    const deadline = Date.now() + 2000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        Bun.sleepSync(50);
      } catch (e) {
        assert.equal(e.code, 'ESRCH');
        alive = false;
      }
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, `sleep ${pid} outlived the timed-out skip_if`);
    assert.match(r.stdout.toString(), /^T1\tUNREAD\t/);
    assert.equal(r.exitCode, 1);
  });

  test('audit CLI: reads the registry and always exits 0', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-audit-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'docs/code-plan/plans'), { recursive: true });
    writeFileSync(path.join(root, 'docs/code-plan/plans/p1.md'), plan('Verification'));
    const reg = path.join(root, 'pr.registry.json');
    writeFileSync(reg, JSON.stringify({ version: 1, sessions: [{ session: 'a', plan: 'p1', state: 'merged', repo: root }] }));
    const r = cli(['--audit', '--registry', reg]);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout.toString(), /p1/);
    assert.match(r.stdout.toString(), /closeout debt: 1 plan\(s\)\n$/);
  });

  test('audit CLI: a plan file that cannot be found is reported as not read, never as debt', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-audit-'));
    dirs.push(root);
    const reg = path.join(root, 'pr.registry.json');
    writeFileSync(reg, JSON.stringify({ version: 1, sessions: [{ session: 'b', plan: 'hilang', state: 'merged', repo: root }] }));
    const r = cli(['--audit', '--registry', reg]);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout.toString(), /closeout debt: 0 plan\(s\)/);
    assert.match(r.stdout.toString(), /not read: 1 plan file\(s\) not found/);
  });
});

describe('open step boxes', () => {
  const FENCE = '`'.repeat(3);
  const front = (ids, status = 'Complete') => [
    '---', 'schema: ultra-plan/v1', 'plan_id: demo', `status: ${status}`, 'tasks:',
    ...ids.flatMap((id) => [`  - id: ${id}`, '    depends_on: []', '    skip_if: "test -f marker"']),
    '---',
  ];
  // Shaped like templates/implementation-plan-template.md: every step ticked, open boxes only in sections no task owns.
  const templatePlan = [
    ...front(['T1', 'T2']), '', '# Demo', '',
    '## 1. Acceptance Criteria',
    '- [ ] AC1 the gate reads ticks',
    '- [ ] AC2 nothing else',
    '',
    '### Task T1: first',
    '- [x] Step 1 write the test',
    '- [X] Step 2 run it',
    '',
    '### Task T2: second',
    '- [x] Step 1 done',
    '',
    '## 8. Approval',
    '- [ ] Approved by the owner',
    '',
  ].join('\n');

  test('open step boxes: a template-shaped plan with every step ticked has none, its other open boxes are listed', () => {
    assert.deepEqual(closeout.openStepBoxes(templatePlan), []);
    assert.deepEqual(closeout.otherOpenBoxes(templatePlan), [
      { line: 17, text: '- [ ] AC1 the gate reads ticks' },
      { line: 18, text: '- [ ] AC2 nothing else' },
      { line: 28, text: '- [ ] Approved by the owner' },
    ]);
  });

  test('open step boxes: an open step inside ### Task T1 blocks and names the task', () => {
    const text = templatePlan.replace('- [X] Step 2 run it', '- [ ] Step 2 run it');
    assert.deepEqual(closeout.openStepBoxes(text), [{ line: 22, text: '- [ ] Step 2 run it', task: 'T1' }]);
  });

  test('open step boxes: a bare box at the end of a step line counts, as plan-mark-done ticks it', () => {
    const text = [...front(['T1']), '', '### Task T1: bare', '- [ ]', ''].join('\n');
    assert.deepEqual(closeout.openStepBoxes(text), [{ line: 12, text: '- [ ]', task: 'T1' }]);
  });

  test('open step boxes: a fenced example inside a task section does not count, as plan-mark-done skips it', () => {
    const text = [...front(['T1']), '', '### Task T1: fenced', FENCE, '- [ ] example inside a fence', FENCE, '- [x] Step 1 done', ''].join('\n');
    assert.deepEqual(closeout.openStepBoxes(text), []);
  });

  test('open step boxes: the counted lines are exactly the lines plan-mark-done ticks', () => {
    const text = [
      ...front(['T1', 'T2']), '', '- [ ] before any task',
      '### Task T1: tricky',
      '- [ ]',
      '+ [ ] plus bullet',
      '-\t[ ] tab after the bullet',
      '  * [ ] indented star',
      '- [ ]x a typo is not a box',
      'prose that mentions - [ ] mid-line',
      FENCE, '- [ ] example', '~~~', '- [ ] after a tilde marker', FENCE,
      '- [ ] fenced again', FENCE,
      '#### Notes',
      '- [ ] under a deeper heading, outside the task',
      '### Task T2: plain',
      '- [ ] Step 1 open',
      '- [x] Step 2 done',
      '',
    ].join('\n');
    const before = text.split('\n');
    const ticked = (id) => tickSteps(text, id).lines.flatMap((l, i) => (l === before[i] ? [] : [i + 1]));
    const expected = [...ticked('T1'), ...ticked('T2')];
    assert.ok(expected.length >= 5, 'the fixture must exercise several box forms');
    assert.deepEqual(closeout.openStepBoxes(text).map((b) => b.line), expected);
  });

  test('other open boxes: a fenced example and a ticked box outside task sections are not listed', () => {
    const text = [...front(['T1']), '', '## Notes', FENCE, '- [ ] example', FENCE, '- [x] done', '+ [ ] plus', '-\t[ ]', ''].join('\n');
    assert.deepEqual(closeout.otherOpenBoxes(text), [{ line: 16, text: '+ [ ] plus' }, { line: 17, text: '-\t[ ]' }]);
  });

  test('open step boxes: a plan without frontmatter tasks blocks nothing, its boxes are other open boxes, and nothing throws', () => {
    assert.deepEqual(closeout.openStepBoxes('# Demo\n- [ ] Step 1 a\n'), []);
    assert.deepEqual(closeout.otherOpenBoxes('# Demo\n- [ ] Step 1 a\n'), [{ line: 2, text: '- [ ] Step 1 a' }]);
  });

  test('open step boxes make every-DONE tasks NOT-READY with exit 1', () => {
    const r = closeout.readinessVerdict({ tasks: [{ id: 'T1', state: 'DONE' }, { id: 'T2', state: 'DONE' }], openBoxes: 2 });
    assert.equal(r.verdict, 'NOT-READY');
    assert.equal(r.exit, 1);
  });

  test('open step boxes beat NEEDS-HUMAN', () => {
    assert.equal(closeout.readinessVerdict({ tasks: [{ id: 'T1', state: 'UNPROVEN' }], openBoxes: 1 }).exit, 1);
    assert.equal(closeout.readinessVerdict({ tasks: [], openBoxes: 1 }).verdict, 'NOT-READY');
  });

  test('open step boxes: zero boxes keep the existing verdicts', () => {
    assert.equal(closeout.readinessVerdict({ tasks: [{ id: 'T1', state: 'DONE' }], openBoxes: 0 }).verdict, 'READY');
    assert.equal(closeout.readinessVerdict({ tasks: [{ id: 'T1', state: 'UNPROVEN' }], openBoxes: 0 }).verdict, 'NEEDS-HUMAN');
  });

  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
  const readiness = (text) => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
    dirs.push(root);
    writeFileSync(path.join(root, 'marker'), '');
    const file = path.join(root, 'plan.md');
    writeFileSync(file, text);
    const r = Bun.spawnSync(['bun', script, '--readiness', file, '--cwd', root, '--timeout-s', '10'], { stdout: 'pipe', stderr: 'pipe' });
    return { file, out: r.stdout.toString(), exit: r.exitCode };
  };
  const tickFor = (file) => `bun scripts/ultra-plan-runner.mjs ${file} --execute > runner.log; bun scripts/plan-mark-done.mjs ${file} --from runner.log`;

  test('open step boxes: readiness CLI prints the count, five task rows and the tick command, then exits 1', () => {
    const { file, out, exit } = readiness([
      ...front(['T1']), '', '### Task T1: todo',
      ...[1, 2, 3, 4, 5, 6].map((n) => `  - [ ] Step ${n} todo  `),
      '', '## Approval', '- [ ] Approved', '',
    ].join('\n'));
    assert.equal(out, [
      'T1\tDONE\ttest -f marker',
      'open NOW follow-ups: 0',
      'open step boxes: 6',
      '    line 12 (T1): - [ ] Step 1 todo',
      '    line 13 (T1): - [ ] Step 2 todo',
      '    line 14 (T1): - [ ] Step 3 todo',
      '    line 15 (T1): - [ ] Step 4 todo',
      '    line 16 (T1): - [ ] Step 5 todo',
      `    tick from evidence: ${tickFor(file)}`,
      'other open boxes: 1 (outside task sections; tick by hand with evidence, not counted)',
      '    line 20: - [ ] Approved',
      'readiness: NOT-READY',
      '',
    ].join('\n'));
    assert.equal(exit, 1);
  });

  test('other open boxes: a template-shaped plan is READY and the CLI lists its other open boxes as not counted', () => {
    const { out, exit } = readiness(templatePlan);
    assert.equal(out, [
      'T1\tDONE\ttest -f marker',
      'T2\tDONE\ttest -f marker',
      'open NOW follow-ups: 0',
      'open step boxes: 0',
      'other open boxes: 3 (outside task sections; tick by hand with evidence, not counted)',
      '    line 17: - [ ] AC1 the gate reads ticks',
      '    line 18: - [ ] AC2 nothing else',
      '    line 28: - [ ] Approved by the owner',
      'readiness: READY',
      '',
    ].join('\n'));
    assert.equal(exit, 0);
  });

  const tick = tickFor(PLAN);

  test('open step boxes: the tick command always runs plan-mark-done, never chained behind the runner with &&', () => {
    const text = [...front(['T1']), '', '### Task T1: a', '- [ ] Step 1 a', ''].join('\n');
    const root = repo({ planText: text, config: cfgWith(closedEntry) });
    const { fix } = checkCloseout({ repoRoot: root, planSlug: 'demo' }).gaps[0];
    assert.doesNotMatch(fix, /&&/);
    assert.match(fix, /--execute > runner\.log; bun scripts\/plan-mark-done\.mjs /);
  });

  test('open step boxes: checkCloseout reports OPEN_STEPS naming the tasks and lines, with the tick command', () => {
    const text = [
      ...front(['T1', 'T2', 'T3']), '',
      '### Task T1: a', '- [ ] Step 1 a', '- [x] Step 2 b',
      '### Task T2: b', '- [x] Step 1 c',
      '### Task T3: c', '- [ ] Step 1 d', '- [ ] Step 2 e', '',
    ].join('\n');
    const root = repo({ planText: text, config: cfgWith(closedEntry) });
    const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
    assert.equal(r.skipped, null);
    assert.deepEqual(r.gaps, [{
      code: 'OPEN_STEPS',
      message: `${PLAN} has 3 open step box(es) in T1, T3 (lines 18, 23, 24)`,
      fix: tick,
    }]);
  });

  test('other open boxes: checkCloseout notes them in skipped with at most five line numbers, never as a gap', () => {
    const root = repo({ planText: templatePlan, config: cfgWith(closedEntry) });
    const r = checkCloseout({ repoRoot: root, planSlug: 'demo' });
    assert.deepEqual(r.gaps, []);
    assert.equal(r.skipped, 'other open boxes: 3 outside task sections, not counted (lines 17, 18, 28)');
    const many = [
      ...front(['T1']), '', '## Acceptance',
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => `- [ ] AC${n}`),
      '### Task T1: a', '- [x] Step 1', '',
    ].join('\n');
    const root2 = repo({ planText: many, config: cfgWith(closedEntry) });
    assert.equal(
      checkCloseout({ repoRoot: root2, planSlug: 'demo' }).skipped,
      'other open boxes: 7 outside task sections, not counted (lines 12, 13, 14, 15, 16, ...)',
    );
  });

  test('open step boxes: checkCloseout lists five line numbers and sits after the issue gaps, before the mirror', () => {
    const text = [
      ...front(['T1'], 'Verification'), '', '### Task T1: many',
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => `- [ ] Step ${n}`), '',
    ].join('\n');
    const entry = { ...closedEntry, state: 'open', status: 'Verification' };
    const root = repo({ planText: text, config: cfgWith(entry) });
    const r = checkCloseoutRaw({ repoRoot: root, planSlug: 'demo', freshness: mirror('DRIFT', 'hash differs') });
    assert.deepEqual(codes(r.gaps), ['PLAN_NOT_COMPLETE', 'ISSUE_NOT_CLOSED', 'OPEN_STEPS', 'MIRROR_STALE']);
    assert.equal(r.gaps[2].message, `${PLAN} has 7 open step box(es) in T1 (lines 12, 13, 14, 15, 16, ...)`);
  });
});
