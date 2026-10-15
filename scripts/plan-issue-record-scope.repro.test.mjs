// Reproduction for the issue record scope bugs found while closing fasttrack
// session member-sidebar (2026-10-15).
//
// B1: plan-issue-sync writes every repository's record into the store next to
//     its own script, but checkCloseout reads <repoRoot>/plan.issues.json, so
//     the merged gate never sees the record for a repository other than vivera.
// B2: the record key is the plan path relative to its repository, with no
//     repository in it, so a plan in one repository picks up another
//     repository's issue number and syncs against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncOne } from './plan-issue-sync.mjs';

const CLOSEOUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-closeout.mjs');
const PLAN_REL = 'docs/code-plan/plans/2026-10-15-shared-name.md';

function fakeRepo(status) {
  const root = mkdtempSync(path.join(tmpdir(), 'issue-scope-repo-'));
  mkdirSync(path.join(root, '.git'), { recursive: true });
  const full = path.join(root, PLAN_REL);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `---\nschema: ultra-plan/v1\nplan_id: 2026-10-15-shared-name\nstatus: ${status}\nversion: 1\n---\n\n# Shared name\n`, 'utf8');
  return { root, full, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The default store is resolved when the module loads, so a child process with
// its own PLAN_ISSUES_CONFIG is the only way to exercise the default without
// reading the machine's real store.
test('B1: the merged gate reads the record from the store the sync writes', () => {
  const r = fakeRepo('Complete');
  const storeDir = mkdtempSync(path.join(tmpdir(), 'issue-scope-store-'));
  const store = path.join(storeDir, 'store.json');
  try {
    const script = `const { checkCloseout } = await import(${JSON.stringify(CLOSEOUT)});
console.log(JSON.stringify(checkCloseout({ repoRoot: ${JSON.stringify(r.root)}, planSlug: '2026-10-15-shared-name', freshness: () => ({ state: 'OK' }) })));`;
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PLAN_ISSUES_CONFIG: store },
    });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout.trim().split('\n').pop());
    assert.equal(out.skipped, `plan.issues.json not found at ${store}, issue not checked`);
    assert.ok(
      !child.stdout.includes(path.join(r.root, 'plan.issues.json')),
      `checkCloseout looked for the record in the session repository instead of ${store}: ${child.stdout}`,
    );
  } finally {
    r.cleanup();
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('B2: a record filed for another repository is never synced against this one', () => {
  const r = fakeRepo('Draft');
  try {
    const cfg = {
      version: 1,
      projects: { [path.basename(r.root)]: 'me/this-repo', other: 'other/repo' },
      issues: {
        [PLAN_REL]: {
          number: 41,
          url: 'https://github.com/other/repo/issues/41',
          hash: 'deadbeef',
          state: 'open',
          status: 'Draft',
          repo: 'other/repo',
          synced_at: '2026-10-01T00:00:00.000Z',
        },
      },
    };
    const calls = [];
    const run = (args) => {
      calls.push(args.join(' '));
      if (args.includes('view')) return { ok: true, out: JSON.stringify({ state: 'OPEN', body: '' }) };
      return { ok: true, out: '[]' };
    };
    // Approved behaviour: refuse loudly rather than guess which repository owns the record.
    let err = null;
    try {
      syncOne(cfg, { planPath: r.full, repoRoot: r.root, run, dryRun: true, project: path.basename(r.root) });
    } catch (e) {
      err = e;
    }
    const touched41 = calls.filter((c) => /\b41\b/.test(c));
    assert.deepEqual(touched41, [], `synced me/this-repo against other/repo's issue #41: ${touched41.join(' | ')}`);
    assert.ok(err, 'syncOne accepted a record filed for other/repo');
    assert.match(err.message, /other\/repo/);
    assert.match(err.message, /me\/this-repo/);
    assert.deepEqual(calls, [], 'a refused sync must not call gh at all');
  } finally {
    r.cleanup();
  }
});
