// scripts/plan-closeout-cwd.test.mjs
//
// Where readiness runs a plan's skip_if and what it does with a missing test file.
// Split from plan-closeout.test.mjs, which is at its size ceiling. Temp dirs only.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as closeout from './plan-closeout.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
const cli = (args) => Bun.spawnSync(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe' });

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const planText = (skipIf) => [
  '---', 'schema: ultra-plan/v1', 'plan_id: demo-plan', 'tasks:',
  '  - id: T1', '    depends_on: []', `    skip_if: ${JSON.stringify(skipIf)}`, '---', '',
].join('\n');

// A checkout whose plan sits at docs/code-plan/plans/demo-plan.md, so the default cwd is its root.
function checkout(skipIf) {
  const root = tempDir('plan-closeout-cwd-');
  mkdirSync(path.join(root, 'docs', 'code-plan', 'plans'), { recursive: true });
  const plan = path.join(root, 'docs', 'code-plan', 'plans', 'demo-plan.md');
  writeFileSync(plan, planText(skipIf));
  return { root, plan };
}

describe('readiness and missing test files', () => {
  test('a skip_if naming a missing test file is OPEN with the path, and is never run', () => {
    const root = tempDir('plan-closeout-missing-');
    const calls = [];
    const run = (cmd) => {
      calls.push(cmd);
      return { exit: 0, timedOut: false };
    };
    const rows = closeout.taskReadiness(planText('timeout 120 bun test --timeout 30000 ./gone.test.mjs'), { run, cwd: root, timeoutMs: 1000 });
    assert.deepEqual(rows.map((r) => [r.id, r.state, r.missing]), [['T1', 'OPEN', ['./gone.test.mjs']]]);
    assert.deepEqual(calls, []);
  });

  test('readiness CLI: bun test over a present and a missing file is OPEN, not DONE, and names the missing one', () => {
    const { root, plan } = checkout('bun test ./present.test.mjs ./absent.test.mjs');
    writeFileSync(path.join(root, 'present.test.mjs'), "import { test } from 'bun:test';\ntest('ok', () => {});\n");
    const r = cli(['--readiness', plan, '--cwd', root, '--timeout-s', '30']);
    const out = r.stdout.toString();
    assert.match(out, /^T1\tOPEN\tbun test \.\/present\.test\.mjs \.\/absent\.test\.mjs\tmissing: \.\/absent\.test\.mjs$/m);
    assert.match(out, /readiness: NOT-READY/);
    assert.equal(r.exitCode, 1);
  });
});

describe('readiness runs in the session worktree', () => {
  const registry = (sessions) => {
    const file = path.join(tempDir('plan-closeout-reg-'), 'pr.registry.json');
    writeFileSync(file, JSON.stringify({ sessions }));
    return file;
  };
  const worktree = (marker) => {
    const d = tempDir('plan-closeout-wt-');
    if (marker) writeFileSync(path.join(d, 'marker'), '');
    return d;
  };
  const session = (session, worktreeDir, state, day, plan = 'demo-plan') => ({ session, plan, worktree: worktreeDir, state, claimed_at: `2026-10-0${day}T00:00:00.000Z` });
  const cwdLine = (out) => out.split('\n').filter((l) => l.startsWith('readiness cwd:'));

  test('without --cwd, skip_if runs in the newest unfinished session worktree, which is named', () => {
    const { plan } = checkout('test -f marker');
    const fresh = worktree(true);
    const reg = registry([
      session('s-new', fresh, 'open', 2),
      session('s-old', worktree(false), 'open', 1),
      session('s-merged', worktree(false), 'merged', 3),
      session('s-closed', worktree(false), 'closed', 4),
      session('s-other', worktree(false), 'open', 5, 'other-plan'),
    ]);
    const r = cli(['--readiness', plan, '--registry', reg, '--timeout-s', '10']);
    const out = r.stdout.toString();
    assert.deepEqual(cwdLine(out), [`readiness cwd: ${fresh} (worktree of unfinished session s-new in ${reg})`]);
    assert.match(out, /^T1\tDONE\ttest -f marker$/m);
    assert.equal(r.exitCode, 0);
  });

  test('--cwd wins over the registry worktree', () => {
    const { root, plan } = checkout('test -f marker');
    const reg = registry([session('s-new', worktree(true), 'open', 2)]);
    const r = cli(['--readiness', plan, '--registry', reg, '--cwd', root, '--timeout-s', '10']);
    assert.deepEqual(cwdLine(r.stdout.toString()), []);
    assert.match(r.stdout.toString(), /^T1\tOPEN\t/m);
  });

  test('when the newest unfinished worktree is gone, readiness keeps the default, not an older session', () => {
    const { root, plan } = checkout('test -f marker');
    writeFileSync(path.join(root, 'marker'), '');
    const reg = registry([session('s-old', worktree(false), 'open', 1), session('s-new', path.join(root, 'no-such-worktree'), 'open', 2)]);
    const r = cli(['--readiness', plan, '--registry', reg, '--timeout-s', '10']);
    assert.deepEqual(cwdLine(r.stdout.toString()), []);
    assert.match(r.stdout.toString(), /^T1\tDONE\t/m);
  });

  test('when every session of the plan is merged or closed, readiness keeps the default', () => {
    const { root, plan } = checkout('test -f marker');
    writeFileSync(path.join(root, 'marker'), '');
    const reg = registry([session('s-merged', worktree(false), 'merged', 1), session('s-closed', worktree(false), 'closed', 2)]);
    const r = cli(['--readiness', plan, '--registry', reg, '--timeout-s', '10']);
    assert.deepEqual(cwdLine(r.stdout.toString()), []);
    assert.match(r.stdout.toString(), /^T1\tDONE\t/m);
  });
});
