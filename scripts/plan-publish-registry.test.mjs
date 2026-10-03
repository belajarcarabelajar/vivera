// scripts/plan-publish-registry.test.mjs
//
// Guards for the plan-publishing registry. The registry is the only thing that
// decides which project owns a plan file and where its vault copy lands, so a
// silent misroute files a plan into the wrong Obsidian folder and there is no
// error to notice.
//
// Every fixture here is built inline (temp dirs or plain objects) on purpose:
// the tests must not depend on whether the real Snipset / ram-audit /
// vivera checkouts happen to exist on the machine running them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRegistry,
  resolveProject,
  enumeratePlans,
  destPathFor,
} from './plan-publish-registry.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VAULT = path.join(homedir(), 'Dokumen/Obsidian Vault');

// The real registry names every project root by absolute path, so the
// "real registry" tests below only have a subject where those roots exist. On a
// clone elsewhere (a CI runner, a VPS) this checkout is not the vivera root
// the config registers, and enumeratePlans() reads no plans at all: asserting
// then would report the checkout's location as a routing bug, while an empty
// enumeration would pass vacuously. Both gates derive their answer from the
// registry rather than a hardcoded host, so they run on the machine that owns
// the checkouts and skip, with the reason, everywhere else.
//
// plans.publish.json itself is machine-local, gitignored config (see
// .gitignore): it names this machine's vault and project checkouts, so a fresh
// clone does not carry it and loadRegistry() would throw before a single test
// ran. The module-level reads are therefore guarded on its existence, and every
// test that needs the real registry skips with the reason instead.
const REGISTRY_PATH = path.join(rootDir, 'plans.publish.json');
const REGISTRY_PRESENT = existsSync(REGISTRY_PATH);
const REGISTRY_SKIP =
  'plans.publish.json is absent: it is gitignored, machine-local publish-routing config (see .gitignore) naming this machine\'s vault and project checkouts, so a fresh clone does not carry it; '
  + 'copy plans.publish.example.json to plans.publish.json and register this checkout to run this test';
const withRegistry = REGISTRY_PRESENT ? test : (name, fn) => test(name, { skip: REGISTRY_SKIP }, fn);
const selfProject = REGISTRY_PRESENT
  ? loadRegistry().projects.find((p) => path.resolve(p.root) === rootDir)
  : undefined;
const realPlans = REGISTRY_PRESENT ? enumeratePlans(loadRegistry()) : [];

// Build a registry of the shape loadRegistry() returns, with every project root
// under a fresh temp directory. `rootRel` is relative to that temp base, so
// nested roots can be expressed without depending on the base before it exists.
//
// spec: [{ name, rootRel, mirror, plans, worktrees }]
//   plans:      undefined means "do not create docs/code-plan/plans at all"
//   worktrees:  [{ rel, plans }] extra checkouts of the same project
function fixture(tag, spec) {
  const base = mkdtempSync(path.join(tmpdir(), `plan-publish-${tag}-`));
  const projects = spec.map(({ name, rootRel, mirror, plans, worktrees }) => {
    const root = path.join(base, rootRel);
    const plansDir = path.join(root, 'docs', 'code-plan', 'plans');
    const writePlans = (dir, files) => {
      mkdirSync(dir, { recursive: true });
      for (const f of files) writeFileSync(path.join(dir, f), `# plan ${f}\n`, 'utf8');
    };
    if (plans) writePlans(plansDir, plans);
    const wt = (worktrees ?? []).map(({ rel, plans: wtPlans }) => {
      const wtRoot = path.join(base, rel);
      const wtPlansDir = path.join(wtRoot, 'docs', 'code-plan', 'plans');
      if (wtPlans) writePlans(wtPlansDir, wtPlans);
      return { root: wtRoot, plansDir: wtPlansDir, plans: wtPlans ?? [] };
    });
    return {
      name,
      root,
      mirror,
      base,
      plansDir,
      worktrees: wt,
    };
  });
  return {
    base,
    projects,
    registry: {
      vault: VAULT,
      destDirTemplate: '01 - Projects/{project}/plans',
      indexTemplate: '01 - Projects/{project}/index.md',
      stageInVault: true,
      projects: projects.map(({ name, root, mirror, worktrees }) => ({
        name,
        root,
        mirror,
        ...(worktrees.length ? { worktrees: worktrees.map((w) => w.root) } : {}),
      })),
    },
  };
}

function cleanup(f) {
  rmSync(f.base, { recursive: true, force: true });
}

function tmpFile(tag, filename, body) {
  const dir = mkdtempSync(path.join(tmpdir(), `plan-publish-${tag}-`));
  const p = path.join(dir, filename);
  writeFileSync(p, body, 'utf8');
  return { dir, path: p };
}

// ---------- loadRegistry ----------

test('loadRegistry throws and names the path when the config file is absent', () => {
  const missing = path.join(mkdtempSync(path.join(tmpdir(), 'plan-publish-missing-')), 'plans.publish.json');
  assert.throws(
    () => loadRegistry(missing),
    (e) => e instanceof Error && e.message.includes(missing),
    'error message must name the missing config path',
  );
});

withRegistry('loadRegistry reads the repo config, whichever projects it lists today', () => {
  const r = loadRegistry();
  assert.equal(r.vault, VAULT);
  assert.equal(r.destDirTemplate, '01 - Projects/{project}/plans');
  assert.equal(r.indexTemplate, '01 - Projects/{project}/index.md');
  assert.equal(r.stageInVault, true);
  // The project LIST is compared against plans.publish.json rather than against
  // a literal. This test guards the parser; a hardcoded list guarded nothing but
  // the day someone added a project, which is exactly what happened when
  // Snipset-seo and dawnbook were registered and this assertion went stale.
  //
  // Reading the same file still proves the file was read: a registry built from
  // defaults would not carry these names, and a config emptied to `projects: []`
  // fails the length check rather than passing quietly.
  const raw = JSON.parse(readFileSync(path.join(rootDir, 'plans.publish.json'), 'utf8'));
  assert.deepEqual(
    r.projects.map((p) => p.name),
    raw.projects.map((p) => p.name),
  );
  assert.ok(
    r.projects.length >= 4,
    `the real registry must still list its projects, got ${r.projects.length}`,
  );
  // The vault's own entry is the reason the mirror flag exists at all.
  assert.equal(r.projects.find((p) => p.name === 'vault').mirror, false);
  assert.equal(r.vault, r.projects.find((p) => p.name === 'vault').root);
});

test('loadRegistry rejects a config missing vault, destDirTemplate, or projects', () => {
  for (const field of ['vault', 'destDirTemplate', 'projects']) {
    const doc = { vault: VAULT, destDirTemplate: 'x/{project}', projects: [] };
    delete doc[field];
    const f = tmpFile('fields', `${field}.json`, JSON.stringify(doc));
    assert.throws(
      () => loadRegistry(f.path),
      (e) => e instanceof Error && e.message.includes(field),
      `config without "${field}" must throw naming the field`,
    );
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('loadRegistry rejects duplicate project names and duplicate roots', () => {
  const dupName = tmpFile('dup-name', 'c.json', JSON.stringify({
    vault: VAULT,
    destDirTemplate: '01 - Projects/{project}/plans',
    projects: [
      { name: 'a', root: '/tmp/a', mirror: true },
      { name: 'a', root: '/tmp/b', mirror: true },
    ],
  }));
  assert.throws(() => loadRegistry(dupName.path), (e) => e instanceof Error && /name/i.test(e.message));

  const dupRoot = tmpFile('dup-root', 'c.json', JSON.stringify({
    vault: VAULT,
    destDirTemplate: '01 - Projects/{project}/plans',
    projects: [
      { name: 'a', root: '/tmp/same', mirror: true },
      { name: 'b', root: '/tmp/same', mirror: true },
    ],
  }));
  assert.throws(() => loadRegistry(dupRoot.path), (e) => e instanceof Error && /root/i.test(e.message));

  rmSync(dupName.dir, { recursive: true, force: true });
  rmSync(dupRoot.dir, { recursive: true, force: true });
});

test('loadRegistry rejects unparseable JSON instead of returning garbage', () => {
  const f = tmpFile('badjson', 'plans.publish.json', '{ not json');
  assert.throws(() => loadRegistry(f.path), (e) => e instanceof Error);
  rmSync(f.dir, { recursive: true, force: true });
});

test('loadRegistry rejects a malformed worktrees field', () => {
  const cases = [
    { label: 'not an array', worktrees: '/tmp/wt', expect: /must be an array/i },
    { label: 'non-string entry', worktrees: [42], expect: /non-empty path/i },
    { label: 'empty string entry', worktrees: [''], expect: /non-empty path/i },
  ];
  for (const { label, worktrees, expect } of cases) {
    const f = tmpFile('wt-bad', 'c.json', JSON.stringify({
      vault: VAULT,
      destDirTemplate: '01 - Projects/{project}/plans',
      projects: [{ name: 'a', root: '/tmp/a', mirror: true, worktrees }],
    }));
    assert.throws(
      () => loadRegistry(f.path),
      (e) => e instanceof Error && expect.test(e.message),
      `worktrees ${label} must be rejected, not silently ignored`,
    );
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('loadRegistry rejects a worktree that is already a project root', () => {
  const f = tmpFile('wt-collide', 'c.json', JSON.stringify({
    vault: VAULT,
    destDirTemplate: '01 - Projects/{project}/plans',
    projects: [
      { name: 'a', root: '/tmp/a', mirror: true, worktrees: ['/tmp/b'] },
      { name: 'b', root: '/tmp/b', mirror: true },
    ],
  }));
  assert.throws(
    () => loadRegistry(f.path),
    (e) => e instanceof Error && /already a project root/i.test(e.message),
    'one directory cannot be routable as two projects',
  );
  rmSync(f.dir, { recursive: true, force: true });
});

test('loadRegistry rejects one worktree claimed by two projects', () => {
  const f = tmpFile('wt-shared', 'c.json', JSON.stringify({
    vault: VAULT,
    destDirTemplate: '01 - Projects/{project}/plans',
    projects: [
      { name: 'a', root: '/tmp/a', mirror: true, worktrees: ['/tmp/shared'] },
      { name: 'b', root: '/tmp/b', mirror: true, worktrees: ['/tmp/shared'] },
    ],
  }));
  assert.throws(
    () => loadRegistry(f.path),
    (e) => e instanceof Error && /more than one project/i.test(e.message),
    'shared ownership would make routing depend on config order',
  );
  rmSync(f.dir, { recursive: true, force: true });
});

// ---------- resolveProject ----------

test('resolveProject picks the longest matching root so nested roots stay specific', () => {
  const f = fixture('nested', [
    { name: 'outer', rootRel: 'outer', mirror: true },
    { name: 'inner', rootRel: 'outer/inner', mirror: true },
  ]);
  const inner = resolveProject(f.registry, path.join(f.projects[1].root, 'docs', 'code-plan', 'plans', 'x.md'));
  assert.equal(inner.name, 'inner');
  const outer = resolveProject(f.registry, path.join(f.projects[0].root, 'docs', 'code-plan', 'plans', 'x.md'));
  assert.equal(outer.name, 'outer');
  cleanup(f);
});

test('resolveProject does not match a sibling root that merely shares a string prefix', () => {
  const f = fixture('prefix', [{ name: 'snip', rootRel: 'snip', mirror: true }]);
  const lookalike = path.join(f.base, 'snipset-2', 'docs', 'code-plan', 'plans', 'x.md');
  assert.throws(
    () => resolveProject(f.registry, lookalike),
    (e) => e instanceof Error && e.message.includes('snipset-2'),
    'a root must match on path segments, not on raw string prefixes',
  );
  cleanup(f);
});

test('resolveProject throws naming the plan path when no project matches', () => {
  const f = fixture('unknown', [{ name: 'snip', rootRel: 'snip', mirror: true }]);
  const orphan = path.join(f.base, 'elsewhere', 'docs', 'code-plan', 'plans', 'orphan.md');
  assert.throws(
    () => resolveProject(f.registry, orphan),
    (e) => e instanceof Error && e.message.includes(orphan),
    'error message must name the plan path that could not be routed',
  );
  cleanup(f);
});

test(
  'resolveProject routes a real repo plan to the vivera project',
  { skip: !REGISTRY_PRESENT ? REGISTRY_SKIP : selfProject ? false : `${rootDir} is not a registered project root in plans.publish.json` },
  () => {
    const registry = loadRegistry();
    const p = resolveProject(registry, path.join(rootDir, 'docs', 'code-plan', 'plans', '2026-09-26-plan-publish-to-obsidian.md'));
    assert.equal(p.name, 'vivera');
  },
);

test('resolveProject routes a worktree plan to the project that owns the worktree', () => {
  const f = fixture('wt-route', [
    { name: 'Snipset', rootRel: 'Snipset', mirror: true, plans: ['a.md'],
      worktrees: [{ rel: 'Snipset-seo', plans: ['branch-plan.md'] }] },
  ]);
  const inWorktree = path.join(f.projects[0].worktrees[0].root, 'docs', 'code-plan', 'plans', 'branch-plan.md');
  assert.equal(resolveProject(f.registry, inWorktree).name, 'Snipset');
  // The point of routing a worktree to its parent: the mirror lands in the one
  // folder, not in a second project built from the same repository.
  const dest = destPathFor(f.registry, resolveProject(f.registry, inWorktree), inWorktree);
  assert.ok(dest.includes('01 - Projects/Snipset/plans/'), `got ${dest}`);
  assert.ok(!dest.includes('Snipset-seo'), 'a worktree must not create its own vault project');
  cleanup(f);
});

test('resolveProject still prefers a longer registered root over a worktree claim', () => {
  const f = fixture('wt-nested', [
    { name: 'outer', rootRel: 'outer', mirror: true, worktrees: [{ rel: 'outer/wt' }] },
    { name: 'inner', rootRel: 'outer/wt/inner', mirror: true },
  ]);
  const plan = path.join(f.base, 'outer', 'wt', 'inner', 'docs', 'code-plan', 'plans', 'x.md');
  assert.equal(resolveProject(f.registry, plan).name, 'inner');
  cleanup(f);
});

withRegistry('resolveProject routes the real Snipset SEO worktree to Snipset, not to a second project', () => {
  const registry = loadRegistry();
  const wt = (registry.projects.find((p) => p.name === 'Snipset') ?? {}).worktrees;
  assert.ok(Array.isArray(wt) && wt.length > 0,
    'the SEO worktree must be registered as a worktree of Snipset');
  const plan = path.join(wt[0], 'docs', 'code-plan', 'plans', '2026-09-28-website-seo-page-audit-and-indexing.md');
  assert.equal(resolveProject(registry, plan).name, 'Snipset');
  // No project may be named after the worktree; that is the duplication.
  assert.equal(
    registry.projects.some((p) => /snipset-seo/i.test(p.name)),
    false,
    'a worktree must never be registered as its own project',
  );
});

// ---------- enumeratePlans ----------

test('enumeratePlans excludes a mirror:false project entirely', () => {
  const f = fixture('mirror', [
    { name: 'live', rootRel: 'live', mirror: true, plans: ['a.md', 'b.md'] },
    { name: 'already-in-vault', rootRel: 'vaultish', mirror: false, plans: ['c.md'] },
  ]);
  const found = enumeratePlans(f.registry);
  assert.deepEqual(found.map((p) => path.basename(p)).sort(), ['a.md', 'b.md'],
    'mirror:false plans must never be enumerated');
  assert.equal(
    found.every((p) => p.startsWith(f.projects[0].plansDir)),
    true,
    'only the mirror:true project may contribute plans',
  );
  cleanup(f);
});

test('enumeratePlans yields an empty list for a project with no plans directory', () => {
  const f = fixture('nodir', [{ name: 'empty', rootRel: 'empty', mirror: true }]);
  assert.deepEqual(enumeratePlans(f.registry), []);
  cleanup(f);
});

test('enumeratePlans ignores non-markdown files in the plans directory', () => {
  const f = fixture('nonmd', [{ name: 'p', rootRel: 'p', mirror: true, plans: ['real.md'] }]);
  writeFileSync(path.join(f.projects[0].plansDir, 'notes.txt'), 'ignore me', 'utf8');
  assert.deepEqual(enumeratePlans(f.registry).map((p) => path.basename(p)), ['real.md']);
  cleanup(f);
});

test('enumeratePlans never enumerates a worktree, so history is not mirrored twice', () => {
  const f = fixture('wt-enum', [
    { name: 'Snipset', rootRel: 'Snipset', mirror: true, plans: ['a.md', 'b.md'],
      worktrees: [{ rel: 'Snipset-seo', plans: ['a.md', 'b.md', 'branch-only.md'] }] },
  ]);
  const found = enumeratePlans(f.registry);
  assert.deepEqual(found.map((p) => path.basename(p)).sort(), ['a.md', 'b.md'],
    'a worktree carries the whole history, so enumerating it republishes every plan');
  assert.equal(
    found.some((p) => p.startsWith(f.projects[0].worktrees[0].root)),
    false,
    'no enumerated plan may come from a worktree directory',
  );
  assert.equal(
    found.some((p) => path.basename(p) === 'branch-only.md'),
    false,
    'a plan that exists only in the worktree is not enumerated either',
  );
  cleanup(f);
});

test(
  'enumeratePlans over the real registry returns each plan once',
  { skip: !REGISTRY_PRESENT ? REGISTRY_SKIP : realPlans.length ? false : 'no registered project root holds a plans directory on this host' },
  () => {
    const registry = loadRegistry();
    const found = enumeratePlans(registry);
    assert.equal(new Set(found).size, found.length, 'enumeration must not yield duplicates');
    const fromWorktrees = found.filter((p) => /Snipset-seo/.test(p));
    assert.deepEqual(fromWorktrees, [],
      'no registered worktree may contribute to enumeration');
  },
);

// ---------- destPathFor ----------

test('destPathFor places a plan under 01 - Projects/Snipset/plans/ inside the vault', () => {
  const f = fixture('dest', [{ name: 'Snipset', rootRel: 'Snipset', mirror: true }]);
  const plan = '/home/testuser/Proyek/Snipset/docs/code-plan/plans/2026-09-26-example.md';
  const dest = destPathFor(f.registry, { name: 'Snipset' }, plan);
  assert.ok(dest.includes('01 - Projects/Snipset/plans/'), `got ${dest}`);
  assert.equal(dest, path.join(VAULT, '01 - Projects', 'Snipset', 'plans', '2026-09-26-example.md'));
  assert.ok(dest.startsWith(`${VAULT}${path.sep}`), 'destination must stay inside the vault');
  cleanup(f);
});

withRegistry('destPathFor keeps the space in the vault path intact', () => {
  const registry = loadRegistry();
  const dest = destPathFor(registry, { name: 'ram-audit' }, '/home/testuser/ram-audit/docs/code-plan/plans/p.md');
  assert.equal(dest.includes('Obsidian Vault'), true);
  assert.equal(dest, `${VAULT}/01 - Projects/ram-audit/plans/p.md`);
});
