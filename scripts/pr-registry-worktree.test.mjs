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
  const r = Bun.spawnSync(['bun', SCRIPT, ...args], { env: { ...process.env, ...GIT_ENV, ...env } });
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
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  const body = path.join(dir, 'body.md');
  writeFileSync(body, 'body\n');
  const registry = path.join(dir, 'pr.registry.json');
  writeFileSync(registry, JSON.stringify({
    version: 1,
    sessions: [{ session: 'w1', plan: 'p', branch: 'p/w1', worktree: `${dir}/repo-wt/w1`, repo, base: 'main', state, pr, depends_on: [], claimed_at: new Date().toISOString() }],
  }, null, 2));
  return {
    body,
    open: (...extra) => cli({ PATH: `${bin}:${process.env.PATH}` }, 'open', 'w1', '--registry', registry, '--body-file', body, ...extra),
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
