// scripts/plan-closeout.test.mjs
//
// Guards for the close-out gap check behind `pr-registry state <session> merged`.
// Local files only: no gh, no network. Every fixture lives in a temp directory.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as closeout from './plan-closeout.mjs';

const { closeoutGaps, checkCloseout: checkCloseoutRaw } = closeout;

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
    assert.equal(r.stdout.toString(), 'T1\tDONE\ttest -f marker\nopen NOW follow-ups: 0\nreadiness: READY\n');
    assert.equal(r.exitCode, 0);
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
