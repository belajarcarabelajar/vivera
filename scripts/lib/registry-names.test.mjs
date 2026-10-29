// scripts/lib/registry-names.test.mjs
//
// The derived branch and worktree names, moved out of pr-registry.test.mjs with
// the functions themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { branchFor, worktreeFor } from './registry-names.mjs';

const REPO = '/home/u/Proyek/snippet';

test('branch name is derived, not chosen, and is scoped by plan', () => {
  assert.equal(branchFor('2026-10-01-add-pr', 'w1'), '2026-10-01-add-pr/w1');
  // No tool, vendor, or workflow prefix. The name lands in permanent repository
  // history, so it has to read like something a person would have written, and
  // an unrequested authorship marker is the same defect as a `Generated with`
  // footer. Asserted literally because the prefix is exactly the kind of thing
  // that gets added back as a "harmless" nicety.
  assert.ok(!branchFor('p', 'w1').startsWith('ai/'), 'the branch must not announce a tool');
  assert.equal(branchFor('p', 'w1').split('/').length, 2, 'exactly <plan-id>/<session-slug>, nothing wrapped around it');
  // Two sessions in the same plan still get different branches, which is the
  // only reason twenty panes can push at once without fighting.
  assert.notEqual(branchFor('p', 'w1'), branchFor('p', 'w2'));
  // The same session id in two different plans is also a different branch, so a
  // recycled session name cannot clobber an earlier plan's PR.
  assert.notEqual(branchFor('plan-a', 'w1'), branchFor('plan-b', 'w1'));
});

test('branch name rejects input that would normalise to an illegal git ref', () => {
  for (const bad of ['', '   ', '...', '-lead', '.hidden', 'a..b']) {
    assert.throws(() => branchFor('plan', bad), /plan id|session id|legal branch segment/,
      `"${bad}" must be refused rather than silently rewritten into a colliding name`);
  }
});

test('punctuation differences cannot produce the same slot', () => {
  // If these collapsed to one name, two agents that named their session
  // differently would still land on one branch, which is the collision the
  // registry exists to make impossible.
  assert.equal(branchFor('plan', 'a b'), branchFor('plan', 'a-b'));
  assert.equal(branchFor('plan', 'a/b'), branchFor('plan', 'a-b'));
});

test('worktree sits beside the repository, never inside it', () => {
  const wt = worktreeFor(REPO, 'w1');
  assert.equal(wt, '/home/u/Proyek/snippet-wt/w1');
  // A worktree nested in its own repository gets picked up by the parent's
  // watchers, formatters, and test globs, which then see two copies of a file.
  assert.ok(!wt.startsWith(`${REPO}${path.sep}`), 'the worktree must not be inside the repository');
});

test('a worktree root moves the -wt directory there, keeping repo and session names', () => {
  assert.equal(worktreeFor(REPO, 'w1', '/mnt/ext'), '/mnt/ext/snippet-wt/w1');
  assert.equal(worktreeFor(REPO, 'a b', '/mnt/ext/'), '/mnt/ext/snippet-wt/a-b');
});
