// scripts/hooks/graphify-search-nudge.test.mjs
//
// Guards for the PreToolUse hook that reminds an agent, once per session and
// agent, that a registered repository has a graphify graph it can query before
// searching file by file.
//
// Most cases spawn the real hook with stdin JSON, because the behavior that
// matters lives across calls in the state file. Repositories are real `git
// init` temp dirs like the classifier's own tests, and every test gets a fresh
// GRAPHIFY_HOOK_STATE_DIR so no state leaks between cases or from the machine.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide, reminderText } from './graphify-search-nudge.mjs';
import { shellArg } from './graphify-session-start.mjs';

const HOOK = path.join(import.meta.dir, 'graphify-search-nudge.mjs');
const COMMIT_EPOCH_S = 1_700_000_000;
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tempDirs = [];

// The hook inherits process.env, so the developer's own git config (for
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
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `graphify-nudge-${tag}-`)));
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

function repo(tag, { graph = true } = {}) {
  const root = tempDir(tag);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-q', '-m', 'init');
  if (graph) {
    const g = path.join(root, 'graphify-out', 'graph.json');
    mkdirSync(path.dirname(g), { recursive: true });
    writeFileSync(g, '{"nodes":[],"links":[]}\n');
    utimesSync(g, COMMIT_EPOCH_S + 60, COMMIT_EPOCH_S + 60);
  }
  return root;
}

function graphPathOf(root) {
  return path.join(root, 'graphify-out', 'graph.json');
}

function event(cwd, tool_name, tool_input = {}, extra = {}) {
  return { session_id: 'sess-1', cwd, hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra };
}

function run(input, { stateDir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED_ENV, GRAPHIFY_HOOK_STATE_DIR: stateDir ?? tempDir('state'), ...env },
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function contextOf(stdout) {
  const lines = stdout.split('\n');
  expect(lines.length).toBe(2);
  expect(lines[1]).toBe('');
  const parsed = JSON.parse(lines[0]);
  expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
  expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName']);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  return parsed.hookSpecificOutput.additionalContext;
}

test('the first search in a registered repository prints one reminder naming the graph and the query command', () => {
  const root = repo('first');
  const r = run(event(root, 'Grep', { pattern: 'foo' }));
  expect(r.status).toBe(0);
  const text = contextOf(r.stdout);
  expect(text).toContain(graphPathOf(root));
  expect(text).toContain(`graphify query "<question>" --graph ${graphPathOf(root)}`);
  expect(text.length).toBeLessThan(600);
  expect(text).not.toContain('\u2014');
  expect(text).not.toMatch(/MANDATORY|You MUST/);
});

test('the suggested query command shell-quotes a graph path with a space or a single quote', () => {
  const spaced = '/home/u/Dokumen/Obsidian Vault/graphify-out/graph.json';
  const quoted = "/tmp/it's/graphify-out/graph.json";
  expect(shellArg(spaced)).toBe(`'${spaced}'`);
  expect(shellArg(quoted)).toBe("'/tmp/it'\\''s/graphify-out/graph.json'");
  for (const graphPath of [spaced, quoted]) {
    expect(reminderText(graphPath)).toContain(`\`graphify query "<question>" --graph ${shellArg(graphPath)}\``);
  }
});

test('a second search in the same session and agent is silent', () => {
  const root = repo('second');
  const stateDir = tempDir('state');
  expect(run(event(root, 'Grep', { pattern: 'foo' }), { stateDir }).stdout).not.toBe('');
  const r = run(event(root, 'Glob', { pattern: '**/*.js' }), { stateDir });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
});

test('a graphify query before any search keeps later searches silent', () => {
  const root = repo('query-first');
  const stateDir = tempDir('state');
  const q = run(event(root, 'Bash', { command: `graphify query "who calls x" --graph ${graphPathOf(root)}` }), {
    stateDir,
  });
  expect(q.status).toBe(0);
  expect(q.stdout).toBe('');
  const r = run(event(root, 'Grep', { pattern: 'foo' }), { stateDir });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
});

test('a graphify MCP tool call counts as a query', () => {
  const root = repo('mcp');
  const stateDir = tempDir('state');
  const q = run(event(root, 'mcp__graphify__query_graph', { question: 'x' }), { stateDir });
  expect(q.status).toBe(0);
  expect(q.stdout).toBe('');
  expect(run(event(root, 'Grep', { pattern: 'foo' }), { stateDir }).stdout).toBe('');
});

test('a Bash rg command is a search', () => {
  const root = repo('rg');
  const r = run(event(root, 'Bash', { command: 'rg foo' }));
  expect(r.status).toBe(0);
  expect(contextOf(r.stdout)).toContain(graphPathOf(root));
});

test('a Bash ls command is silent and leaves the reminder for the next search', () => {
  const root = repo('ls');
  const stateDir = tempDir('state');
  const r = run(event(root, 'Bash', { command: 'ls -la' }), { stateDir });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(contextOf(run(event(root, 'Bash', { command: 'rg foo' }), { stateDir }).stdout)).toContain(
    graphPathOf(root),
  );
});

test('a Bash graphify query behind timeout counts as a query', () => {
  const root = repo('timeout');
  const stateDir = tempDir('state');
  expect(run(event(root, 'Bash', { command: 'timeout 30 graphify query "x"' }), { stateDir }).stdout).toBe('');
  expect(run(event(root, 'Grep', { pattern: 'foo' }), { stateDir }).stdout).toBe('');
});

test('a Read of a Markdown file is not a search', () => {
  const root = repo('md');
  const stateDir = tempDir('state');
  const r = run(event(root, 'Read', { file_path: path.join(root, 'README.md') }), { stateDir });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(run(event(root, 'Read', { file_path: path.join(root, 'a.txt') }), { stateDir }).stdout).not.toBe('');
});

test('a Read under graphify-out is not a search', () => {
  const root = repo('gout');
  const stateDir = tempDir('state');
  const r = run(event(root, 'Read', { file_path: path.join(root, 'graphify-out', 'GRAPH_REPORT.json') }), {
    stateDir,
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(run(event(root, 'Grep', { pattern: 'foo' }), { stateDir }).stdout).not.toBe('');
});

test('a search in a repository without a graph is silent', () => {
  const root = repo('unreg', { graph: false });
  const r = run(event(root, 'Grep', { pattern: 'foo' }));
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
});

test('a search outside any repository is silent', () => {
  const r = run(event(tempDir('plain'), 'Grep', { pattern: 'foo' }));
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
});

test('only the first call of a session and agent spawns git', () => {
  const root = repo('cache', { graph: false });
  const realGit = Bun.which('git');
  const shimDir = tempDir('shim');
  const log = path.join(shimDir, 'calls.log');
  writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\necho x >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(path.join(shimDir, 'git'), 0o755);
  const stateDir = tempDir('state');
  const env = { PATH: `${shimDir}:${process.env.PATH}` };
  expect(run(event(root, 'Grep', { pattern: 'a' }), { stateDir, env }).stdout).toBe('');
  const afterFirst = readFileSync(log, 'utf8');
  expect(afterFirst.length).toBeGreaterThan(0);
  expect(run(event(root, 'Grep', { pattern: 'b' }), { stateDir, env }).stdout).toBe('');
  expect(readFileSync(log, 'utf8')).toBe(afterFirst);
});

test('two agents in one session are each reminded once', () => {
  const root = repo('agents');
  const stateDir = tempDir('state');
  const grep = (agent_id) => run(event(root, 'Grep', { pattern: 'foo' }, { agent_id }), { stateDir }).stdout;
  expect(grep('agent-a')).not.toBe('');
  expect(grep('agent-b')).not.toBe('');
  expect(grep('agent-a')).toBe('');
  expect(grep('agent-b')).toBe('');
});

test('ids are sanitized into one file inside the state directory', () => {
  const root = repo('ids');
  const stateDir = tempDir('state');
  const r = run(event(root, 'Grep', { pattern: 'foo' }, { session_id: '../s 1', agent_id: 'a/b' }), { stateDir });
  expect(r.stdout).not.toBe('');
  expect(readdirSync(stateDir)).toEqual(['___s_1.a_b.json']);
});

test('the main agent state file is named main when agent_id is absent', () => {
  const root = repo('main-id');
  const stateDir = tempDir('state');
  run(event(root, 'Grep', { pattern: 'foo' }), { stateDir });
  expect(readdirSync(stateDir)).toEqual(['sess-1.main.json']);
});

test('bad stdin exits 0 with no output', () => {
  for (const input of ['', 'not json', '[]', 'null', '{"tool_name":"Grep"}']) {
    const r = run(input);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }
});

test('an unwritable state directory exits 0 with no output', () => {
  const root = repo('unwritable');
  const blocker = path.join(tempDir('blocker'), 'file');
  writeFileSync(blocker, 'x');
  const r = run(event(root, 'Grep', { pattern: 'foo' }), { stateDir: path.join(blocker, 'state') });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  expect(existsSync(path.join(blocker, 'state'))).toBe(false);
});

test('output never contains permissionDecision', () => {
  const root = repo('perm');
  const stateDir = tempDir('state');
  const inputs = [
    event(root, 'Grep', { pattern: 'foo' }, { agent_id: 'p1' }),
    event(root, 'Bash', { command: 'rg foo' }, { agent_id: 'p2' }),
    event(root, 'Read', { file_path: path.join(root, 'a.txt') }, { agent_id: 'p3' }),
    event(root, 'mcp__graphify__query_graph', {}, { agent_id: 'p4' }),
    event(root, 'Edit', { file_path: path.join(root, 'a.txt') }, { agent_id: 'p5' }),
  ];
  let printed = 0;
  for (const input of inputs) {
    const r = run(input, { stateDir });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('permissionDecision');
    if (r.stdout) printed++;
  }
  expect(printed).toBe(3);
});

const REGISTERED = { kind: 'registered', graphPath: '/r/graphify-out/graph.json' };

function kindOf(tool_name, tool_input) {
  const { output, nextState } = decide({ session_id: 's', cwd: '/r', tool_name, tool_input }, {}, REGISTERED);
  if (nextState.queried) return 'query';
  if (output) return 'search';
  return 'other';
}

test('decide recognizes graphify query, path and explain after separators and prefixes', () => {
  for (const command of [
    'graphify query "x"',
    'graphify path "A" "B" --graph g.json',
    'graphify explain "X"',
    'cd sub && graphify query "x"',
    'echo hi; graphify explain "X"',
    'graphify query "x" | head -20',
    'FOO=1 graphify query "x"',
    'timeout 30 graphify path "A" "B"',
    '/usr/local/bin/graphify query "x"',
  ]) {
    expect([command, kindOf('Bash', { command })]).toEqual([command, 'query']);
  }
});

test('decide does not count other graphify subcommands or mentions as a query', () => {
  for (const command of ['graphify update .', 'echo graphify query', 'cat graphify-query.txt', 'graphify']) {
    expect([command, kindOf('Bash', { command })]).toEqual([command, 'other']);
  }
});

test('decide treats Grep, Glob, non-Markdown Read and search commands as searches', () => {
  expect(kindOf('Grep', { pattern: 'x' })).toBe('search');
  expect(kindOf('Glob', { pattern: '*.js' })).toBe('search');
  expect(kindOf('Read', { file_path: '/r/src/a.ts' })).toBe('search');
  for (const command of ['rg foo', 'grep -rn foo .', 'fd foo', 'find . -name x', 'ag foo', 'timeout 10 rg foo']) {
    expect([command, kindOf('Bash', { command })]).toEqual([command, 'search']);
  }
});

test('decide treats Markdown reads, graphify-out reads and other commands as neither', () => {
  expect(kindOf('Read', { file_path: '/r/docs/NOTES.MD' })).toBe('other');
  expect(kindOf('Read', { file_path: '/r/graphify-out/graph.json' })).toBe('other');
  expect(kindOf('Read', {})).toBe('other');
  for (const command of ['ls', 'git status', 'cd x && rg foo', 'echo rg']) {
    expect([command, kindOf('Bash', { command })]).toEqual([command, 'other']);
  }
  expect(kindOf('Edit', { file_path: '/r/a.ts' })).toBe('other');
});

test('decide stays silent when the state is already reminded or queried', () => {
  const input = { session_id: 's', cwd: '/r', tool_name: 'Grep', tool_input: {} };
  expect(decide(input, { reminded: true }, REGISTERED).output).toBeNull();
  expect(decide(input, { queried: true }, REGISTERED).output).toBeNull();
  expect(decide(input, {}, { kind: 'unregistered' }).output).toBeNull();
  expect(decide(input, {}, null).output).toBeNull();
});
