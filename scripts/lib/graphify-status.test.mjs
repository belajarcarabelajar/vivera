// scripts/lib/graphify-status.test.mjs
//
// Guards for the classifier that tells every graphify hook and command which
// repository a directory belongs to and whether its graph exists and is fresh.
//
// Every fixture is a real repository built with `git init` in a temp dir,
// because the classifier's answers come from git itself (toplevel, common dir,
// local config, last commit time). A stubbed git would only test the stub.
// Commit times are pinned and graph mtimes are set with utimesSync, so the
// staleness verdicts never depend on how fast the machine runs the suite.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { graphifyStatus, graphPathFor } from './graphify-status.mjs';

const COMMIT_EPOCH_S = 1_700_000_000;
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tempDirs = [];

// The module inherits process.env, so the developer's own git config (for
// example a global graphify.register) must not leak into its git calls.
const savedEnv = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(ISOLATED_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag) {
  // realpath so paths compare equal to what git prints for --show-toplevel.
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `graphify-status-${tag}-`)));
  tempDirs.push(d);
  return d;
}

function git(cwd, ...args) {
  const date = `@${COMMIT_EPOCH_S} +0000`;
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function repo(tag, { commit = true } = {}) {
  const root = tempDir(tag);
  git(root, 'init', '-q', '-b', 'main');
  if (commit) {
    writeFileSync(path.join(root, 'a.txt'), 'a\n');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-q', '-m', 'init');
  }
  return root;
}

function writeGraph(mainRoot, mtimeS) {
  const graph = path.join(mainRoot, 'graphify-out', 'graph.json');
  mkdirSync(path.dirname(graph), { recursive: true });
  writeFileSync(graph, '{"nodes":[],"links":[]}\n');
  utimesSync(graph, mtimeS, mtimeS);
  return graph;
}

test('a directory outside any repository is not-git', () => {
  const d = tempDir('plain');
  expect(graphifyStatus(d)).toEqual({ kind: 'not-git', dir: d });
});

test('a directory that does not exist is not-git instead of throwing', () => {
  const d = path.join(tempDir('missing'), 'nope');
  expect(graphifyStatus(d)).toEqual({ kind: 'not-git', dir: d });
});

test('a git binary that cannot run is not-git instead of throwing', () => {
  const root = repo('badgit');
  expect(graphifyStatus(root, { gitBin: path.join(root, 'no-such-git') })).toEqual({
    kind: 'not-git',
    dir: root,
  });
});

test('a repository without a graph is unregistered with the graph path under its root', () => {
  const root = repo('unreg');
  expect(graphifyStatus(root)).toEqual({
    kind: 'unregistered',
    dir: root,
    root,
    mainRoot: root,
    graphPath: path.join(root, 'graphify-out', 'graph.json'),
  });
});

test('a subfolder of a repository resolves to the repository root', () => {
  const root = repo('sub');
  const sub = path.join(root, 'deep', 'er');
  mkdirSync(sub, { recursive: true });
  const s = graphifyStatus(sub);
  expect(s.kind).toBe('unregistered');
  expect(s.dir).toBe(sub);
  expect(s.root).toBe(root);
  expect(s.mainRoot).toBe(root);
});

test('a graph newer than the last commit is registered and fresh', () => {
  const root = repo('fresh');
  const graph = writeGraph(root, COMMIT_EPOCH_S + 60);
  expect(graphifyStatus(root)).toEqual({
    kind: 'registered',
    dir: root,
    root,
    mainRoot: root,
    graphPath: graph,
    graphMtimeMs: (COMMIT_EPOCH_S + 60) * 1000,
    headCommitMs: COMMIT_EPOCH_S * 1000,
    stale: false,
    worktree: false,
  });
});

test('a graph older than the last commit is registered and stale', () => {
  const root = repo('stale');
  writeGraph(root, COMMIT_EPOCH_S - 60);
  const s = graphifyStatus(root);
  expect(s.kind).toBe('registered');
  expect(s.graphMtimeMs).toBe((COMMIT_EPOCH_S - 60) * 1000);
  expect(s.headCommitMs).toBe(COMMIT_EPOCH_S * 1000);
  expect(s.stale).toBe(true);
});

test('a graph written in the same second as the last commit is not stale', () => {
  const root = repo('tie');
  writeGraph(root, COMMIT_EPOCH_S);
  expect(graphifyStatus(root).stale).toBe(false);
});

test('a repository with no commits and no graph is unregistered', () => {
  const root = repo('empty-unreg', { commit: false });
  expect(graphifyStatus(root).kind).toBe('unregistered');
});

test('a repository with no commits and a graph is registered with a null head and not stale', () => {
  const root = repo('empty-reg', { commit: false });
  writeGraph(root, COMMIT_EPOCH_S);
  const s = graphifyStatus(root);
  expect(s.kind).toBe('registered');
  expect(s.headCommitMs).toBeNull();
  expect(s.stale).toBe(false);
});

test('graphify.register=never opts the repository out even when a graph exists', () => {
  const root = repo('optout');
  writeGraph(root, COMMIT_EPOCH_S + 60);
  git(root, 'config', 'graphify.register', 'never');
  expect(graphifyStatus(root)).toEqual({ kind: 'opted-out', dir: root, root, mainRoot: root });
});

test('another graphify.register value does not opt the repository out', () => {
  const root = repo('optin');
  git(root, 'config', 'graphify.register', 'always');
  expect(graphifyStatus(root).kind).toBe('unregistered');
});

test('a linked worktree uses the graph of its main checkout', () => {
  const main = repo('wt-main');
  const graph = writeGraph(main, COMMIT_EPOCH_S + 60);
  const wt = path.join(tempDir('wt-link'), 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  expect(graphifyStatus(wt)).toEqual({
    kind: 'registered',
    dir: wt,
    root: wt,
    mainRoot: main,
    graphPath: graph,
    graphMtimeMs: (COMMIT_EPOCH_S + 60) * 1000,
    headCommitMs: COMMIT_EPOCH_S * 1000,
    stale: false,
    worktree: true,
  });
});

test('an opt-out set in the main checkout applies to its linked worktree', () => {
  const main = repo('wt-optout');
  git(main, 'config', 'graphify.register', 'never');
  const wt = path.join(tempDir('wt-optout-link'), 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  expect(graphifyStatus(wt)).toEqual({ kind: 'opted-out', dir: wt, root: wt, mainRoot: main });
});

test('graphPathFor puts the graph under graphify-out in the main checkout', () => {
  expect(graphPathFor('/r/main')).toBe(path.join('/r/main', 'graphify-out', 'graph.json'));
});
