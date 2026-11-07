// scripts/hooks/worktree-create.test.mjs
//
// Guards for the WorktreeCreate hook that routes Claude Code worktrees through
// wt-new. The hook is spawned the way Claude Code runs it (JSON on stdin, path
// on stdout) with a temp git repo as cwd and a stub wt-new passed through
// WT_NEW, so no test touches the real /mnt root.

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.join(import.meta.dir, 'worktree-create.mjs');
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tempDirs = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `worktree-create-${tag}-`)));
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

// The repo dir is named "myrepo" so the expected path has a known literal.
function setup(stubBody = () => '') {
  const base = tempDir('case');
  const repo = path.join(base, 'myrepo');
  spawnSync('mkdir', ['-p', repo]);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  const root = path.join(base, 'wtroot');
  const log = path.join(base, 'stub.log');
  const stub = path.join(base, 'wt-new-stub.sh');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nprintf 'PWD=%s\\n' "$PWD" >> "${log}"\n${stubBody(root)}\n`,
  );
  chmodSync(stub, 0o755);
  return { base, repo, root, log, stub, dest: (name) => path.join(root, 'myrepo-wt', name) };
}

function run(ctx, input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync('bun', [HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED_ENV, WT_NEW: ctx.stub, VIVERA_WT_ROOT: ctx.root },
  });
}

const MKDIR = (root) => `echo "stub noise on stdout"; mkdir -p "${root}/myrepo-wt/$2"`;

test('passes worktree-<name> <name> --from HEAD to wt-new in cwd', () => {
  const ctx = setup(MKDIR);
  const r = run(ctx, { name: 'feat-x', cwd: ctx.repo, session_id: 'ignored' });
  expect(r.status).toBe(0);
  const lines = readFileSync(ctx.log, 'utf8').trimEnd().split('\n');
  expect(lines).toEqual(['worktree-feat-x', 'feat-x', '--from', 'HEAD', `PWD=${ctx.repo}`]);
});

test('stdout is exactly one line holding the absolute worktree path, stub noise excluded', () => {
  const ctx = setup(MKDIR);
  const r = run(ctx, { name: 'feat-y', cwd: ctx.repo });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe(`${ctx.dest('feat-y')}\n`);
  expect(r.stderr).toContain('stub noise on stdout');
});

test('repo name comes from the main checkout when cwd is a linked worktree', () => {
  const ctx = setup(MKDIR);
  const linked = path.join(ctx.base, 'other-name');
  git(ctx.repo, 'worktree', 'add', '-q', '--detach', linked);
  const r = run(ctx, { name: 'feat-z', cwd: linked });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe(`${ctx.dest('feat-z')}\n`);
});

test('wt-new failing exits 1 with empty stdout and its output on stderr', () => {
  const ctx = setup(() => 'echo "boom from wt-new" >&2; exit 4');
  const r = run(ctx, { name: 'feat-f', cwd: ctx.repo });
  expect(r.status).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('boom from wt-new');
});

test('wt-new exiting 0 without creating the directory exits 1 with empty stdout', () => {
  const ctx = setup(() => 'exit 0');
  const r = run(ctx, { name: 'feat-m', cwd: ctx.repo });
  expect(r.status).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr.length).toBeGreaterThan(0);
});

for (const [label, input] of [
  ['traversal name', { name: '../x', cwd: null }],
  ['empty name', { name: '', cwd: null }],
  ['missing name', { cwd: null }],
  ['dot name', { name: '..', cwd: null }],
  ['non-JSON stdin', 'not json'],
]) {
  test(`${label} exits 1 without calling wt-new`, () => {
    const ctx = setup(MKDIR);
    const body = typeof input === 'string' ? input : { ...input, cwd: ctx.repo };
    const r = run(ctx, body);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(existsSync(ctx.log)).toBe(false);
  });
}
