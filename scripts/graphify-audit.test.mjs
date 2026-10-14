// scripts/graphify-audit.test.mjs
//
// Guards for the audit command that lists which repositories under a set of
// roots have a graphify graph, which are stale, and which are unregistered.
//
// Fixtures are real repositories built with `git init` in temp dirs, because
// the audit classifies each one through graphifyStatus, which asks git itself.
// Commit times are pinned and graph mtimes are set with utimesSync, so the
// stale column never depends on how fast the machine runs the suite.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { audit } from './graphify-audit.mjs';

const SCRIPT = path.join(import.meta.dir, 'graphify-audit.mjs');
const COMMIT_EPOCH_S = 1_700_000_000;
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tempDirs = [];

// audit() runs git with process.env, so the developer's own git config (for
// example a global graphify.register) must not leak into its git calls.
const savedEnv = {};
let tree;
beforeAll(() => {
  for (const [k, v] of Object.entries(ISOLATED_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  tree = buildTree();
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag) {
  // realpath so paths compare equal to what git prints for its toplevel.
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `graphify-audit-${tag}-`)));
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

function repo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function writeGraph(dir, body, mtimeS = COMMIT_EPOCH_S + 60) {
  const graph = path.join(dir, 'graphify-out', 'graph.json');
  mkdirSync(path.dirname(graph), { recursive: true });
  writeFileSync(graph, body);
  utimesSync(graph, mtimeS, mtimeS);
  return graph;
}

function graphBody(nodes, edges, edgeKey = 'links') {
  return JSON.stringify({
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })),
    [edgeKey]: Array.from({ length: edges }, (_, i) => ({ source: 'n0', target: `n${i}` })),
  });
}

function buildTree() {
  const root = tempDir('tree');
  const registered = repo(path.join(root, 'registered'));
  writeGraph(registered, graphBody(3, 2));
  // A repository inside a found repository is never visited.
  repo(path.join(registered, 'vendor', 'inner'));
  repo(path.join(root, 'group', 'unregistered'));
  const opted = repo(path.join(root, 'opted'));
  git(opted, 'config', 'graphify.register', 'never');
  mkdirSync(path.join(root, 'wt'));
  git(registered, 'worktree', 'add', '-q', '-b', 'feat', path.join(root, 'wt', 'feature'));
  repo(path.join(root, 'node_modules', 'pkg'));
  repo(path.join(root, '.cache', 'tool'));
  // Depth 5 from the root: one level past the default limit of 4.
  repo(path.join(root, 'a', 'b', 'c', 'd', 'deep'));
  return {
    root,
    registered,
    unregistered: path.join(root, 'group', 'unregistered'),
    opted,
    worktree: path.join(root, 'wt', 'feature'),
    deep: path.join(root, 'a', 'b', 'c', 'd', 'deep'),
  };
}

function runCli(...args) {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, ...ISOLATED_ENV },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test('audit classifies registered, unregistered, and opted-out repositories', () => {
  const { repos } = audit([tree.root]);
  expect(repos).toEqual([
    { path: tree.unregistered, kind: 'unregistered', nodes: null, edges: null, stale: null },
    { path: tree.opted, kind: 'opted-out', nodes: null, edges: null, stale: null },
    { path: tree.registered, kind: 'registered', nodes: 3, edges: 2, stale: false },
  ]);
});

test('a linked worktree is listed under worktrees with its main checkout', () => {
  const { repos, worktrees } = audit([tree.root]);
  expect(worktrees).toEqual([{ path: tree.worktree, mainRoot: tree.registered }]);
  expect(repos.map((r) => r.path)).not.toContain(tree.worktree);
});

test('node_modules, .cache, and repositories nested in a repository are skipped', () => {
  // Relative to the fixture root, because TMPDIR itself may sit under ~/.cache.
  const rel = audit([tree.root]).repos.map((r) => path.relative(tree.root, r.path));
  expect(rel).not.toContain(path.join('node_modules', 'pkg'));
  expect(rel).not.toContain(path.join('.cache', 'tool'));
  expect(rel).not.toContain(path.join('registered', 'vendor', 'inner'));
});

test('a repository deeper than maxDepth is skipped and found once the limit allows it', () => {
  expect(audit([tree.root]).repos.map((r) => r.path)).not.toContain(tree.deep);
  expect(audit([tree.root], { maxDepth: 5 }).repos.map((r) => r.path)).toContain(tree.deep);
});

test('a stale graph is reported stale', () => {
  const root = tempDir('stale');
  const r = repo(path.join(root, 'old'));
  writeGraph(r, graphBody(1, 0), COMMIT_EPOCH_S - 60);
  expect(audit([root]).repos).toEqual([{ path: r, kind: 'registered', nodes: 1, edges: 0, stale: true }]);
});

test('edges are counted from an edges array when links is absent', () => {
  const root = tempDir('edges');
  const r = repo(path.join(root, 'r'));
  writeGraph(r, graphBody(4, 5, 'edges'));
  expect(audit([root]).repos[0]).toMatchObject({ nodes: 4, edges: 5 });
});

test('an invalid graph.json stays registered with null counts and a note', () => {
  const root = tempDir('invalid');
  const r = repo(path.join(root, 'broken'));
  writeGraph(r, '{"nodes": [');
  const [entry] = audit([root]).repos;
  expect(entry).toMatchObject({ path: r, kind: 'registered', nodes: null, edges: null, stale: false });
  expect(typeof entry.note).toBe('string');
  expect(entry.note.length).toBeGreaterThan(0);
});

test('the CLI exits 1 while a repository is unregistered and 0 once it is opted out', () => {
  const root = tempDir('gate');
  writeGraph(repo(path.join(root, 'ok')), graphBody(2, 1));
  const missing = repo(path.join(root, 'missing'));
  const before = runCli(root);
  expect(before.code).toBe(1);
  expect(before.stdout).toContain(missing);
  git(missing, 'config', 'graphify.register', 'never');
  expect(runCli(root).code).toBe(0);
});

test('the CLI prints a table and a totals line', () => {
  const out = runCli(tree.root);
  expect(out.code).toBe(1);
  const lines = out.stdout.trimEnd().split('\n');
  expect(lines[0]).toMatch(/^path\s+kind\s+nodes\s+edges\s+stale$/);
  expect(out.stdout).toMatch(new RegExp(`${tree.registered}\\s+registered\\s+3\\s+2\\s+no`));
  expect(lines.at(-1)).toBe(
    'totals: repositories 3, registered 1, stale 0, unregistered 1, opted-out 1, worktrees 1',
  );
});

test('the CLI prints the audit as JSON with --json and honors --max-depth', () => {
  const out = runCli(tree.root, '--json', '--max-depth', '5');
  expect(out.code).toBe(1);
  const parsed = JSON.parse(out.stdout);
  expect(Object.keys(parsed).sort()).toEqual(['repos', 'worktrees']);
  expect(parsed).toEqual(audit([tree.root], { maxDepth: 5 }));
  expect(parsed.repos.map((r) => r.path)).toContain(tree.deep);
});

test('the CLI ignores a leading -- argument', () => {
  const root = tempDir('dashdash');
  writeGraph(repo(path.join(root, 'ok')), graphBody(1, 0));
  expect(runCli('--', root).code).toBe(0);
});

test('the CLI prints usage and exits 0 with --help', () => {
  const out = runCli('--help');
  expect(out.code).toBe(0);
  expect(out.stdout).toContain('Usage:');
});

test('the CLI exits 2 without a root', () => {
  const out = runCli();
  expect(out.code).toBe(2);
  expect(out.stderr).toContain('Usage:');
});

test('the CLI exits 2 when a root does not exist', () => {
  const missing = path.join(tempDir('noroot'), 'nope');
  const out = runCli(missing);
  expect(out.code).toBe(2);
  expect(out.stderr).toContain(missing);
});
