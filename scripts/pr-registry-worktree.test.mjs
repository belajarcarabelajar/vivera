// scripts/pr-registry-worktree.test.mjs
//
// `claim --worktree` runs the three git commands the claim used to only print,
// against a real bare origin and clone in a temp dir. `open` runs `gh pr create`
// through a fake `gh` on PATH that logs its arguments and prints a PR URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRegistry } from './pr-registry.mjs';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'pr-registry.mjs');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd, ...args) {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...GIT_ENV } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

function cli(env, ...args) {
  const cwd = env.CWD ?? process.cwd();
  const r = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd, env: { ...process.env, ...GIT_ENV, ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function gitFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-registry-wt-'));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const repo = path.join(dir, 'repo');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-q', '-b', 'main', seed);
  writeFileSync(path.join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', origin, 'main');
  git(dir, 'clone', '-q', origin, repo);
  const registry = path.join(dir, 'pr.registry.json');
  const claim = () => cli({}, 'claim', '--plan', 'p', '--session', 'w1', '--repo', repo, '--registry', registry, '--worktree');
  return { dir, repo, registry, claim, worktree: path.join(dir, 'repo-wt', 'w1'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('claim --worktree creates the worktree on the derived branch from origin/<base>', () => {
  const f = gitFixture();
  try {
    const r = f.claim();
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'p/w1');
    assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), git(f.repo, 'rev-parse', 'origin/main'));
    assert.match(r.out, /git worktree prune/);
    assert.match(r.out, /git fetch origin main/);
    assert.match(r.out, /git worktree add .*repo-wt\/w1 -b p\/w1 origin\/main/);
  } finally { f.cleanup(); }
});

test('claim --worktree is idempotent when the worktree already exists on the branch', () => {
  const f = gitFixture();
  try {
    assert.equal(f.claim().code, 0);
    const r = f.claim();
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /already a worktree on p\/w1; skipping/);
    assert.equal(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'p/w1');
  } finally { f.cleanup(); }
});

test('claim --worktree re-adds a deleted worktree on the existing branch after a crash', () => {
  const f = gitFixture();
  try {
    assert.equal(f.claim().code, 0);
    rmSync(f.worktree, { recursive: true, force: true });
    const r = f.claim();
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(git(f.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'p/w1');
  } finally { f.cleanup(); }
});

test('claim --worktree does not take a worktree on a branch that only shares the prefix', () => {
  const f = gitFixture();
  try {
    git(f.repo, 'worktree', 'add', '-q', f.worktree, '-b', 'p/w1-old');
    const r = f.claim();
    assert.ok(!r.out.includes('skipping'), r.out);
    assert.equal(r.code, 1, r.out + r.err);
  } finally { f.cleanup(); }
});

test('claim --worktree exits 1 with git stderr when a git step fails', () => {
  const f = gitFixture();
  try {
    git(f.repo, 'remote', 'set-url', 'origin', path.join(f.dir, 'missing.git'));
    const r = f.claim();
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /missing\.git/);
    assert.ok(!existsSync(f.worktree), 'no worktree after a failed fetch');
  } finally { f.cleanup(); }
});

// ---------- open ----------

function openFixture(state, pr = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-registry-open-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'gh.log');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in\n  *FAIL*) echo "gh: GraphQL: base branch missing" >&2; exit 1 ;;\nesac\necho "https://github.com/acme/widgets/pull/77"\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  const origin = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'seed');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'branch', 'p/w1');
  const body = path.join(dir, 'body.md');
  writeFileSync(body, 'body\n');
  const registry = path.join(dir, 'pr.registry.json');
  writeFileSync(registry, JSON.stringify({
    version: 1,
    sessions: [{ session: 'w1', plan: 'p', branch: 'p/w1', worktree: `${dir}/repo-wt/w1`, repo, base: 'main', state, pr, depends_on: [], claimed_at: new Date().toISOString() }],
  }, null, 2));
  const env = { PATH: `${bin}:${process.env.PATH}` };
  return {
    body,
    remoteHead: () => Bun.spawnSync(['git', '-C', origin, 'rev-parse', '--verify', '-q', 'refs/heads/p/w1']).stdout.toString().trim(),
    localHead: () => git(repo, 'rev-parse', 'p/w1'),
    openFrom: (cwd, file, ...extra) => cli({ ...env, CWD: cwd }, 'open', 'w1', '--registry', registry, '--body-file', file, ...extra),
    open: (...extra) => cli(env, 'open', 'w1', '--registry', registry, '--body-file', body, ...extra),
    session: () => loadRegistry(registry).sessions[0],
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('open creates the PR with gh and records its number like the pr command', () => {
  const f = openFixture('verified');
  try {
    const r = f.open('--title', 'Add thing');
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(f.calls(), [`pr create --base main --head p/w1 --title Add thing --body-file ${f.body}`]);
    assert.equal(f.session().pr, 77);
    assert.equal(f.session().state, 'open');
    assert.match(r.out, /recorded PR #77 for w1/);
  } finally { f.cleanup(); }
});

test('open pushes the session branch to origin before creating the PR', () => {
  const f = openFixture('verified');
  try {
    assert.equal(f.open('--title', 'T').code, 0);
    assert.equal(f.remoteHead(), f.localHead());
  } finally { f.cleanup(); }
});

test('open resolves a relative --body-file against the caller cwd', () => {
  const f = openFixture('verified');
  try {
    const r = f.openFrom(path.dirname(f.body), 'body.md', '--title', 'T');
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(f.calls()[0].endsWith(`--body-file ${f.body}`), f.calls()[0]);
  } finally { f.cleanup(); }
});

test('open exits 2 without calling gh when the body file does not exist', () => {
  const f = openFixture('verified');
  try {
    const r = f.openFrom(path.dirname(f.body), 'nope.md', '--title', 'T');
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /nope\.md/);
    assert.deepEqual(f.calls(), []);
    assert.equal(f.remoteHead(), '');
  } finally { f.cleanup(); }
});

test('open --draft passes --draft to gh', () => {
  const f = openFixture('verified');
  try {
    assert.equal(f.open('--title', 'T', '--draft').code, 0);
    assert.match(f.calls()[0], / --draft$/);
  } finally { f.cleanup(); }
});

test('open refuses a session that is not verified and never calls gh', () => {
  const f = openFixture('active');
  try {
    const r = f.open('--title', 'T');
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /w1.*active.*verified/);
    assert.deepEqual(f.calls(), []);
    assert.equal(f.remoteHead(), '', 'nothing is pushed for a refused session');
    assert.equal(f.session().state, 'active');
  } finally { f.cleanup(); }
});

test('open on a session already open with a PR is a no-op', () => {
  const f = openFixture('open', 42);
  try {
    const r = f.open('--title', 'T');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /already open as PR #42/);
    assert.deepEqual(f.calls(), []);
    assert.equal(f.session().pr, 42);
  } finally { f.cleanup(); }
});

test('open exits 1 with gh stderr and records nothing when gh fails', () => {
  const f = openFixture('verified');
  try {
    const r = f.open('--title', 'FAIL');
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /base branch missing/);
    assert.equal(f.session().state, 'verified');
    assert.equal(f.session().pr, null);
  } finally { f.cleanup(); }
});
