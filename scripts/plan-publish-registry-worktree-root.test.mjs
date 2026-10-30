// scripts/plan-publish-registry-worktree-root.test.mjs
//
// Guards for worktrees that `claim --worktree` puts under VIVERA_WORKTREE_ROOT
// (<root>/<repo>-wt/<slot>, on another disk) instead of beside the repository.
// The claim side and the publisher side must derive the same container, or a
// plan written in such a worktree is unroutable.
//
// Separate from plan-publish-registry.test.mjs, which sits at its size-gate
// ceiling. Fixtures live under the system temp dir and the worktree root is
// always injected, so no test depends on this machine's environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { worktreesDirFor, worktreeFor } from './lib/registry-names.mjs';
import { resolveProject, destPathFor } from './plan-publish-registry.mjs';

const VAULT = '/vault/Obsidian Vault';
const UNROUTED = /no project in plans\.publish\.json owns/;

// A registry of the shape loadRegistry() returns, every root under a fresh temp
// base, plus `ext`, the stand-in for VIVERA_WORKTREE_ROOT. Routing is pure path
// logic, so no plan file needs to exist.
//   spec: [{ name, rootRel, worktrees: [rel] }]
function withFixture(tag, spec, fn) {
  const base = mkdtempSync(path.join(tmpdir(), `plan-publish-wtroot-${tag}-`));
  const registry = {
    vault: VAULT,
    destDirTemplate: '01 - Projects/{project}/plans',
    projects: spec.map(({ name, rootRel, worktrees }) => ({
      name,
      root: path.join(base, rootRel),
      mirror: true,
      ...(worktrees ? { worktrees: worktrees.map((w) => path.join(base, w)) } : {}),
    })),
  };
  try {
    fn({ base, ext: path.join(base, 'ext'), registry });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const planIn = (...segs) => path.join(...segs, 'docs', 'code-plan', 'plans', 'x.md');

const TWO = [
  { name: 'dawnbook', rootRel: 'code/dawnbook' },
  { name: 'other', rootRel: 'code/other' },
];

// ---------- worktreesDirFor ----------

test('worktreesDirFor without a root is the sibling <repo>-wt', () => {
  assert.equal(worktreesDirFor('/srv/code/dawnbook'), '/srv/code/dawnbook-wt');
});

test('worktreesDirFor with a root is <root>/<repo-basename>-wt', () => {
  assert.equal(worktreesDirFor('/srv/code/dawnbook', '/mnt/disk'), '/mnt/disk/dawnbook-wt');
});

test('worktreesDirFor resolves trailing slashes and relative inputs', () => {
  assert.equal(worktreesDirFor('/srv/code/dawnbook/'), '/srv/code/dawnbook-wt');
  assert.equal(worktreesDirFor('/srv/code/dawnbook/', '/mnt/disk/'), '/mnt/disk/dawnbook-wt');
  assert.equal(worktreesDirFor('rel/repo'), path.join(process.cwd(), 'rel', 'repo-wt'));
  assert.equal(worktreesDirFor('rel/repo', 'ext'), path.join(process.cwd(), 'ext', 'repo-wt'));
});

test('worktreesDirFor refuses an empty repo root', () => {
  for (const bad of ['', '   ', undefined, null, 7]) {
    assert.throws(() => worktreesDirFor(bad), /repo root must be a non-empty string/, String(bad));
  }
});

test('worktreesDirFor is the container worktreeFor puts each slot in', () => {
  assert.equal(worktreeFor('/srv/code/dawnbook', 'my slot'), '/srv/code/dawnbook-wt/my-slot');
  assert.equal(worktreeFor('/srv/code/dawnbook', 'my slot', '/mnt/disk'), '/mnt/disk/dawnbook-wt/my-slot');
  for (const root of [undefined, '/mnt/disk']) {
    assert.equal(
      worktreeFor('/srv/code/dawnbook', 'my slot', root),
      path.join(worktreesDirFor('/srv/code/dawnbook', root), 'my-slot'),
    );
  }
});

// ---------- resolveProject with a worktree root ----------

test('resolveProject routes a plan in <worktreeRoot>/<repo>-wt/<slot> to the project named by <repo>', () => {
  withFixture('ext', TWO, ({ ext, registry }) => {
    const plan = planIn(ext, 'dawnbook-wt', 'blog-rebrand');
    const project = resolveProject(registry, plan, { worktreeRoot: ext });
    assert.equal(project.name, 'dawnbook');
    assert.equal(destPathFor(registry, project, plan), '/vault/Obsidian Vault/01 - Projects/dawnbook/plans/x.md');
  });
});

test('resolveProject does not route the external container without a worktree root', () => {
  withFixture('noext', TWO, ({ ext, registry }) => {
    const plan = planIn(ext, 'dawnbook-wt', 'slot');
    assert.throws(() => resolveProject(registry, plan, { worktreeRoot: '' }), UNROUTED);
    const saved = process.env.VIVERA_WORKTREE_ROOT;
    try {
      // The default reads VIVERA_WORKTREE_ROOT, which is how the two-argument
      // callers (plan-publish, plan-sync, plan-lifecycle-audit) pick it up.
      process.env.VIVERA_WORKTREE_ROOT = ext;
      assert.equal(resolveProject(registry, plan).name, 'dawnbook');
      delete process.env.VIVERA_WORKTREE_ROOT;
      assert.throws(() => resolveProject(registry, plan), UNROUTED);
      assert.throws(() => resolveProject(registry, plan, { worktreeRoot: undefined }), UNROUTED);
    } finally {
      if (saved === undefined) delete process.env.VIVERA_WORKTREE_ROOT;
      else process.env.VIVERA_WORKTREE_ROOT = saved;
    }
  });
});

test('resolveProject does not route a <repo>-wtx lookalike or a bare file in the external container', () => {
  withFixture('ext-lookalike', TWO, ({ ext, registry }) => {
    for (const orphan of [planIn(ext, 'dawnbook-wtx', 'slot'), path.join(ext, 'dawnbook-wt', 'x.md')]) {
      assert.throws(() => resolveProject(registry, orphan, { worktreeRoot: ext }), UNROUTED, orphan);
    }
  });
});

test('resolveProject refuses an external container that two projects with one basename derive', () => {
  const spec = [
    { name: 'alpha', rootRel: 'a/Same' },
    { name: 'beta', rootRel: 'b/Same' },
  ];
  withFixture('ext-ambiguous', spec, ({ ext, registry }) => {
    const plan = planIn(ext, 'Same-wt', 'slot');
    assert.throws(() => resolveProject(registry, plan, { worktreeRoot: ext }), (e) => {
      assert.doesNotMatch(e.message, UNROUTED);
      for (const part of ['alpha', 'beta', path.join(ext, 'Same-wt')]) assert.ok(e.message.includes(part), e.message);
      return true;
    });
  });
});

test('resolveProject with a worktree root still routes sibling slots and explicit worktrees entries', () => {
  const spec = [
    { name: 'dawnbook', rootRel: 'code/dawnbook' },
    { name: 'other', rootRel: 'code/other', worktrees: ['code/dawnbook-wt/pinned', 'ext/dawnbook-wt/pinned'] },
  ];
  withFixture('ext-controls', spec, ({ base, ext, registry }) => {
    const opts = { worktreeRoot: ext };
    assert.equal(resolveProject(registry, planIn(base, 'code', 'dawnbook-wt', 'slot'), opts).name, 'dawnbook');
    assert.equal(resolveProject(registry, planIn(base, 'code', 'dawnbook'), opts).name, 'dawnbook');
    assert.equal(resolveProject(registry, planIn(base, 'code', 'dawnbook-wt', 'pinned'), opts).name, 'other');
    assert.equal(resolveProject(registry, planIn(ext, 'dawnbook-wt', 'pinned'), opts).name, 'other');
  });
});
