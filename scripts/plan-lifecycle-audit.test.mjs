// scripts/plan-lifecycle-audit.test.mjs
//
// Guards for the plan lifecycle audit. The audit exists because `status: Draft`
// in a vault mirror has TWO origins that mean opposite things:
//
//   * the plan file has no frontmatter at all, so the publisher fell back to a
//     default (`verbatimStatus ?? 'status: Draft'` in plan-publish-frontmatter.mjs),
//     and the mirror is reporting that the plan has never been in a lifecycle at
//     all — it says NOTHING about the work;
//   * the plan file declares `status: Draft`, which is a real claim and may be a
//     stale one.
//
// A report that conflates them produces a number nobody can act on, and a
// backfill built on that number would be fabrication rather than maintenance. So
// the three buckets are the contract under test here, not the arithmetic.
//
// Every fixture is a throwaway registry under the system temp dir. Nothing in
// this file reads or writes ~/Dokumen/Obsidian Vault, and
// nothing depends on whether the real project checkouts exist on the machine
// running it.
//
// Namespace import, not a named one, for the same reason plan-publish.test.mjs
// uses one: a named import of a symbol that does not exist is a module LINK
// error, which aborts the whole file before a single test runs. With a namespace
// the file loads and every assertion below reports its own failure, which is
// what a red run is for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as audit from './plan-lifecycle-audit.mjs';
// The registry module is imported here rather than in the module under test, so
// the test can build the SAME registry object the CLI builds and hand it to
// auditPlans() in-process. If auditPlans() grew its own directory walk instead of
// calling enumeratePlans(), these tests would still pass — which is exactly why
// the CLI tests below go through PLAN_PUBLISH_CONFIG as well.
import { loadRegistry } from './plan-publish-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'plan-lifecycle-audit.mjs');

// ---------- fixtures ----------

// A registry of one mirror:true project, entirely under a temp dir. `plans` maps
// a filename to its exact file text, so a test can spell out whether a plan
// opens with a frontmatter fence, and whether it declares a status.
function fixture(tag, plans) {
  const base = mkdtempSync(path.join(tmpdir(), `plan-audit-${tag}-`));
  const vault = path.join(base, 'vault');
  const root = path.join(base, 'proj');
  const plansDir = path.join(root, 'docs', 'code-plan', 'plans');
  mkdirSync(vault, { recursive: true });
  mkdirSync(plansDir, { recursive: true });
  for (const [name, text] of Object.entries(plans)) {
    writeFileSync(path.join(plansDir, name), text, 'utf8');
  }
  const config = path.join(base, 'plans.publish.json');
  writeFileSync(config, JSON.stringify({
    vault,
    destDirTemplate: '01 - Projects/{project}/plans',
    stageInVault: false,
    projects: [{ name: 'demo', root, mirror: true }],
  }, null, 2), 'utf8');
  return {
    base, vault, root, plansDir, config,
    write(name, text) {
      writeFileSync(path.join(plansDir, name), text, 'utf8');
    },
    cleanup() { rmSync(base, { recursive: true, force: true }); },
  };
}

function run(args, f, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PLAN_PUBLISH_CONFIG: f.config, ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------- classify: one plan, in isolation ----------

test('classifyPlan buckets a plan with no frontmatter as untracked', () => {
  const c = audit.classifyPlan('# Just a plan\n\nNo frontmatter at all.\n');
  assert.equal(c.bucket, 'untracked', 'a body with no leading --- fence is untracked');
  assert.equal(c.declaresFrontmatter, false);
  // An untracked plan has no status of its own to read. Reporting a value here
  // is the exact conflation this script exists to prevent.
  assert.equal(c.statusValue, null);
  assert.equal(c.statusLine, null);
  assert.equal(c.status, null);
});

test('classifyPlan buckets a plan that declares a status as tracked, verbatim', () => {
  const c = audit.classifyPlan('---\nschema: ultra-plan/v1\nstatus: Verification\n---\n\n# Plan\n');
  assert.equal(c.bucket, 'tracked');
  assert.equal(c.declaresFrontmatter, true);
  assert.equal(c.statusValue, 'Verification');
  assert.equal(c.status, 'Verification');
  // The LINE is kept whole. The publisher copies the source's status line
  // verbatim, so the audit quoting it back is what lets a human diff a claim
  // against the file it came from.
  assert.equal(c.statusLine, 'status: Verification');
});

test('classifyPlan puts frontmatter-without-status in its own bucket, not in either of the others', () => {
  const c = audit.classifyPlan('---\nschema: ultra-plan/v1\nrunner_contract: true\n---\n\n# Plan\n');
  assert.equal(c.bucket, 'tracked-no-status', 'a fence with no status: line is a third case');
  assert.equal(c.declaresFrontmatter, true);
  assert.equal(c.status, null);
  // It must not be folded into `untracked`: that bucket means the publisher
  // invented a default, and this file is not what produced the mirror's status.
  assert.notEqual(c.bucket, 'untracked');
  assert.notEqual(c.bucket, 'tracked');
});

test('classifyPlan strips a trailing # comment from the status for grouping only', () => {
  const c = audit.classifyPlan('---\nstatus: Draft   # published at Draft on purpose\n---\n\n# Plan\n');
  assert.equal(c.bucket, 'tracked');
  // Grouping key: the comment is NOT part of the status, so a plan annotated
  // with a comment counts in the same Draft row as an uncommented one.
  assert.equal(c.status, 'Draft');
  // Verbatim value: the comment IS part of the source line and is preserved,
  // because the whole line is what the publisher copies through.
  assert.equal(c.statusValue, 'Draft   # published at Draft on purpose');
  assert.equal(c.statusLine, 'status: Draft   # published at Draft on purpose');
});

test('classifyPlan only reads a status line inside the frontmatter fence', () => {
  // A `status:` in the BODY is prose, not frontmatter. Reading it would invent a
  // lifecycle claim for a plan that declares none.
  const c = audit.classifyPlan('---\nschema: ultra-plan/v1\n---\n\n# Plan\n\nstatus: Complete\n');
  assert.equal(c.bucket, 'tracked-no-status');
  assert.equal(c.status, null);
});

test('classifyPlan does not treat a horizontal rule later in the file as a fence', () => {
  const c = audit.classifyPlan('# Plan\n\nsome text\n\n---\n\nmore text\n');
  assert.equal(c.declaresFrontmatter, false, 'only the FIRST line can open a fence');
  assert.equal(c.bucket, 'untracked');
});

test('classifyPlan reads a status out of a frontmatter fence that is never closed', () => {
  // A plan with broken frontmatter is still a plan that has to be counted, and
  // silently reporting it as untracked would be inventing a cause for it.
  const c = audit.classifyPlan('---\nschema: ultra-plan/v1\nstatus: Open\n\n# Plan\n');
  assert.equal(c.bucket, 'tracked');
  assert.equal(c.status, 'Open');
});

// ---------- aggregate: the whole registry ----------

const MIXED = {
  // no frontmatter at all
  '2026-01-01-a.md': '# A\n\nno frontmatter\n',
  '2026-01-02-b.md': '# B\n\nalso none\n',
  // frontmatter + status
  '2026-01-03-c.md': '---\nschema: ultra-plan/v1\nstatus: Complete\n---\n\n# C\n',
  '2026-01-04-d.md': '---\nschema: ultra-plan/v1\nstatus: Draft  # not measured yet\n---\n\n# D\n',
  '2026-01-05-e.md': '---\nschema: ultra-plan/v1\nstatus: Draft\n---\n\n# E\n',
  // frontmatter, NO status
  '2026-01-06-f.md': '---\nschema: ultra-plan/v1\n---\n\n# F\n',
};

test('audit splits the registry into untracked, tracked and tracked-no-status, and the three sum to the total', () => {
  const f = fixture('split', MIXED);
  const r = audit.auditPlans(loadRegistry(f.config));
  assert.equal(r.total, 6);
  assert.equal(r.untracked, 2);
  assert.equal(r.tracked, 3);
  assert.equal(r.trackedNoStatus, 1);
  assert.equal(
    r.untracked + r.trackedNoStatus + r.tracked,
    r.total,
    'every enumerated plan must land in exactly one bucket, or the tally lies',
  );
  f.cleanup();
});

test('audit groups the tracked plans by status, with the comment stripped', () => {
  const f = fixture('group', MIXED);
  const r = audit.auditPlans(loadRegistry(f.config));
  assert.deepEqual(r.byStatus, { Complete: 1, Draft: 2 },
    'both Draft plans — annotated and bare — must count in one Draft row');
  f.cleanup();
});

test('audit records the verbatim status line of every tracked plan, for a human to check', () => {
  const f = fixture('verbatim', MIXED);
  const r = audit.auditPlans(loadRegistry(f.config));
  const d = r.trackedPlans.find((p) => path.basename(p.path) === '2026-01-04-d.md');
  assert.equal(d.statusLine, 'status: Draft  # not measured yet');
  assert.equal(d.status, 'Draft');
  assert.equal(d.project, 'demo');
  f.cleanup();
});

// ---------- CLI ----------

test('the CLI prints both bucket labels, a per-status breakdown, and exits 0', () => {
  const f = fixture('cli', MIXED);
  const r = run([], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  // skip_if for T5 greps for this exact token.
  assert.ok(r.stdout.includes('untracked (no frontmatter)'), `stdout: ${r.stdout}`);
  assert.ok(r.stdout.includes('tracked (declares status)'), `stdout: ${r.stdout}`);
  assert.ok(/tracked, frontmatter but NO status line:\s*1/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(/Complete\s+1/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(/Draft\s+2/.test(r.stdout), `stdout: ${r.stdout}`);
  f.cleanup();
});

test('the CLI says in words that an untracked mirror status is a publisher fallback, not a claim', () => {
  const f = fixture('wording', MIXED);
  const r = run([], f);
  const lower = r.stdout.toLowerCase();
  assert.ok(lower.includes('fallback'), `the report must name the fallback:\n${r.stdout}`);
  assert.ok(lower.includes('says nothing about the work'),
    `the report must state that the value says nothing about the work:\n${r.stdout}`);
  f.cleanup();
});

test('the CLI calls out a non-zero tracked-but-no-status count as its own case and names the plans', () => {
  const f = fixture('callout', MIXED);
  const r = run([], f);
  // The figure must be labelled as a distinct case rather than implied by the
  // arithmetic: someone reading only the two bucket lines would otherwise add
  // tracked+untracked to the total and get the right answer by accident.
  assert.ok(/NOT the expected/.test(r.stdout),
    `a non-zero third bucket must be called out as a departure:\n${r.stdout}`);
  assert.ok(r.stdout.includes('2026-01-06-f.md'),
    `the report must name the plans in that bucket:\n${r.stdout}`);
  f.cleanup();
});

test('the CLI reports the expected zero of the third bucket without inventing a callout', () => {
  const f = fixture('third-zero', {
    '2026-01-01-a.md': '# A\n\nno frontmatter\n',
    '2026-01-02-b.md': '---\nschema: ultra-plan/v1\nstatus: Complete\n---\n\n# B\n',
  });
  const r = run([], f);
  assert.ok(/tracked, frontmatter but NO status line: 0/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(/is the expected/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(!/NOT the expected/.test(r.stdout), 'a zero must not be dressed up as a finding');
  f.cleanup();
});

test('the CLI exits 0 on an empty registry instead of treating it as an error', () => {
  const f = fixture('empty', {});
  const r = run([], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(/0 total|total plans: 0/.test(r.stdout), `stdout: ${r.stdout}`);
  f.cleanup();
});

test('the CLI exits 0 even when the registry cannot be loaded, because it is a report and never a gate', () => {
  const f = fixture('badcfg', MIXED);
  const r = run([], f, { PLAN_PUBLISH_CONFIG: path.join(f.base, 'nope.json') });
  assert.equal(r.code, 0, `a missing config is a fact about the world, not a failure:\n${r.stdout}\n${r.stderr}`);
  assert.ok(/nope\.json/.test(`${r.stdout}${r.stderr}`), 'the error must name the path that failed');
  f.cleanup();
});

test('the CLI exits 0 on a plan whose text is unreadable garbage rather than dropping it', () => {
  const f = fixture('garbage', MIXED);
  f.write('2026-01-07-g.md', 'not markdown at all, no fence, no heading\n');
  const r = run([], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(/total plans: 7/.test(r.stdout), `stdout: ${r.stdout}`);
  assert.ok(/untracked \(no frontmatter\): 3/.test(r.stdout), `stdout: ${r.stdout}`);
  f.cleanup();
});

test('--json emits the same numbers as the text report', () => {
  const f = fixture('json', MIXED);
  const r = run(['--json'], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const data = JSON.parse(r.stdout);
  assert.equal(data.total, 6);
  assert.equal(data.untracked, 2);
  assert.equal(data.tracked, 3);
  assert.equal(data.trackedNoStatus, 1);
  assert.deepEqual(data.byStatus, { Complete: 1, Draft: 2 });
  assert.ok(data.config.endsWith('plans.publish.json'), 'the JSON must name the registry it measured');
  // T6 quotes the nine explicit Draft plans by source path, so the paths have to
  // be in the JSON and not only implied by the text table.
  const drafts = data.trackedPlans.filter((p) => p.status === 'Draft').map((p) => path.basename(p.path)).sort();
  assert.deepEqual(drafts, ['2026-01-04-d.md', '2026-01-05-e.md']);
  f.cleanup();
});

test('--help exits 0 and documents the flags', () => {
  const f = fixture('help', MIXED);
  const r = run(['--help'], f);
  assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(r.stdout.includes('--json'), `stdout: ${r.stdout}`);
  f.cleanup();
});

test('the CLI never reads the real vault: it runs entirely off PLAN_PUBLISH_CONFIG', () => {
  // The fake registry's vault is a temp dir. If the audit ignored
  // PLAN_PUBLISH_CONFIG it would have measured the real 271 plans and these
  // numbers would be 6 in name only.
  const f = fixture('injection', MIXED);
  const r = run([], f);
  assert.ok(r.stdout.includes(f.vault), `the report must name the vault it read from:\n${r.stdout}`);
  assert.ok(!r.stdout.includes(path.join(homedir(), 'Dokumen/Obsidian Vault')),
    'the report must come from the injected config, not the real registry');
  f.cleanup();
});


// ---------- --stale-status: Draft claims that look finished ----------
//
// Why this exists. `status: Draft` in a mirror is a real claim for the plans
// that declare it, and a claim can go stale: a plan whose work is finished but
// which was never closed leaves the vault saying `Draft` indefinitely. This
// vault has no Dataview, so there is no board that would surface that, and
// re-reading 272 mirrors by hand is how it stays unnoticed. This finds the
// CANDIDATES. It never decides they are finished — the verdict is the reader's.
//
// THREE SIGNALS, deliberately of different strength, because they are not the
// same claim and must not be printed as if they were:
//
//   CONTRADICTED  the plan's own body records Complete while its frontmatter
//                 says Draft. Nothing is inferred: the file disagrees with itself.
//   FULLY-TICKED  every step checkbox inside every `### Task <id>` section is
//                 ticked, and there is at least one. A fact about the file.
//   STALE-BY-AGE  frontmatter says Draft and the plan has not changed for N
//                 days. The weakest, and labelled so: an abandoned draft and a
//                 finished one are indistinguishable from here.
//
// Step checkboxes are counted ONLY inside a `### Task <id>` section — the same
// scoping rule plan-mark-done.mjs uses, and for the same reason: the acceptance
// list in section 1 and the approval gate in section 7 are not steps, and
// counting them would let a plan look finished because somebody ticked a box
// that was never a step.

const STEP_LINE_RE = /^[ \t]*-[ \t]*\[([ xX])\]/;
const TASK_HEADING_RE = /^#{2,4}[ \t]+Task[ \t]+(\S+?)[ \t]*[:—-]?[ \t]*(.*)$/;
const ANY_HEADING_RE = /^#{1,6}[ \t]+/;

function draftPlan({ status = 'Draft', steps, tail = [] }) {
  return [
    '---', 'schema: ultra-plan/v1', `status: ${status}`, '---', '',
    '# A plan', '',
    '## 1. Intent & Scope', '- [x] AC-1: an acceptance criterion, not a step', '',
    '### Task T1: Something', ...steps, '',
    '## 7. Human Approval Gate', '- [x] approved by a human, also not a step', '',
    ...tail,
  ].join('\n');
}

// Counts the step checkboxes inside `### Task <id>` sections only, reusing the
// same heading rule the implementation must use. Returns null when the plan has
// no task section at all, which is a different thing from having zero steps.
function countSteps(text) {
  const lines = text.split('\n');
  let inTask = false;
  let ticked = 0;
  let unticked = 0;
  for (const line of lines) {
    if (TASK_HEADING_RE.test(line)) { inTask = true; continue; }
    if (ANY_HEADING_RE.test(line)) { inTask = false; continue; }
    if (!inTask) continue;
    const m = STEP_LINE_RE.exec(line);
    if (!m) continue;
    if (m[1] === ' ') unticked++; else ticked++;
  }
  return { ticked, unticked, hasTaskSection: ticked + unticked > 0 };
}

test('flags a plan whose own body contradicts its Draft frontmatter', () => {
  const f = fixture('contradicted', {
    'a.md': draftPlan({
      steps: ['- [x] Step one'],
      tail: ['## 8. Task State', '', '- **Status:** Complete', ''],
    }),
  });
  try {
    const { candidates } = audit.auditPlans(loadRegistry(f.config));
    const c = candidates.find((x) => x.planPath.endsWith('a.md'));
    assert.ok(c, `expected a candidate:\n${JSON.stringify(candidates, null, 2)}`);
    assert.ok(c.signals.includes('CONTRADICTED'), `expected CONTRADICTED, got ${c.signals}`);
    assert.ok(c.signals.includes('FULLY-TICKED'), `expected FULLY-TICKED, got ${c.signals}`);
    assert.equal(c.untickedSteps, 0);
    assert.equal(c.tickedSteps, 1);
  } finally { f.cleanup(); }
});

test('does not flag a fully ticked plan that already says Complete', () => {
  const f = fixture('already-complete', {
    'b.md': draftPlan({
      status: 'Complete',
      steps: ['- [x] Step one'],
      tail: ['## 8. Task State', '', '- **Status:** Complete', ''],
    }),
  });
  try {
    const { candidates } = audit.auditPlans(loadRegistry(f.config));
    assert.ok(!candidates.some((x) => x.planPath.endsWith('b.md')),
      `a closed plan is not a stale claim:\n${JSON.stringify(candidates, null, 2)}`);
  } finally { f.cleanup(); }
});

test('an untouched Draft plan is a candidate by age only, never by ticks', () => {
  const f = fixture('untouched-draft', { 'c.md': draftPlan({ steps: ['- [ ] Step one', '- [ ] Step two'] }) });
  try {
    const { candidates } = audit.auditPlans(loadRegistry(f.config));
    const c = candidates.find((x) => x.planPath.endsWith('c.md'));
    assert.ok(!c || !c.signals.includes('FULLY-TICKED'),
      'zero ticked steps is not FULLY-TICKED');
    assert.ok(!c || !c.signals.includes('CONTRADICTED'),
      'a silent body is not CONTRADICTED');
    if (c) assert.equal(c.untickedSteps, 2, 'the report must carry the number a judge needs');
  } finally { f.cleanup(); }
});

test('ticked acceptance criteria and a ticked approval box never look like finished work', () => {
  // The counting is asserted against the PURE function, not against the
  // candidate list. A plan whose only unticked line is a real step fires no
  // signal at all, so it is not a candidate and reading `untickedSteps` off a
  // candidate would be reading a `undefined`. The two facts are separate: the
  // pure function reports the counts, the audit decides candidacy.
  const text = draftPlan({ steps: ['- [ ] Step one'] });
  const v = audit.staleStatusCandidates(text, { mtimeMs: Date.now() });
  assert.equal(v.untickedSteps, 1,
    'only the in-task line is a step; the ticked AC-1 and the ticked approval box are not');
  assert.equal(v.tickedSteps, 0, 'the AC and approval checkboxes are not counted as steps either');
  assert.ok(!v.signals.includes('FULLY-TICKED'),
    'a plan with an unticked step is not finished, whatever else is ticked');

  const f = fixture('ac-checklists', { 'd.md': text });
  try {
    const { candidates } = audit.auditPlans(loadRegistry(f.config));
    assert.ok(!candidates.some((x) => x.planPath.endsWith('d.md')),
      `and at the audit level it is not even a candidate:\n${JSON.stringify(candidates, null, 2)}`);
  } finally { f.cleanup(); }
});

test('a plan with no task section is never FULLY-TICKED', () => {
  // Vacuous truth is the trap here: "every step is ticked" is true of a plan
  // with zero steps, and a report that said so would light up every prose-only
  // plan in the registry.
  const f = fixture('no-tasks', {
    'e.md': '---\nschema: ultra-plan/v1\nstatus: Draft\n---\n\n# Prose only\n\nJust words.\n',
  });
  try {
    const { candidates } = audit.auditPlans(loadRegistry(f.config));
    const c = candidates.find((x) => x.planPath.endsWith('e.md'));
    assert.ok(!c || !c.signals.includes('FULLY-TICKED'),
      'a plan with no steps cannot be fully ticked');
  } finally { f.cleanup(); }
});

test('the stale-status report exits 0 even when it finds candidates', () => {
  // It is a report. If a non-empty candidate list could fail the command, it
  // would be a gate, and a gate nobody can satisfy without editing 272 plans
  // would be ignored — which is how the original drift went unnoticed.
  const f = fixture('exit-zero', {
    'f.md': draftPlan({
      steps: ['- [x] Step one'],
      tail: ['## 8. Task State', '', '- **Status:** Complete', ''],
    }),
  });
  try {
    const r = run(['--stale-status'], f);
    assert.equal(r.code, 0, `must always exit 0, got ${r.code}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /f\.md/, `must name the candidate:\n${r.stdout}`);
  } finally { f.cleanup(); }
});

test('a Draft plan with no signal is counted but never listed as a candidate', () => {
  // The distinction this file's whole report turns on. An earlier version added
  // EVERY tracked Draft plan to `candidates`, which produced a real, observed
  // defect: the live report printed "8 candidates" with an EMPTY signals column
  // on all eight, because none of them was contradicted, none was fully ticked,
  // and none was old enough. That reads as "all eight are suspicious" when the
  // truth is "none of the eight has said anything at all". So: no signal means
  // not a candidate — but the plan is still counted, so the gap stays visible.
  const f = fixture('silent-draft', {
    'silent.md': draftPlan({ steps: ['- [ ] Step one', '- [ ] Step two'] }),
    'loud.md': draftPlan({
      steps: ['- [x] Step one'],
      tail: ['## 8. Task State', '', '- **Status:** Complete', ''],
    }),
  });
  try {
    const data = audit.auditPlans(loadRegistry(f.config));
    assert.equal(data.draftCount, 2, 'both plans declare status: Draft, so both are counted');
    const paths = data.candidates.map((c) => c.planPath);
    assert.ok(!paths.some((p) => p.endsWith('silent.md')),
      `a silent plan must not be a candidate:\n${JSON.stringify(data.candidates, null, 2)}`);
    assert.ok(paths.some((p) => p.endsWith('loud.md')),
      'the contradicted plan must still be a candidate');
    assert.equal(data.candidates.length, 1, 'exactly one candidate, not two');
  } finally { f.cleanup(); }
});

test('the report states how many Draft plans said nothing, instead of implying all are suspect', () => {
  const f = fixture('silent-wording', {
    'silent.md': draftPlan({ steps: ['- [ ] Step one'] }),
  });
  try {
    const r = run(['--stale-status'], f);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1 tracked plan\(s\) declare `status: Draft`; 0 carry evidence/,
      `the counts must be stated up front:\n${r.stdout}`);
    assert.match(r.stdout, /say nothing either way/,
      `the silent ones must be accounted for, not omitted:\n${r.stdout}`);
    // And the candidate table must not be printed at all when there is nothing
    // in it — an empty table with headers reads as "the list is empty" fine, but
    // an empty table under a heading that says "candidates" invites the reader
    // to go looking for the missing ones.
    assert.match(r.stdout, /no candidate carries evidence/,
      `an empty result must say so plainly:\n${r.stdout}`);
    // The unsignalled plan must not be named in the candidate table.
    assert.ok(!/^\s+silent\.md\s/m.test(r.stdout),
      `a plan with no signal must not appear in the candidate table:\n${r.stdout}`);
  } finally { f.cleanup(); }
});
