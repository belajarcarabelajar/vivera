// scripts/hooks/graphify-session-start.test.mjs
//
// Guards for the SessionStart and SubagentStart hook that tells a Claude Code
// session whether its repository has a graphify graph and how to query it.
//
// The hook is spawned the way Claude Code runs it (one JSON object on stdin,
// context JSON on stdout) against real git repositories in temp dirs, because
// its verdict comes from git itself. Wording edge cases call the exported text
// builder directly so they do not need a repository per variant.

import { test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contextFor } from './graphify-session-start.mjs';

const HOOK = path.join(import.meta.dir, 'graphify-session-start.mjs');
const VIVERA_ROOT = path.resolve(import.meta.dir, '..', '..');
const REGISTER_SCRIPT = `${VIVERA_ROOT}/scripts/graphify-register.mjs`;
const COMMIT_EPOCH_S = 1_700_000_000;
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const BUDGET_MS = 300;
const MAX_CONTEXT_CHARS = 1500;
const tempDirs = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag) {
  // realpath so paths compare equal to what git prints for --show-toplevel.
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `graphify-session-start-${tag}-`)));
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

function repo(tag) {
  const root = tempDir(tag);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function writeGraph(mainRoot, mtimeS) {
  const graph = path.join(mainRoot, 'graphify-out', 'graph.json');
  mkdirSync(path.dirname(graph), { recursive: true });
  writeFileSync(graph, '{"nodes":[],"links":[]}\n');
  utimesSync(graph, mtimeS, mtimeS);
  return graph;
}

function runHook(stdin, { spawnCwd } = {}) {
  const r = Bun.spawnSync([process.execPath, HOOK], {
    stdin: Buffer.from(stdin),
    env: { ...process.env, ...ISOLATED_ENV },
    cwd: spawnCwd,
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function event(name, cwd) {
  return JSON.stringify({ hook_event_name: name, cwd, session_id: 'test-session' });
}

function expectFactualWording(text) {
  expect(text).not.toMatch(/mandatory/i);
  expect(text).not.toMatch(/\bmust\b/i);
  expect(text).not.toContain(String.fromCodePoint(0x2014));
  expect(text).not.toContain('\n');
  expect(text.length).toBeLessThan(MAX_CONTEXT_CHARS);
}

// Asserts the hook printed exactly one JSON line of the documented shape and
// returns its context text.
function contextFrom(r, eventName) {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toMatch(/^[^\n]+\n?$/);
  const out = JSON.parse(r.stdout);
  expect(Object.keys(out)).toEqual(['hookSpecificOutput']);
  expect(Object.keys(out.hookSpecificOutput)).toEqual(['hookEventName', 'additionalContext']);
  expect(out.hookSpecificOutput.hookEventName).toBe(eventName);
  const text = out.hookSpecificOutput.additionalContext;
  expect(typeof text).toBe('string');
  expectFactualWording(text);
  return text;
}

function expectSilent(r) {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('');
}

function expectQueryCommands(text, mainRoot, graph) {
  expect(text).toContain(`graphify query "<question>" --graph ${graph}`);
  expect(text).toContain('graphify path');
  expect(text).toContain('graphify explain');
  expect(text).toContain(`query_graph with project_path set to ${mainRoot}`);
  expect(text).toContain('scoped subgraph');
  expect(text).toContain('before grepping or reading source files');
}

test('a registered fresh repository gets the graph path, the main checkout, and the query commands', () => {
  const root = repo('fresh');
  const graph = writeGraph(root, COMMIT_EPOCH_S + 60);
  const text = contextFrom(runHook(event('SessionStart', root)), 'SessionStart');
  expect(text).toContain(graph);
  expect(text).toContain(`main checkout ${root}`);
  expectQueryCommands(text, root, graph);
  expect(text).not.toContain('graphify update');
  expect(text).not.toContain('worktree');
});

test('a registered stale repository is told the graph is older than the last commit and how to refresh it', () => {
  const root = repo('stale');
  const graph = writeGraph(root, COMMIT_EPOCH_S - 60);
  const text = contextFrom(runHook(event('SessionStart', root)), 'SessionStart');
  expect(text).toContain('older than the last commit');
  expect(text).toContain(`graphify update ${root}`);
  expect(text).toContain('offline');
  expectQueryCommands(text, root, graph);
});

test('a linked worktree is pointed at the graph in its main checkout', () => {
  const main = repo('wt-main');
  const graph = writeGraph(main, COMMIT_EPOCH_S + 60);
  const wt = path.join(tempDir('wt-link'), 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  const text = contextFrom(runHook(event('SessionStart', wt)), 'SessionStart');
  expect(graph.startsWith(`${main}/`)).toBe(true);
  expect(text).toContain(graph);
  expect(text).toContain(wt);
  expect(text).toContain('describes the main checkout');
  expectQueryCommands(text, main, graph);
});

test('a subagent in a registered repository gets the same context under SubagentStart', () => {
  const root = repo('sub-reg');
  const graph = writeGraph(root, COMMIT_EPOCH_S + 60);
  const r = runHook(
    JSON.stringify({ hook_event_name: 'SubagentStart', cwd: root, session_id: 's', agent_id: 'a1' }),
  );
  expectQueryCommands(contextFrom(r, 'SubagentStart'), root, graph);
});

test('an unregistered repository on SessionStart is offered registration with the command and --never', () => {
  const root = repo('unreg');
  const text = contextFrom(runHook(event('SessionStart', root)), 'SessionStart');
  expect(text).toContain(`${root} has no`);
  expect(text).toContain('graph queries are unavailable');
  expect(text).toContain('offline');
  expect(text).toContain('about 13 s per 2,000 files');
  expect(text).toContain(`bun ${REGISTER_SCRIPT} ${root}`);
  expect(text).toContain('--never');
  expect(text).toContain('question tool');
  expect(text).toContain('Register now');
  expect(text).toContain('Not now');
  expect(text).toContain('Never for this repository');
  expect(text).toContain('A dismissed question registers nothing; only an explicit Register now does.');
});

test('an unregistered repository on SubagentStart prints nothing', () => {
  const root = repo('unreg-sub');
  expectSilent(runHook(event('SubagentStart', root)));
});

test('an opted-out repository prints nothing on either event', () => {
  const root = repo('optout');
  git(root, 'config', 'graphify.register', 'never');
  expectSilent(runHook(event('SessionStart', root)));
  expectSilent(runHook(event('SubagentStart', root)));
});

test('a directory outside any repository prints nothing', () => {
  expectSilent(runHook(event('SessionStart', tempDir('plain'))));
});

test('a cwd that does not exist prints nothing', () => {
  expectSilent(runHook(event('SessionStart', path.join(tempDir('gone'), 'nope'))));
});

test('a missing, non-string, empty, or relative cwd prints nothing', () => {
  // The hook runs from a registered repository, so an empty or relative cwd
  // that leaked into git -C would classify that repository and print context.
  const spawnCwd = repo('rel-cwd');
  writeGraph(spawnCwd, COMMIT_EPOCH_S + 60);
  mkdirSync(path.join(spawnCwd, 'sub'));
  expectSilent(runHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's' }), { spawnCwd }));
  for (const cwd of [42, '', '.', 'sub']) {
    const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd, session_id: 's' });
    expectSilent(runHook(input, { spawnCwd }));
  }
});

test('an event other than SessionStart or SubagentStart prints nothing', () => {
  const root = repo('other-event');
  writeGraph(root, COMMIT_EPOCH_S + 60);
  expectSilent(runHook(event('PreToolUse', root)));
});

test('empty stdin, invalid JSON, and JSON that is not an object exit 0 and print nothing', () => {
  for (const input of ['', '   \n', '{not json', 'null', '[]', '"SessionStart"', '42']) {
    expectSilent(runHook(input));
  }
});

test('contextFor stays factual and under the size limit for long paths', () => {
  const mainRoot = `/home/${'u'.repeat(20)}/${'project-'.repeat(8)}main`;
  const root = `/home/${'u'.repeat(20)}/${'worktrees-'.repeat(8)}linked`;
  const graphPath = `${mainRoot}/graphify-out/graph.json`;
  const viveraRoot = `/home/${'u'.repeat(20)}/${'vivera-'.repeat(6)}root`;
  const registered = {
    kind: 'registered',
    dir: root,
    root,
    mainRoot,
    graphPath,
    graphMtimeMs: 0,
    headCommitMs: 1000,
    stale: true,
    worktree: true,
  };
  const unregistered = { kind: 'unregistered', dir: mainRoot, root: mainRoot, mainRoot, graphPath };
  for (const ev of ['SessionStart', 'SubagentStart']) expectFactualWording(contextFor(ev, registered, viveraRoot));
  expectFactualWording(contextFor('SessionStart', unregistered, viveraRoot));
});

test('contextFor returns null when there is nothing to say', () => {
  const unregistered = { kind: 'unregistered', dir: '/r', root: '/r', mainRoot: '/r', graphPath: '/r/g' };
  expect(contextFor('SubagentStart', unregistered, '/v')).toBeNull();
  expect(contextFor('SessionStart', { kind: 'opted-out', dir: '/r', root: '/r', mainRoot: '/r' }, '/v')).toBeNull();
  expect(contextFor('SessionStart', { kind: 'not-git', dir: '/r' }, '/v')).toBeNull();
});

test('contextFor shell-quotes paths with spaces inside commands', () => {
  const mainRoot = "/home/u/my repo's";
  const graphPath = `${mainRoot}/graphify-out/graph.json`;
  const quotedRoot = `'/home/u/my repo'\\''s'`;
  const registered = {
    kind: 'registered',
    dir: mainRoot,
    root: mainRoot,
    mainRoot,
    graphPath,
    graphMtimeMs: 0,
    headCommitMs: 1000,
    stale: true,
    worktree: false,
  };
  const reg = contextFor('SessionStart', registered, '/v');
  expect(reg).toContain(`graphify update ${quotedRoot}`);
  expect(reg).toContain(`--graph ${quotedRoot.slice(0, -1)}/graphify-out/graph.json'`);
  const unregistered = { kind: 'unregistered', dir: mainRoot, root: mainRoot, mainRoot, graphPath };
  expect(contextFor('SessionStart', unregistered, '/v w')).toContain(
    `bun '/v w/scripts/graphify-register.mjs' ${quotedRoot}`,
  );
});

test('one hook run on a fixture repository finishes within the time budget', () => {
  const root = repo('budget');
  writeGraph(root, COMMIT_EPOCH_S + 60);
  const input = event('SessionStart', root);
  // The first spawn pays for cold disk and module caches, which a real
  // session start does not pay twice.
  runHook(input);
  const t0 = performance.now();
  const r = runHook(input);
  const elapsed = performance.now() - t0;
  contextFrom(r, 'SessionStart');
  expect(elapsed).toBeLessThan(BUDGET_MS);
});
