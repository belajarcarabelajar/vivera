// scripts/plan-issue-sync.test.mjs
//
// Guards for the plan -> GitHub issue mirror.
//
// The decision of whether to create, update, close, or do nothing is the whole
// product here, and every one of those outcomes is a network write to somebody
// else's API. A wrong `create` floods a real repository with duplicate issues; a
// wrong `current` silently stops syncing; a wrong `close` marks unfinished work
// as done. None of those raise an error, so the matrix below is asserted
// directly against `deriveAction`.
//
// There is exactly ONE seam to the outside world: the injected gh runner, which
// takes (args, input). Anything that actually writes goes through
// `withFakeGh`, a real executable on disk, so the argv and stdin that would
// reach GitHub are asserted rather than assumed. A purely stubbed runner cannot
// see `--body-file -` at all, which is exactly the thing most likely to be
// wrong. The live-state READ goes through that same runner, so a fake gh here
// has to answer `issue view --json state` the way real gh does.
//
// The consequence worth knowing before reading the assertions: `current` is no
// longer free. It costs one `gh issue view`. Before the live read, the state
// compared in `deriveAction` was `entry.state`, a row this script wrote itself,
// so `current` was a claim the script could never fail on: once the sidecar said
// "closed", every later run agreed with itself and a human reopening the issue
// was invisible forever. That is the drift this mirror exists to catch, created
// by the mirror itself.
//
// Every fixture is inline. These tests never touch the network, never require
// gh, and never read the developer's real plan.issues.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ghRunner,
  loadConfig,
  saveConfig,
  splitFrontmatter,
  planStatus,
  planId,
  issueKey,
  hashOf,
  issueBody,
  parseTrailer,
  readLiveState,
  deriveAction,
  applyAction,
  syncOne,
  OPEN_STATUSES,
  CLOSED_STATUS,
} from './plan-issue-sync.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-issue-sync.mjs');

const PLAN_REL = 'docs/code-plan/plans/2026-10-01-add-pr.md';

function plan(status = 'Draft', extra = '') {
  return `---
schema: ultra-plan/v1
plan_id: 2026-10-01-add-pr
status: ${status}
version: 1
---

# Add PR delivery

**Goal:** one thing.
${extra}
`;
}

// The plan must live INSIDE the fake repository root, because the issue key is
// computed relative to that root. A bare temp dir would exercise the "not inside"
// refusal instead of the behaviour under test.
function tmpPlan(text, rel = PLAN_REL) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'plan-issue-repo-'));
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  const full = path.join(repoRoot, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
  return { repoRoot, full, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

// The project is derived from the repository directory name, and the fixture
// directory name is random, so the config keys off the real basename. Otherwise
// every test asserts the "no repository configured" refusal instead of the
// behaviour it was written for.
function cfgFor(repoRoot, overrides = {}) {
  return {
    version: 1,
    projects: { [path.basename(repoRoot)]: 'u/snippet' },
    issues: {},
    ...overrides,
  };
}

// A recording stub, for the paths that never reach the network: refusals that
// happen before any gh call, and the pure decision layer.
function stub(result = { ok: true, url: 'https://github.com/u/r/issues/7' }) {
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    return typeof result === 'function' ? result(args, input) : result;
  };
  run.calls = calls;
  return run;
}

// ONE fake binary for the whole suite, on the real GH_BIN seam.
function withFakeGh(script, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-issue-gh-'));
  const bin = path.join(dir, 'gh');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const argvFile = path.join(dir, 'argv.txt');
  const stdinFile = path.join(dir, 'stdin.txt');
  const prev = {
    GH_BIN: process.env.GH_BIN,
    CAPTURE_ARGV: process.env.CAPTURE_ARGV,
    CAPTURE_STDIN: process.env.CAPTURE_STDIN,
    FAKE_ISSUE_URL: process.env.FAKE_ISSUE_URL,
  };
  process.env.GH_BIN = bin;
  process.env.CAPTURE_ARGV = argvFile;
  process.env.CAPTURE_STDIN = stdinFile;
  process.env.FAKE_ISSUE_URL = 'https://github.com/u/r/issues/11';
  // The capture files only exist once the fake gh has actually run, so "no argv
  // recorded" reads as the empty string. That is what makes "this action called
  // gh zero times" an assertion rather than an ENOENT.
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  try {
    return fn({ dir, argv: () => read(argvFile), stdin: () => read(stdinFile) });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Records argv and stdin, then answers the way the real gh it stands in for
// answers: JSON for `issue view --json state`, a bare URL for create and edit.
// A fake that printed the URL to every subcommand would fail the live-state read
// for a reason that has nothing to do with the behaviour under test, and a test
// that fails for the wrong reason is worse than no test.
function fakeGh({ state = 'OPEN', viewOk = true } = {}) {
  const view = viewOk
    ? `  echo '{"state":"${state}"}'`
    : '  echo "gh: could not resolve to an issue with the number 7" >&2; exit 1';
  return `echo "$@" >> "$CAPTURE_ARGV"; cat >> "$CAPTURE_STDIN"; if [ "$1 $2" = "issue view" ]; then
${view}
else
echo "$FAKE_ISSUE_URL"
fi`;
}

// Records argv and stdin, then prints the URL a real `gh issue create` prints.
const RECORD_AND_ECHO_URL = fakeGh();
const GH_HOLDING_OPEN = fakeGh({ state: 'OPEN' });
const GH_HOLDING_CLOSED = fakeGh({ state: 'CLOSED' });
const GH_VIEW_UNREADABLE = fakeGh({ viewOk: false });

// ---------- reading the plan ----------

test('frontmatter is split on the closing fence, not on any later ---', () => {
  const text = plan('Draft', '\n## Section\n\n---\n\nmore body');
  const { frontmatter, body } = splitFrontmatter(text);
  assert.match(frontmatter, /plan_id: 2026-10-01-add-pr/);
  // A horizontal rule in the body must not be mistaken for the frontmatter end.
  assert.match(body, /## Section/);
});

test('status and plan_id are read from frontmatter, not from the body', () => {
  assert.equal(planStatus(plan('InProgress')), 'InProgress');
  assert.equal(planId(plan(), '/x/whatever.md'), '2026-10-01-add-pr');
});

test('a plan with no frontmatter reports no status rather than guessing', () => {
  // Deriving an issue state from a missing status would mean closing issues for
  // plans nobody marked Complete.
  assert.equal(planStatus('# just a heading\n'), null);
});

test('a quoted status is unquoted', () => {
  assert.equal(planStatus('---\nstatus: "Complete"\n---\n'), 'Complete');
});

test('plan_id falls back to the filename when frontmatter omits it', () => {
  assert.equal(planId('# no frontmatter\n', '/x/2026-10-01-fallback.md'), '2026-10-01-fallback');
});

test('the issue key is relative to the repository root, not a bare basename', () => {
  // A basename collides across projects, and a worktree checkout of the same
  // repository must resolve to the SAME entry as the root checkout.
  assert.equal(issueKey('/home/u/Proyek/snippet', `/home/u/Proyek/snippet/${PLAN_REL}`), PLAN_REL);
  assert.equal(issueKey('/home/u/Proyek/snippet-seo', `/home/u/Proyek/snippet-seo/${PLAN_REL}`), PLAN_REL);
});

test('a plan outside the repository root is refused, not keyed by basename', () => {
  assert.throws(() => issueKey('/home/u/Proyek/snippet', '/somewhere/else/plan.md'), /is not inside/);
});

test('the hash is stable and content-sensitive', () => {
  assert.equal(hashOf(plan('Draft')), hashOf(plan('Draft')));
  assert.notEqual(hashOf(plan('Draft')), hashOf(plan('Draft', '\nextra line')));
  // A one-character change must not collide, or an edited plan looks unchanged.
  assert.notEqual(hashOf('# a'), hashOf('# b'));
});

// ---------- the body ----------

test('the issue body is the plan text, byte for byte, plus a machine trailer', () => {
  const text = plan('Draft');
  const body = issueBody(text, { planId: 'p1', key: 'k', sourcePath: 'src.md', status: 'Draft' });
  // The premise of the mirror is that the issue IS the plan. A summary would be
  // a second source of truth that drifts the moment the plan changes.
  assert.ok(body.startsWith(text.replace(/\s*$/, '')));
  assert.ok(body.includes('# Add PR delivery'));
  assert.ok(body.includes('schema: ultra-plan/v1'));
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

// ---------- readLiveState: the one read that makes `current` falsifiable ----------

test('the live state is read from the issue itself, with an explicit --json state', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    return { ok: true, status: 0, out: '{"state":"CLOSED"}', data: { state: 'CLOSED' } };
  };
  assert.equal(readLiveState(run, { number: 7, repo: 'u/r' }), 'closed');
  assert.equal(calls[0], 'issue view 7 --repo u/r --json state');
});

test('a state gh cannot report is an explicit error, never a fallback to the sidecar', () => {
  // The fallback IS the defect: a sidecar that says "closed" while the issue is
  // open is exactly how this mirror went stale while reporting success.
  const run = () => ({ ok: false, status: 1, out: '', err: 'HTTP 401: Bad credentials' });
  assert.throws(
    () => readLiveState(run, { number: 7, repo: 'u/r' }),
    (e) => /issue view 7 --repo u\/r --json state/.test(e.message)
      && /401/.test(e.message)
      && /refuses to fall back/.test(e.message),
  );
});

test('a state that is neither OPEN nor CLOSED is refused rather than read as a guess', () => {
  // `gh issue view` answers {"state":"MERGED"} for a merged pull request. An entry
  // pointing at a PR is a mapping bug, and reading MERGED as anything else would
  // decide a write on an assumption.
  const run = () => ({ ok: true, status: 0, out: '{"state":"MERGED"}', data: { state: 'MERGED' } });
  assert.throws(() => readLiveState(run, { number: 7, repo: 'u/r' }), /neither OPEN nor CLOSED/);
});

test('output with no state field is refused rather than treated as an unreadable state', () => {
  const run = () => ({ ok: true, status: 0, out: 'https://github.com/u/r/issues/7', data: null });
  assert.throws(() => readLiveState(run, { number: 7, repo: 'u/r' }), /no "state" field/);
});

// ---------- deriveAction: the whole matrix ----------

// `liveState` is what GitHub reported, resolved by the caller. It is an INPUT and
// not a lookup, so the matrix below stays network-free, and every existing case
// feeds the value its recorded entry used to supply for itself.
const base = { key: PLAN_REL, id: '2026-10-01-add-pr', repo: 'u/snippet' };

test('an unrecorded plan is created, never updated', () => {
  const a = deriveAction({ entry: null, liveState: null, planText: plan('Draft'), status: 'Draft', ...base });
  assert.equal(a.kind, 'create');
  assert.equal(a.number, undefined, 'a create has no issue number yet');
});

test('an unchanged plan is current, which is the real no-op', () => {
  const text = plan('Draft');
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'open' };
  const a = deriveAction({ entry, liveState: 'open', planText: text, status: 'Draft', ...base });
  assert.equal(a.kind, 'current');
  assert.equal(a.number, 7);
});

test('an edited plan updates the body and nothing else', () => {
  const entry = { number: 7, url: 'u', hash: hashOf(plan('Draft')), state: 'open' };
  const a = deriveAction({ entry, liveState: 'open', planText: plan('Draft', '\nnew line'), status: 'Draft', ...base });
  assert.equal(a.kind, 'update-body');
  assert.equal(a.close, undefined, 'a body edit must not silently close or reopen the issue');
});

test('a plan that reached Complete closes its issue', () => {
  const text = plan(CLOSED_STATUS);
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'open' };
  const a = deriveAction({ entry, liveState: 'open', planText: text, status: CLOSED_STATUS, ...base });
  assert.equal(a.kind, 'update-state');
  assert.equal(a.close, true);
});

test('an in-progress plan reopens an issue somebody closed by hand', () => {
  // The issue is derived state, so the plan wins. A human closing the issue to
  // tidy the board must not permanently detach the plan from its mirror.
  const text = plan('InProgress');
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'closed' };
  const a = deriveAction({ entry, liveState: 'closed', planText: text, status: 'InProgress', ...base });
  assert.equal(a.kind, 'update-state');
  assert.equal(a.close, false);
});

test('a plan edited and completed in one step does both', () => {
  const text = plan(CLOSED_STATUS, '\nedited too');
  const entry = { number: 7, url: 'u', hash: hashOf(plan(CLOSED_STATUS)), state: 'open' };
  const a = deriveAction({ entry, liveState: 'open', planText: text, status: CLOSED_STATUS, ...base });
  assert.equal(a.kind, 'update-and-state');
  assert.equal(a.close, true);
});

test('every non-Complete status in the open set leaves the issue open', () => {
  for (const status of OPEN_STATUSES) {
    const text = plan(status);
    const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'closed' };
    const a = deriveAction({ entry, liveState: 'closed', planText: text, status, ...base });
    assert.equal(a.kind, 'update-state', `${status} must resolve to a state change`);
    assert.equal(a.close, false, `${status} must not close its issue`);
  }
});

test('a Blocked plan keeps its issue open', () => {
  // Blocked means work is unfinished, so closing the issue would report done.
  const text = plan('Blocked');
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'closed' };
  const a = deriveAction({ entry, liveState: 'closed', planText: text, status: 'Blocked', ...base });
  assert.equal(a.close, false);
});

// ---------- deriveAction: the sidecar does not get a vote ----------

test('a sidecar that says closed does not outvote an issue GitHub holds open', () => {
  // Measured 2026-10-05: a plan at Complete whose sidecar row said "closed"
  // while the issue was OPEN produced kind "current", printed CURRENT, and made
  // zero gh calls. The claim could not fail, so it was a false pass.
  const text = plan(CLOSED_STATUS);
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'closed' };
  const a = deriveAction({ entry, liveState: 'open', planText: text, status: CLOSED_STATUS, ...base });
  assert.notEqual(a.kind, 'current', 'the sidecar agreeing with itself is not evidence');
  assert.equal(a.kind, 'update-state', 'a state transition is the only honest outcome here');
  // The plan is the source of truth for intent, so Complete means the issue ends
  // up closed. What must not happen is deciding there was nothing to do.
  assert.equal(a.close, true);
});

test('a sidecar that says open does not outvote an issue GitHub holds closed', () => {
  const text = plan('InProgress');
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'open' };
  const a = deriveAction({ entry, liveState: 'closed', planText: text, status: 'InProgress', ...base });
  assert.notEqual(a.kind, 'current');
  assert.equal(a.kind, 'update-state');
  assert.equal(a.close, false, 'an in-progress plan reopens its issue');
});

test('current requires the sidecar, GitHub and the plan to agree', () => {
  const text = plan('InProgress');
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'open' };
  const a = deriveAction({ entry, liveState: 'open', planText: text, status: 'InProgress', ...base });
  assert.equal(a.kind, 'current');
});

test('deriveAction refuses to decide the state when no live read was supplied', () => {
  // Without the read there is no third opinion to compare, so the function
  // errors instead of quietly reading entry.state again.
  const text = plan(CLOSED_STATUS);
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'open' };
  assert.throws(
    () => deriveAction({ entry, planText: text, status: CLOSED_STATUS, ...base }),
    /Refusing to fall back to the recorded state/,
  );
  assert.throws(
    () => deriveAction({ entry, liveState: null, planText: text, status: CLOSED_STATUS, ...base }),
    /Refusing to fall back to the recorded state/,
  );
});

// ---------- applyAction, through a real executable ----------

test('a create sends the body on stdin and never on argv', () => {
  // A plan body on the command line hits ARG_MAX and goes through the shell's
  // quoting rules. `--body-file -` is what keeps the bytes identical.
  withFakeGh(RECORD_AND_ECHO_URL, (g) => {
    const r = applyAction({ kind: 'create', title: 'T', body: 'BODY-BYTES', repo: 'u/r' }, ghRunner());
    assert.equal(r.ok, true);
    assert.equal(r.number, 11, 'the number is parsed from the URL gh prints');
    const argv = g.argv();
    assert.match(argv, /--body-file -/, 'the body must arrive on stdin');
    assert.ok(!argv.includes('BODY-BYTES'), 'the body must never appear in argv');
    assert.equal(g.stdin(), 'BODY-BYTES', 'stdin must carry the plan bytes unchanged');
  });
});

test('no create or edit passes --json, which real gh rejects', () => {
  // `gh issue create` and `gh issue edit` have no --json flag. Adding it fails
  // with "unknown flag" against every real gh, which a stubbed runner hides.
  withFakeGh(RECORD_AND_ECHO_URL, (g) => {
    applyAction({ kind: 'create', title: 'T', body: 'B', repo: 'u/r' }, ghRunner());
    assert.ok(!g.argv().includes('--json'), 'gh issue create does not accept --json');
  });
  withFakeGh(RECORD_AND_ECHO_URL, (g) => {
    applyAction({ kind: 'update-body', number: 7, title: 'T', body: 'B', repo: 'u/r' }, ghRunner());
    assert.ok(!g.argv().includes('--json'), 'gh issue edit does not accept --json');
  });
});

test('a body-and-state change edits once, then closes', () => {
  // gh 2.102.0 removed `gh issue edit --state`, so this is now necessarily two calls.
  // The invariant that survives is: exactly one `issue edit` (never a second edit that
  // could half-apply a title or body), and the state change is a separate close/reopen
  // that happens only after the edit succeeded.
  withFakeGh(RECORD_AND_ECHO_URL, (g) => {
    const r = applyAction({ kind: 'update-and-state', number: 7, title: 'T', body: 'B', repo: 'u/r', close: true }, ghRunner());
    assert.equal(r.ok, true);
    assert.equal(r.closed, true);
    const argv = g.argv();
    assert.match(argv, /issue close 7/);
    assert.doesNotMatch(argv, /--state/, 'gh 2.102.0 removed --state; passing it is a hard error');
    assert.match(argv, /--title T/);
    assert.equal((argv.match(/issue edit/g) || []).length, 1, 'exactly one edit call');
  });
});

test('a failed body edit does not go on to close the issue', () => {
  // Half-applying in the other order would close the issue while leaving the previous
  // plan text on it, which reads as "done" for work that never landed.
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'edit') return { ok: false, status: 1, out: '', err: 'boom' };
    return { ok: true, status: 0, out: 'https://github.com/u/r/issues/7' };
  };
  const r = applyAction({ kind: 'update-and-state', number: 7, title: 'T', body: 'B', repo: 'u/r', close: true }, run);
  assert.equal(r.ok, false);
  assert.equal(calls.filter((c) => c.startsWith('issue close')).length, 0, 'must not close after a failed edit');
});

test('reopening an issue uses issue reopen, not an --state flag', () => {
  withFakeGh(RECORD_AND_ECHO_URL, (g) => {
    const r = applyAction({ kind: 'update-state', number: 7, url: 'u', close: false, repo: 'u/r' }, ghRunner());
    assert.equal(r.ok, true);
    assert.match(g.argv(), /issue reopen 7/);
    assert.doesNotMatch(g.argv(), /--state/);
  });
});

test('a title-plus-body edit is still a single call', () => {
  withFakeGh(RECORD_AND_ECHO_URL, (g) => {
    applyAction({ kind: 'update-body', number: 7, title: 'T', body: 'B', repo: 'u/r' }, ghRunner());
    assert.equal((g.argv().match(/issue edit/g) || []).length, 1);
  });
});

test('a current action performs no gh call at all', () => {
  const run = stub();
  const r = applyAction({ kind: 'current', number: 7, url: 'u' }, run);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.deepEqual(run.calls, [], 'the real no-op must not touch the network');
});

test('an unknown action kind throws rather than silently doing nothing', () => {
  assert.throws(() => applyAction({ kind: 'delete-everything' }, stub()), /unknown action kind/);
});

test('a failed gh call surfaces the error instead of recording a phantom entry', () => {
  const run = stub({ ok: false, err: 'HTTP 401: Bad credentials' });
  const r = applyAction({ kind: 'update-state', number: 7, url: 'u', close: true, repo: 'u/r' }, run);
  assert.equal(r.ok, false);
  assert.match(r.error, /401/);
});

// ---------- syncOne end to end ----------

test('a first sync creates the issue and records the number', () => {
  const f = tmpPlan(plan('Draft'));
  try {
    withFakeGh(RECORD_AND_ECHO_URL, (g) => {
      const res = syncOne(cfgFor(f.repoRoot), { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() });
      assert.equal(res.action, 'create');
      assert.equal(res.written, true);
      assert.equal(res.cfg.issues[PLAN_REL].number, 11, 'the number comes from the URL gh printed');
      assert.equal(res.cfg.issues[PLAN_REL].state, 'open');
      assert.equal(res.cfg.issues[PLAN_REL].status, 'Draft');
      // The plan text itself must reach GitHub, not a summary of it.
      assert.ok(g.stdin().includes('# Add PR delivery'), 'the issue body IS the plan');
      assert.ok(g.stdin().includes('plan-sync: plan_id=2026-10-01-add-pr'), 'the trailer is appended');
    });
  } finally {
    f.cleanup();
  }
});

test('running the sync twice performs no second write', () => {
  const f = tmpPlan(plan('Draft'));
  try {
    let cfgNow;
    withFakeGh(RECORD_AND_ECHO_URL, () => {
      cfgNow = syncOne(cfgFor(f.repoRoot), { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() }).cfg;
    });
    assert.equal(cfgNow.issues[PLAN_REL].number, 11);

    // A second run over an unchanged plan must not WRITE anything. A duplicate
    // issue in a real repository is the failure this prevents. One read is
    // expected, though: `current` is only a statement after GitHub was asked.
    withFakeGh(RECORD_AND_ECHO_URL, (g) => {
      const res = syncOne(cfgNow, { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() });
      assert.equal(res.action, 'current');
      assert.equal(res.written, false);
      const argv = g.argv();
      assert.doesNotMatch(argv, /issue edit|issue close|issue reopen/, 'a re-sync of an unchanged plan must not write');
    });
  } finally {
    f.cleanup();
  }
});

test('a project with no configured repository is refused, not guessed', () => {
  const f = tmpPlan(plan('Draft'));
  try {
    // Publishing a plan into the wrong repository is worse than not publishing.
    assert.throws(
      () => syncOne({ version: 1, projects: {}, issues: {} }, { planPath: f.full, repoRoot: f.repoRoot, run: stub() }),
      /no GitHub repository is configured for project/,
    );
  } finally {
    f.cleanup();
  }
});

test('a malformed owner/repo in the config is a load error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-issue-cfg-'));
  try {
    const file = path.join(dir, 'plan.issues.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: { snippet: 'not-a-slug' } }), 'utf8');
    assert.throws(() => loadConfig(file), /must be "owner\/repo"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan with no status is refused rather than filed under a guessed state', () => {
  const f = tmpPlan('# no frontmatter at all\n');
  try {
    assert.throws(
      () => syncOne(cfgFor(f.repoRoot), { planPath: f.full, repoRoot: f.repoRoot, run: stub() }),
      /has no "status:" in its frontmatter/,
    );
  } finally {
    f.cleanup();
  }
});

test('a dry run reports the action and records nothing', () => {
  const f = tmpPlan(plan('Draft'));
  try {
    withFakeGh(RECORD_AND_ECHO_URL, (g) => {
      const res = syncOne(cfgFor(f.repoRoot), { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner(), dryRun: true });
      assert.equal(res.dryRun, true);
      assert.equal(res.written, false);
      assert.equal(res.cfg, undefined, 'a dry run must not hand back a config to persist');
      assert.equal(g.argv(), '', 'a dry run must not call gh');
    });
  } finally {
    f.cleanup();
  }
});

test('an explicit project overrides the directory name, so a worktree resolves', () => {
  // A worktree is a SEPARATE checkout beside the root, carrying the same tracked
  // history, so the same plan path exists in both. The directory is named after
  // the branch, not the project, so the project must come from the override or
  // the plan is filed under a project that does not exist.
  const f = tmpPlan(plan('Draft'));
  const worktree = `${f.repoRoot}-seo`;
  try {
    mkdirSync(path.join(worktree, path.dirname(PLAN_REL)), { recursive: true });
    const wtPlan = path.join(worktree, PLAN_REL);
    writeFileSync(wtPlan, plan('Draft'), 'utf8');
    withFakeGh(RECORD_AND_ECHO_URL, () => {
      const res = syncOne(cfgFor(f.repoRoot), {
        planPath: wtPlan,
        repoRoot: worktree,
        project: path.basename(f.repoRoot),
        run: ghRunner(),
      });
      assert.equal(res.repo, 'u/snippet');
      // Same relative path in both checkouts, so both resolve to ONE issue.
      assert.equal(res.key, PLAN_REL);
    });
  } finally {
    f.cleanup();
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('the recorded state follows the plan, not the previous entry', () => {
  const f = tmpPlan(plan(CLOSED_STATUS));
  try {
    withFakeGh(RECORD_AND_ECHO_URL, (g) => {
      const res = syncOne(cfgFor(f.repoRoot, {
        issues: { [PLAN_REL]: { number: 9, url: 'u9', hash: hashOf(plan('Draft')), state: 'open' } },
      }), { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() });
      assert.equal(res.action, 'update-and-state');
      assert.equal(res.cfg.issues[PLAN_REL].state, 'closed');
      assert.match(g.argv(), /issue close 9/);
      assert.doesNotMatch(g.argv(), /--state/);
    });
  } finally {
    f.cleanup();
  }
});

// ---------- syncOne: the recorded state is checked, not believed ----------

// Every case below is the same fixture with two opinions in it: the sidecar row
// this script wrote earlier, and what GitHub reports now. Only the second one is
// evidence, so only the second one decides.

test('a sidecar that says closed cannot make an open issue look current', () => {
  const text = plan(CLOSED_STATUS);
  const f = tmpPlan(text);
  try {
    withFakeGh(GH_HOLDING_OPEN, (g) => {
      const res = syncOne(cfgFor(f.repoRoot, {
        issues: { [PLAN_REL]: { number: 9, url: 'u9', hash: hashOf(text), state: 'closed' } },
      }), { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() });
      assert.notEqual(res.action, 'current', 'the sidecar agreeing with itself is not evidence');
      assert.equal(res.action, 'update-state');
      const argv = g.argv();
      assert.match(argv, /issue view 9 --repo u\/snippet --json state/, 'the state is read before it is used');
      assert.match(argv, /issue close 9/, 'the plan says Complete, so the open issue is closed');
      // What gets recorded is what GitHub acknowledged, never what the sidecar
      // claimed before this run.
      assert.equal(res.cfg.issues[PLAN_REL].state, 'closed');
    });
  } finally {
    f.cleanup();
  }
});

test('an issue GitHub holds closed is reopened even when the sidecar says open', () => {
  const text = plan('InProgress');
  const f = tmpPlan(text);
  try {
    withFakeGh(GH_HOLDING_CLOSED, (g) => {
      const res = syncOne(cfgFor(f.repoRoot, {
        issues: { [PLAN_REL]: { number: 9, url: 'u9', hash: hashOf(text), state: 'open' } },
      }), { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() });
      assert.notEqual(res.action, 'current');
      assert.equal(res.action, 'update-state');
      assert.match(g.argv(), /issue reopen 9/);
      assert.equal(res.cfg.issues[PLAN_REL].state, 'open');
    });
  } finally {
    f.cleanup();
  }
});

test('current means all three agree: sidecar, GitHub and the plan', () => {
  const text = plan('InProgress');
  const f = tmpPlan(text);
  try {
    withFakeGh(GH_HOLDING_OPEN, (g) => {
      const res = syncOne(cfgFor(f.repoRoot, {
        issues: { [PLAN_REL]: { number: 9, url: 'u9', hash: hashOf(text), state: 'open' } },
      }), { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() });
      assert.equal(res.action, 'current');
      assert.equal(res.written, false);
      const argv = g.argv();
      assert.match(argv, /issue view 9/, 'the no-op is only a no-op after GitHub was asked');
      assert.doesNotMatch(argv, /issue edit|issue close|issue reopen/, 'and it writes nothing');
    });
  } finally {
    f.cleanup();
  }
});

test('an unreadable live state stops the plan at the read, before any write', () => {
  const text = plan(CLOSED_STATUS);
  const f = tmpPlan(text);
  try {
    withFakeGh(GH_VIEW_UNREADABLE, (g) => {
      assert.throws(
        () => syncOne(cfgFor(f.repoRoot, {
          issues: { [PLAN_REL]: { number: 9, url: 'u9', hash: hashOf(text), state: 'closed' } },
        }), { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() }),
        (e) => /issue view 9 --repo u\/snippet --json state/.test(e.message)
          && /refuses to fall back/.test(e.message),
      );
      assert.doesNotMatch(g.argv(), /issue edit|issue close|issue reopen/, 'an unreadable state must not be followed by a write');
    });
  } finally {
    f.cleanup();
  }
});

test('a check whose live state cannot be read exits non-zero and never prints the green line', () => {
  // The CLI is where a refusal turns into a verdict. A plan that could not be
  // checked is not a plan that matches, and `--check` returning 0 here would put
  // the green line on a run that proved nothing.
  const text = plan(CLOSED_STATUS);
  const f = tmpPlan(text);
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-issue-cli-'));
  const cfgPath = path.join(dir, 'plan.issues.json');
  try {
    writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      projects: { [path.basename(f.repoRoot)]: 'u/snippet' },
      issues: { [PLAN_REL]: { number: 9, url: 'u9', hash: hashOf(text), state: 'closed' } },
    }), 'utf8');
    withFakeGh(GH_VIEW_UNREADABLE, () => {
      const r = spawnSync(process.execPath, [
        SCRIPT, '--check', f.full, '--config', cfgPath,
        '--repo-root', f.repoRoot, '--project', path.basename(f.repoRoot),
      ], { encoding: 'utf8' });
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${out}`);
      assert.doesNotMatch(out, /Every plan issue matches/, 'an unchecked plan must not be reported as a match');
      assert.match(out, /refuses to fall back/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    f.cleanup();
  }
});

test('a run over several plans records every plan, not only the last', () => {
  // Each plan's sync must start from the config the previous plan returned. Fed
  // the config as loaded instead, every plan but the last loses its row while its
  // issue still exists on GitHub, so the next run creates that issue a second time.
  const f = tmpPlan(plan('Draft'));
  const secondRel = 'docs/code-plan/plans/2026-10-02-add-sync.md';
  const second = path.join(f.repoRoot, secondRel);
  writeFileSync(second, plan('Draft').replace('2026-10-01-add-pr', '2026-10-02-add-sync'), 'utf8');
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-issue-multi-'));
  const cfgPath = path.join(dir, 'plan.issues.json');
  const cli = (...flags) => spawnSync(process.execPath, [
    SCRIPT, ...flags, f.full, second, '--config', cfgPath,
    '--repo-root', f.repoRoot, '--project', path.basename(f.repoRoot),
  ], { encoding: 'utf8' });
  try {
    writeFileSync(cfgPath, JSON.stringify(cfgFor(f.repoRoot)), 'utf8');
    withFakeGh(RECORD_AND_ECHO_URL, () => {
      const r = cli();
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    });
    const saved = loadConfig(cfgPath);
    assert.deepEqual(Object.keys(saved.issues).sort(), [PLAN_REL, secondRel]);

    withFakeGh(RECORD_AND_ECHO_URL, (g) => {
      const r = cli('--check');
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      assert.doesNotMatch(g.argv(), /issue create/, 'a plan synced once must not be created again');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    f.cleanup();
  }
});

// ---------- config persistence ----------

test('config round-trips and a missing file is an explicit error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-issue-cfg2-'));
  try {
    const file = path.join(dir, 'plan.issues.json');
    saveConfig({ projects: { snippet: 'u/snippet' }, issues: { 'a.md': { number: 3, state: 'open' } } }, file);
    const back = loadConfig(file);
    assert.equal(back.projects.snippet, 'u/snippet');
    assert.equal(back.issues['a.md'].number, 3);
    // A missing config is not an empty registry: syncing with no repository map
    // would refuse every plan, and the message must name the missing file.
    assert.throws(() => loadConfig(path.join(dir, 'nope.json')), /missing plan\/issue config/);
    // plan.issues.json is machine-local state (gitignored, untracked), so a
    // fresh clone legitimately lacks it: the error must tell the reader what to
    // do, naming the tracked plan.issues.example.json template to copy.
    assert.throws(
      () => loadConfig(path.join(dir, 'nope.json')),
      (e) => /machine-local/.test(e.message)
        && /untracked/.test(e.message)
        && e.message.includes('plan.issues.example.json'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unsupported config version is refused', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-issue-ver-'));
  try {
    const file = path.join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ version: 7, projects: {} }), 'utf8');
    assert.throws(() => loadConfig(file), /unsupported version 7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an "issues" field that is not an object is a load error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-issue-iss-'));
  try {
    const file = path.join(dir, 'c.json');
    writeFileSync(file, JSON.stringify({ version: 1, projects: {}, issues: [] }), 'utf8');
    assert.throws(() => loadConfig(file), /"issues" field that is not an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
