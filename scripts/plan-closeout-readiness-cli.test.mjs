// scripts/plan-closeout-readiness-cli.test.mjs
//
// The readiness CLI end to end: spawns plan-closeout.mjs --readiness on temp plans and
// checks its rows, failure output, and open box listing. Split from
// plan-closeout.test.mjs, which is at its size ceiling. Temp dirs only.

import './lib/local-runner-env.mjs';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentIssueEnv } from './lib/readiness-issue-fixture.mjs';
import { cli, front, templatePlan, tickFor } from './lib/plan-closeout-fixtures.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('closeout CLI', () => {
  test('readiness CLI: unknown arguments print usage on stderr and exit 2', () => {
    const r = cli(['--bogus']);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr.toString(), /usage/i);
  });

  test('readiness CLI: a missing plan file exits 2 with a message, not a stack trace', () => {
    const r = cli(['--readiness', path.join(tmpdir(), 'plan-closeout-no-such-plan.md')]);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr.toString(), /cannot read plan/);
    assert.doesNotMatch(r.stderr.toString(), /at readinessCli/);
  });

  test('readiness CLI: runs skip_if in --cwd and prints rows, open NOW count and verdict', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
    dirs.push(root);
    writeFileSync(path.join(root, 'marker'), '');
    const file = path.join(root, 'plan.md');
    writeFileSync(file, [
      '---', 'schema: ultra-plan/v1', 'plan_id: demo', 'tasks:',
      '  - id: T1', '    depends_on: []', '    skip_if: "test -f marker"',
      '---', '', '| Item | Class | State |', '|---|---|---|', '| x | NOW | DONE |', '',
    ].join('\n'));
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10'], currentIssueEnv(root, file));
    assert.equal(r.stdout.toString(), 'T1\tDONE\ttest -f marker\nopen NOW follow-ups: 0\nopen step boxes: 0\nother open boxes: 0 (outside task sections; tick by hand with evidence, not counted)\nissue sync: CURRENT (issue #1 matches the plan)\nreadiness: READY\n');
    assert.equal(r.exitCode, 0);
  });

  const planWith = (root, tasks) => {
    const file = path.join(root, 'plan.md');
    writeFileSync(file, [
      '---', 'schema: ultra-plan/v1', 'plan_id: demo', 'tasks:',
      ...tasks.flatMap(({ id, skipIf }) => [`  - id: ${id}`, '    depends_on: []', `    skip_if: ${JSON.stringify(skipIf)}`]),
      '---', '',
    ].join('\n'));
    return file;
  };
  const tmpRoot = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
    dirs.push(root);
    return root;
  };

  test('failure output: an OPEN task prints its stderr tail under its row', () => {
    const root = tmpRoot();
    const file = planWith(root, [
      { id: 'T1', skipIf: 'echo from-stdout; echo from-stderr >&2; exit 1' },
      { id: 'T2', skipIf: 'exit 1' },
    ]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10']);
    const out = r.stdout.toString().split('\n');
    const i = out.findIndex((l) => l.startsWith('T1\tOPEN\t'));
    assert.ok(i >= 0, r.stdout.toString());
    assert.equal(out[i + 1], '    T1> from-stderr');
    assert.ok(out[i + 2].startsWith('T2\tOPEN\t'), r.stdout.toString());
    assert.equal(out[i + 3], '    T2> (no output)');
    assert.doesNotMatch(r.stdout.toString(), /> from-stdout/);
    assert.equal(r.exitCode, 1);
  });

  test('failure output: an UNREAD task prints what it wrote before the timeout', () => {
    const root = tmpRoot();
    const file = planWith(root, [{ id: 'T1', skipIf: 'echo started >&2; exec sleep 5' }]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '1']);
    assert.match(r.stdout.toString(), /^T1\tUNREAD\t.*\n    T1> started\n/);
  });

  test('failure output: a DONE task prints nothing extra', () => {
    const root = tmpRoot();
    const file = planWith(root, [{ id: 'T1', skipIf: 'echo noisy; echo noisy-err >&2; true' }]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10'], currentIssueEnv(root, file));
    assert.equal(r.stdout.toString(), `T1\tDONE\techo noisy; echo noisy-err >&2; true\nopen NOW follow-ups: 0\nopen step boxes: 0\nother open boxes: 0 (outside task sections; tick by hand with evidence, not counted)\nissue sync: CURRENT (issue #1 matches the plan)\nreadiness: READY\n`);
  });

  test('failure output: a task printing many lines shows at most 5', () => {
    const root = tmpRoot();
    const file = planWith(root, [{ id: 'T1', skipIf: 'for i in $(seq 1 40); do echo err$i >&2; done; exit 2' }]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10']);
    const shown = r.stdout.toString().split('\n').filter((l) => l.startsWith('    T1> '));
    assert.deepEqual(shown, ['err36', 'err37', 'err38', 'err39', 'err40'].map((l) => `    T1> ${l}`));
  });

  test('failure output: --log writes one file per executed task and prints the dir once', () => {
    const root = tmpRoot();
    const logDir = path.join(root, 'logs', 'nested');
    const file = planWith(root, [
      { id: 'T1', skipIf: 'echo one-out; echo one-err >&2; exit 1' },
      { id: 'T2', skipIf: 'echo two-out' },
      { id: 'T3', skipIf: 'false' },
    ]);
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '10', '--log', logDir]);
    assert.deepEqual(readdirSync(logDir).sort(), ['T1.log', 'T2.log']);
    const one = readFileSync(path.join(logDir, 'T1.log'), 'utf8');
    assert.match(one, /one-out/);
    assert.match(one, /one-err/);
    assert.match(readFileSync(path.join(logDir, 'T2.log'), 'utf8'), /two-out/);
    assert.equal(r.stdout.toString().split('\n').filter((l) => l === `log: ${logDir}`).length, 1);
  });

  test('readiness CLI: a timed-out skip_if is UNREAD and leaves no child process alive', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
    dirs.push(root);
    const file = path.join(root, 'plan.md');
    writeFileSync(file, [
      '---', 'schema: ultra-plan/v1', 'plan_id: demo', 'tasks:',
      '  - id: T1', '    depends_on: []', `    skip_if: ${JSON.stringify('sleep 7 & echo $! > child.pid; wait')}`,
      '---', '',
    ].join('\n'));
    const r = cli(['--readiness', file, '--cwd', root, '--timeout-s', '1']);
    const pid = Number(readFileSync(path.join(root, 'child.pid'), 'utf8'));
    assert.ok(pid > 0);
    // A killed child is a zombie until init reaps it, and signal 0 still finds a zombie.
    const deadline = Date.now() + 2000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        Bun.sleepSync(50);
      } catch (e) {
        assert.equal(e.code, 'ESRCH');
        alive = false;
      }
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, `sleep ${pid} outlived the timed-out skip_if`);
    assert.match(r.stdout.toString(), /^T1\tUNREAD\t/);
    assert.equal(r.exitCode, 1);
  });
});

describe('open step boxes', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
  const readiness = (text) => {
    const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-cli-'));
    dirs.push(root);
    writeFileSync(path.join(root, 'marker'), '');
    const file = path.join(root, 'plan.md');
    writeFileSync(file, text);
    const r = Bun.spawnSync(['bun', script, '--readiness', file, '--cwd', root, '--timeout-s', '10'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...currentIssueEnv(root, file) } });
    return { file, out: r.stdout.toString(), exit: r.exitCode };
  };

  test('open step boxes: readiness CLI prints the count, five task rows and the tick command, then exits 1', () => {
    const { file, out, exit } = readiness([
      ...front(['T1']), '', '### Task T1: todo',
      ...[1, 2, 3, 4, 5, 6].map((n) => `  - [ ] Step ${n} todo  `),
      '', '## Approval', '- [ ] Approved', '',
    ].join('\n'));
    assert.equal(out, [
      'T1\tDONE\ttest -f marker',
      'open NOW follow-ups: 0',
      'open step boxes: 6',
      '    line 12 (T1): - [ ] Step 1 todo',
      '    line 13 (T1): - [ ] Step 2 todo',
      '    line 14 (T1): - [ ] Step 3 todo',
      '    line 15 (T1): - [ ] Step 4 todo',
      '    line 16 (T1): - [ ] Step 5 todo',
      `    tick from evidence: ${tickFor(file)}`,
      'other open boxes: 1 (outside task sections; tick by hand with evidence, not counted)',
      '    line 20: - [ ] Approved',
      'issue sync: CURRENT (issue #1 matches the plan)',
      'readiness: NOT-READY',
      '',
    ].join('\n'));
    assert.equal(exit, 1);
  });

  test('other open boxes: a template-shaped plan is READY and the CLI lists its other open boxes as not counted', () => {
    const { out, exit } = readiness(templatePlan);
    assert.equal(out, [
      'T1\tDONE\ttest -f marker',
      'T2\tDONE\ttest -f marker',
      'open NOW follow-ups: 0',
      'open step boxes: 0',
      'other open boxes: 3 (outside task sections; tick by hand with evidence, not counted)',
      '    line 17: - [ ] AC1 the gate reads ticks',
      '    line 18: - [ ] AC2 nothing else',
      '    line 28: - [ ] Approved by the owner',
      'issue sync: CURRENT (issue #1 matches the plan)',
      'readiness: READY',
      '',
    ].join('\n'));
    assert.equal(exit, 0);
  });
});
