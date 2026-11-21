// scripts/plan-closeout-merged.test.mjs
//
// Readiness after every session of a plan landed, while the checkout holding the
// plan (its closing commit) is ahead of origin/main: a task OPEN there is read
// again at origin/main of the same repository. Split from plan-closeout.test.mjs,
// which is at its size ceiling. Temp git repositories with a bare origin, no network.

import './lib/local-runner-env.mjs';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
// Isolated from the user's git config, and no repository above the temp root is found.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: tmpdir(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const cli = (args) => Bun.spawnSync(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe', env });
const gitRun = (cwd, args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
function git(cwd, ...args) {
  const r = gitRun(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const planText = (skipIf) => [
  '---', 'schema: ultra-plan/v1', 'plan_id: demo-plan', 'tasks:',
  '  - id: T1', '    depends_on: []', `    skip_if: ${JSON.stringify(skipIf)}`, '---', '',
].join('\n');

const ANCESTOR = 'git merge-base --is-ancestor HEAD origin/main';
const SIDE_FILE = 'test -f only-on-branch.txt';
const session = (name, worktree, state) => ({ session: name, plan: 'demo-plan', branch: 'side', worktree, state, claimed_at: '2026-11-21T00:00:00.000Z' });

// origin/main holds the merged work; branch side (pushed, never merged) holds only-on-branch.txt;
// the penutup worktree is one commit ahead of origin/main and holds the plan.
function fixture(skipIf, sessionsOf) {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-merged-'));
  dirs.push(root);
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'main');
  const side = path.join(root, 'side');
  const penutup = path.join(root, 'penutup');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', main);
  writeFileSync(path.join(main, 'work.txt'), 'merged work\n');
  writeFileSync(path.join(main, 'present.test.mjs'), "import { test } from 'bun:test';\ntest('ok', () => {});\n");
  git(main, 'add', 'work.txt', 'present.test.mjs');
  git(main, 'commit', '-qm', 'merged work');
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'worktree', 'add', '-q', '-b', 'side', side, 'main');
  writeFileSync(path.join(side, 'only-on-branch.txt'), '');
  git(side, 'add', 'only-on-branch.txt');
  git(side, 'commit', '-qm', 'side work');
  git(main, 'push', '-q', 'origin', 'main', 'side');
  git(main, 'worktree', 'add', '-q', '-b', 'penutup', penutup, 'main');
  mkdirSync(path.join(penutup, 'docs', 'code-plan', 'plans'), { recursive: true });
  const plan = path.join(penutup, 'docs', 'code-plan', 'plans', 'demo-plan.md');
  writeFileSync(plan, planText(skipIf));
  git(penutup, 'add', 'docs');
  git(penutup, 'commit', '-qm', 'penutup');
  const registry = path.join(root, 'pr.registry.json');
  writeFileSync(registry, JSON.stringify({ sessions: sessionsOf({ root, penutup }) }));
  // A broken setup must not pass for a RED: origin/main resolves and penutup is ahead of it.
  assert.equal(gitRun(penutup, ['rev-parse', '--verify', '--quiet', 'origin/main']).status, 0);
  assert.equal(gitRun(penutup, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).status, 1);
  return { root, main, penutup, plan, registry };
}

const merged = ({ root }) => [session('s-work', path.join(root, 'gone'), 'merged'), session('s-dropped', path.join(root, 'gone2'), 'closed')];
const mainLine = (out) => out.split('\n').filter((l) => l.startsWith('readiness origin/main:'));
const mainDir = (line) => line.replace(/^readiness origin\/main: /, '').replace(/ \(.*$/, '');

function assertRemoved(f, out) {
  for (const line of mainLine(out)) {
    const dir = mainDir(line);
    assert.equal(existsSync(dir), false, `${dir} still exists`);
    assert.ok(!git(f.main, 'worktree', 'list', '--porcelain').includes(dir), `${dir} still listed`);
  }
}

describe('readiness after every session of the plan landed', () => {
  test('a task OPEN in the checkout ahead of origin/main is read again at origin/main, named and removed, and counts as DONE', () => {
    const f = fixture(ANCESTOR, merged);
    const r = cli(['--readiness', f.plan, '--registry', f.registry, '--timeout-s', '30']);
    const out = r.stdout.toString();
    assert.equal(mainLine(out).length, 1, out);
    assert.match(out, /^T1\tDONE\tgit merge-base --is-ancestor HEAD origin\/main$/m);
    assert.match(out, /^readiness: READY$/m);
    assertRemoved(f, out);
    assert.equal(r.exitCode, 0, out + r.stderr.toString());
  });

  test('another worktree whose folder is gone keeps its metadata: the re-read prunes nothing repo-wide', () => {
    const f = fixture(ANCESTOR, merged);
    const stray = path.join(f.root, 'stray');
    git(f.main, 'worktree', 'add', '-q', '--detach', stray, 'main');
    rmSync(stray, { recursive: true, force: true });
    const r = cli(['--readiness', f.plan, '--registry', f.registry, '--timeout-s', '30']);
    const out = r.stdout.toString();
    assert.equal(mainLine(out).length, 1, out);
    assert.ok(git(f.main, 'worktree', 'list', '--porcelain').includes(stray), 'the stray worktree metadata was pruned');
    assertRemoved(f, out);
  });

  test('work only on an unmerged branch stays OPEN at origin/main', () => {
    const f = fixture(SIDE_FILE, merged);
    const r = cli(['--readiness', f.plan, '--registry', f.registry, '--timeout-s', '30']);
    const out = r.stdout.toString();
    assert.match(out, /^T1\tOPEN\ttest -f only-on-branch\.txt$/m);
    assertRemoved(f, out);
    assert.equal(r.exitCode, 1);
  });

  test('a test file missing at origin/main too keeps the task OPEN, since bun test would exit 0', () => {
    const f = fixture('bun test ./present.test.mjs ./absent.test.mjs', merged);
    const r = cli(['--readiness', f.plan, '--registry', f.registry, '--timeout-s', '60']);
    const out = r.stdout.toString();
    assert.match(out, /^T1\tOPEN\tbun test \.\/present\.test\.mjs \.\/absent\.test\.mjs\tmissing: \.\/absent\.test\.mjs$/m);
    assertRemoved(f, out);
    assert.equal(r.exitCode, 1);
  });

  test('a plan whose own sessions were only closed is not read again, even when another plan merged', () => {
    const f = fixture(ANCESTOR, ({ root }) => [
      session('s-dropped', path.join(root, 'gone'), 'closed'),
      { ...session('s-other', path.join(root, 'gone2'), 'merged'), plan: 'other-plan' },
    ]);
    const r = cli(['--readiness', f.plan, '--registry', f.registry, '--timeout-s', '30']);
    const out = r.stdout.toString();
    assert.deepEqual(mainLine(out), []);
    assert.match(out, /^T1\tOPEN\t/m);
    assert.equal(r.exitCode, 1);
  });

  test('an unfinished session still sets the cwd and nothing is read at origin/main', () => {
    const f = fixture(ANCESTOR, ({ root, penutup }) => [session('s-open', penutup, 'open'), ...merged({ root })]);
    const r = cli(['--readiness', f.plan, '--registry', f.registry, '--timeout-s', '30']);
    const out = r.stdout.toString();
    assert.ok(out.includes(`readiness cwd: ${f.penutup} (worktree of unfinished session s-open`), out);
    assert.deepEqual(mainLine(out), []);
    assert.match(out, /^T1\tOPEN\t/m);
    assert.equal(r.exitCode, 1);
  });

  test('a checkout at origin/main is not ahead, so nothing is read again', () => {
    // Passes only where the plan folder is absent, so a read at origin/main would flip it to DONE.
    const f = fixture('test ! -e docs', merged);
    mkdirSync(path.join(f.main, 'docs', 'code-plan', 'plans'), { recursive: true });
    const plan = path.join(f.main, 'docs', 'code-plan', 'plans', 'demo-plan.md');
    writeFileSync(plan, planText('test ! -e docs'));
    const r = cli(['--readiness', plan, '--registry', f.registry, '--timeout-s', '30']);
    const out = r.stdout.toString();
    assert.deepEqual(mainLine(out), []);
    assert.match(out, /^T1\tOPEN\t/m);
    assert.equal(r.exitCode, 1);
  });

  test('--cwd keeps the given checkout even when every session landed', () => {
    const f = fixture(ANCESTOR, merged);
    const r = cli(['--readiness', f.plan, '--registry', f.registry, '--cwd', f.penutup, '--timeout-s', '30']);
    const out = r.stdout.toString();
    assert.deepEqual(mainLine(out), []);
    assert.match(out, /^T1\tOPEN\t/m);
    assert.equal(r.exitCode, 1);
  });
});
