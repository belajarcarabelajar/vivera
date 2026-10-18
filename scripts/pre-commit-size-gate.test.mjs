// Tests for the size gate wired into .githooks/pre-commit. Each test builds a
// throwaway repository with the real hook and the real checker copied in, then
// drives it through `git commit`, so the assertions see what a committer sees.
import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, '.githooks', 'pre-commit');
// The checker plus every local module it imports; the temp repo needs all of them.
const CHECKER_FILES = ['scripts/check-file-size.mjs', 'scripts/lib/atomic-write.mjs'];
const OVERSIZED = 'x'.repeat(20001);

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function baseEnv(extra = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: os.tmpdir(),
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  };
  delete env.GRAPHIFY_SYNC_SKIP;
  return { ...env, ...extra };
}

/** A temp repo with the hook installed and, unless told otherwise, the checker. */
function sizeGateRepo({ checker = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'size-gate-hook-'));
  tmpDirs.push(tmp);
  const git = (args, extraEnv) =>
    spawnSync('git', args, { cwd: tmp, encoding: 'utf8', env: baseEnv(extraEnv) });
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), content);
  };
  const commit = (msg, extraEnv, ...more) =>
    git(['-c', 'commit.gpgsign=false', 'commit', ...more, '-m', msg], extraEnv);
  const head = () => git(['rev-parse', '--verify', '-q', 'HEAD']).stdout.trim();

  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  git(['config', 'core.hooksPath', '.githooks']);
  write('.githooks/pre-commit', fs.readFileSync(HOOK, 'utf8'));
  fs.chmodSync(path.join(tmp, '.githooks', 'pre-commit'), 0o755);
  if (checker) for (const rel of CHECKER_FILES) write(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  return { tmp, git, write, commit, head };
}

const outputOf = (r) => `${r.stdout}${r.stderr}`;

test('an oversized new staged file blocks the commit with the split advice', () => {
  const repo = sizeGateRepo();
  repo.write('big.txt', OVERSIZED);
  repo.git(['add', 'big.txt']);
  const r = repo.commit('big');
  assert.notEqual(r.status, 0, outputOf(r));
  assert.ok(outputOf(r).includes('How to split'), outputOf(r));
  assert.equal(repo.head(), '', 'no commit should exist after a blocked commit');
});

test('an oversized file marked -size-gate in .gitattributes commits', () => {
  const repo = sizeGateRepo();
  repo.write('big.txt', OVERSIZED);
  repo.write('.gitattributes', 'big.txt -size-gate\n');
  repo.git(['add', 'big.txt', '.gitattributes']);
  const r = repo.commit('exempt');
  assert.equal(r.status, 0, outputOf(r));
  assert.notEqual(repo.head(), '');
});

test('a file with a baseline ceiling that grows past it blocks the commit', () => {
  const repo = sizeGateRepo();
  repo.write('scripts/file-size-baseline.json', '{\n  "seeded.txt": 25000\n}\n');
  repo.write('seeded.txt', 'y'.repeat(25000));
  repo.git(['add', '-A']);
  const first = repo.commit('seed');
  assert.equal(first.status, 0, outputOf(first));
  const before = repo.head();
  repo.write('seeded.txt', 'y'.repeat(25001));
  repo.git(['add', 'seeded.txt']);
  const r = repo.commit('grow');
  assert.notEqual(r.status, 0, outputOf(r));
  assert.ok(outputOf(r).includes('How to split'), outputOf(r));
  assert.equal(repo.head(), before, 'a blocked commit must not move HEAD');
});

test('a file with a baseline ceiling that shrinks commits', () => {
  const repo = sizeGateRepo();
  repo.write('scripts/file-size-baseline.json', '{\n  "seeded.txt": 25000\n}\n');
  repo.write('seeded.txt', 'y'.repeat(25000));
  repo.git(['add', '-A']);
  const first = repo.commit('seed');
  assert.equal(first.status, 0, outputOf(first));
  const before = repo.head();
  repo.write('seeded.txt', 'y'.repeat(24000));
  repo.git(['add', 'seeded.txt']);
  const r = repo.commit('shrink');
  assert.equal(r.status, 0, outputOf(r));
  assert.notEqual(repo.head(), before);
});

test('GRAPHIFY_SYNC_SKIP=1 still blocks an oversized file', () => {
  const repo = sizeGateRepo();
  repo.write('big.txt', OVERSIZED);
  repo.git(['add', 'big.txt']);
  const r = repo.commit('big', { GRAPHIFY_SYNC_SKIP: '1' });
  assert.notEqual(r.status, 0, outputOf(r));
  assert.ok(outputOf(r).includes('How to split'), outputOf(r));
  assert.equal(repo.head(), '');
});

test('a repo without the checker commits and prints the skip note', () => {
  const repo = sizeGateRepo({ checker: false });
  repo.write('big.txt', OVERSIZED);
  repo.git(['add', 'big.txt']);
  const r = repo.commit('no checker');
  assert.equal(r.status, 0, outputOf(r));
  assert.ok(outputOf(r).includes('[size-gate] skipped: scripts/check-file-size.mjs not found'), outputOf(r));
});

test('an empty commit prints nothing from the hook', () => {
  const repo = sizeGateRepo();
  const r = repo.commit('empty', undefined, '-q', '--allow-empty');
  assert.equal(r.status, 0, outputOf(r));
  assert.ok(!outputOf(r).includes('size-gate'), outputOf(r));
  assert.ok(!outputOf(r).includes('graphify'), outputOf(r));
});

test('a small file commits', () => {
  const repo = sizeGateRepo();
  repo.write('small.txt', 'hello\n');
  repo.git(['add', 'small.txt']);
  const r = repo.commit('small');
  assert.equal(r.status, 0, outputOf(r));
  assert.notEqual(repo.head(), '');
});

test('a ceiling raise that is not staged does not let a grown file through', () => {
  const repo = sizeGateRepo();
  repo.write('scripts/file-size-baseline.json', '{\n  "seeded.txt": 25000\n}\n');
  repo.write('seeded.txt', 'y'.repeat(25000));
  repo.git(['add', '-A']);
  const first = repo.commit('seed');
  assert.equal(first.status, 0, outputOf(first));
  const before = repo.head();
  repo.write('seeded.txt', 'y'.repeat(26000));
  repo.write('scripts/file-size-baseline.json', '{\n  "seeded.txt": 30000\n}\n');
  repo.git(['add', 'seeded.txt']);
  const r = repo.commit('grow without staging the raise');
  assert.notEqual(r.status, 0, outputOf(r));
  assert.equal(repo.head(), before, 'a blocked commit must not move HEAD');
});
