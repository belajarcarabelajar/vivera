// scripts/lib/hook-io.test.mjs
//
// Guards for the fail-open hook IO library shared by the context hooks.
//
// runHook is exercised the way Claude Code runs a hook: a small fixture hook
// written into a temp dir imports the library by absolute path and is spawned
// with one JSON object on stdin. The state dir comes from VIVERA_HOOK_STATE_DIR
// so no test touches the real ~/.local/state/vivera.

import { test, expect, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hookPaths, isDisabled, logHookError, readHookInput } from './hook-io.mjs';

const LIB = path.join(import.meta.dir, 'hook-io.mjs');
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
const tempDirs = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag) {
  const d = mkdtempSync(path.join(tmpdir(), `hook-io-${tag}-`));
  tempDirs.push(d);
  return d;
}

// FIXTURE_MODE picks what the handler does, so one fixture file covers every
// runHook case.
const FIXTURE = `
import { runHook } from ${JSON.stringify(LIB)};
await runHook('fixture-hook', async (input, paths) => {
  const mode = process.env.FIXTURE_MODE;
  if (mode === 'throw') throw new Error('boom');
  if (mode === 'throw-multiline') throw new Error('first\\nsecond');
  if (mode === 'throw-string') throw 'plain string';
  if (mode === 'null') return null;
  return { got: input, paths };
});
`;

function fixtureHook() {
  const dir = tempDir('fixture');
  const file = path.join(dir, 'fixture-hook.mjs');
  writeFileSync(file, FIXTURE);
  return file;
}

const HOOK = fixtureHook();

function runFixture(stdin, { mode = 'echo', stateDir, scratchDir } = {}) {
  const env = { ...process.env, FIXTURE_MODE: mode, VIVERA_HOOK_STATE_DIR: stateDir };
  if (scratchDir) env.VIVERA_HOOK_SCRATCH_DIR = scratchDir;
  const r = Bun.spawnSync([process.execPath, HOOK], { stdin: Buffer.from(stdin), env });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function logLines(stateDir) {
  const log = path.join(stateDir, 'hook-errors.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

const EVENT = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 's' });

test('readHookInput returns the parsed object for a JSON object', () => {
  expect(readHookInput('{"a":1,"b":{"c":"d"}}')).toEqual({ a: 1, b: { c: 'd' } });
});

test('readHookInput returns null for empty, malformed, and non-object JSON', () => {
  for (const text of ['', '   \n', '{not json', 'null', '[]', '[1,2]', '"x"', '42', 'true', undefined, null]) {
    expect(readHookInput(text)).toBeNull();
  }
});

test('hookPaths uses the environment overrides', () => {
  const p = hookPaths({ VIVERA_HOOK_STATE_DIR: '/s/state', VIVERA_HOOK_SCRATCH_DIR: '/s/scratch', HOME: '/h' });
  expect(p).toEqual({
    stateDir: '/s/state',
    scratchDir: '/s/scratch',
    errorLog: '/s/state/hook-errors.log',
    killSwitch: '/s/state/context-hooks-off',
  });
});

test('hookPaths defaults to the state and scratch dirs under HOME', () => {
  expect(hookPaths({ HOME: '/home/u' })).toEqual({
    stateDir: '/home/u/.local/state/vivera',
    scratchDir: '/home/u/.cache/tmp/vivera-scratch',
    errorLog: '/home/u/.local/state/vivera/hook-errors.log',
    killSwitch: '/home/u/.local/state/vivera/context-hooks-off',
  });
});

test('hookPaths treats an empty override as unset', () => {
  const p = hookPaths({ HOME: '/home/u', VIVERA_HOOK_STATE_DIR: '', VIVERA_HOOK_SCRATCH_DIR: '' });
  expect(p.stateDir).toBe('/home/u/.local/state/vivera');
  expect(p.scratchDir).toBe('/home/u/.cache/tmp/vivera-scratch');
});

test('isDisabled is true only while the kill-switch file exists', () => {
  const paths = hookPaths({ VIVERA_HOOK_STATE_DIR: tempDir('kill') });
  expect(isDisabled(paths)).toBe(false);
  writeFileSync(paths.killSwitch, '');
  expect(isDisabled(paths)).toBe(true);
});

test('logHookError appends one timestamped line per call and creates the state dir', () => {
  const stateDir = path.join(tempDir('log'), 'nested', 'state');
  const paths = hookPaths({ VIVERA_HOOK_STATE_DIR: stateDir });
  logHookError(paths, 'my-hook', new Error('first'));
  logHookError(paths, 'my-hook', new Error('line one\nline two'));
  const lines = logLines(stateDir);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(LOG_LINE);
  expect(lines[0].endsWith(' my-hook first')).toBe(true);
  expect(lines[1].endsWith(' my-hook line one line two')).toBe(true);
});

test('logHookError never throws when the log dir cannot be written', () => {
  const blocker = path.join(tempDir('unwritable'), 'a-file');
  writeFileSync(blocker, '');
  const paths = hookPaths({ VIVERA_HOOK_STATE_DIR: path.join(blocker, 'state') });
  expect(() => logHookError(paths, 'my-hook', new Error('x'))).not.toThrow();
});

test('runHook prints the handler result as one JSON line and exits 0', () => {
  const stateDir = tempDir('echo');
  const r = runFixture(EVENT, { stateDir });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toMatch(/^[^\n]+\n?$/);
  const out = JSON.parse(r.stdout);
  expect(out.got).toEqual(JSON.parse(EVENT));
  expect(out.paths.stateDir).toBe(stateDir);
  expect(logLines(stateDir)).toEqual([]);
});

test('runHook prints nothing when the handler returns null', () => {
  const stateDir = tempDir('null');
  const r = runFixture(EVENT, { mode: 'null', stateDir });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('');
  expect(logLines(stateDir)).toEqual([]);
});

test('runHook exits 0 with no output and logs one line when the handler throws', () => {
  const stateDir = tempDir('throw');
  const r = runFixture(EVENT, { mode: 'throw', stateDir });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('');
  const lines = logLines(stateDir);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(LOG_LINE);
  expect(lines[0].endsWith(' fixture-hook boom')).toBe(true);
});

test('runHook keeps a multi-line or non-Error throw on one log line', () => {
  const stateDir = tempDir('throw-odd');
  expect(runFixture(EVENT, { mode: 'throw-multiline', stateDir }).exitCode).toBe(0);
  expect(runFixture(EVENT, { mode: 'throw-string', stateDir }).exitCode).toBe(0);
  const lines = logLines(stateDir);
  expect(lines).toHaveLength(2);
  expect(lines[0].endsWith(' fixture-hook first second')).toBe(true);
  expect(lines[1].endsWith(' fixture-hook plain string')).toBe(true);
});

test('runHook exits 0 with no output and logs one line per malformed stdin', () => {
  const stateDir = tempDir('malformed');
  const inputs = ['', '{not json', 'null', '[]', '42'];
  for (const input of inputs) {
    const r = runFixture(input, { stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  }
  const lines = logLines(stateDir);
  expect(lines).toHaveLength(inputs.length);
  for (const line of lines) expect(line).toMatch(new RegExp(`${LOG_LINE.source}fixture-hook \\S`));
});

test('runHook is a no-op while the kill-switch file exists, even for a throwing handler', () => {
  const stateDir = tempDir('off');
  writeFileSync(path.join(stateDir, 'context-hooks-off'), '');
  for (const mode of ['echo', 'throw']) {
    const r = runFixture(EVENT, { mode, stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  }
  expect(logLines(stateDir)).toEqual([]);
});

test('runHook exits 0 with no output when the handler throws and the log dir is unwritable', () => {
  const blocker = path.join(tempDir('unwritable-run'), 'a-file');
  writeFileSync(blocker, '');
  const r = runFixture(EVENT, { mode: 'throw', stateDir: path.join(blocker, 'state') });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('');
});

test('runHook hands the handler the paths resolved from the environment', () => {
  const stateDir = tempDir('scratch');
  const scratchDir = path.join(stateDir, 'scratch');
  const r = runFixture(EVENT, { stateDir, scratchDir });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout).paths).toEqual({
    stateDir,
    scratchDir,
    errorLog: path.join(stateDir, 'hook-errors.log'),
    killSwitch: path.join(stateDir, 'context-hooks-off'),
  });
});
