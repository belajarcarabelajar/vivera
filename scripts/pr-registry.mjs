#!/usr/bin/env bun
// scripts/pr-registry.mjs
//
// Slot allocator and merge-order resolver for the PR delivery stage.
//
// The problem this solves: the skill now ends every session with a pull request
// instead of a commit on the working branch, and it explicitly supports running
// twenty or more sessions at once across panes. Twenty agents that each invent
// their own branch name and their own worktree path collide in three separate
// ways, and none of the collisions raise an error:
//
//   1. Two sessions pick the same branch name. The second `git push` either
//      fast-forwards the first session's PR or is rejected, and the agent
//      reaches for `--force` to make it "work".
//   2. Two sessions pick the same worktree path. `git worktree add` fails, or
//      worse, the second session works inside the first session's checkout and
//      both diffs become garbage.
//   3. Two sessions merge in the order they happened to finish, so a session
//      that depends on another lands first and conflicts with everything.
//
// A git-level guard cannot catch any of this, because each individual command
// is valid. So the naming is derived here instead of chosen by the agent, and
// the merge order is computed from a recorded dependency graph rather than
// from timestamps.
//
//   bun scripts/pr-registry.mjs claim --plan <plan-id> --session <slug>
//   bun scripts/pr-registry.mjs pr <session> --number 42
//   bun scripts/pr-registry.mjs state <session> <state>
//   bun scripts/pr-registry.mjs order
//   bun scripts/pr-registry.mjs status
//   bun test scripts/pr-registry.test.mjs
//
// Pure by design: this module never runs `git`, `gh`, or anything else. It
// reads and writes one JSON file and refuses ambiguous input. That is what makes
// it testable without a repository, and it is the same reason
// `plan-publish-registry.mjs` holds no vault I/O either.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeFileAtomic } from './lib/atomic-write.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
export const DEFAULT_REGISTRY = path.join(rootDir, 'pr.registry.json');

// A session moves through these in order. `merged` and `closed` are terminal.
//
//   isolated  worktree and branch exist, nothing written yet
//   active    subagents are writing inside the isolated worktree
//   verified  local evidence is green and the parent diff audit passed
//   open      the PR exists and is on the remote
//   merged    the PR reached the base branch
//   closed    the PR was closed without merging (superseded, abandoned, or its
//             change landed by another path). The record is kept so the session
//             still has history, but it owes no merge and must not block a
//             dependent the way an unmerged `open` session does.
//
// `verified` is a separate state from `open` on purpose. It is the gate that
// stops an agent from merging a session whose checks were never run, and it is
// the same distinction the plan lifecycle already draws between Verification and
// Complete.
export const SESSION_STATES = ['isolated', 'active', 'verified', 'open', 'merged', 'closed'];

// States from which a merge is allowed. `open` alone is not enough: the PR
// existing on the remote says nothing about whether the local evidence is green.
export const MERGEABLE_STATES = ['open'];

const TERMINAL_STATE = 'merged';
const CLOSED_STATE = 'closed';
// Both terminal states stop a session from moving again, but only `merged` moved
// the base branch. `closed` leaves origin/<base> untouched, so it must not feed
// the rebase calculation the way a merge does.
const TERMINAL_STATES = [TERMINAL_STATE, CLOSED_STATE];

// ---------- Naming ----------

// Branch and worktree names have to survive a POSIX filesystem, a git ref, and
// a shell. Everything outside this set collapses to a single dash so two
// different inputs can never produce the same slot by differing only in
// punctuation.
function slugify(input, label) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  const collapsed = input.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  // Checked before trimming, so a leading dot or dash is refused rather than
  // quietly trimmed into a legal-looking name. `git check-ref-format` rejects
  // both, and a branch the push cannot create is a slot the session cannot use.
  if (collapsed.startsWith('.') || collapsed.startsWith('-') || collapsed.includes('..')) {
    throw new Error(`${label} "${input}" normalises to "${collapsed}", which is not a legal branch segment`);
  }
  const slug = collapsed.replace(/-+$/g, '');
  if (slug === '') throw new Error(`${label} "${input}" contains no usable characters`);
  return slug;
}

export function branchFor(planId, sessionId) {
  return `ai/${slugify(planId, 'plan id')}/${slugify(sessionId, 'session id')}`;
}

// The worktree lives beside the repository, never inside it. A worktree nested
// in the repository it checks out is picked up by the parent's file watchers,
// formatters, and test globs, which then operate on two copies of the same file.
export function worktreeFor(repoRoot, sessionId) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new Error('repo root must be a non-empty string');
  }
  const base = path.basename(path.resolve(repoRoot));
  return path.join(path.dirname(path.resolve(repoRoot)), `${base}-wt`, slugify(sessionId, 'session id'));
}

// ---------- Loading ----------

export function loadRegistry(registryPath = DEFAULT_REGISTRY) {
  if (!existsSync(registryPath)) {
    return { version: 1, sessions: [] };
  }
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (e) {
    throw new Error(`cannot parse PR registry ${registryPath}: ${e.message}`);
  }
  if (!registry || typeof registry !== 'object') {
    throw new Error(`PR registry ${registryPath} is not a JSON object`);
  }
  if (registry.version !== 1) {
    throw new Error(`PR registry ${registryPath} has unsupported version ${JSON.stringify(registry.version)}; this tool writes version 1`);
  }
  if (!Array.isArray(registry.sessions)) {
    throw new Error(`PR registry ${registryPath} is missing a "sessions" array`);
  }
  for (const s of registry.sessions) {
    for (const field of ['session', 'plan', 'branch', 'worktree', 'state']) {
      if (!s || !s[field]) {
        throw new Error(`PR registry ${registryPath}: a session entry is missing "${field}" (${JSON.stringify(s)})`);
      }
    }
    if (!SESSION_STATES.includes(s.state)) {
      throw new Error(`PR registry ${registryPath}: session ${s.session} has unknown state ${JSON.stringify(s.state)}; expected one of ${SESSION_STATES.join(', ')}`);
    }
  }
  assertNoCollisions(registry.sessions, registryPath);
  return registry;
}

export function saveRegistry(registry, registryPath = DEFAULT_REGISTRY) {
  assertNoCollisions(registry.sessions, registryPath);
  mkdirSync(path.dirname(path.resolve(registryPath)), { recursive: true });
  // Atomic, with one generation of backup. The registry is the shipping bin: it
  // decides which session owns which branch and worktree, and it is gitignored,
  // so a truncated write is unrecoverable from git. `keepBackup` leaves the
  // previous generation at `<registry>.bak` for the one case that matters — the
  // moment right after a bad write. See scripts/lib/atomic-write.mjs.
  writeFileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { keepBackup: true });
  return registryPath;
}

// The three collisions named in the header comment, asserted on every load and
// every save. Refusing is the entire point: a registry that silently tolerates a
// duplicate branch is worse than no registry, because it reports success for a
// layout that will lose work.
function assertNoCollisions(sessions, where) {
  const branches = new Map();
  const worktrees = new Map();
  for (const s of sessions) {
    const prevBranch = branches.get(s.branch);
    if (prevBranch && prevBranch !== s.session) {
      throw new Error(`PR registry ${where}: sessions "${prevBranch}" and "${s.session}" share branch ${s.branch}; each session gets its own branch`);
    }
    branches.set(s.branch, s.session);

    const prevWorktree = worktrees.get(s.worktree);
    if (prevWorktree && prevWorktree !== s.session) {
      throw new Error(`PR registry ${where}: sessions "${prevWorktree}" and "${s.session}" share worktree ${s.worktree}; each session gets its own worktree`);
    }
    worktrees.set(s.worktree, s.session);
  }
}

// ---------- Claim ----------

export function claimSlot(registry, { plan, session, repoRoot, dependsOn = [] }) {
  const planSlug = slugify(plan, 'plan id');
  const sessionSlug = slugify(session, 'session id');
  const branch = branchFor(planSlug, sessionSlug);
  const worktree = worktreeFor(repoRoot, sessionSlug);

  const existing = registry.sessions.find((s) => s.session === sessionSlug);
  if (existing) {
    // Re-claiming the same session id is idempotent rather than an error: a
    // retried claim after a crashed session must not need a manual edit, and
    // the derived names are a pure function of the inputs so they cannot drift.
    return { session: existing, created: false };
  }

  const known = new Set(registry.sessions.map((s) => s.session));
  for (const dep of dependsOn) {
    const depSlug = slugify(dep, 'depends_on entry');
    if (!known.has(depSlug)) {
      throw new Error(`session "${sessionSlug}" depends on "${depSlug}", which holds no slot in this registry; claim the dependency first so the merge order is provable`);
    }
  }

  const record = {
    session: sessionSlug,
    plan: planSlug,
    branch,
    worktree,
    base: 'main',
    state: 'isolated',
    pr: null,
    depends_on: dependsOn.map((d) => slugify(d, 'depends_on entry')),
    claimed_at: new Date().toISOString(),
  };

  // Mutates a copy, so a caller holding the old object still sees a consistent
  // registry if this throws.
  const next = { ...registry, sessions: [...registry.sessions, record] };
  assertNoCollisions(next.sessions, 'claim');
  return { session: record, created: true, registry: next };
}

// ---------- State transitions ----------

export function setPr(registry, sessionId, number) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`PR number must be a positive integer, got ${JSON.stringify(number)}`);
  }
  return transition(registry, sessionId, (s) => {
    if (s.pr !== null && s.pr !== number) {
      throw new Error(`session "${s.session}" already records PR #${s.pr}; refusing to repoint it at #${number}. Delete the stale slot if the old PR was closed.`);
    }
    // Recording the PR implies the work is finished and verified, so the state
    // moves forward rather than back. Allowing `isolated -> open` would let a
    // session skip its evidence gate entirely.
    if (!['verified', 'open', 'merged'].includes(s.state)) {
      throw new Error(`session "${s.session}" is ${s.state}; a PR number can only be recorded after the session reaches "verified"`);
    }
    return { ...s, pr: number, state: s.state === 'verified' ? 'open' : s.state };
  });
}

export function setState(registry, sessionId, next) {
  if (!SESSION_STATES.includes(next)) {
    throw new Error(`unknown session state ${JSON.stringify(next)}; expected one of ${SESSION_STATES.join(', ')}`);
  }
  return transition(registry, sessionId, (s) => {
    if (next === TERMINAL_STATE) {
      return assertMergeable(s);
    }
    // Both terminal states are final. Nothing reopens a session: one that
    // reached the base branch cannot be "un-merged" by editing a file, and one
    // whose PR is closed is finished. Redoing either is a new session.
    if (TERMINAL_STATES.includes(s.state)) {
      throw new Error(`session "${s.session}" is already ${s.state}; reverting or redoing it is a new session, not a state change`);
    }
    if (next === CLOSED_STATE) {
      return { ...s, state: next, closed_at: new Date().toISOString() };
    }
    return { ...s, state: next };
  });
}

function transition(registry, sessionId, fn) {
  const target = slugify(sessionId, 'session id');
  const index = registry.sessions.findIndex((s) => s.session === target);
  if (index === -1) {
    throw new Error(`no slot for session "${target}"; claim it first`);
  }
  const sessions = [...registry.sessions];
  sessions[index] = fn(sessions[index]);
  const next = { ...registry, sessions };
  assertNoCollisions(next.sessions, 'transition');
  return { registry: next, session: sessions[index] };
}

function assertMergeable(s) {
  if (!MERGEABLE_STATES.includes(s.state)) {
    throw new Error(`session "${s.session}" is ${s.state}; only a session in ${MERGEABLE_STATES.join('/')} can merge. Run the local checks and the parent diff audit first, then record the PR.`);
  }
  if (!s.pr) {
    throw new Error(`session "${s.session}" has no recorded PR number; there is nothing to merge`);
  }
  return { ...s, state: TERMINAL_STATE, merged_at: new Date().toISOString() };
}

// ---------- Merge order ----------

// Topological order over the recorded `depends_on` graph, restricted to the
// sessions that actually need merging. Ties break on session name so the same
// registry always produces the same order; a timestamp tiebreak would make the
// plan unreproducible and two runs of the same registry would disagree.
//
// Sessions that are not ready are omitted rather than blocking: that is the
// plan's own blast-radius rule applied to merges, where an independent session
// waiting on nothing should still be able to land.
export function mergeOrder(registry, { only = null } = {}) {
  const wanted = only ? new Set(only.map((s) => slugify(s, 'session filter'))) : null;
  const inScope = registry.sessions.filter((s) => {
    if (TERMINAL_STATES.includes(s.state)) return false;
    if (wanted && !wanted.has(s.session)) return false;
    return true;
  });

  const byName = new Map(inScope.map((s) => [s.session, s]));
  const ordered = [];
  const placed = new Set();
  const visiting = new Set();

  const visit = (name, trail) => {
    if (placed.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`dependency cycle among sessions: ${[...trail, name].join(' -> ')}. A cycle cannot be merged in any order; break it by splitting one session.`);
    }
    const node = byName.get(name);
    // A dependency outside the requested scope is treated as already-landed.
    // Filtering must not manufacture a cycle or a missing-node error.
    if (!node) return;
    visiting.add(name);
    for (const dep of node.depends_on ?? []) visit(dep, [...trail, name]);
    visiting.delete(name);
    placed.add(name);
    ordered.push(node);
  };

  for (const name of [...byName.keys()].sort()) visit(name, []);
  return ordered;
}

// A dry-run report of what the next merge will touch, so the conflict surface is
// known before the first rebase rather than after it.
export function conflictSurface(registry, sessionId) {
  const target = slugify(sessionId, 'session id');
  const node = registry.sessions.find((s) => s.session === target);
  if (!node) throw new Error(`no slot for session "${target}"; claim it first`);

  // Anything already merged can conflict with this session, because the base
  // branch moved after this branch was cut. A closed session did not move the
  // base, so it is not a rebase reason even though it does satisfy a dependency.
  const landed = registry.sessions.filter((s) => s.state === TERMINAL_STATE && s.session !== target);
  // `blocked_by` is this session's own unmerged dependencies, not its
  // dependents. Naming the wrong direction would tell a session to wait on the
  // sessions that are actually waiting on it. A closed dependency is finished:
  // it will never merge, so listing it as blocked would wait forever.
  const resolved = new Set(
    registry.sessions.filter((s) => TERMINAL_STATES.includes(s.state)).map((s) => s.session),
  );
  const pending = (node.depends_on ?? []).filter((d) => !resolved.has(d));

  return {
    session: node,
    rebase_required: landed.length > 0,
    landed_before_rebase: landed.map((s) => ({ session: s.session, plan: s.plan, merged_at: s.merged_at ?? null })),
    blocked_by: pending,
  };
}

// ---------- CLI ----------

function usage(msg) {
  if (msg) console.error(`❌ ${msg}`);
  console.error('usage:');
  console.error('  bun scripts/pr-registry.mjs claim --plan <plan-id> --session <slug> [--repo <path>] [--depends-on <slug,...>]');
  console.error('  bun scripts/pr-registry.mjs pr <session> --number <N>');
  console.error('  bun scripts/pr-registry.mjs state <session> <' + SESSION_STATES.join('|') + '>');
  console.error('  bun scripts/pr-registry.mjs order');
  console.error('  bun scripts/pr-registry.mjs surface <session>');
  console.error('  bun scripts/pr-registry.mjs status');
  process.exit(2);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) usage(`--${key} needs a value`);
      flags[key] = next;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function printSession(s) {
  const pr = s.pr ? `#${s.pr}` : '-';
  console.log(`${s.session.padEnd(24)} ${s.state.padEnd(10)} ${pr.padEnd(7)} ${s.branch}`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command) usage();
  const { flags, positional } = parseFlags(rest);
  const registryPath = flags.registry || DEFAULT_REGISTRY;

  try {
    if (command === 'claim') {
      if (!flags.plan || !flags.session) usage('claim needs --plan and --session');
      const repoRoot = flags.repo || process.cwd();
      const registry = loadRegistry(registryPath);
      const { session, created, registry: next } = claimSlot(registry, {
        plan: flags.plan,
        session: flags.session,
        repoRoot,
        dependsOn: flags['depends-on'] ? flags['depends-on'].split(',').map((d) => d.trim()).filter(Boolean) : [],
      });
      if (created) saveRegistry(next, registryPath);
      console.log(`${created ? '✅ claimed' : '♻️  already claimed'}: ${session.session}`);
      printSession(session);
      if (created) {
        console.log('');
        console.log('Next, in the repository, before any subagent writes:');
        console.log(`  git worktree prune`);
        console.log(`  git fetch origin ${session.base}`);
        console.log(`  git worktree add ${session.worktree} -b ${session.branch} origin/${session.base}`);
      }
      return 0;
    }

    if (command === 'pr') {
      if (!positional[0] || !flags.number) usage('pr needs <session> --number <N>');
      const { registry, session } = setPr(loadRegistry(registryPath), positional[0], Number(flags.number));
      saveRegistry(registry, registryPath);
      console.log(`✅ recorded PR #${session.pr} for ${session.session}`);
      printSession(session);
      return 0;
    }

    if (command === 'state') {
      if (!positional[0] || !positional[1]) usage(`state needs <session> <${SESSION_STATES.join('|')}>`);
      const { registry, session } = setState(loadRegistry(registryPath), positional[0], positional[1]);
      saveRegistry(registry, registryPath);
      console.log(`✅ ${session.session} -> ${session.state}`);
      return 0;
    }

    if (command === 'order') {
      const order = mergeOrder(loadRegistry(registryPath));
      if (order.length === 0) {
        console.log('No unmerged sessions. Nothing to do.');
        return 0;
      }
      console.log('Merge in this order. Rebase each branch onto origin/<base> immediately before its own merge,');
      console.log('run the local checks, then merge. One at a time; a batch merge is an unverified batch.\n');
      order.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.session.padEnd(24)} ${s.state.padEnd(10)} pr=${s.pr ?? '-'}  deps=[${(s.depends_on ?? []).join(', ') || '-'}]`));
      return 0;
    }

    if (command === 'surface') {
      if (!positional[0]) usage('surface needs <session>');
      const surface = conflictSurface(loadRegistry(registryPath), positional[0]);
      console.log(JSON.stringify(surface, null, 2));
      if (surface.rebase_required) {
        console.error(`\n⚠️  ${surface.landed_before_rebase.length} session(s) already landed; rebase ${surface.session.branch} onto origin/${surface.session.base} before merging it.`);
      }
      return 0;
    }

    if (command === 'status') {
      const registry = loadRegistry(registryPath);
      if (registry.sessions.length === 0) {
        console.log('No sessions claimed.');
        return 0;
      }
      console.log('session                     state      pr       branch');
      for (const s of registry.sessions) printSession(s);
      return 0;
    }

    usage(`unknown command "${command}"`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('pr-registry.mjs');
if (isMain) process.exit(main(process.argv.slice(2)));
