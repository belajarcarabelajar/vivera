// scripts/graphify-register.test.mjs
//
// Guards for the command that builds a repository's graph, adds it to the
// global graphify registry only with --global, or records that the repository
// opted out.
//
// Fixtures are real repositories built with `git init` in temp dirs, because
// the command's answers (main checkout, common dir, ignore rules, local config)
// come from git itself. graphify is always a stub shell script that logs its
// arguments, so the suite never runs the real CLI or touches ~/.graphify.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from './graphify-register.mjs';

const SCRIPT = path.join(import.meta.dir, 'graphify-register.mjs');
const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tempDirs = [];

// The module inherits process.env, so the developer's git config must not
// leak in, and a call that forgets graphifyBin must hit a missing binary
// instead of the real graphify on PATH.
const savedEnv = {};
let guardBin;
beforeAll(() => {
  guardBin = path.join(tempDir('guard'), 'no-such-graphify');
  const env = { ...ISOLATED_ENV, GRAPHIFY_BIN: guardBin };
  for (const [k, v] of Object.entries(env)) {
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
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `graphify-register-${tag}-`)));
  tempDirs.push(d);
  return d;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED_ENV },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.replace(/\n$/, '');
}

function repo(tag) {
  const root = tempDir(tag);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function stub({ failOn = null, code = 1 } = {}) {
  const dir = tempDir('bin');
  const bin = path.join(dir, 'graphify');
  const log = path.join(dir, 'calls.log');
  const fail = failOn
    ? `if [ "$1" = "${failOn}" ]; then echo "boom from stub" >&2; exit ${code}; fi\n`
    : '';
  writeFileSync(
    bin,
    '#!/bin/sh\n' +
      `printf '%s\\n' "$*" >> "${log}"\n` +
      fail +
      'if [ "$1" = update ]; then\n' +
      '  mkdir -p "$2/graphify-out"\n' +
      `  printf '{"nodes":[],"links":[]}\\n' > "$2/graphify-out/graph.json"\n` +
      'fi\n' +
      'exit 0\n',
  );
  chmodSync(bin, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { bin, calls };
}

function excludeOf(root) {
  return path.join(root, '.git', 'info', 'exclude');
}

function runCli(args, env = {}) {
  const r = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    env: { ...process.env, ...ISOLATED_ENV, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

test('global: true builds the graph then adds it to the global registry under the repository name', () => {
  const root = repo('build');
  const g = stub();
  const r = register(root, { graphifyBin: g.bin, global: true });
  expect(r.exitCode).toBe(0);
  const graph = path.join(root, 'graphify-out', 'graph.json');
  expect(g.calls()).toEqual([`update ${root}`, `global add ${graph} --as ${path.basename(root)}`]);
  expect(JSON.parse(readFileSync(graph, 'utf8'))).toEqual({ nodes: [], links: [] });
  expect(r.lines.length).toBeGreaterThanOrEqual(3);
});

test('a default registration builds the graph but does not call global add', () => {
  const root = repo('default');
  const g = stub();
  const r = register(root, { graphifyBin: g.bin });
  expect(r.exitCode).toBe(0);
  expect(g.calls()).toEqual([`update ${root}`]);
  expect(existsSync(path.join(root, 'graphify-out', 'graph.json'))).toBe(true);
  expect(readFileSync(excludeOf(root), 'utf8').split('\n')).toContain('graphify-out/');
});

test('a default registration prints a hint naming the graph path and both ways to add it to the global graph', () => {
  const root = repo('hint');
  const g = stub();
  const r = register(root, { graphifyBin: g.bin });
  const graph = path.join(root, 'graphify-out', 'graph.json');
  const hint = r.lines.filter((l) => l.includes('not in the global graph'));
  expect(hint).toHaveLength(1);
  expect(hint[0]).toContain(`graphify global add ${graph} --as ${path.basename(root)}`);
  expect(hint[0]).toContain('--global');
});

test('never with global: never wins, global is ignored with a line saying so', () => {
  const root = repo('never-global');
  const g = stub();
  const r = register(root, { graphifyBin: g.bin, never: true, global: true });
  expect(r.exitCode).toBe(0);
  expect(git(root, 'config', '--get', 'graphify.register')).toBe('never');
  expect(g.calls()).toEqual([]);
  expect(r.lines.join('\n')).toContain('--global ignored');
});

test('appends graphify-out/ to info/exclude once across two runs without global add', () => {
  const root = repo('twice');
  const g = stub();
  expect(register(root, { graphifyBin: g.bin }).exitCode).toBe(0);
  expect(register(root, { graphifyBin: g.bin }).exitCode).toBe(0);
  const lines = readFileSync(excludeOf(root), 'utf8').split('\n');
  expect(lines.filter((l) => l === 'graphify-out/')).toHaveLength(1);
  expect(g.calls()).toEqual([`update ${root}`, `update ${root}`]);
  expect(git(root, 'status', '--porcelain')).toBe('');
});

test('does not append twice when a .gitignore negation keeps graphify-out/ tracked', () => {
  const root = repo('negated');
  writeFileSync(path.join(root, '.gitignore'), '!graphify-out/\n');
  const g = stub();
  expect(register(root, { graphifyBin: g.bin }).exitCode).toBe(0);
  expect(register(root, { graphifyBin: g.bin }).exitCode).toBe(0);
  const lines = readFileSync(excludeOf(root), 'utf8').split('\n');
  expect(lines.filter((l) => l === 'graphify-out/')).toHaveLength(1);
});

test('creates info/exclude when the info directory is missing', () => {
  const root = repo('noinfo');
  rmSync(path.join(root, '.git', 'info'), { recursive: true, force: true });
  const g = stub();
  expect(register(root, { graphifyBin: g.bin }).exitCode).toBe(0);
  expect(readFileSync(excludeOf(root), 'utf8')).toBe('graphify-out/\n');
});

test('keeps an existing exclude line intact when the file lacks a final newline', () => {
  const root = repo('nonl');
  writeFileSync(excludeOf(root), '*.log');
  const g = stub();
  expect(register(root, { graphifyBin: g.bin }).exitCode).toBe(0);
  expect(readFileSync(excludeOf(root), 'utf8')).toBe('*.log\ngraphify-out/\n');
});

test('an already ignored graphify-out/ leaves info/exclude unchanged', () => {
  const root = repo('ignored');
  writeFileSync(path.join(root, '.gitignore'), 'graphify-out/\n');
  const before = readFileSync(excludeOf(root), 'utf8');
  const g = stub();
  const r = register(root, { graphifyBin: g.bin });
  expect(r.exitCode).toBe(0);
  expect(readFileSync(excludeOf(root), 'utf8')).toBe(before);
  expect(r.lines.join('\n')).toContain('already ignored');
});

test('never sets graphify.register=never without calling graphify', () => {
  const root = repo('never');
  const g = stub();
  const r = register(root, { graphifyBin: g.bin, never: true });
  expect(r.exitCode).toBe(0);
  expect(git(root, 'config', '--get', 'graphify.register')).toBe('never');
  expect(g.calls()).toEqual([]);
  expect(existsSync(path.join(root, 'graphify-out'))).toBe(false);
});

test('an opted-out repository is skipped with the undo command', () => {
  const root = repo('optout');
  git(root, 'config', 'graphify.register', 'never');
  const g = stub();
  const r = register(root, { graphifyBin: g.bin });
  expect(r.exitCode).toBe(0);
  const text = r.lines.join('\n');
  expect(text).toContain('opted out');
  expect(text).toContain('git config --unset graphify.register');
  expect(g.calls()).toEqual([]);
});

test('a linked worktree registers its main checkout in the global registry with global: true', () => {
  const main = repo('wt-main');
  const wt = path.join(tempDir('wt-link'), 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  const g = stub();
  const r = register(wt, { graphifyBin: g.bin, global: true });
  expect(r.exitCode).toBe(0);
  const graph = path.join(main, 'graphify-out', 'graph.json');
  expect(g.calls()).toEqual([`update ${main}`, `global add ${graph} --as ${path.basename(main)}`]);
  expect(existsSync(graph)).toBe(true);
  expect(existsSync(path.join(wt, 'graphify-out'))).toBe(false);
  expect(readFileSync(excludeOf(main), 'utf8').split('\n')).toContain('graphify-out/');
});

test('a failing update exits 1 naming the step, its exit code, and the stderr tail', () => {
  const root = repo('upfail');
  const g = stub({ failOn: 'update', code: 1 });
  const r = register(root, { graphifyBin: g.bin });
  expect(r.exitCode).toBe(1);
  const text = r.lines.join('\n');
  expect(text).toMatch(/update.*exit code 1/);
  expect(text).toContain('boom from stub');
  expect(g.calls()).toEqual([`update ${root}`]);
});

test('a failing global add exits 1 naming the step and its exit code', () => {
  const root = repo('addfail');
  const g = stub({ failOn: 'global', code: 3 });
  const r = register(root, { graphifyBin: g.bin, global: true });
  expect(r.exitCode).toBe(1);
  expect(r.lines.join('\n')).toMatch(/global add.*exit code 3/);
});

test('a missing graphify binary exits 1 and reads GRAPHIFY_BIN by default', () => {
  const root = repo('missing');
  const r = register(root);
  expect(r.exitCode).toBe(1);
  const text = r.lines.join('\n');
  expect(text).toContain('not found');
  expect(text).toContain(guardBin);
});

test('a directory outside any repository exits 2', () => {
  const d = tempDir('plain');
  const r = register(d, { graphifyBin: stub().bin });
  expect(r.exitCode).toBe(2);
  expect(r.lines.join('\n')).toContain('not a git repository');
});

test('CLI --help prints usage and exits 0', () => {
  const r = runCli(['--help']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('Usage');
});

test('CLI --help mentions --global', () => {
  const r = runCli(['--help']);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('--global');
});

test('CLI without a directory prints usage and exits 2', () => {
  const r = runCli([]);
  expect(r.exitCode).toBe(2);
  expect(r.stderr).toContain('Usage');
});

test('CLI on a directory outside any repository exits 2', () => {
  const r = runCli([tempDir('cli-plain')]);
  expect(r.exitCode).toBe(2);
  expect(r.stderr).toContain('not a git repository');
});

test('CLI ignores a leading -- and uses the graphify from GRAPHIFY_BIN', () => {
  const root = repo('cli-build');
  const g = stub();
  const r = runCli(['--', root], { GRAPHIFY_BIN: g.bin });
  expect(r.exitCode).toBe(0);
  expect(g.calls()[0]).toBe(`update ${root}`);
  expect(r.stdout).toContain(root);
});

test('CLI --never opts the repository out', () => {
  const root = repo('cli-never');
  const g = stub();
  const r = runCli([root, '--never'], { GRAPHIFY_BIN: g.bin });
  expect(r.exitCode).toBe(0);
  expect(git(root, 'config', '--get', 'graphify.register')).toBe('never');
  expect(g.calls()).toEqual([]);
});

test('CLI --global adds the graph to the global registry', () => {
  const root = repo('cli-global');
  const g = stub();
  const r = runCli([root, '--global'], { GRAPHIFY_BIN: g.bin });
  expect(r.exitCode).toBe(0);
  const graph = path.join(root, 'graphify-out', 'graph.json');
  expect(g.calls()).toEqual([`update ${root}`, `global add ${graph} --as ${path.basename(root)}`]);
  expect(r.stdout).toContain(`registered ${graph}`);
});

test('CLI without --global does not call global add and prints the hint', () => {
  const root = repo('cli-noglobal');
  const g = stub();
  const r = runCli([root], { GRAPHIFY_BIN: g.bin });
  expect(r.exitCode).toBe(0);
  expect(g.calls()).toEqual([`update ${root}`]);
  expect(r.stdout).toContain('not in the global graph');
});
