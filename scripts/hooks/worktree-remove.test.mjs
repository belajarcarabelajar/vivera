// scripts/hooks/worktree-remove.test.mjs
//
// Guards for the WorktreeRemove hook that removes a wt-new worktree and its
// branch. The hook is spawned the way Claude Code runs it (one JSON object on
// stdin, verdict in the exit code) against a real git repository under a temp
// root passed through VIVERA_WT_ROOT, because removal is done by git itself.

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.join(import.meta.dir, 'worktree-remove.mjs');
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tempDirs = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag) {
  // realpath so the paths match what git prints for its worktree list.
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `worktree-remove-${tag}-`)));
  tempDirs.push(d);
  return d;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED_ENV },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function setup(tag) {
  const root = tempDir(tag);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  return { root, repo };
}

function addWorktree(repo, root, name, branch) {
  const wt = path.join(root, 'repo-wt', name);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt);
  git(repo, 'worktree', 'lock', wt);
  return wt;
}

function branches(repo) {
  return git(repo, 'branch', '--format=%(refname:short)').trim().split('\n');
}

function runHook(root, stdin) {
  return spawnSync('bun', [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED_ENV, VIVERA_WT_ROOT: root },
  });
}

const payload = (p) => JSON.stringify({ hook_event_name: 'WorktreeRemove', worktree_path: p });

test('removes a locked worktree and deletes its merged branch', () => {
  const { root, repo } = setup('merged');
  const wt = addWorktree(repo, root, 'merged', 'feat/merged');
  const r = runHook(root, payload(wt));
  expect(r.status).toBe(0);
  expect(existsSync(wt)).toBe(false);
  expect(branches(repo)).not.toContain('feat/merged');
});

test('removes a worktree but keeps a branch with unmerged commits', () => {
  const { root, repo } = setup('unmerged');
  const wt = addWorktree(repo, root, 'unmerged', 'feat/unmerged');
  writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', 'b.txt');
  git(wt, 'commit', '-q', '-m', 'extra');
  const r = runHook(root, payload(wt));
  expect(r.status).toBe(0);
  expect(existsSync(wt)).toBe(false);
  expect(branches(repo)).toContain('feat/unmerged');
  expect(r.stderr).toContain('feat/unmerged');
});

test('refuses paths that are not <root>/<repo>-wt/<name> and leaves them in place', () => {
  const { root, repo } = setup('refuse');
  // Real locked worktrees, so only the path check (not a git failure) keeps them.
  const elsewhere = path.join(tempDir('elsewhere'), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/elsewhere', elsewhere);
  git(repo, 'worktree', 'lock', elsewhere);
  const deep = path.join(root, 'repo-wt', 'a', 'b');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/deep', deep);
  git(repo, 'worktree', 'lock', deep);
  mkdirSync(path.join(root, 'x'));
  const cases = [
    [elsewhere, elsewhere],
    [path.join(root, 'repo-wt'), path.join(root, 'repo-wt')],
    [deep, deep],
    [`${root}/repo-wt/../x`, path.join(root, 'x')],
    [root, root],
    [repo, repo],
  ];
  for (const [input, mustExist] of cases) {
    const r = runHook(root, payload(input));
    expect({ input, status: r.status }).toEqual({ input, status: 1 });
    expect(existsSync(mustExist)).toBe(true);
  }
});

test('exits 0 when a valid worktree path does not exist', () => {
  const { root } = setup('missing');
  const r = runHook(root, payload(path.join(root, 'repo-wt', 'gone')));
  expect(r.status).toBe(0);
});

test('exits 1 on input that is not JSON', () => {
  const { root } = setup('badjson');
  const r = runHook(root, 'not json{');
  expect(r.status).toBe(1);
});

test('keeps a worktree with uncommitted or untracked files and exits 1', () => {
  const { root, repo } = setup('dirty');
  const wt = addWorktree(repo, root, 'dirty', 'feat/dirty');
  writeFileSync(path.join(wt, 'untracked.txt'), 'work in progress\n');
  const r = runHook(root, payload(wt));
  expect(r.status).toBe(1);
  expect(existsSync(path.join(wt, 'untracked.txt'))).toBe(true);
  expect(branches(repo)).toContain('feat/dirty');
  expect(r.stderr).toContain('untracked.txt');
});

test('refuses a <root>/<repo>-wt/<name> symlink that points at a worktree outside the root', () => {
  const { root, repo } = setup('symlink');
  const outside = path.join(tempDir('symlink-target'), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/outside', outside);
  git(repo, 'worktree', 'lock', outside);
  mkdirSync(path.join(root, 'repo-wt'));
  const link = path.join(root, 'repo-wt', 'link');
  symlinkSync(outside, link);
  const r = runHook(root, payload(link));
  expect(r.status).toBe(1);
  expect(existsSync(outside)).toBe(true);
});
