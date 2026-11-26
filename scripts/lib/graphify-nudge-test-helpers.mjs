// scripts/lib/graphify-nudge-test-helpers.mjs
//
// Shared fixtures for the graphify-search-nudge hook tests: real `git init`
// temp repositories with an optional graph, and a runner that spawns the hook
// with stdin JSON and a fresh state directory. Split out of
// graphify-search-nudge.test.mjs when the gate tests got their own file.

import { afterAll, beforeAll, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitText } from './git.mjs';

export const HOOK = path.join(import.meta.dir, '..', 'hooks', 'graphify-search-nudge.mjs');
export const COMMIT_EPOCH_S = 1_700_000_000;
export const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
export const tempDirs = [];

// The hook inherits process.env, so the developer's own git config (for
// example a global graphify.register) must not leak into its git calls.
// Call once at the top level of each test file.
export function isolateGitEnv() {
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
}

export function tempDir(tag) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `graphify-nudge-${tag}-`)));
  tempDirs.push(d);
  return d;
}

export function git(cwd, ...args) {
  const date = `@${COMMIT_EPOCH_S} +0000`;
  return gitText(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], {
    env: { ...process.env, ...ISOLATED_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    label: `git ${args.join(' ')} failed`,
  });
}

export function repo(tag, { graph = true } = {}) {
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

export function graphPathOf(root) {
  return path.join(root, 'graphify-out', 'graph.json');
}

export function event(cwd, tool_name, tool_input = {}, extra = {}) {
  return { session_id: 'sess-1', cwd, hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra };
}

export function run(input, { stateDir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    // The gate is off unless a test turns it on (graphify-search-gate.test.mjs).
    env: {
      ...process.env,
      ...ISOLATED_ENV,
      GRAPHIFY_HOOK_STATE_DIR: stateDir ?? tempDir('state'),
      GRAPHIFY_GATE: '0',
      ...env,
    },
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function contextOf(stdout) {
  const lines = stdout.split('\n');
  expect(lines.length).toBe(2);
  expect(lines[1]).toBe('');
  const parsed = JSON.parse(lines[0]);
  expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
  expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName']);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  return parsed.hookSpecificOutput.additionalContext;
}
