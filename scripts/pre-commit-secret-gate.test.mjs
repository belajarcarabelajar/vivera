// Tests for the secret gate wired into .githooks/pre-commit. Each test builds a
// throwaway repository with the real hook and the real checkers copied in, then
// drives it through `git commit`, so the assertions see what a committer sees.
// This file is scanned by the same gate, so the token is assembled at run time and
// no complete credential literal appears here.
import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const HOOK = path.join(ROOT, '.githooks', 'pre-commit');
// Both checkers plus their relative import closure, walked from the source so a new
// local import reaches the temp repo without editing a list.
function importClosure(entries) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Anchored to a statement start: a usage comment such as "import { x } from './lib/y.mjs'"
    // must not count as an import.
    for (const [, spec] of source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+['"](\.{1,2}\/[^'"]+\.mjs)['"]/gm)) {
      visit(path.posix.join(path.posix.dirname(rel), spec));
    }
  };
  entries.forEach(visit);
  return [...seen];
}
const CHECKER_FILES = importClosure(['scripts/check-secrets.mjs', 'scripts/check-file-size.mjs']);
const OVERSIZED = 'x'.repeat(20001);
const TOKEN = '1234567' + '890' + ':' + 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cFaB3dE5'.slice(0, 35);

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

/** A temp repo with the hook and both real checkers installed. */
function secretGateRepo({ checker = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-gate-hook-'));
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

test('a staged bot token blocks the commit and the report names file, line and rule', () => {
  const repo = secretGateRepo();
  repo.write('notes.txt', `first line\nsecond ${TOKEN} line\n`);
  repo.git(['add', 'notes.txt']);
  const r = repo.commit('token');
  assert.equal(r.status, 1, outputOf(r));
  assert.ok(outputOf(r).includes('[secret-gate] notes.txt:2 telegram-bot-token'), outputOf(r));
  assert.equal(repo.head(), '', 'no commit should exist after a blocked commit');
});

test('the planted token never reaches the hook output', () => {
  const repo = secretGateRepo();
  repo.write('notes.txt', `${TOKEN}\n`);
  repo.git(['add', 'notes.txt']);
  const r = repo.commit('token');
  assert.equal(r.status, 1, outputOf(r));
  assert.ok(!outputOf(r).includes(TOKEN), 'the output must not echo the credential');
  assert.ok(!outputOf(r).includes(TOKEN.split(':')[1]), 'nor its secret half');
});

test('a clean stage commits and the hook prints no summary line', () => {
  const repo = secretGateRepo();
  repo.write('small.txt', 'hello\n');
  repo.git(['add', 'small.txt']);
  const r = repo.commit('clean');
  assert.equal(r.status, 0, outputOf(r));
  assert.ok(!r.stdout.includes('checked'), outputOf(r));
  assert.ok(!r.stderr.includes('checked'), outputOf(r));
  assert.ok(!outputOf(r).includes('secret-gate'), outputOf(r));
  assert.notEqual(repo.head(), '');
});

test('a checker exit 2 is skipped with a note and the commit follows the size gate', () => {
  const repo = secretGateRepo();
  repo.write('scripts/check-secrets.mjs', 'process.exit(2);\n');
  repo.write('small.txt', 'small\n');
  repo.git(['add', 'small.txt']);
  const r = repo.commit('exit 2');
  assert.equal(r.status, 0, outputOf(r));
  assert.ok(outputOf(r).includes('[secret-gate] skipped: checker exited 2'), outputOf(r));
  assert.notEqual(repo.head(), '');

  repo.write('big.txt', OVERSIZED);
  repo.git(['add', 'big.txt']);
  const blocked = repo.commit('exit 2 then oversized');
  assert.equal(blocked.status, 1, outputOf(blocked));
  assert.ok(outputOf(blocked).includes('[secret-gate] skipped: checker exited 2'), outputOf(blocked));
  assert.ok(outputOf(blocked).includes('How to split'), outputOf(blocked));
});

test('a checker exit 1 without a report line blocks as failed before judging', () => {
  const repo = secretGateRepo();
  repo.write('scripts/check-secrets.mjs', "throw new Error('boom');\n");
  repo.write('small.txt', 'small\n');
  repo.git(['add', 'small.txt']);
  const r = repo.commit('crash at import');
  assert.equal(r.status, 1, outputOf(r));
  assert.ok(
    outputOf(r).includes('[secret-gate] blocked: the checker failed before judging (exit 1)'),
    outputOf(r),
  );
  assert.ok(outputOf(r).includes('boom'), outputOf(r));
  assert.equal(repo.head(), '');
});

test('a checker report with exit 1 blocks without the failed-before-judging note', () => {
  const repo = secretGateRepo();
  repo.write('scripts/check-secrets.mjs', "console.error('[secret-gate] x:1 fake-rule');\nprocess.exit(1);\n");
  repo.write('small.txt', 'small\n');
  repo.git(['add', 'small.txt']);
  const r = repo.commit('reported');
  assert.equal(r.status, 1, outputOf(r));
  assert.ok(outputOf(r).includes('[secret-gate] x:1 fake-rule'), outputOf(r));
  assert.ok(!outputOf(r).includes('failed before judging'), outputOf(r));
});

test('a checker crash with exit 3 blocks the commit', () => {
  const repo = secretGateRepo();
  repo.write('scripts/check-secrets.mjs', 'process.exit(3);\n');
  repo.write('small.txt', 'small\n');
  repo.git(['add', 'small.txt']);
  const r = repo.commit('crash exit 3');
  assert.equal(r.status, 1, outputOf(r));
  assert.ok(outputOf(r).includes('[secret-gate] blocked: the checker crashed (exit 3)'), outputOf(r));
  assert.equal(repo.head(), '');
});

test('a repo without the secret checker commits and prints the skip note', () => {
  const repo = secretGateRepo({ checker: false });
  repo.write('small.txt', 'small\n');
  repo.git(['add', 'small.txt']);
  const r = repo.commit('no checker');
  assert.equal(r.status, 0, outputOf(r));
  assert.ok(outputOf(r).includes('[secret-gate] skipped:'), outputOf(r));
});

test('a secret finding wins over the size gate and the size gate never runs', () => {
  const repo = secretGateRepo();
  repo.write('notes.txt', `${TOKEN}\n`);
  repo.write('big.txt', OVERSIZED);
  repo.git(['add', 'notes.txt', 'big.txt']);
  const r = repo.commit('both');
  assert.equal(r.status, 1, outputOf(r));
  assert.ok(outputOf(r).includes('[secret-gate] notes.txt:1 telegram-bot-token'), outputOf(r));
  assert.ok(!outputOf(r).includes('[size-gate]'), outputOf(r));
  assert.ok(!outputOf(r).includes('How to split'), outputOf(r));
  assert.equal(repo.head(), '');
});

test('GRAPHIFY_SYNC_SKIP=1 still blocks a staged token', () => {
  const repo = secretGateRepo();
  repo.write('notes.txt', `${TOKEN}\n`);
  repo.git(['add', 'notes.txt']);
  const r = repo.commit('token', { GRAPHIFY_SYNC_SKIP: '1' });
  assert.equal(r.status, 1, outputOf(r));
  assert.equal(repo.head(), '');
});
