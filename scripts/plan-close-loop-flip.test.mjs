// scripts/plan-close-loop-flip.test.mjs
//
// The Complete flip (AC-4): bare-origin fixtures, real git and readiness CLI,
// recording stubs for gh and the sync, state and worktrees in temp dirs.

import './lib/local-runner-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Namespace imports, so a missing export fails its own test instead of the whole file.
import * as flip from './lib/closeout-flip.mjs';
import * as loop from './plan-close-loop.mjs';
import { planStatus } from './plan-issue-sync.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-close-loop.mjs');
// Local time 12:34:56, so the branch stamp is a known literal in any time zone.
const NOW = new Date(2026, 10, 26, 12, 34, 56).getTime();
const STAMP = '2026-11-26-123456';
const BRANCH = `closeout/${STAMP}`;
const REL = 'docs/code-plan/plans/ready.md';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  delete process.env.VIVERA_CLOSEOUT_STATE;
  delete process.env.VIVERA_CLOSEOUT_WT_ROOT;
  delete process.env.VIVERA_PLANS_PUBLISH;
});
const tmp = (p) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};

const planOf = (id, tasks, status = 'Verification  # set by the runner') => [
  '---',
  'schema: ultra-plan/v1',
  `plan_id: ${id}`,
  `status: ${status}`,
  'tasks:',
  ...tasks.flatMap((t) => [`  - id: ${t.id}`, '    depends_on: []', `    skip_if: ${JSON.stringify(t.skipIf)}`]),
  '---',
  '',
  `# ${id}`,
  '',
  ...tasks.flatMap((t) => [`### Task ${t.id}: work`, ...t.body, '']),
].join('\n');

// READY once the open box of the DONE task T1 is ticked; T2 is DONE-ASSERTED.
const READY = planOf('ready', [
  { id: 'T1', skipIf: 'true', body: ['- [ ] Step 1: run it'] },
  { id: 'T2', skipIf: 'false', body: ['- [x] Step 1: did it'] },
]);
const OTHER = planOf('other', [{ id: 'T1', skipIf: 'true', body: ['- [ ] Step 1: run it'] }]);
const otherOf = (fx) => ({ plan: 'other', file: path.join(fx.repo, 'docs', 'code-plan', 'plans', 'other.md') });
const FAILING = planOf('ready', [{ id: 'T1', skipIf: 'exit 1', body: ['- [ ] Step 1: a'] }]);

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// A clone of <tmp>/acme/widgets.git, so the owner/name slug comes from the origin path.
function fixture({ text = READY, ignored = false, extra = {} } = {}) {
  const root = tmp('closeout-flip-');
  const bare = path.join(root, 'acme', 'widgets.git');
  mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '--bare', '-q', '-b', 'main');
  const repo = path.join(root, 'widgets');
  sh(root, 'clone', '-q', bare, repo);
  sh(repo, 'config', 'user.name', 'Fixture');
  sh(repo, 'config', 'user.email', 'fixture@example.invalid');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(repo, 'docs', 'code-plan', 'plans'), { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), 'widgets\n');
  if (ignored) writeFileSync(path.join(repo, '.gitignore'), 'docs/code-plan/\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, REL), text);
  for (const [id, body] of Object.entries(extra)) writeFileSync(path.join(repo, 'docs', 'code-plan', 'plans', `${id}.md`), body);
  if (!ignored) {
    sh(repo, 'add', 'docs');
    sh(repo, 'commit', '-q', '-m', 'plan');
  }
  sh(repo, 'push', '-q', '-u', 'origin', 'main');
  sh(repo, 'remote', 'set-head', 'origin', '-a');
  const stateDir = path.join(root, 'state');
  const wtRoot = path.join(root, 'wt');
  mkdirSync(wtRoot);
  process.env.VIVERA_CLOSEOUT_STATE = stateDir;
  process.env.VIVERA_CLOSEOUT_WT_ROOT = wtRoot;
  const publish = path.join(root, 'plans.publish.json');
  writeFileSync(publish, JSON.stringify({ vault: '/nowhere', projects: [{ name: 'widgets', root: repo, mirror: true }, { name: 'other', root: '/elsewhere' }] }));
  process.env.VIVERA_PLANS_PUBLISH = publish;
  const registry = path.join(root, 'pr.registry.json');
  writeFileSync(registry, JSON.stringify({ sessions: [{ session: 's-ready', plan: 'ready', state: 'merged', repo }] }));
  return { root, bare, repo, stateDir, wtRoot, registry, file: path.join(repo, REL), wt: path.join(wtRoot, `vivera-closeout-${STAMP}-widgets`) };
}

function recorder(fx, { failPush = false, failPr = false, throwSync = false } = {}) {
  const events = [];
  const deps = {
    git(args, { cwd }) {
      events.push({ kind: 'git', args });
      if (failPush && args[0] === 'push') return { code: 1, stdout: '', stderr: 'remote: permission denied' };
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    gh(args, { input }) {
      events.push({ kind: 'gh', args, input });
      if (failPr) return { code: 1, stdout: '', stderr: 'GraphQL: a pull request already exists' };
      return { code: 0, stdout: 'https://github.com/acme/widgets/pull/42\n', stderr: '' };
    },
    sync(file, { env }) {
      if (throwSync) throw new Error('boom: vault unreachable');
      const config = env.PLAN_PUBLISH_CONFIG ? JSON.parse(readFileSync(env.PLAN_PUBLISH_CONFIG, 'utf8')) : null;
      events.push({ kind: 'sync', file, config, text: readFileSync(file, 'utf8') });
      return { code: 0 };
    },
    // The --due measure.
    measure: loop.readinessMeasure({ registry: fx.registry, timeoutS: 30 }),
  };
  return { deps, events, of: (k) => events.filter((e) => e.kind === k) };
}

const run = (fx, rec, now = NOW, plans = [{ plan: 'ready', file: fx.file }]) => flip.flipRepo({ repoRoot: fx.repo, plans, deps: rec.deps, now });
const localCloseouts = (fx) => sh(fx.repo, 'branch', '--list', 'closeout/*');
const remoteCloseouts = (fx) => sh(fx.bare, 'branch', '--list', 'closeout/*').split('\n').map((b) => b.trim()).filter(Boolean);
const pushes = (rec) => rec.of('git').filter((e) => e.args[0] === 'push');
const readDue = (fx) => JSON.parse(readFileSync(path.join(fx.stateDir, 'due.json'), 'utf8'));

test('flip: a tracked plan goes out as one close-out commit and PR, then syncs and records pending_pr', () => {
  const fx = fixture();
  const rec = recorder(fx);
  const r = run(fx, rec);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.pr, { number: 42, url: 'https://github.com/acme/widgets/pull/42' });
  assert.deepEqual(r.flipped, ['ready']);
  assert.deepEqual(r.skipped, []);

  assert.equal(sh(fx.bare, 'rev-list', '--count', `main..${BRANCH}`), '1');
  assert.equal(sh(fx.bare, 'log', '-1', '--format=%s', BRANCH), 'docs(plans): close out 1 finished plan(s)');
  assert.equal(sh(fx.bare, 'diff', '--name-only', 'main', BRANCH), REL);
  const shipped = sh(fx.bare, 'show', `${BRANCH}:${REL}`);
  assert.equal(planStatus(shipped), 'Complete');
  assert.match(shipped, /^status: Complete$/m);
  assert.match(shipped, /^- \[x\] Step 1: run it$/m);
  assert.match(shipped, /^- \[x\] Step 1: did it$/m);
  // The main checkout changes only through the merge.
  assert.equal(readFileSync(fx.file, 'utf8'), READY);

  const gh = rec.of('gh');
  assert.equal(gh.length, 1);
  const a = gh[0].args;
  assert.deepEqual(a.slice(0, 2), ['pr', 'create']);
  for (const [flag, value] of [['--repo', 'acme/widgets'], ['--base', 'main'], ['--head', BRANCH], ['--title', 'Close out 1 finished plan(s)'], ['--body-file', '-']]) {
    assert.equal(a[a.indexOf(flag) + 1], value, flag);
  }
  assert.match(gh[0].input, /ready: READY \(asserted 1, ticked 1\)/);

  const order = rec.events.filter((e) => e.kind !== 'git').map((e) => e.kind);
  assert.deepEqual(order, ['gh', 'sync']);
  const [s] = rec.of('sync');
  assert.equal(s.file, path.join(fx.wt, REL));
  assert.equal(planStatus(s.text), 'Complete');
  const project = s.config.projects.find((p) => p.name === 'widgets');
  assert.deepEqual(project.worktrees, [fx.wt]);
  assert.equal(s.config.projects.find((p) => p.name === 'other').worktrees, undefined);

  const entry = readDue(fx).plans.find((p) => p.plan === 'ready');
  assert.equal(entry.pending_pr.number, 42);
  assert.equal(entry.pending_pr.repo, 'acme/widgets');
  assert.equal(entry.pending_pr.opened_at, new Date(NOW).toISOString());
  assert.equal(entry.verdict, 'PR-OPEN');
  assert.deepEqual(Object.keys(entry).sort(), ['asserted', 'file', 'hash', 'pending_pr', 'plan', 'repo', 'tickable', 'verdict']);
  assert.equal(existsSync(fx.wt), false);
  // The remote branch backs the PR; the local one is gone.
  assert.equal(localCloseouts(fx), '');
});

test('flip: plans gitignored in their repository are written in place with no git call but check-ignore', () => {
  const fx = fixture({ ignored: true });
  const rec = recorder(fx);
  const head = sh(fx.repo, 'rev-parse', 'HEAD');
  const r = run(fx, rec);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.pr, null);
  assert.deepEqual(r.flipped, ['ready']);
  const text = readFileSync(fx.file, 'utf8');
  assert.equal(planStatus(text), 'Complete');
  assert.match(text, /^- \[x\] Step 1: run it$/m);
  assert.deepEqual([...new Set(rec.of('git').map((e) => e.args[0]))], ['check-ignore']);
  assert.equal(sh(fx.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(rec.of('gh').length, 0);
  assert.deepEqual(rec.of('sync').map((e) => e.file), [fx.file]);
});

// A failed run leaves no worktree, branch or remote branch, so a rerun starts clean.
function assertRolledBack(fx, r) {
  assert.equal(r.pr, null);
  assert.deepEqual(r.flipped, []);
  assert.equal(existsSync(fx.wt), false);
  assert.equal(localCloseouts(fx), '');
  assert.deepEqual(remoteCloseouts(fx), []);
  assert.equal(existsSync(path.join(fx.stateDir, 'due.json')), false);
}

function assertRerunFlips(fx) {
  const rec = recorder(fx);
  const r = run(fx, rec);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.flipped, ['ready']);
  assert.equal(pushes(rec).length, 1);
  assert.equal(rec.of('gh').length, 1);
  assert.deepEqual(remoteCloseouts(fx), [BRANCH]);
}

test('flip: a failed push rolls back fully, so a rerun flips and pushes once', () => {
  const fx = fixture();
  const rec = recorder(fx, { failPush: true });
  const r = run(fx, rec);
  assert.match(r.error ?? '', /push/);
  assert.match(r.error, /permission denied/);
  assert.equal(rec.of('gh').length, 0);
  assert.equal(rec.of('sync').length, 0);
  assertRolledBack(fx, r);
  assertRerunFlips(fx);
});

test('flip: a failed gh pr create deletes the pushed branch, so a rerun flips and pushes once', () => {
  const fx = fixture();
  const rec = recorder(fx, { failPr: true });
  const r = run(fx, rec);
  assert.match(r.error ?? '', /pr create/);
  assert.match(r.error, /already exists/);
  assert.equal(rec.of('sync').length, 0);
  assertRolledBack(fx, r);
  assertRerunFlips(fx);
});

test('flip: two flips at different times open two PRs on their own branches and leave no local branch', () => {
  // A second plan, because the first one's open close-out PR now refuses it.
  const fx = fixture({ extra: { other: OTHER } });
  const rec = recorder(fx);
  const first = run(fx, rec);
  const second = run(fx, rec, NOW + 60 * 60 * 1000, [otherOf(fx)]);
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.equal(second.error, undefined, JSON.stringify(second));
  assert.deepEqual([first.flipped, second.flipped], [['ready'], ['other']]);
  assert.equal(rec.of('gh').length, 2);
  assert.deepEqual(remoteCloseouts(fx), [BRANCH, 'closeout/2026-11-26-133456']);
  assert.equal(localCloseouts(fx), '');
  assert.equal(sh(fx.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
});

test('flip: a plan edited in the main checkout but not on origin is skipped as drift, with no PR', () => {
  const fx = fixture();
  writeFileSync(fx.file, READY + '\nA local note not pushed yet.\n');
  const rec = recorder(fx);
  const r = run(fx, rec);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.flipped, []);
  assert.deepEqual(r.skipped, [{ plan: 'ready', reason: `plan differs between ${fx.repo} and origin/main; pull, then run --due again` }]);
  assert.equal(rec.of('gh').length, 0);
  assert.equal(existsSync(fx.wt), false);
});

test('flip: skip_if runs in the main checkout, so a file only it has still counts', () => {
  const fx = fixture({ text: planOf('ready', [
    { id: 'T1', skipIf: 'test -f local-only.txt', body: ['- [ ] Step 1: run it'] },
    { id: 'T2', skipIf: 'false', body: ['- [x] Step 1: did it'] },
  ]) });
  // Untracked, so the worktree at origin/main lacks it, like node_modules.
  writeFileSync(path.join(fx.repo, 'local-only.txt'), 'x\n');
  const rec = recorder(fx);
  const r = run(fx, rec);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.flipped, ['ready']);
  assert.match(sh(fx.bare, 'show', `${BRANCH}:${REL}`), /^- \[x\] Step 1: run it$/m);
});

test('flip: a DONE task whose boxes are already ticked still flips the status', () => {
  const fx = fixture({ text: planOf('ready', [{ id: 'T1', skipIf: 'true', body: ['- [x] Step 1: run it'] }]) });
  const rec = recorder(fx);
  const r = run(fx, rec);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.flipped, ['ready']);
  assert.equal(planStatus(sh(fx.bare, 'show', `${BRANCH}:${REL}`)), 'Complete');
  assert.match(rec.of('gh')[0].input, /ready: READY \(asserted 0, ticked 0\)/);
});

test('flip: a plan that no longer measures READY is skipped with its verdict and no PR is opened', () => {
  const fx = fixture({ text: FAILING });
  const rec = recorder(fx);
  const r = run(fx, rec);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.pr, null);
  assert.deepEqual(r.flipped, []);
  assert.deepEqual(r.skipped, [{ plan: 'ready', reason: 'NOT-READY' }]);
  assert.equal(rec.of('gh').length, 0);
  assert.equal(rec.of('sync').length, 0);
  assert.equal(rec.of('git').some((e) => e.args[0] === 'push'), false);
  assert.deepEqual(remoteCloseouts(fx), []);
  assert.equal(existsSync(fx.wt), false);
});

test('flip: a sync that throws after the PR exists still records pending_pr and drops the worktree and local branch', () => {
  const fx = fixture();
  const rec = recorder(fx, { throwSync: true });
  const r = run(fx, rec);
  assert.match(r.error ?? '', /boom: vault unreachable/);
  assert.equal(r.pr?.number, 42);
  assert.deepEqual(r.flipped, ['ready']);
  assert.equal(readDue(fx).plans.find((p) => p.plan === 'ready').pending_pr.number, 42);
  assert.equal(existsSync(fx.wt), false);
  assert.equal(localCloseouts(fx), '');
  // The PR exists, so its branch stays on origin.
  assert.deepEqual(remoteCloseouts(fx), [BRANCH]);
});

// The CLI with real deps: gh through GH_BIN, plan-sync.mjs through its stub seams.
function cliFixture(fx, { state = 'merged', more = [] } = {}) {
  const bin = path.join(fx.root, 'bin');
  mkdirSync(bin);
  const ghLog = path.join(fx.root, 'gh.log');
  const syncLog = path.join(fx.root, 'sync.log');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${ghLog}'\ncat > /dev/null\necho https://github.com/acme/widgets/pull/7\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const stub = path.join(bin, 'sync-stub.mjs');
  writeFileSync(stub, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(syncLog)}, process.argv.slice(2).join(' ') + ' ' + (process.env.PLAN_PUBLISH_CONFIG ? 'config' : 'none') + '\\n');\n`);
  const registry = path.join(fx.root, 'pr.registry.json');
  writeFileSync(registry, JSON.stringify({ sessions: [{ session: 's-ready', plan: 'ready', state, repo: fx.repo }, ...more.map((s) => ({ plan: 'ready', repo: fx.repo, ...s }))] }));
  const issues = path.join(fx.root, 'plan.issues.json');
  writeFileSync(issues, JSON.stringify({ version: 1, projects: { widgets: 'acme/widgets' } }));
  const env = {
    ...process.env, GH_BIN: path.join(bin, 'gh'), PLAN_SYNC_PUBLISH_CMD: stub, PLAN_SYNC_ISSUE_CMD: stub, PLAN_ISSUES_CONFIG: issues,
  };
  const cli = (args) => {
    const r = Bun.spawnSync(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe', env });
    return { out: r.stdout.toString(), err: r.stderr.toString(), exit: r.exitCode };
  };
  return { cli, registry, ghLog, syncLog };
}

test('cli: --flip groups by repository, prints the PR and exits 0', () => {
  const fx = fixture();
  const c = cliFixture(fx);
  const { out, err, exit } = c.cli(['--flip', 'ready', '--registry', c.registry, '--timeout-s', '30']);
  assert.equal(exit, 0, out + err);
  assert.match(out, new RegExp(`^${fx.repo}: flipped 1, PR https://github.com/acme/widgets/pull/7$`, 'm'));
  assert.match(readFileSync(c.ghLog, 'utf8'), /^pr create --repo acme\/widgets --base main --head closeout\/\d{4}-\d{2}-\d{2}-\d{6} /m);
  // The publish step gets the plan alone; the issue step names the main checkout's project (rule B4).
  const syncLog = readFileSync(c.syncLog, 'utf8');
  assert.match(syncLog, /^\S+ready\.md config$/m);
  assert.match(syncLog, /^--project widgets \S+ready\.md config$/m);
});

test('cli: --flip with an unknown plan exits 2 and runs nothing; no plan is a usage error', () => {
  const fx = fixture();
  const c = cliFixture(fx);
  const r = c.cli(['--flip', 'ready', 'nosuch', '--registry', c.registry]);
  assert.equal(r.exit, 2);
  assert.match(r.err, /nosuch/);
  assert.equal(existsSync(c.ghLog), false);
  assert.equal(c.cli(['--flip', '--registry', c.registry]).exit, 2);
});

test('cli: --flip refuses a plan with no merged registry session, naming it, and flips nothing', () => {
  const fx = fixture();
  const c = cliFixture(fx, { state: 'claimed' });
  const r = c.cli(['--flip', 'ready', '--registry', c.registry, '--timeout-s', '30']);
  assert.equal(r.exit, 2, r.out + r.err);
  assert.match(r.err, /not landed: ready/);
  assert.equal(existsSync(c.ghLog), false);
  assert.deepEqual(remoteCloseouts(fx), []);
  assert.equal(planStatus(readFileSync(fx.file, 'utf8')), 'Verification');
});

test('cli: --flip refuses a plan with a merged and an unfinished session as not landed', () => {
  const fx = fixture();
  const c = cliFixture(fx, { more: [{ session: 's-ready-2', state: 'claimed' }] });
  const r = c.cli(['--flip', 'ready', '--registry', c.registry, '--timeout-s', '30']);
  assert.equal(r.exit, 2, r.out + r.err);
  assert.match(r.err, /not landed: ready/);
  assert.equal(existsSync(c.ghLog), false);
  assert.deepEqual(remoteCloseouts(fx), []);
});
