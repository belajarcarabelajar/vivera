// The size-raise rule end to end: .githooks/commit-msg run directly against a
// temp repo's staged index, and the checker's --commit-msg and --all --base
// modes where a split check-file-size.test.mjs has no room for them.
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, '.githooks', 'commit-msg');
const CHECKER = path.join(ROOT, 'scripts', 'check-file-size.mjs');
const BASELINE = 'scripts/file-size-baseline.json';
const ID = '2026-10-19-x';
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
};

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-raise-'));
  dirs.push(dir);
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function put(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'number' ? 'x'.repeat(body) : body);
  }
}

// Stages the baseline and, for --all, files of exactly the ceiling so no ceiling is stale.
function ceilings(dir, obj) {
  put(dir, { [BASELINE]: JSON.stringify(obj), ...obj });
  git(dir, 'add', '-A');
}

const out = (r) => `${r.stdout}${r.stderr}`;

// A repo whose HEAD holds a.txt at 25000 and whose index raises it to 26000.
function raisedRepo({ checker = null } = {}) {
  const dir = tmpDir();
  git(dir, 'init', '-q');
  put(dir, { [BASELINE]: JSON.stringify({ 'a.txt': 25000 }) });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'seed');
  if (checker) put(dir, { 'scripts/check-file-size.mjs': checker });
  return dir;
}

function hook(dir, msg, env = {}) {
  put(dir, { '.git/COMMIT_EDITMSG': msg });
  return spawnSync('bash', [HOOK, '.git/COMMIT_EDITMSG'], { cwd: dir, env: { ...ENV, ...env }, encoding: 'utf8' });
}

// The hook runs scripts/check-file-size.mjs from the repo it is in, so copy the real one in.
function withRealChecker(dir) {
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), {
    recursive: true,
    filter: (src) => !src.endsWith('.test.mjs') && !src.endsWith('file-size-baseline.json'),
  });
  return dir;
}

describe('.githooks/commit-msg', () => {
  test('exits 0 silently when the baseline is not staged as changed', () => {
    const r = hook(withRealChecker(raisedRepo()), 'no raise');
    expect([r.status, out(r)]).toEqual([0, '']);
  });

  test('blocks a raised ceiling whose message has no size-raise line', () => {
    const dir = withRealChecker(raisedRepo());
    put(dir, { [BASELINE]: JSON.stringify({ 'a.txt': 26000 }) });
    git(dir, 'add', BASELINE);
    const r = hook(dir, 'grow');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a.txt: ceiling 25000 -> 26000 bytes');
  });

  test('passes a raised ceiling whose message names a plan', () => {
    const dir = withRealChecker(raisedRepo());
    put(dir, { [BASELINE]: JSON.stringify({ 'a.txt': 26000 }), [`docs/code-plan/plans/${ID}.md`]: '#' });
    git(dir, 'add', BASELINE);
    const r = hook(dir, `grow\n\nsize-raise: ${ID} later\n`);
    expect([r.status, r.stderr]).toEqual([0, '']);
  });

  test('skips with a note when the checker exits 2', () => {
    const dir = raisedRepo({ checker: 'process.exit(2);\n' });
    put(dir, { [BASELINE]: '{}' });
    git(dir, 'add', BASELINE);
    const r = hook(dir, 'grow');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[size-gate] skipped: checker exited 2');
  });

  test('blocks when the checker crashes with exit 3', () => {
    const dir = raisedRepo({ checker: 'process.exit(3);\n' });
    put(dir, { [BASELINE]: '{}' });
    git(dir, 'add', BASELINE);
    const r = hook(dir, 'grow');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[size-gate] blocked: the checker crashed (exit 3)');
  });

  test('skips with a note when bun is neither on PATH nor in ~/.bun', () => {
    const dir = withRealChecker(raisedRepo());
    put(dir, { [BASELINE]: JSON.stringify({ 'a.txt': 26000 }) });
    git(dir, 'add', BASELINE);
    const bin = tmpDir();
    for (const tool of ['git', 'bash', 'sh', 'dirname', 'basename']) fs.symlinkSync(Bun.which(tool), path.join(bin, tool));
    const r = hook(dir, 'grow', { PATH: bin, HOME: tmpDir() });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[size-gate] skipped: bun not found');
  });
});

const run = (cwd, ...args) => spawnSync(process.execPath, [CHECKER, ...args], { cwd, env: ENV, encoding: 'utf8' });

describe('raised ceiling in a linked worktree', () => {
  // The plans directory is gitignored, so it lives only in the main checkout.
  function worktree(msg) {
    const main = raisedRepo();
    put(main, { [`docs/code-plan/plans/${ID}.md`]: '#' });
    const wt = path.join(tmpDir(), 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    put(wt, { [BASELINE]: JSON.stringify({ 'a.txt': 26000 }), MSG: msg });
    git(wt, 'add', BASELINE);
    return run(wt, '--commit-msg', 'MSG');
  }

  test('raised ceiling naming a plan that only the main checkout has passes', () => {
    const r = worktree(`size-raise: ${ID} later`);
    expect([r.status, r.stderr, r.stdout]).toEqual([0, '', '']);
  });

  test('raised ceiling naming a plan missing from the main checkout fails', () => {
    const r = worktree('size-raise: 2026-10-19-missing later');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/code-plan/plans/2026-10-19-missing.md');
  });
});

describe('raised ceiling judged per commit with --all --base', () => {
  function branch(...steps) {
    const dir = tmpDir();
    git(dir, 'init', '-q');
    ceilings(dir, { 'a.txt': 25000, 'b.txt': 25000 });
    git(dir, 'commit', '-qm', 'seed');
    git(dir, 'branch', 'base');
    for (const [obj, msg] of steps) {
      ceilings(dir, obj);
      git(dir, 'commit', '-qm', msg);
    }
    return { dir, r: run(dir, '--all', '--base', 'base') };
  }

  test('raised ceiling in a later commit without its own line fails, naming the file and the commit', () => {
    const { dir, r } = branch(
      [{ 'a.txt': 26000, 'b.txt': 25000 }, `raise a\n\nsize-raise: ${ID} later`],
      [{ 'a.txt': 26000, 'b.txt': 26000 }, 'raise b'],
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('b.txt: ceiling 25000 -> 26000 bytes');
    expect(r.stderr).toContain(`${git(dir, 'rev-parse', '--short', 'HEAD')} raise b`);
    expect(r.stderr).not.toContain('a.txt: ceiling');
  });

  test('raised ceiling that a later commit lowers back needs no line', () => {
    const { r } = branch(
      [{ 'a.txt': 26000, 'b.txt': 25000 }, 'raise a'],
      [{ 'a.txt': 25000, 'b.txt': 25000 }, 'lower a'],
    );
    expect([r.status, r.stderr]).toEqual([0, '']);
  });

  test('raised ceiling in every commit with its own line passes', () => {
    const { r } = branch(
      [{ 'a.txt': 26000, 'b.txt': 25000 }, `raise a\n\nsize-raise: ${ID} later`],
      [{ 'a.txt': 26000, 'b.txt': 26000 }, `raise b\n\nsize-raise: ${ID} later`],
    );
    expect(r.status).toBe(0);
  });
});
