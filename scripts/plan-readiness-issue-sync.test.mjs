// scripts/plan-readiness-issue-sync.test.mjs
//
// Readiness reports whether the plan's GitHub issue mirror matches the plan, read
// offline from the plan.issues.json sidecar. Temp git repos and temp sidecars only.

import './lib/local-runner-env.mjs';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as closeout from './plan-closeout.mjs';
import { hashOf, ISSUE_FORMAT } from './plan-issue-sync.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
const KEY = 'docs/code-plan/plans/demo.md';
const PLAN_TEXT = [
  '---', 'schema: ultra-plan/v1', 'plan_id: demo', 'status: Verification', 'tasks:',
  '  - id: T1', '    depends_on: []', '    skip_if: "true"', '---', '', '# Demo', '',
].join('\n');

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// The project is resolved from the directory name, so "demo" is the mapped one.
function checkout(name = 'demo') {
  const base = mkdtempSync(path.join(tmpdir(), 'readiness-issue-sync-'));
  dirs.push(base);
  const root = path.join(base, name);
  mkdirSync(path.join(root, 'docs', 'code-plan', 'plans'), { recursive: true });
  spawnSync('git', ['init', '--quiet', root], { stdio: 'ignore' });
  const planFile = path.join(root, KEY);
  writeFileSync(planFile, PLAN_TEXT);
  return { base, root, planFile };
}

function sidecar(base, issues, raw) {
  const file = path.join(base, 'plan.issues.json');
  writeFileSync(file, raw ?? JSON.stringify({ version: 1, projects: { demo: 'o/r' }, issues }));
  return file;
}

const record = (over = {}) => ({
  number: 7, url: 'https://github.com/o/r/issues/7', hash: hashOf(PLAN_TEXT), state: 'open',
  status: 'Verification', repo: 'o/r', synced_at: '2026-11-27T00:00:00.000Z', format: ISSUE_FORMAT, ...over,
});

const { readinessVerdict } = closeout;
const stateOf = ({ planFile, root }, configPath) => closeout.issueSyncState({ planFile, planText: PLAN_TEXT, repoRoot: root, configPath });

describe('issueSyncState', () => {
  test('a record built from this plan text in the current format is CURRENT, with no fix', () => {
    const c = checkout();
    const s = stateOf(c, sidecar(c.base, { [KEY]: record() }));
    assert.equal(s.state, 'CURRENT');
    assert.equal(s.fix, null);
  });

  test('a record whose hash is from another plan text is DRIFT, fixed by plan-sync with the project', () => {
    const c = checkout();
    const s = stateOf(c, sidecar(c.base, { [KEY]: record({ hash: '00000000' }) }));
    assert.equal(s.state, 'DRIFT');
    assert.equal(s.fix, `bun scripts/plan-sync.mjs ${c.planFile} --project demo`);
  });

  test('a record with the right hash but an older body format is DRIFT', () => {
    const c = checkout();
    const s = stateOf(c, sidecar(c.base, { [KEY]: record({ format: ISSUE_FORMAT - 1 }) }));
    assert.equal(s.state, 'DRIFT');
    const noFormat = record();
    delete noFormat.format;
    assert.equal(stateOf(c, sidecar(c.base, { [KEY]: noFormat })).state, 'DRIFT');
  });

  test('no record while the project resolves is MISSING, fixed by plan-sync', () => {
    const c = checkout();
    const s = stateOf(c, sidecar(c.base, {}));
    assert.equal(s.state, 'MISSING');
    assert.equal(s.fix, `bun scripts/plan-sync.mjs ${c.planFile} --project demo`);
  });

  test('a record with no issue number is MISSING, since the sync would create the issue', () => {
    const c = checkout();
    const fix = `bun scripts/plan-sync.mjs ${c.planFile} --project demo`;
    for (const number of [null, undefined]) {
      const s = stateOf(c, sidecar(c.base, { [KEY]: record({ number }) }));
      assert.deepEqual([s.state, s.fix], ['MISSING', fix], String(number));
    }
  });

  test('no sidecar file, as in a session worktree, is NOT-CHECKED and says where to run it', () => {
    const c = checkout();
    const absent = path.join(c.base, 'no-such', 'plan.issues.json');
    const s = stateOf(c, absent);
    assert.equal(s.state, 'NOT-CHECKED');
    assert.ok(s.detail.includes(absent), s.detail);
    assert.match(s.detail, /main checkout/);
    assert.match(s.detail, /PLAN_ISSUES_CONFIG/);
    assert.equal(s.fix, null);
  });

  test('a project with no repository mapping is NOT-CHECKED, not MISSING', () => {
    const c = checkout('unmapped');
    const s = stateOf(c, sidecar(c.base, {}));
    assert.equal(s.state, 'NOT-CHECKED');
    assert.equal(s.fix, null);
  });

  test('a record held by another repository is NOT-CHECKED, not DRIFT', () => {
    const c = checkout();
    const s = stateOf(c, sidecar(c.base, { [KEY]: record({ repo: 'x/y', hash: '00000000' }) }));
    assert.equal(s.state, 'NOT-CHECKED');
    assert.match(s.detail, /x\/y/);
  });

  test('a corrupt sidecar is UNREADABLE', () => {
    const c = checkout();
    const s = stateOf(c, sidecar(c.base, null, '{ not json'));
    assert.equal(s.state, 'UNREADABLE');
  });
});

describe('readinessVerdict and the issue mirror', () => {
  const done = [{ id: 'T1', state: 'DONE' }];
  const pick = (v) => [v.verdict, v.exit];

  test('without the new params the verdicts are unchanged', () => {
    assert.deepEqual(pick(readinessVerdict({ tasks: done })), ['READY', 0]);
    assert.deepEqual(pick(readinessVerdict({ tasks: [{ id: 'T1', state: 'UNPROVEN' }] })), ['NEEDS-HUMAN', 3]);
    assert.deepEqual(pick(readinessVerdict({ tasks: done, issueDrift: 0, issueUnchecked: false })), ['READY', 0]);
  });

  test('a drifted issue makes an otherwise ready plan NOT-READY, exit 1', () => {
    assert.deepEqual(pick(readinessVerdict({ tasks: done, issueDrift: 1 })), ['NOT-READY', 1]);
  });

  test('an unchecked issue turns READY into NEEDS-HUMAN and leaves NOT-READY alone', () => {
    assert.deepEqual(pick(readinessVerdict({ tasks: done, issueUnchecked: true })), ['NEEDS-HUMAN', 3]);
    assert.deepEqual(pick(readinessVerdict({ tasks: [{ id: 'T1', state: 'OPEN' }], issueUnchecked: true })), ['NOT-READY', 1]);
  });
});

describe('readiness CLI', () => {
  const cli = (c, configPath) => {
    const r = Bun.spawnSync(['bun', script, '--readiness', c.planFile, '--cwd', c.root, '--timeout-s', '10'], {
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PLAN_ISSUES_CONFIG: configPath },
    });
    return { out: r.stdout.toString(), exit: r.exitCode };
  };

  test('a drifted issue prints its state and fix before the verdict and exits 1', () => {
    const c = checkout();
    const { out, exit } = cli(c, sidecar(c.base, { [KEY]: record({ hash: '00000000' }) }));
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.startsWith('issue sync: '));
    assert.match(lines[at], /^issue sync: DRIFT \(.+\)$/);
    assert.equal(lines[at + 1], `    fix: bun scripts/plan-sync.mjs ${c.planFile} --project demo`);
    assert.equal(lines[at + 2], 'readiness: NOT-READY');
    assert.equal(lines.filter((l) => l.startsWith('issue sync: ')).length, 1);
    assert.equal(exit, 1);
  });

  test('a current issue prints CURRENT with no fix and the plan stays READY, exit 0', () => {
    const c = checkout();
    const { out, exit } = cli(c, sidecar(c.base, { [KEY]: record() }));
    assert.match(out, /\nissue sync: CURRENT \(.+\)\nreadiness: READY\n$/);
    assert.doesNotMatch(out, /fix:/);
    assert.equal(exit, 0);
  });

  test('a missing record prints MISSING with its fix and exits 1', () => {
    const c = checkout();
    const { out, exit } = cli(c, sidecar(c.base, {}));
    assert.match(out, /\nissue sync: MISSING \(.+\)\n {4}fix: bun scripts\/plan-sync\.mjs .+ --project demo\nreadiness: NOT-READY\n$/);
    assert.equal(exit, 1);
  });

  test('a corrupt sidecar prints UNREADABLE and exits 1', () => {
    const c = checkout();
    const { out, exit } = cli(c, sidecar(c.base, null, '{ not json'));
    assert.match(out, /\nissue sync: UNREADABLE \(.+\)\nreadiness: NOT-READY\n$/);
    assert.equal(exit, 1);
  });

  test('a sidecar path that does not exist prints NOT-CHECKED and turns READY into NEEDS-HUMAN, exit 3', () => {
    const c = checkout();
    const { out, exit } = cli(c, path.join(c.base, 'no-such', 'plan.issues.json'));
    assert.match(out, /^T1\tDONE\ttrue$/m);
    assert.match(out, /\nissue sync: NOT-CHECKED \(.+\)\nreadiness: NEEDS-HUMAN\n$/);
    assert.equal(exit, 3);
  });
});
