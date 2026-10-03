// scripts/skipif-registry-audit.test.mjs
//
// Guards for the skip_if registry audit.
//
// The audit is the command that answers "which plans would a classifier change
// break", so the thing worth protecting is not its arithmetic — it is its
// SOURCES. Two failure modes are silently harmless and fatally misleading:
//
//   * A second directory walk. If the audit decided for itself what a plan is,
//     it would disagree with plan-publish-registry.mjs the first time a project
//     turned mirror:false or moved its plans tree, and the disagreement would
//     look like a change in the work. So the registry module is imported, and
//     this file's fixtures go through it rather than around it.
//   * A hardcoded diff. If `affected` were computed by comparing two literal
//     lists of known-bad commands, it would keep reporting the same 44 rows
//     forever and would find nothing the day a new one appeared. So the
//     classifier is INJECTED and the same traversal runs twice; test 3 is the
//     one that proves the injection actually drives the answer.
//
// Every fixture is a throwaway registry under tmpdir, reached through the
// documented PLAN_PUBLISH_CONFIG seam, exactly as plan-lifecycle-audit.mjs
// documents it. Nothing here reads the real vault, and nothing here writes
// outside tmpdir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditRegistry,
  renderReport,
  selectRows,
  CLASS_ORDER,
  CLASS_LABELS,
} from './skipif-registry-audit.mjs';
import { classifySpikeSkipIf } from './spike-skipif-classifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'skipif-registry-audit.mjs');

// The vault root recorded in fixture registries. The audit never opens it (see
// the header), so any absolute path works; joined to the machine home so this
// file runs unchanged on any checkout.
const VAULT = path.join(homedir(), 'Dokumen/Obsidian Vault');

// ---------- fixtures ----------

function planWith(skipIfs) {
  const steps = skipIfs
    .map(([id, skipIf]) => [
      `  - id: ${id}`,
      `    depends_on: []`,
      `    skip_if: "${skipIf}"`,
      `    run:`,
      `      - cmd: "echo ${id}"`,
      `        expect_exit: 0`,
    ].join('\n'))
    .join('\n');
  return [
    '---',
    'schema: ultra-plan/v1',
    'plan_id: fixture',
    'status: Draft',
    'version: 1',
    'tasks:',
    steps,
    '---',
    '',
    '# fixture',
    '',
  ].join('\n');
}

function barePlan() {
  return '# a plan with no frontmatter at all\n\nprose only\n';
}

function unterminatedFencePlan() {
  return '---\nschema: ultra-plan/v1\ntasks:\n  - id: T1\n\n# the closing fence is missing\n';
}

// spec: { [projectName]: { plans: { [filename]: contents } } }
function fixture(tag, spec) {
  const base = mkdtempSync(path.join(tmpdir(), `skipif-audit-${tag}-`));
  const projects = [];
  for (const [name, { plans }] of Object.entries(spec)) {
    const root = path.join(base, name);
    const dir = path.join(root, 'docs', 'code-plan', 'plans');
    mkdirSync(dir, { recursive: true });
    for (const [file, body] of Object.entries(plans)) writeFileSync(path.join(dir, file), body, 'utf8');
    projects.push({ name, root });
  }
  return {
    base,
    registry: {
      vault: VAULT,
      destDirTemplate: '01 - Projects/{project}/plans',
      projects: projects.map(({ name, root }) => ({ name, root, mirror: true })),
    },
  };
}

const cleanup = (f) => rmSync(f.base, { recursive: true, force: true });

// A five-plan fixture reused by most tests:
//   alpha  behavioural + sentinel + loose
//   beta   loose + unknown
//   gamma  no frontmatter at all
//   delta  unterminated frontmatter fence
const MIXED = {
  alpha: { plans: { '2026-01-01-alpha.md': planWith([['T1', 'bun test scripts/'], ['T2', 'false'], ['T3', "grep -q 'x' f.ts"]]) } },
  beta: { plans: { '2026-01-02-beta.md': planWith([['T4', 'cat notes.md'], ['T5', 'pacman -Q rtkit >/dev/null 2>&1']]) } },
  gamma: { plans: { '2026-01-03-gamma.md': barePlan() } },
  delta: { plans: { '2026-01-04-delta.md': unterminatedFencePlan() } },
};

// ---------- 1. the tally ----------

test('auditRegistry tallies every skip_if under the injected classifier', () => {
  const f = fixture('tally', MIXED);
  try {
    const a = auditRegistry(f.registry);
    assert.equal(a.plans, 4);
    assert.equal(a.withFrontmatter, 2);
    assert.equal(a.skipIfTotal, 5);
    assert.deepEqual(a.tally, {
      empty: 0,
      sentinel: 1,
      behavioural: 1,
      loose: 2,
      unknown: 1,
    });
    // The five keys are always all present, in the classifier's own resolution
    // order, so a diff between two runs shows a class dropping to 0 rather than
    // vanishing from the object.
    assert.deepEqual(Object.keys(a.tally), CLASS_ORDER);
  } finally {
    cleanup(f);
  }
});

test('byProject attributes plans, skip_if values and classes to the owning project', () => {
  const f = fixture('byproject', MIXED);
  try {
    const a = auditRegistry(f.registry);
    assert.deepEqual(Object.keys(a.byProject).sort(), ['alpha', 'beta', 'delta', 'gamma']);
    assert.equal(a.byProject.alpha.plans, 1);
    assert.equal(a.byProject.alpha.skipIf, 3);
    assert.equal(a.byProject.alpha.tally.behavioural, 1);
    assert.equal(a.byProject.alpha.tally.sentinel, 1);
    assert.equal(a.byProject.beta.tally.loose, 1);
    assert.equal(a.byProject.beta.tally.unknown, 1);
    // Projects add up to the totals, or the byProject table is a different
    // measurement wearing the same report.
    const totalSkipIf = Object.values(a.byProject).reduce((n, p) => n + p.skipIf, 0);
    assert.equal(totalSkipIf, a.skipIfTotal);
    const totalPlans = Object.values(a.byProject).reduce((n, p) => n + p.plans, 0);
    assert.equal(totalPlans, a.plans);
  } finally {
    cleanup(f);
  }
});

test('every tally row sums to skipIfTotal, and unknown rows are named', () => {
  const f = fixture('rows', MIXED);
  try {
    const a = auditRegistry(f.registry);
    const summed = CLASS_ORDER.reduce((n, c) => n + a.tally[c], 0);
    assert.equal(summed, a.skipIfTotal, 'a class was counted that the row list does not contain');
    const unknown = a.rows.filter((r) => r.class === 'unknown');
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].taskId, 'T5');
    assert.equal(unknown[0].project, 'beta');
    assert.equal(unknown[0].plan, '2026-01-02-beta.md');
    assert.equal(unknown[0].cmd, 'pacman -Q rtkit >/dev/null 2>&1');
  } finally {
    cleanup(f);
  }
});

// ---------- 2. the noFrontmatter bucket ----------

test('a plan with no frontmatter is counted separately, not silently skipped', () => {
  const f = fixture('nofm', MIXED);
  try {
    const a = auditRegistry(f.registry);
    assert.equal(a.plans, 4, 'the bare plan is still a plan');
    assert.equal(a.noFrontmatter, 1);
    assert.equal(a.withFrontmatter, 2);
    assert.deepEqual(a.noFrontmatterPlans.map((p) => p.plan), ['2026-01-03-gamma.md']);
    // Crucially: it contributes nothing to the tally and nothing to affected.
    // Folding it into `withFrontmatter` would be a claim this file cannot make.
    assert.equal(a.skipIfTotal, 5);
    assert.equal(a.rows.some((r) => r.plan === '2026-01-03-gamma.md'), false);
    assert.equal(a.affected.some((r) => r.plan === '2026-01-03-gamma.md'), false);
  } finally {
    cleanup(f);
  }
});

// ---------- 3. the injection point ----------

test('affected reports before/after when a candidate classifier is injected', () => {
  const f = fixture('affected', MIXED);
  try {
    // Frozen spike classifier as BEFORE, live as AFTER. The sentinel and the
    // unknown both used to be `behavioural`, so both are regressions.
    const a = auditRegistry(f.registry, { compareTo: classifySpikeSkipIf });
    assert.equal(a.affected.length, 2);
    const byId = Object.fromEntries(a.affected.map((r) => [r.taskId, r]));
    assert.deepEqual(byId.T2, {
      plan: '2026-01-01-alpha.md',
      project: 'alpha',
      taskId: 'T2',
      cmd: 'false',
      before: 'behavioural',
      after: 'sentinel',
    });
    assert.deepEqual(byId.T5, {
      plan: '2026-01-02-beta.md',
      project: 'beta',
      taskId: 'T5',
      cmd: 'pacman -Q rtkit >/dev/null 2>&1',
      before: 'behavioural',
      after: 'unknown',
    });
    // T1 (behavioural under both) and T4 (loose under both) are untouched, and
    // their absence is the assertion that the diff is not "every row".
    assert.deepEqual(Object.keys(byId).sort(), ['T2', 'T5']);
    assert.equal(a.classifiers.after, 'classifySkipIf');
    assert.equal(a.classifiers.before, 'the injected candidate');
  } finally {
    cleanup(f);
  }
});

test('affected is empty, not absent, when no candidate is injected', () => {
  const f = fixture('noaffected', MIXED);
  try {
    const a = auditRegistry(f.registry);
    assert.deepEqual(a.affected, []);
    assert.equal(a.classifiers.before, null);
  } finally {
    cleanup(f);
  }
});

test('a candidate classifier can flip a verdict the other way, and both directions are recorded', () => {
  const f = fixture('swap', {
    alpha: { plans: { '2026-01-01-alpha.md': planWith([['T1', 'bun test scripts/'], ['T2', 'false']]) } },
  });
  try {
    // classify = frozen, compareTo = live. Now `false` is the one that moved,
    // and the direction is the mirror image of test 3.
    const a = auditRegistry(f.registry, { classify: classifySpikeSkipIf, compareTo: (c) => (c === 'false' ? 'sentinel' : 'behavioural') });
    assert.equal(a.affected.length, 1);
    assert.equal(a.affected[0].taskId, 'T2');
    assert.equal(a.affected[0].before, 'sentinel');
    assert.equal(a.affected[0].after, 'behavioural');
    assert.equal(a.classifiers.after, 'the injected classifier');
  } finally {
    cleanup(f);
  }
});

// ---------- 4. one broken file must not zero the report ----------

test('malformed frontmatter is counted and named; the rest of the audit survives', () => {
  const f = fixture('malformed', MIXED);
  try {
    const a = auditRegistry(f.registry);
    assert.equal(a.plans, 4);
    assert.equal(a.malformed, 1);
    assert.equal(a.noFrontmatter, 1);
    assert.equal(a.withFrontmatter, 2);
    assert.deepEqual(a.malformedPlans.map((p) => p.plan), ['2026-01-04-delta.md']);
    assert.match(a.malformedPlans[0].error, /[Uu]nterminated frontmatter/);
    // The five good skip_if values are still tallied: one broken file must not
    // take the report to zero, which would read as "nothing to fix".
    assert.equal(a.skipIfTotal, 5);
    assert.equal(a.tally.behavioural, 1);
  } finally {
    cleanup(f);
  }
});

test('an unreadable plan is its own bucket too, not folded into noFrontmatter', () => {
  const f = fixture('unreadable', {
    alpha: { plans: { '2026-01-01-alpha.md': planWith([['T1', 'bun test scripts/']]) } },
  });
  try {
    const a = auditRegistry(f.registry, { readFile: () => { throw new Error('EACCES: permission denied'); } });
    assert.equal(a.plans, 1);
    assert.equal(a.unreadable, 1);
    assert.equal(a.noFrontmatter, 0, 'claiming "no frontmatter" about a file nobody read would be a guess');
    assert.equal(a.withFrontmatter, 0);
    assert.equal(a.skipIfTotal, 0);
    assert.equal(a.unreadablePlans.length, 1);
    assert.match(a.unreadablePlans[0].error, /EACCES/);
  } finally {
    cleanup(f);
  }
});

// ---------- 5. the CLI ----------

test('the CLI writes valid JSON under --json and exits 0', () => {
  const f = fixture('cli', MIXED);
  try {
    const cfg = path.join(f.base, 'plans.publish.json');
    writeFileSync(cfg, JSON.stringify(f.registry, null, 2), 'utf8');
    const r = spawnSync('bun', [CLI, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, PLAN_PUBLISH_CONFIG: cfg },
    });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const data = JSON.parse(r.stdout);
    assert.equal(data.plans, 4);
    assert.equal(data.withFrontmatter, 2);
    assert.equal(data.skipIfTotal, 5);
    assert.equal(data.tally.unknown, 1);
    assert.equal(data.config, cfg, 'the JSON must record WHICH registry it measured');
    // The human view and the JSON are two renderings of one measurement; the
    // same numbers must come out of both.
    const text = renderReport(data);
    assert.match(text, /plans enumerated/);
    assert.match(text, /unknown/);
  } finally {
    cleanup(f);
  }
});

test('the CLI --compare-to-frozen names the frozen classifier and finds differences', () => {
  const f = fixture('cli-frozen', MIXED);
  try {
    const cfg = path.join(f.base, 'plans.publish.json');
    writeFileSync(cfg, JSON.stringify(f.registry, null, 2), 'utf8');
    const r = spawnSync('bun', [CLI, '--json', '--compare-to-frozen'], {
      encoding: 'utf8',
      env: { ...process.env, PLAN_PUBLISH_CONFIG: cfg },
    });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const data = JSON.parse(r.stdout);
    assert.equal(data.classifiers.before, 'classifySpikeSkipIf (frozen 2026-09-30)');
    assert.equal(data.affected.length, 2);
  } finally {
    cleanup(f);
  }
});

test('the CLI --class filter locates rows by class, and --grep locates them by command', () => {
  const f = fixture('cli-class', MIXED);
  try {
    const cfg = path.join(f.base, 'plans.publish.json');
    writeFileSync(cfg, JSON.stringify(f.registry, null, 2), 'utf8');
    const byClass = spawnSync('bun', [CLI, '--json', '--class', 'unknown'], {
      encoding: 'utf8', env: { ...process.env, PLAN_PUBLISH_CONFIG: cfg },
    });
    assert.equal(byClass.status, 0);
    assert.deepEqual(JSON.parse(byClass.stdout).rows.map((r) => r.taskId), ['T5']);

    const byGrep = spawnSync('bun', [CLI, '--json', '--grep', 'pacman'], {
      encoding: 'utf8', env: { ...process.env, PLAN_PUBLISH_CONFIG: cfg },
    });
    assert.equal(byGrep.status, 0);
    assert.deepEqual(JSON.parse(byGrep.stdout).rows.map((r) => r.taskId), ['T5']);
  } finally {
    cleanup(f);
  }
});

test('the CLI rejects an unknown class name instead of printing an empty table', () => {
  const f = fixture('cli-bad', MIXED);
  try {
    const cfg = path.join(f.base, 'plans.publish.json');
    writeFileSync(cfg, JSON.stringify(f.registry, null, 2), 'utf8');
    const r = spawnSync('bun', [CLI, '--json', '--class', 'behavioural-ish'], {
      encoding: 'utf8', env: { ...process.env, PLAN_PUBLISH_CONFIG: cfg },
    });
    assert.notEqual(r.status, 0, 'a typo in a query must not read as "no rows"');
    assert.match(r.stderr, /behavioural-ish/);
  } finally {
    cleanup(f);
  }
});

// ---------- selectRows: the query T5 will re-run ----------

test('selectRows filters on class, command substring and project together', () => {
  const rows = [
    { plan: 'a.md', project: 'alpha', taskId: 'T1', cmd: 'bun test x', class: 'behavioural' },
    { plan: 'b.md', project: 'beta', taskId: 'T2', cmd: "tgrep -q 'x' f.ts", class: 'unknown' },
    { plan: 'c.md', project: 'beta', taskId: 'T3', cmd: 'grep -q y g.md', class: 'loose' },
  ];
  assert.deepEqual(selectRows(rows, { cls: 'unknown' }).map((r) => r.taskId), ['T2']);
  assert.deepEqual(selectRows(rows, { grep: 'grep' }).map((r) => r.taskId), ['T2', 'T3']);
  assert.deepEqual(selectRows(rows, { project: 'beta' }).map((r) => r.taskId), ['T2', 'T3']);
  assert.deepEqual(selectRows(rows, { cls: 'unknown', project: 'alpha' }), []);
  assert.equal(rows.length, 3, 'selectRows must not mutate its input');
});

test('CLASS_LABELS explains every class the classifier can return', () => {
  for (const c of CLASS_ORDER) assert.ok(CLASS_LABELS[c], `no label for class ${c}`);
});
