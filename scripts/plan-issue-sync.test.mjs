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
// wrong.
//
// Every fixture is inline. These tests never touch the network, never require
// gh, and never read the developer's real plan.issues.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  deriveAction,
  applyAction,
  syncOne,
  OPEN_STATUSES,
  CLOSED_STATUS,
} from './plan-issue-sync.mjs';

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

// Records argv and stdin, then prints the URL a real `gh issue create` prints.
const RECORD_AND_ECHO_URL = 'echo "$@" >> "$CAPTURE_ARGV"; cat >> "$CAPTURE_STDIN"; echo "$FAKE_ISSUE_URL"';

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

// ---------- deriveAction: the whole matrix ----------

const base = { key: PLAN_REL, id: '2026-10-01-add-pr', repo: 'u/snippet' };

test('an unrecorded plan is created, never updated', () => {
  const a = deriveAction({ entry: null, planText: plan('Draft'), status: 'Draft', ...base });
  assert.equal(a.kind, 'create');
  assert.equal(a.number, undefined, 'a create has no issue number yet');
});

test('an unchanged plan is current, which is the real no-op', () => {
  const text = plan('Draft');
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'open' };
  const a = deriveAction({ entry, planText: text, status: 'Draft', ...base });
  assert.equal(a.kind, 'current');
  assert.equal(a.number, 7);
});

test('an edited plan updates the body and nothing else', () => {
  const entry = { number: 7, url: 'u', hash: hashOf(plan('Draft')), state: 'open' };
  const a = deriveAction({ entry, planText: plan('Draft', '\nnew line'), status: 'Draft', ...base });
  assert.equal(a.kind, 'update-body');
  assert.equal(a.close, undefined, 'a body edit must not silently close or reopen the issue');
});

test('a plan that reached Complete closes its issue', () => {
  const text = plan(CLOSED_STATUS);
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'open' };
  const a = deriveAction({ entry, planText: text, status: CLOSED_STATUS, ...base });
  assert.equal(a.kind, 'update-state');
  assert.equal(a.close, true);
});

test('an in-progress plan reopens an issue somebody closed by hand', () => {
  // The issue is derived state, so the plan wins. A human closing the issue to
  // tidy the board must not permanently detach the plan from its mirror.
  const text = plan('InProgress');
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'closed' };
  const a = deriveAction({ entry, planText: text, status: 'InProgress', ...base });
  assert.equal(a.kind, 'update-state');
  assert.equal(a.close, false);
});

test('a plan edited and completed in one step does both', () => {
  const text = plan(CLOSED_STATUS, '\nedited too');
  const entry = { number: 7, url: 'u', hash: hashOf(plan(CLOSED_STATUS)), state: 'open' };
  const a = deriveAction({ entry, planText: text, status: CLOSED_STATUS, ...base });
  assert.equal(a.kind, 'update-and-state');
  assert.equal(a.close, true);
});

test('every non-Complete status in the open set leaves the issue open', () => {
  for (const status of OPEN_STATUSES) {
    const text = plan(status);
    const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'closed' };
    const a = deriveAction({ entry, planText: text, status, ...base });
    assert.equal(a.kind, 'update-state', `${status} must resolve to a state change`);
    assert.equal(a.close, false, `${status} must not close its issue`);
  }
});

test('a Blocked plan keeps its issue open', () => {
  // Blocked means work is unfinished, so closing the issue would report done.
  const text = plan('Blocked');
  const entry = { number: 7, url: 'u', hash: hashOf(text), state: 'closed' };
  const a = deriveAction({ entry, planText: text, status: 'Blocked', ...base });
  assert.equal(a.close, false);
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

    // A second run over an unchanged plan must not touch the network at all. A
    // duplicate issue in a real repository is the failure this prevents.
    withFakeGh(RECORD_AND_ECHO_URL, (g) => {
      const res = syncOne(cfgNow, { planPath: f.full, repoRoot: f.repoRoot, run: ghRunner() });
      assert.equal(res.action, 'current');
      assert.equal(res.written, false);
      assert.equal(g.argv(), '', 'a re-sync of an unchanged plan must not call gh');
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
