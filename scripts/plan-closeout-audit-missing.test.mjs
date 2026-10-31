// Audit behaviour for registry entries whose plan is not at docs/code-plan/plans/<plan>.md:
// `plan_file` points at the real file, `plan_missing` records that no plan file exists.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
const cli = (args) => Bun.spawnSync(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe' });
const plan = (status) => `---\nschema: ultra-plan/v1\nplan_id: x\nstatus: ${status}\n---\n# Plan\n`;
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function audit(sessions, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'plan-closeout-missing-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  const reg = path.join(root, 'pr.registry.json');
  writeFileSync(reg, JSON.stringify({ version: 1, sessions: sessions.map((s) => ({ state: 'merged', repo: root, ...s })) }));
  const r = cli(['--audit', '--registry', reg]);
  return { code: r.exitCode, out: r.stdout.toString() };
}

describe('audit: plan_file and plan_missing', () => {
  test('a session with plan_file is read from that path, so its status counts', () => {
    const { code, out } = audit(
      [{ session: 'a', plan: 'p1', plan_file: 'docs/code-plan/plans/p1-plan.md' }],
      { 'docs/code-plan/plans/p1-plan.md': plan('Approved') },
    );
    assert.equal(code, 0);
    assert.match(out, /^p1\tApproved\ta\t/m);
    assert.match(out, /closeout debt: 1 plan\(s\)/);
    assert.doesNotMatch(out, /not read/);
  });

  test('a Complete plan reached through plan_file is neither debt nor unread', () => {
    const { out } = audit(
      [{ session: 'a', plan: 'p1', plan_file: 'notes/p1.md' }],
      { 'notes/p1.md': plan('Complete') },
    );
    assert.match(out, /closeout debt: 0 plan\(s\)/);
    assert.doesNotMatch(out, /not read|p1/);
  });

  test('a plan recorded with plan_missing is counted on one line, never listed as debt or unread', () => {
    const { code, out } = audit([
      { session: 'a', plan: 'gone', plan_missing: 'lost with a removed worktree' },
      { session: 'b', plan: 'single', plan_missing: 'no plan file: single-task work' },
    ]);
    assert.equal(code, 0);
    assert.match(out, /closeout debt: 0 plan\(s\)/);
    assert.match(out, /no plan file: 2 plan\(s\) recorded with plan_missing in the registry/);
    assert.doesNotMatch(out, /not read|\bgone\b|\bsingle\b/);
  });

  test('a readable plan file wins over plan_missing on another session of the same plan', () => {
    const { out } = audit(
      [{ session: 'a', plan: 'p' }, { session: 'b', plan: 'p', plan_missing: 'x' }],
      { 'docs/code-plan/plans/p.md': plan('Approved') },
    );
    assert.match(out, /^p\tApproved\ta,b\t/m);
    assert.match(out, /closeout debt: 1 plan\(s\)/);
    assert.doesNotMatch(out, /no plan file/);
  });

  test('a plan with neither field and no file is still listed under not read', () => {
    const { out } = audit([
      { session: 'a', plan: 'hilang' },
      { session: 'b', plan: 'gone', plan_missing: 'lost' },
    ]);
    assert.match(out, /not read: 1 plan file\(s\) not found/);
    assert.match(out, /^ {2}hilang\t/m);
    assert.match(out, /no plan file: 1 plan\(s\)/);
  });
});
