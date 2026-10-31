// The registry `repo` field is where a session's branch and PR live; `plan_repo` is where its plan
// file lives when that is another repository (a vivera plan driving sessions in other repositories).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planFileOf, planRepoAtClaim } from './lib/registry-plan-file.mjs';
import { claimSlot, resolveMergeRepo } from './pr-registry.mjs';
import { auditCloseout } from './plan-closeout.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function repoWithPlans(...ids) {
  const root = mkdtempSync(path.join(tmpdir(), 'registry-plan-repo-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'docs/code-plan/plans'), { recursive: true });
  for (const id of ids) writeFileSync(path.join(root, 'docs/code-plan/plans', `${id}.md`), '---\nstatus: Approved\n---\n');
  return root;
}

describe('planFileOf', () => {
  test('reads from plan_repo first, then repo, then the fallback', () => {
    const plan = 'docs/code-plan/plans/p.md';
    assert.equal(planFileOf({ plan: 'p', repo: '/r', plan_repo: '/v' }, '/f'), path.join('/v', plan));
    assert.equal(planFileOf({ plan: 'p', repo: '/r' }, '/f'), path.join('/r', plan));
    assert.equal(planFileOf({ plan: 'p' }, '/f'), path.join('/f', plan));
  });
});

describe('planRepoAtClaim', () => {
  test('names the vivera checkout when the plan exists only there', () => {
    const vivera = repoWithPlans('p');
    const target = repoWithPlans();
    assert.equal(planRepoAtClaim({ plan: 'p', repoRoot: target, viveraRoot: vivera }), path.resolve(vivera));
  });

  test('looks for the slug the registry records, not the raw --plan text', () => {
    const vivera = repoWithPlans('my-plan');
    const target = repoWithPlans();
    assert.equal(planRepoAtClaim({ plan: 'my plan', repoRoot: target, viveraRoot: vivera }), path.resolve(vivera));
  });

  test('is null when the plan exists in the claimed repository, in neither, or both are one checkout', () => {
    const vivera = repoWithPlans('p');
    const target = repoWithPlans('p');
    assert.equal(planRepoAtClaim({ plan: 'p', repoRoot: target, viveraRoot: vivera }), null);
    assert.equal(planRepoAtClaim({ plan: 'q', repoRoot: target, viveraRoot: vivera }), null);
    assert.equal(planRepoAtClaim({ plan: 'p', repoRoot: vivera, viveraRoot: vivera }), null);
  });
});

describe('audit location', () => {
  test('an audit row names the repository holding the plan, not the PR repository', () => {
    const rows = auditCloseout({
      sessions: [{ session: 'a', plan: 'p', state: 'merged', repo: '/repo/bcb', plan_repo: '/repo/vivera' }],
      planStatusOf: () => 'Approved',
    });
    assert.equal(rows[0].repo, '/repo/vivera');
  });
});

describe('claimSlot and resolveMergeRepo', () => {
  test('a new claim records plan_repo when one is given, and none otherwise', () => {
    const registry = { version: 1, sessions: [] };
    const withPlan = claimSlot(registry, { plan: 'p', session: 's1', repoRoot: '/repo/bcb', root: '/wt', planRepo: '/repo/vivera' });
    assert.equal(withPlan.session.repo, path.resolve('/repo/bcb'));
    assert.equal(withPlan.session.plan_repo, '/repo/vivera');
    const without = claimSlot(withPlan.registry, { plan: 'p', session: 's2', repoRoot: '/repo/bcb', root: '/wt' });
    assert.equal('plan_repo' in without.session, false);
  });

  test('state merged reads the plan from plan_repo first', () => {
    assert.equal(resolveMergeRepo({ repo: '/repo/bcb', plan_repo: '/repo/vivera' }), '/repo/vivera');
    assert.equal(resolveMergeRepo({ repo: '/repo/bcb' }), '/repo/bcb');
    assert.equal(resolveMergeRepo({ repo: '/repo/bcb', plan_repo: '/repo/vivera' }, '/flag'), path.resolve('/flag'));
  });
});
