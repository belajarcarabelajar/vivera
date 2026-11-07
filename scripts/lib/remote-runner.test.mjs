// scripts/lib/remote-runner.test.mjs
//
// The optional remote runner for plan commands (skip_if, run[].cmd, loop_until).
// A fake runner script in a temp directory records its argv and then either runs
// the command it was handed or exits with a chosen code. No network.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPlanCommand } from './remote-runner.mjs';
import { run } from './runner-process.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

// The fake runner appends one record per call holding its NUL-separated argv, then exits
// with FAKE_RUNNER_EXIT when that is set, or execs the argv it was given.
function fakeRunner() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vivera-remote-runner-'));
  dirs.push(dir);
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'fake-runner');
  writeFileSync(bin, [
    '#!/usr/bin/env bash',
    `{ printf '%s\\0' "$@"; printf '\\036'; } >> ${JSON.stringify(log)}`,
    '[ -n "$FAKE_RUNNER_EXIT" ] && exit "$FAKE_RUNNER_EXIT"',
    '[ "$1" = "--" ] && shift',
    'exec "$@"',
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  const calls = () => (existsSync(log)
    ? readFileSync(log, 'utf8').split('\x1e').slice(0, -1).map((rec) => rec.split('\0').slice(0, -1))
    : []);
  return { dir, bin, calls };
}

// The local executor every call site hands in: one shell string, exit and stdout back.
const exec = (cwd, env) => (cmd) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8' });
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe('runPlanCommand', () => {
  const CMD = `printf '%s' "it's" && echo " ok" > out.txt && cat out.txt`;

  test('runner unset or empty: the command runs locally and the runner is never called', () => {
    const f = fakeRunner();
    for (const value of [undefined, '', '   ']) {
      const env = { ...process.env, SUCP_REMOTE_RUNNER: value };
      if (value === undefined) delete env.SUCP_REMOTE_RUNNER;
      const r = runPlanCommand(CMD, exec(f.dir, env), env);
      assert.equal(r.exit, 0);
      assert.equal(r.stdout, "it's ok\n");
    }
    assert.deepEqual(f.calls(), []);
  });

  test('runner set: the runner receives bash -c and the command unchanged, quotes and && included', () => {
    const f = fakeRunner();
    const env = { ...process.env, SUCP_REMOTE_RUNNER: `${f.bin} --` };
    const r = runPlanCommand(CMD, exec(f.dir, env), env);
    assert.deepEqual(f.calls(), [['--', 'bash', '-c', CMD]]);
    assert.equal(r.exit, 0);
    assert.equal(r.stdout, "it's ok\n");
  });

  test('runner exits with the fallback code: the command reruns locally once and that result is used', () => {
    const f = fakeRunner();
    const env = { ...process.env, SUCP_REMOTE_RUNNER: f.bin, SUCP_REMOTE_RUNNER_FALLBACK_EXIT: '3', FAKE_RUNNER_EXIT: '3' };
    const r = runPlanCommand('echo local >> ran.txt; exit 7', exec(f.dir, env), env);
    assert.equal(f.calls().length, 1);
    assert.equal(r.exit, 7);
    assert.equal(readFileSync(path.join(f.dir, 'ran.txt'), 'utf8'), 'local\n');
  });

  test('runner fails with another code: that exit is returned and nothing runs locally', () => {
    const f = fakeRunner();
    const env = { ...process.env, SUCP_REMOTE_RUNNER: f.bin, SUCP_REMOTE_RUNNER_FALLBACK_EXIT: '3', FAKE_RUNNER_EXIT: '5' };
    const r = runPlanCommand('echo local >> ran.txt', exec(f.dir, env), env);
    assert.equal(r.exit, 5);
    assert.equal(existsSync(path.join(f.dir, 'ran.txt')), false);
  });

  test('fallback unset: the runner exit is returned even when it is the code a fallback would catch', () => {
    const f = fakeRunner();
    const env = { ...process.env, SUCP_REMOTE_RUNNER: f.bin, FAKE_RUNNER_EXIT: '3' };
    const r = runPlanCommand('echo local >> ran.txt', exec(f.dir, env), env);
    assert.equal(r.exit, 3);
    assert.equal(existsSync(path.join(f.dir, 'ran.txt')), false);
  });
});

describe('ultra-plan-runner step execution', () => {
  test('run() sends the step through SUCP_REMOTE_RUNNER when it is set', () => {
    const f = fakeRunner();
    const saved = process.env.SUCP_REMOTE_RUNNER;
    process.env.SUCP_REMOTE_RUNNER = f.bin;
    try {
      const r = run(`echo "a b" && echo 'c'`, 10000);
      assert.equal(r.exit, 0);
      assert.equal(r.stdout, 'a b\nc\n');
      assert.deepEqual(f.calls(), [['bash', '-c', `echo "a b" && echo 'c'`]]);
    } finally {
      if (saved === undefined) delete process.env.SUCP_REMOTE_RUNNER; else process.env.SUCP_REMOTE_RUNNER = saved;
    }
  });
});
