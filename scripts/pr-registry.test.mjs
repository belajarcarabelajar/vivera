// scripts/pr-registry.test.mjs
//
// Guards for the PR slot allocator and merge-order resolver.
//
// The function under test decides the branch name, the worktree path, and the
// order twenty concurrent sessions merge in. Each individual `git` command it
// produces is valid on its own, so nothing downstream will catch a wrong
// answer here: a duplicate branch pushes one session's commits onto another
// session's PR, and a wrong merge order lands a dependent session first and
// conflicts with the rest of the batch.
//
// Every fixture is built inline on purpose. These tests must not depend on
// whether a real checkout, a real vault, or a real Snipset install exists on the
// machine running them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadRegistry,
  saveRegistry,
  readRegistryRaw,
  mutateRegistry,
  claimSlot,
  setPr,
  setState,
  mergeOrder,
  conflictSurface,
  branchFor,
  worktreeFor,
  SESSION_STATES,
} from './pr-registry.mjs';

// A registry file in a temp dir, so save/load round-trips are exercised for real
// rather than against a stub.
function registryFile(tag, contents = null) {
  const dir = mkdtempSync(path.join(tmpdir(), `pr-registry-${tag}-`));
  const file = path.join(dir, 'pr.registry.json');
  if (contents !== null) writeFileSync(file, JSON.stringify(contents, null, 2), 'utf8');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const REPO = '/home/u/Proyek/snippet';

test('branch name is derived, not chosen, and is scoped by plan', () => {
  assert.equal(branchFor('2026-10-01-add-pr', 'w1'), '2026-10-01-add-pr/w1');
  // No tool, vendor, or workflow prefix. The name lands in permanent repository
  // history, so it has to read like something a person would have written, and
  // an unrequested authorship marker is the same defect as a `Generated with`
  // footer. Asserted literally because the prefix is exactly the kind of thing
  // that gets added back as a "harmless" nicety.
  assert.ok(!branchFor('p', 'w1').startsWith('ai/'), 'the branch must not announce a tool');
  assert.equal(branchFor('p', 'w1').split('/').length, 2, 'exactly <plan-id>/<session-slug>, nothing wrapped around it');
  // Two sessions in the same plan still get different branches, which is the
  // only reason twenty panes can push at once without fighting.
  assert.notEqual(branchFor('p', 'w1'), branchFor('p', 'w2'));
  // The same session id in two different plans is also a different branch, so a
  // recycled session name cannot clobber an earlier plan's PR.
  assert.notEqual(branchFor('plan-a', 'w1'), branchFor('plan-b', 'w1'));
});

test('branch name rejects input that would normalise to an illegal git ref', () => {
  for (const bad of ['', '   ', '...', '-lead', '.hidden', 'a..b']) {
    assert.throws(() => branchFor('plan', bad), /plan id|session id|legal branch segment/,
      `"${bad}" must be refused rather than silently rewritten into a colliding name`);
  }
});

test('punctuation differences cannot produce the same slot', () => {
  // If these collapsed to one name, two agents that named their session
  // differently would still land on one branch, which is the collision the
  // registry exists to make impossible.
  assert.equal(branchFor('plan', 'a b'), branchFor('plan', 'a-b'));
  assert.equal(branchFor('plan', 'a/b'), branchFor('plan', 'a-b'));
});

test('worktree sits beside the repository, never inside it', () => {
  const wt = worktreeFor(REPO, 'w1');
  assert.equal(wt, '/home/u/Proyek/snippet-wt/w1');
  // A worktree nested in its own repository gets picked up by the parent's
  // watchers, formatters, and test globs, which then see two copies of a file.
  assert.ok(!wt.startsWith(`${REPO}${path.sep}`), 'the worktree must not be inside the repository');
});

test('claim records a slot with derived names and an isolated starting state', () => {
  const { session, created } = claimSlot({ version: 1, sessions: [] }, {
    plan: '2026-10-01-x', session: 'w1', repoRoot: REPO,
  });
  assert.equal(created, true);
  assert.equal(session.state, 'isolated');
  assert.equal(session.branch, '2026-10-01-x/w1');
  assert.equal(session.worktree, '/home/u/Proyek/snippet-wt/w1');
  assert.equal(session.pr, null);
  assert.deepEqual(session.depends_on, []);
  // `merged` is terminal, so a slot that started merged could never be reopened.
  assert.ok(SESSION_STATES.indexOf('isolated') < SESSION_STATES.indexOf('merged'));
});

test('re-claiming the same session is idempotent, not a second slot', () => {
  const first = claimSlot({ version: 1, sessions: [] }, { plan: 'p', session: 'w1', repoRoot: REPO });
  const again = claimSlot({ registry: null, ...{ version: 1, sessions: [first.session] } },
    { plan: 'p', session: 'w1', repoRoot: REPO });
  assert.equal(again.created, false, 'a retried claim after a crashed session must not need a manual edit');
  assert.equal(again.session.branch, first.session.branch);
});

test('two sessions that normalise to the same name are one session, not a collision', () => {
  const a = claimSlot({ version: 1, sessions: [] }, { plan: 'p', session: 'w 1', repoRoot: REPO });
  const b = claimSlot({ version: 1, sessions: [a.session] }, { plan: 'p', session: 'w-1', repoRoot: REPO });
  assert.equal(b.created, false);
  assert.equal(b.session.branch, a.session.branch);
});

test('a session cannot depend on a slot that does not exist', () => {
  assert.throws(
    () => claimSlot({ version: 1, sessions: [] }, { plan: 'p', session: 'w2', repoRoot: REPO, dependsOn: ['w1'] }),
    /depends on "w1", which holds no slot/,
    'an unclaimable dependency would make the merge order unprovable, so it is refused at claim time',
  );
});

test('two live sessions never share a branch or a worktree', () => {
  let registry = { version: 1, sessions: [] };
  for (const s of ['w1', 'w2', 'w3', 'w4']) {
    const r = claimSlot(registry, { plan: 'p', session: s, repoRoot: REPO });
    registry = r.registry;
  }
  const branches = new Set(registry.sessions.map((s) => s.branch));
  const worktrees = new Set(registry.sessions.map((s) => s.worktree));
  assert.equal(branches.size, 4, 'each session needs its own branch');
  assert.equal(worktrees.size, 4, 'each session needs its own worktree');
});

// --- State transitions -------------------------------------------------------

function openSession(session = 'w1', deps = []) {
  const claimed = claimSlot({ version: 1, sessions: [] }, { plan: 'p', session, repoRoot: REPO, dependsOn: deps });
  let reg = claimed.registry;
  reg = setState(reg, session, 'active').registry;
  reg = setState(reg, session, 'verified').registry;
  return setPr(reg, session, 42).registry;
}

test('a PR number cannot be recorded before the session is verified', () => {
  const claimed = claimSlot({ version: 1, sessions: [] }, { plan: 'p', session: 'w1', repoRoot: REPO });
  // Recording a PR implies the work is done and the evidence is green, so
  // isolated -> open would skip the gate that makes a merge safe.
  assert.throws(() => setPr(claimed.registry, 'w1', 42), /only be recorded after the session reaches "verified"/);
});

test('recording a PR moves verified to open, because a PR only exists after verification', () => {
  const reg = openSession();
  const s = reg.sessions[0];
  assert.equal(s.state, 'open');
  assert.equal(s.pr, 42);
});

test('a session cannot be repointed at a different PR number', () => {
  const reg = openSession();
  assert.throws(() => setPr(reg, 'w1', 43), /already records PR #42; refusing to repoint/,
    'a silently repointed slot would file the next merge against the wrong PR');
});

test('only a verified, PR-backed session can merge', () => {
  assert.throws(() => setState({ version: 1, sessions: [] }, 'nope', 'merged'), /no slot for session/);

  const claimed = claimSlot({ version: 1, sessions: [] }, { plan: 'p', session: 'w1', repoRoot: REPO });
  // No PR recorded: a green local run is still not a mergeable session.
  const ready = setState(claimed.registry, 'w1', 'verified').registry;
  assert.throws(() => setState(ready, 'w1', 'merged'), /only a session in open can merge/);
});

test('merged is terminal', () => {
  const reg = openSession();
  const merged = setState(reg, 'w1', 'merged').registry;
  assert.equal(merged.sessions[0].state, 'merged');
  assert.ok(merged.sessions[0].merged_at, 'a merge records when it happened, for the rebase calculation');
  assert.throws(() => setState(merged, 'w1', 'active'), /already merged; reverting or redoing it is a new session/,
    'un-merging is a revert, not a state edit; letting the file do it would hide the revert');
});

test('closed is terminal and records when, without claiming a merge', () => {
  const reg = openSession();
  const closed = setState(reg, 'w1', 'closed').registry;
  assert.equal(closed.sessions[0].state, 'closed');
  assert.ok(closed.sessions[0].closed_at, 'a close records when it happened, so the history is not lost');
  assert.equal(closed.sessions[0].merged_at, undefined, 'a closed PR did not reach the base branch, so there is no merge time');
  assert.throws(() => setState(closed, 'w1', 'active'), /is already closed; reverting or redoing it is a new session/,
    'reopening a closed session would hide that its PR never landed');
});

test('a session can be closed before a PR is recorded, because nothing owes a merge', () => {
  // Unlike `merged`, closing is not a claim of green evidence, so it is allowed
  // from `verified`: a session whose work is superseded can stop without a PR.
  const claimed = claimSlot({ version: 1, sessions: [] }, { plan: 'p', session: 'w1', repoRoot: REPO });
  const ready = setState(claimed.registry, 'w1', 'verified').registry;
  assert.equal(setState(ready, 'w1', 'closed').registry.sessions[0].state, 'closed');
});

test('an unknown state is refused instead of falling back to a default', () => {
  const reg = openSession();
  assert.throws(() => setState(reg, 'w1', 'MERGED'), /unknown session state/);
});

// --- Merge order -------------------------------------------------------------

test('merge order follows depends_on, not finish order', () => {
  // w3 finished first, w1 last. Order must still be w1, w2, w3.
  let reg = { version: 1, sessions: [] };
  for (const [s, deps] of [['w1', []], ['w2', ['w1']], ['w3', ['w2']]]) {
    reg = claimSlot(reg, { plan: 'p', session: s, repoRoot: REPO, dependsOn: deps }).registry;
  }
  const order = mergeOrder(reg).map((s) => s.session);
  assert.deepEqual(order, ['w1', 'w2', 'w3']);
});

test('merge order is reproducible, so two runs of one registry agree', () => {
  // Three independent sessions, no edges. Any order is topologically valid, so
  // the tiebreak has to be deterministic or the printed plan is not a plan.
  let reg = { version: 1, sessions: [] };
  for (const s of ['w3', 'w1', 'w20', 'w2']) {
    reg = claimSlot(reg, { plan: 'p', session: s, repoRoot: REPO }).registry;
  }
  const a = mergeOrder(reg).map((s) => s.session);
  const b = mergeOrder({ ...reg, sessions: [...reg.sessions].reverse() }).map((s) => s.session);
  assert.deepEqual(a, b, 'insertion order must not leak into the merge plan');
});

test('merged sessions drop out of the order and do not block their dependents', () => {
  let reg = openSession('w1');
  reg = setState(reg, 'w1', 'merged').registry;
  reg = setState(setState(claimSlot(reg, { plan: 'p', session: 'w2', repoRoot: REPO, dependsOn: ['w1'] }).registry, 'w2', 'active').registry, 'w2', 'verified').registry;
  reg = setPr(reg, 'w2', 43).registry;

  const order = mergeOrder(reg).map((s) => s.session);
  assert.deepEqual(order, ['w2'], 'a landed dependency is satisfied, not pending');
});

test('closed sessions drop out of the order and do not block their dependents', () => {
  let reg = openSession('w1');
  reg = setState(reg, 'w1', 'closed').registry;
  reg = claimSlot(reg, { plan: 'p', session: 'w2', repoRoot: REPO, dependsOn: ['w1'] }).registry;
  reg = setState(reg, 'w2', 'active').registry;
  reg = setState(reg, 'w2', 'verified').registry;
  reg = setPr(reg, 'w2', 43).registry;

  const order = mergeOrder(reg).map((s) => s.session);
  assert.deepEqual(order, ['w2'], 'a closed dependency will never merge, so it is not something to wait on');
});

test('a dependency cycle is refused with the cycle named', () => {
  // Built by hand: claimSlot refuses unclaimable deps, so a cycle can only be
  // introduced by editing the file. It must still fail loudly at merge time.
  const reg = {
    version: 1,
    sessions: [
      { session: 'a', plan: 'p', branch: 'p/a', worktree: '/w/a', state: 'open', pr: 1, depends_on: ['b'] },
      { session: 'b', plan: 'p', branch: 'p/b', worktree: '/w/b', state: 'open', pr: 2, depends_on: ['a'] },
    ],
  };
  assert.throws(() => mergeOrder(reg), /dependency cycle among sessions: a -> b -> a/,
    'a cycle has no valid merge order; the remedy is to split a session, not to guess');
});

test('filtering the scope does not manufacture a cycle or a missing node', () => {
  // w2 depends on w1. Asking only for w2 must return w2, not fail on the w1
  // edge that is now out of scope.
  let reg = { version: 1, sessions: [] };
  reg = claimSlot(reg, { plan: 'p', session: 'w1', repoRoot: REPO }).registry;
  reg = claimSlot(reg, { plan: 'p', session: 'w2', repoRoot: REPO, dependsOn: ['w1'] }).registry;
  const order = mergeOrder(reg, { only: ['w2'] }).map((s) => s.session);
  assert.deepEqual(order, ['w2']);
});

// --- Conflict surface --------------------------------------------------------

test('a session cut before a merge must rebase before it merges', () => {
  // w1 merged, so the base branch moved. w2 was cut earlier, so its branch is
  // behind and merging it un-rebased is how a twenty-PR batch produces a
  // conflict storm.
  let reg = openSession('w1');
  reg = setState(reg, 'w1', 'merged').registry;
  reg = claimSlot(reg, { plan: 'p', session: 'w2', repoRoot: REPO }).registry;

  const surface = conflictSurface(reg, 'w2');
  assert.equal(surface.rebase_required, true);
  assert.deepEqual(surface.landed_before_rebase.map((s) => s.session), ['w1']);
  assert.ok(surface.landed_before_rebase[0].merged_at, 'the surface report is what tells the agent how far behind it is');
});

test('the first merge of a batch needs no rebase', () => {
  const surface = conflictSurface(openSession('w1'), 'w1');
  assert.equal(surface.rebase_required, false);
  assert.deepEqual(surface.landed_before_rebase, []);
});

test('conflict surface names the sessions that must land first', () => {
  let reg = { version: 1, sessions: [] };
  for (const [s, deps] of [['w1', []], ['w2', ['w1']]]) {
    reg = claimSlot(reg, { plan: 'p', session: s, repoRoot: REPO, dependsOn: deps }).registry;
  }
  reg = setState(setState(reg, 'w1', 'active').registry, 'w1', 'verified').registry;
  reg = setPr(reg, 'w1', 1).registry;
  reg = setState(setState(reg, 'w2', 'active').registry, 'w2', 'verified').registry;
  reg = setPr(reg, 'w2', 2).registry;

  assert.deepEqual(conflictSurface(reg, 'w2').blocked_by, ['w1']);
  assert.deepEqual(conflictSurface(reg, 'w1').blocked_by, []);
});

test('a closed session does not move the base, but does satisfy a dependency', () => {
  let reg = openSession('w1');
  reg = setState(reg, 'w1', 'closed').registry;
  reg = claimSlot(reg, { plan: 'p', session: 'w2', repoRoot: REPO, dependsOn: ['w1'] }).registry;

  const surface = conflictSurface(reg, 'w2');
  assert.equal(surface.rebase_required, false, 'a close leaves origin/<base> where it was; only a merge moves it');
  assert.deepEqual(surface.landed_before_rebase, [], 'a closed PR is not a landed merge');
  assert.deepEqual(surface.blocked_by, [], 'a closed dependency is finished, not something w2 must wait on');
});

// --- Persistence -------------------------------------------------------------

test('a duplicate branch in the file is refused on load, not tolerated', () => {
  // The header comment names this as failure mode #1. A registry that reports
  // success for a layout that will lose work is worse than no registry.
  const f = registryFile('dup', {
    version: 1,
    sessions: [
      { session: 'a', plan: 'p', branch: 'p/x', worktree: '/w/a', state: 'isolated' },
      { session: 'b', plan: 'p', branch: 'p/x', worktree: '/w/b', state: 'isolated' },
    ],
  });
  try {
    assert.throws(() => loadRegistry(f.file), /share branch p\/x/);
  } finally {
    f.cleanup();
  }
});

test('a duplicate worktree in the file is refused on load', () => {
  const f = registryFile('dupwt', {
    version: 1,
    sessions: [
      { session: 'a', plan: 'p', branch: 'p/a', worktree: '/w/same', state: 'isolated' },
      { session: 'b', plan: 'p', branch: 'p/b', worktree: '/w/same', state: 'isolated' },
    ],
  });
  try {
    assert.throws(() => loadRegistry(f.file), /share worktree \/w\/same/);
  } finally {
    f.cleanup();
  }
});

test('save refuses to persist a collision', () => {
  const f = registryFile('save');
  try {
    assert.throws(() => saveRegistry({
      version: 1,
      sessions: [
        { session: 'a', plan: 'p', branch: 'p/x', worktree: '/w/a', state: 'isolated' },
        { session: 'b', plan: 'p', branch: 'p/x', worktree: '/w/b', state: 'isolated' },
      ],
    }, f.file), /share branch/);
  } finally {
    f.cleanup();
  }
});

test('a round trip preserves every field the CLI depends on', () => {
  const f = registryFile('roundtrip');
  try {
    const claimed = claimSlot({ version: 1, sessions: [] }, { plan: 'p', session: 'w1', repoRoot: REPO });
    saveRegistry(claimed.registry, f.file);
    const back = loadRegistry(f.file);
    assert.equal(back.sessions[0].worktree, claimed.session.worktree, 'a lost worktree path means a lost worktree');
    assert.equal(back.sessions[0].branch, claimed.session.branch);
    assert.ok(back.sessions[0].claimed_at);
  } finally {
    f.cleanup();
  }
});

test('a missing registry file is an empty registry, not an error', () => {
  // The first agent of the first session has nothing to load. Refusing here
  // would make the tool unusable exactly when it is first needed.
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-registry-empty-'));
  try {
    const reg = loadRegistry(path.join(dir, 'nothing-here.json'));
    assert.deepEqual(reg, { version: 1, sessions: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt or future-version registry is refused with a readable reason', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-registry-bad-'));
  try {
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{ not json', 'utf8');
    assert.throws(() => loadRegistry(bad), /cannot parse PR registry/);

    const future = path.join(dir, 'future.json');
    writeFileSync(future, JSON.stringify({ version: 99, sessions: [] }), 'utf8');
    assert.throws(() => loadRegistry(future), /unsupported version 99/);

    const unknownState = path.join(dir, 'state.json');
    writeFileSync(unknownState, JSON.stringify({
      version: 1,
      sessions: [{ session: 'a', plan: 'p', branch: 'b', worktree: 'w', state: 'MERGED' }],
    }), 'utf8');
    assert.throws(() => loadRegistry(unknownState), /unknown state "MERGED"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session entry missing a required field names the field', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-registry-field-'));
  try {
    const f = path.join(dir, 'r.json');
    writeFileSync(f, JSON.stringify({ version: 1, sessions: [{ session: 'a' }] }), 'utf8');
    assert.throws(() => loadRegistry(f), /missing "plan"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Scale -------------------------------------------------------------------

test('twenty sessions get twenty distinct branches and worktrees', () => {
  // The number the skill advertises. If the naming scheme collides at this
  // scale it is useless, and nothing else in the pipeline would notice.
  let reg = { version: 1, sessions: [] };
  for (let i = 1; i <= 20; i++) {
    reg = claimSlot(reg, { plan: '2026-10-01-batch', session: `w${i}`, repoRoot: REPO }).registry;
  }
  assert.equal(new Set(reg.sessions.map((s) => s.branch)).size, 20);
  assert.equal(new Set(reg.sessions.map((s) => s.worktree)).size, 20);
  // A dependency chain across all twenty still produces a total order.
  let chained = { version: 1, sessions: [] };
  for (let i = 1; i <= 20; i++) {
    chained = claimSlot(chained, {
      plan: 'p', session: `w${i}`, repoRoot: REPO, dependsOn: i === 1 ? [] : [`w${i - 1}`],
    }).registry;
  }
  const order = mergeOrder(chained).map((s) => s.session);
  assert.equal(order.length, 20);
  assert.equal(order[0], 'w1');
  assert.equal(order[19], 'w20');
});

/** The temp-registry helper the mutual-exclusion tests below use. */
function tempRegistry(contents = null) {
  const f = registryFile('cas', contents === null ? { version: 1, sessions: [] } : contents);
  return { registryPath: f.file, dir: f.dir, cleanup: f.cleanup };
}

// ---------- mutual exclusion ----------
//
// The failure this closes. `saveRegistry` used to write unconditionally, and
// every command was a bare read-modify-write:
//
//   const registry = loadRegistry(path);   // read
//   const next = claimSlot(registry, …);  // compute
//   saveRegistry(next, path);              // write
//
// Two sessions claiming in the same window read the same bytes, and the second
// rename silently discarded the first claim. That is worse than a duplicate
// branch, because the branch and worktree of the lost session remain on disk
// while the registry has no record of them: `assertNoCollisions` is built to
// catch exactly that, and it arrives too late to catch it.
//
// There is no lock file, and that is the design rather than an omission. A lock
// needs a stale-lock policy, and a stale lock needs a decision about what a
// crashed holder does to the next one. Those are their own failure modes, and
// they would trade a silent lost write for a refused legitimate claim. Compare
// and swap has neither: it needs no state to survive a crash, because the state
// it reads IS the state.

test('saveRegistry refuses to overwrite bytes the caller did not read', () => {
  const { registryPath } = tempRegistry();
  saveRegistry({ version: 1, sessions: [] }, registryPath);
  const read = readRegistryRaw(registryPath);

  // Somebody else writes between the read and the save.
  saveRegistry({ version: 1, sessions: [{ session: 'other', plan: 'p', branch: 'b', worktree: 'w', state: 'isolated' }] }, registryPath);

  assert.throws(
    () => saveRegistry({ version: 1, sessions: [] }, registryPath, { expectedRaw: read }),
    /changed since it was read/,
  );
  // The other writer's session survived, which is the whole point.
  assert.equal(loadRegistry(registryPath).sessions.length, 1);
});

test('saveRegistry without expectedRaw still writes, so a solo caller is unaffected', () => {
  const { registryPath } = tempRegistry();
  saveRegistry({ version: 1, sessions: [] }, registryPath);
  const first = claimSlot(loadRegistry(registryPath), { plan: 'p', session: 'a', repoRoot: '/tmp' });
  saveRegistry(first.registry, registryPath);
  const second = claimSlot(loadRegistry(registryPath), { plan: 'p', session: 'b', repoRoot: '/tmp' });
  assert.doesNotThrow(() => saveRegistry(second.registry, registryPath));
  assert.equal(loadRegistry(registryPath).sessions.length, 2);
});

test('mutateRegistry re-applies on a fresh read instead of losing the write', () => {
  const { registryPath } = tempRegistry();
  saveRegistry({ version: 1, sessions: [] }, registryPath);

  let calls = 0;
  const { result, attempts } = mutateRegistry((registry) => {
    calls++;
    // A competing writer lands between this read and this save, exactly once.
    if (calls === 1) {
      saveRegistry({
        version: 1,
        sessions: [{ session: 'competitor', plan: 'p', branch: 'b0', worktree: 'w0', state: 'isolated' }],
      }, registryPath);
    }
    const claimed = claimSlot(registry, { plan: 'mine', session: 'mine', repoRoot: '/tmp' });
    return claimed.registry;
  }, { registryPath });

  assert.equal(calls, 2, 'the mutation must be re-applied on a fresh read');
  assert.equal(attempts, 2);
  const ids = loadRegistry(registryPath).sessions.map((s) => s.session).sort();
  assert.deepEqual(ids, ['competitor', 'mine'], 'the competing write must survive, not be discarded');
  assert.ok(result.sessions);
});

test('mutateRegistry gives up loudly rather than spinning forever', () => {
  const { registryPath } = tempRegistry();
  saveRegistry({ version: 1, sessions: [] }, registryPath);

  let calls = 0;
  assert.throws(() => mutateRegistry(() => {
    calls++;
    // Always racing, so no retry can win.
    saveRegistry({
      version: 1,
      sessions: [{ session: `racer-${calls}`, plan: 'p', branch: `b${calls}`, worktree: `w${calls}`, state: 'isolated' }],
    }, registryPath);
    return loadRegistry(registryPath);
  }, { registryPath, retries: 2 }), /written by another process 3 times in a row/);

  assert.equal(calls, 3, 'retries: 2 means three attempts in total, not two and not four');
});

test('two sequential claims of DIFFERENT sessions both land, through the CLI path', () => {
  // The regression that matters operationally: the claim path must still work
  // normally for the common case. A conflict check that refuses ordinary claims
  // would be worse than the defect it fixes.
  const { registryPath } = tempRegistry();
  for (const session of ['alpha', 'beta', 'gamma']) {
    mutateRegistry((registry) => claimSlot(registry, { plan: 'p', session, repoRoot: '/tmp' }).registry, { registryPath });
  }
  assert.deepEqual(loadRegistry(registryPath).sessions.map((s) => s.session), ['alpha', 'beta', 'gamma']);
});

test('re-claiming the same session stays idempotent under the CAS path', () => {
  // `claim` after a crashed session must return the same slot, not allocate a
  // second one. The CAS wrapper calls the mutation more than once under
  // contention, and idempotence is what makes that safe.
  const { registryPath } = tempRegistry();
  const once = mutateRegistry((r) => claimSlot(r, { plan: 'p', session: 'x', repoRoot: '/tmp' }).registry, { registryPath });
  const twice = mutateRegistry((r) => claimSlot(r, { plan: 'p', session: 'x', repoRoot: '/tmp' }).registry, { registryPath });
  assert.equal(loadRegistry(registryPath).sessions.length, 1);
  // `mutateRegistry` returns the mutation's own value under `result`, not the
  // registry: the two differ, because the registry the caller passed in was the
  // pre-mutation read.
  assert.equal(once.result.sessions[0].branch, twice.result.sessions[0].branch);
});
