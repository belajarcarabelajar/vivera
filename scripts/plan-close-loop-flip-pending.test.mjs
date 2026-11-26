// scripts/plan-close-loop-flip-pending.test.mjs
//
// --flip and an earlier close-out PR recorded in due.json: the PR state is read
// through the injected gh. OPEN and MERGED skip, CLOSED clears the record and
// flips, an unreadable state skips. Plans are gitignored, so they flip in place,
// except in trackedFixture, a clone of a bare origin for the close-out PR path.

import './lib/local-runner-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as flip from './lib/closeout-flip.mjs';
import * as loop from './plan-close-loop.mjs';
import { planStatus } from './plan-issue-sync.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  delete process.env.VIVERA_CLOSEOUT_STATE;
  delete process.env.VIVERA_CLOSEOUT_WT_ROOT;
});

const PLAN = (id, skipIf = 'true') => [
  '---', `plan_id: ${id}`, 'status: Verification', 'tasks:', '  - id: T1', '    depends_on: []', `    skip_if: "${skipIf}"`, '---', '',
  `# ${id}`, '', '### Task T1: work', '- [ ] Step 1: run it', '',
].join('\n');

function fixture({ ready = PLAN('ready') } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-pending-'));
  dirs.push(root);
  const repo = path.join(root, 'widgets');
  const planDir = path.join(repo, 'docs', 'code-plan', 'plans');
  mkdirSync(planDir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, '.gitignore'), 'docs/code-plan/\n');
  const file = (id) => path.join(planDir, `${id}.md`);
  writeFileSync(file('ready'), ready);
  writeFileSync(file('other'), PLAN('other'));
  const registry = path.join(root, 'pr.registry.json');
  writeFileSync(registry, JSON.stringify({ sessions: ['ready', 'other'].map((plan) => ({ session: `s-${plan}`, plan, state: 'merged', repo })) }));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir);
  process.env.VIVERA_CLOSEOUT_STATE = stateDir;
  const due = path.join(stateDir, 'due.json');
  writeFileSync(due, JSON.stringify({ generated_at: '2026-11-25T00:00:00.000Z', plans: [
    { plan: 'ready', repo, file: file('ready'), hash: 'deadbeef', verdict: 'PR-OPEN', asserted: 0, tickable: 1, pending_pr: { number: 7, repo: 'acme/widgets', opened_at: '2026-11-25T00:00:00.000Z' } },
  ] }));
  return { repo, registry, file, due };
}

function flipWith(fx, ghReply) {
  const views = [];
  const deps = {
    git: (args, { cwd }) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    gh: (args) => {
      views.push(args);
      return ghReply;
    },
    sync: () => ({ code: 0 }),
    measure: loop.readinessMeasure({ registry: fx.registry, timeoutS: 30 }),
  };
  const r = flip.flipRepo({ repoRoot: fx.repo, plans: [{ plan: 'ready', file: fx.file('ready') }, { plan: 'other', file: fx.file('other') }], deps });
  return { r, views, ready: readFileSync(fx.file('ready'), 'utf8'), entry: JSON.parse(readFileSync(fx.due, 'utf8')).plans.find((p) => p.plan === 'ready') };
}
const state = (s) => ({ code: 0, stdout: JSON.stringify({ state: s }), stderr: '' });

test('pending: an OPEN close-out PR skips the plan, read through gh pr view, and the others flip', () => {
  const fx = fixture();
  const { r, views, ready, entry } = flipWith(fx, state('OPEN'));
  assert.deepEqual(views, [['pr', 'view', '7', '--repo', 'acme/widgets', '--json', 'state']]);
  assert.deepEqual(r.skipped, [{ plan: 'ready', reason: 'closeout PR #7 open' }]);
  assert.deepEqual(r.flipped, ['other']);
  assert.equal(ready, PLAN('ready'));
  assert.equal(entry.pending_pr.number, 7);
});

test('pending: a MERGED close-out PR skips the plan and says to pull, then run --due', () => {
  const fx = fixture();
  const { r, ready } = flipWith(fx, state('MERGED'));
  assert.deepEqual(r.skipped, [{ plan: 'ready', reason: `closeout PR #7 merged; pull ${fx.repo}, then run --due again` }]);
  assert.deepEqual(r.flipped, ['other']);
  assert.equal(ready, PLAN('ready'));
});

test('pending: a CLOSED close-out PR clears pending_pr and the plan flips', () => {
  const fx = fixture();
  const { r, ready, entry } = flipWith(fx, state('CLOSED'));
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.flipped, ['ready', 'other']);
  assert.equal(planStatus(ready), 'Complete');
  assert.equal(entry.pending_pr, null);
});

test('pending: an unreadable PR state skips the plan with the gh error, never flips it', () => {
  for (const [reply, why] of [[{ code: 1, stdout: '', stderr: 'HTTP 502: bad gateway' }, /HTTP 502: bad gateway/], [state('DRAFTY'), /DRAFTY/]]) {
    const fx = fixture();
    const { r, ready, entry } = flipWith(fx, reply);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].plan, 'ready');
    assert.match(r.skipped[0].reason, /^closeout PR #7 state unreadable/);
    assert.match(r.skipped[0].reason, why);
    assert.deepEqual(r.flipped, ['other']);
    assert.equal(ready, PLAN('ready'));
    assert.equal(entry.pending_pr.number, 7);
  }
});

test('pending: a CLOSED PR cleared for a plan that then measures NOT-READY leaves no PR-OPEN label behind', () => {
  const fx = fixture({ ready: PLAN('ready', 'exit 1') });
  const { r, entry } = flipWith(fx, state('CLOSED'));
  assert.deepEqual(r.skipped, [{ plan: 'ready', reason: 'NOT-READY' }]);
  assert.equal(entry.pending_pr, null);
  assert.equal(entry.verdict, null);
});

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// The plan is committed and pushed, so --flip takes the close-out PR path.
function trackedFixture({ stateDir } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-pending-tracked-'));
  dirs.push(root);
  const bare = path.join(root, 'acme', 'widgets.git');
  mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '--bare', '-q', '-b', 'main');
  const repo = path.join(root, 'widgets');
  sh(root, 'clone', '-q', bare, repo);
  for (const [k, v] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false']]) sh(repo, 'config', k, v);
  const file = path.join(repo, 'docs', 'code-plan', 'plans', 'ready.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, PLAN('ready'));
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'plan');
  sh(repo, 'push', '-q', '-u', 'origin', 'main');
  sh(repo, 'remote', 'set-head', 'origin', '-a');
  const registry = path.join(root, 'pr.registry.json');
  writeFileSync(registry, JSON.stringify({ sessions: [{ session: 's-ready', plan: 'ready', state: 'merged', repo }] }));
  process.env.VIVERA_CLOSEOUT_STATE = stateDir ? stateDir(root) : path.join(root, 'state');
  process.env.VIVERA_CLOSEOUT_WT_ROOT = path.join(root, 'wt');
  mkdirSync(process.env.VIVERA_CLOSEOUT_WT_ROOT);
  const deps = {
    git: (args, { cwd }) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    gh: (args) => (args[1] === 'view' ? state('CLOSED') : { code: 0, stdout: 'https://github.com/acme/widgets/pull/42\n', stderr: '' }),
    sync: () => ({ code: 0 }),
    measure: loop.readinessMeasure({ registry, timeoutS: 30 }),
  };
  const closeouts = (dir) => sh(dir, 'branch', '--list', 'closeout/*');
  return { root, bare, repo, file, deps, closeouts, flip: () => flip.flipRepo({ repoRoot: repo, plans: [{ plan: 'ready', file }], deps }) };
}

test('pending: a due.json write that throws after the PR exists reports the PR and the error and still drops the worktree and branch', () => {
  // A state dir under a regular file, so the mkdir inside writeDue throws ENOTDIR.
  const fx = trackedFixture({ stateDir: (root) => path.join(root, 'blocker', 'state') });
  writeFileSync(path.join(fx.root, 'blocker'), 'not a directory\n');
  const r = fx.flip();
  assert.equal(r.pr?.number, 42);
  assert.deepEqual(r.flipped, ['ready']);
  assert.match(r.error ?? '', /^pending_pr for PR #42 not recorded \(.*ENOTDIR/);
  assert.deepEqual(readdirSync(path.join(fx.root, 'wt')), []);
  assert.equal(fx.closeouts(fx.repo), '');
  // The PR exists, so its branch stays on origin.
  assert.match(fx.closeouts(fx.bare), /closeout\//);
});

test('pending: a CLOSED PR cleared for a plan then skipped as drift leaves no PR-OPEN label behind', () => {
  const fx = trackedFixture();
  const due = path.join(process.env.VIVERA_CLOSEOUT_STATE, 'due.json');
  mkdirSync(path.dirname(due));
  writeFileSync(due, JSON.stringify({ generated_at: '2026-11-25T00:00:00.000Z', plans: [
    { plan: 'ready', repo: fx.repo, file: fx.file, hash: 'deadbeef', verdict: 'PR-OPEN', asserted: 0, tickable: 1, pending_pr: { number: 7, repo: 'acme/widgets', opened_at: '2026-11-25T00:00:00.000Z' } },
  ] }));
  writeFileSync(fx.file, PLAN('ready') + '\nA local note not pushed yet.\n');
  const r = fx.flip();
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.flipped, []);
  assert.match(r.skipped[0]?.reason ?? '', /^plan differs between/);
  const entry = JSON.parse(readFileSync(due, 'utf8')).plans.find((p) => p.plan === 'ready');
  assert.equal(entry.pending_pr, null);
  assert.equal(entry.verdict, null);
});
