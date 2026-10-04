#!/usr/bin/env bun
// scripts/skipif-registry-audit.mjs
//
// WHY THIS FILE EXISTS
//
// "Which plans would changing `classifySkipIf` break?" was answered once, by
// hand, in a chat log. That answer cannot be re-checked after a regex edit, and
// a number nobody can re-run is a claim rather than a measurement. This turns it
// into a command:
//
//   bun scripts/skipif-registry-audit.mjs
//   bun scripts/skipif-registry-audit.mjs --json
//   bun scripts/skipif-registry-audit.mjs --compare-to-frozen
//   bun scripts/skipif-registry-audit.mjs --class unknown
//   bun scripts/skipif-registry-audit.mjs --grep tgrep
//
// THE CLASSIFIER IS INJECTED. THAT IS THE DESIGN POINT.
//
// `affected` is NOT a hardcoded list of the commands we happen to know are
// misfiled. The same traversal runs twice over the same rows — once through the
// live `classifySkipIf`, once through whatever candidate is injected as
// "before" — and the difference falls out. Three things follow from that, and all
// three are the reason it is written this way:
//
//   * A candidate classifier that has not been written yet can still be measured
//     against. T5's step 2 edits `FILE_PROBE`; its step 4 re-runs this and diffs
//     the tallies. A hardcoded diff would report the same 44 rows forever.
//   * The direction is explicit, so "regression" is a fact and not a vibe. The
//     frozen 2026-09-30 classifier calls `false` and `pacman -Q` both
//     `behavioural`; the live one calls them `sentinel` and `unknown`. Run it the
//     other way round and the same two rows move the other way.
//   * A test can inject a stub and assert the before/after pair, which is how the
//     injection point is proven to be load-bearing rather than decorative.
//
// WHY enumeratePlans IS REUSED RATHER THAN RE-WALKED
//
// A second directory walk here would be a second source of truth for "what is a
// plan", and the two would disagree the first time a project turned mirror:false
// or moved its plans tree. The registry module already owns that question and
// already excludes the vault's own `mirror: false` root, so the audit borrows it
// along with `resolveProject`. Frontmatter is read with the runner's own
// `extractFrontmatter` / `parseUltraPlanYaml` for the same reason: an audit that
// parsed YAML its own way would report classes for tasks the runner cannot see.
//
// FOUR BUCKETS, AND WHY THE FOURTH EXISTS
//
// Mirroring plan-lifecycle-audit.mjs's three-bucket rule, which exists because
// "the mirror reads Draft" and "the plan claims Draft" are different claims:
//
//   withFrontmatter  a parseable `---` fence; its tasks were classified
//   noFrontmatter    no fence at all. Counted, named, and NOT in the tally —
//                    there is no `skip_if` in it to classify, and calling that
//                    "no unclassified commands" would be a different statement
//   malformed         a fence that never closes, or YAML the parser rejects. A
//                    broken file is still a file. It is counted separately and
//                    named by path, so ONE broken plan cannot zero the report
//   unreadable       exists but could not be read. Explicitly NOT filed under
//                    noFrontmatter: claiming a plan declares no frontmatter when
//                    nobody managed to look at it is a guess wearing a fact's
//                    clothes
//
// NO EXPECTED COUNTS ARE HARDCODED HERE. The figures in the plan that commissioned
// this file (293 plans, 65 with frontmatter, 415 skip_if values, 77/210/114/14)
// were measured on 2026-09-30 and both the plan count and the frontmatter count
// move the moment a plan is written. A report that exited non-zero on a moved
// number would be a gate, and a gate on a growing directory is a script that
// gets deleted. So the numbers are printed and the exit code is not a judgement
// of them.
//
// EXIT CODE IS ALWAYS 0 for a successful measurement. It is a report, never a
// gate — the same convention as plan-lifecycle-audit.mjs. A usage error or an
// unloadable registry is exit 1, because nothing was measured and silence would
// be a lie; a measurement that disagrees with an expectation is exit 0, because
// only a human can say whether the world or the expectation moved.
//
// CONFIG INJECTION
//
// plans.publish.json is resolved from this file's own directory, and
// PLAN_PUBLISH_CONFIG overrides it — the documented seam plan-publish.mjs uses,
// which is what lets the tests run against a throwaway registry.
//
// READ-ONLY, EVERYWHERE
//
// This opens plan files belonging to other repositories and never opens one for
// writing. It writes nothing at all: not a cache, not a temp file, not a mirror.
// Revert is `rm scripts/skipif-registry-audit.mjs` plus its test.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, enumeratePlans, resolveProject } from './plan-publish-registry.mjs';
import { classifySkipIf, extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';
import { classifySpikeSkipIf, SPIKE_CLASSIFIER_FROZEN_ON } from './spike-skipif-classifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(rootDir, 'plans.publish.json');

// ---------- The five classes ----------

// The classifier's own resolution order, not an alphabetical one. `tally` is
// built in this order so two runs of this file diff cleanly and a class that
// falls to zero is visible as a zero instead of vanishing from the object.
export const CLASS_ORDER = ['empty', 'sentinel', 'behavioural', 'loose', 'unknown'];

export const CLASS_LABELS = {
  empty: 'blank or non-string — nothing was claimed',
  sentinel: 'the string "false" — the documented "this task has no command"',
  behavioural: 'runs a tool that has to succeed first',
  loose: 'reads a file and asserts a string is in it',
  unknown: 'matches neither rule — the classifier does not know, and says so',
};

const FROZEN_LABEL = `classifySpikeSkipIf (frozen ${SPIKE_CLASSIFIER_FROZEN_ON})`;

const USAGE = [
  'usage:',
  '  bun scripts/skipif-registry-audit.mjs                        tally the live classifier, human table',
  '  bun scripts/skipif-registry-audit.mjs --json                 the same data as JSON',
  '  bun scripts/skipif-registry-audit.mjs --compare-to-frozen    affected = live vs the 2026-09-30 freeze',
  '  bun scripts/skipif-registry-audit.mjs --class <name>         list only rows of that class',
  '  bun scripts/skipif-registry-audit.mjs --grep <text>          list only rows whose command contains <text>',
  '  bun scripts/skipif-registry-audit.mjs --plan <text>          list only rows from plans whose name contains <text>',
  '',
  `  classes: ${CLASS_ORDER.join(' | ')}`,
  '  PLAN_PUBLISH_CONFIG overrides plans.publish.json (the seam plan-publish.mjs uses).',
].join('\n');

// ---------- argument parsing ----------

function parseArgs(argv) {
  const opts = {
    json: false,
    help: false,
    compareToFrozen: false,
    classify: 'live',
    compareTo: null,
    cls: null,
    grep: null,
    plan: null,
  };
  const need = (flag, value) => {
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--help':
      case '-h': opts.help = true; break;
      case '--compare-to-frozen': opts.compareToFrozen = true; break;
      // The second injection point, spelled out. `--classify live --compare-to
      // frozen` and `--compare-to-frozen` are the same measurement; the long form
      // exists so the *next* candidate does not need a new flag.
      case '--classify': opts.classify = need('--classify', argv[++i]); break;
      case '--compare-to': opts.compareTo = need('--compare-to', argv[++i]); break;
      case '--class': opts.cls = need('--class', argv[++i]); break;
      case '--grep': opts.grep = need('--grep', argv[++i]); break;
      case '--plan': opts.plan = need('--plan', argv[++i]); break;
      default: throw new Error(`unknown flag "${a}"`);
    }
  }
  return opts;
}

function resolveClassifier(name) {
  if (name === 'live' || name === 'classifySkipIf') return classifySkipIf;
  if (name === 'frozen' || name === 'spike' || name === FROZEN_LABEL) return classifySpikeSkipIf;
  throw new Error(`unknown classifier "${name}": use "live" or "frozen"`);
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const emptyTally = () => Object.fromEntries(CLASS_ORDER.map((c) => [c, 0]));

function bump(tally, cls) {
  tally[cls] = (tally[cls] ?? 0) + 1;
  return tally;
}

const base = (p) => path.basename(p);

function blankProject() {
  return {
    plans: 0,
    withFrontmatter: 0,
    noFrontmatter: 0,
    malformed: 0,
    unreadable: 0,
    skipIf: 0,
    tally: emptyTally(),
  };
}

// ---------- the audit ----------

// Measures one registry with one (or two) classifiers.
//
// Options:
//   classify      the AFTER classifier. Defaults to the live classifySkipIf.
//   compareTo     the BEFORE classifier, or null. When given, `affected` lists
//                 every row whose class differs between the two.
//   configPath    provenance only, so the JSON records WHICH registry it measured.
//   readFile      seam for the unreadable bucket; the tests inject a thrower.
//
// Returns { plans, withFrontmatter, noFrontmatter, skipIfTotal, tally,
// byProject, affected } plus the row list and the named buckets.
export function auditRegistry(registry, options = {}) {
  const {
    classify = classifySkipIf,
    compareTo = null,
    configPath = DEFAULT_CONFIG,
    readFile = readFileSync,
    // Provenance for the JSON. A row that says "behavioural → sentinel" is only
    // reproducible if the output records WHICH two classifiers produced it, so an
    // injected function is labelled as one rather than as `classifySkipIf`.
    afterLabel = classify === classifySkipIf ? 'classifySkipIf' : 'the injected classifier',
    beforeLabel = compareTo === null ? null : 'the injected candidate',
  } = options;

  // The registry module's answer to "what is a plan", reused rather than
  // re-derived. It already excludes mirror:false roots and already knows where
  // the plans live.
  const planPaths = enumeratePlans(registry);

  const rows = [];
  const byProject = {};
  const noFrontmatterPlans = [];
  const malformedPlans = [];
  const unreadablePlans = [];
  const tally = emptyTally();
  let withFrontmatter = 0;

  for (const p of planPaths) {
    let project = '?';
    try {
      project = resolveProject(registry, p).name;
    } catch {
      // enumeratePlans only yields paths under a registered root, so this is
      // unreachable in practice. Caught rather than thrown because a plan whose
      // owner cannot be named is still a plan whose skip_if must be counted.
    }

    const proj = (byProject[project] ??= blankProject());
    proj.plans++;

    let text;
    try {
      text = readFile(p, 'utf8');
    } catch (e) {
      // Its own bucket, deliberately not merged into noFrontmatter. See header.
      proj.unreadable++;
      unreadablePlans.push({ plan: base(p), path: p, project, error: e.message });
      continue;
    }

    // A leading fence is what makes a plan claimable at all. Checked here so
    // "declares no frontmatter" is a fact about the file rather than a side
    // effect of which exception extractFrontmatter happened to throw.
    if (!/^---[ \t]*(\r?\n|$)/.test(text)) {
      proj.noFrontmatter++;
      noFrontmatterPlans.push({ plan: base(p), path: p, project });
      continue;
    }

    let plan;
    try {
      const { frontmatter } = extractFrontmatter(text);
      plan = parseUltraPlanYaml(frontmatter);
    } catch (e) {
      // A fence that never closes, or YAML the subset parser rejects. Counted and
      // NAMED so one broken plan is visible instead of silently shrinking the
      // report, which would read as "nothing to fix".
      proj.malformed++;
      malformedPlans.push({ plan: base(p), path: p, project, error: e.message });
      continue;
    }

    withFrontmatter++;
    proj.withFrontmatter++;

    for (const task of plan.tasks ?? []) {
      if (!task || !Object.hasOwn(task, 'skip_if')) continue;
      const cmd = task.skip_if;
      const cls = classify(cmd);
      proj.skipIf++;
      bump(tally, cls);
      bump(proj.tally, cls);
      rows.push({
        plan: base(p),
        path: p,
        project,
        taskId: task.id === undefined ? '(no id)' : String(task.id),
        cmd: typeof cmd === 'string' ? cmd : String(cmd),
        class: cls,
      });
    }
  }

  // BEFORE/AFTER, computed by running both classifiers over the SAME rows. The
  // alternative — a stored list of known-bad commands — would keep reporting the
  // same 44 rows forever and would find nothing the day a new one appeared.
  const affected = [];
  if (typeof compareTo === 'function') {
    for (const r of rows) {
      const before = compareTo(r.cmd);
      if (before === r.class) continue;
      affected.push({
        plan: r.plan,
        project: r.project,
        taskId: r.taskId,
        cmd: r.cmd,
        before,
        after: r.class,
      });
    }
  }

  // Deterministic order: project, then plan, then the natural task order of the
  // file. Two runs on one tree produce byte-identical output, so a diff between
  // them means something moved rather than that the sort disagreed with itself.
  rows.sort((a, b) => a.project.localeCompare(b.project)
    || a.plan.localeCompare(b.plan)
    || String(a.taskId).localeCompare(String(b.taskId), undefined, { numeric: true }));

  const sortedByProject = {};
  for (const name of Object.keys(byProject).sort()) sortedByProject[name] = byProject[name];

  return {
    generated: today(),
    config: configPath,
    vault: registry.vault,
    classifiers: { before: beforeLabel, after: afterLabel },
    plans: planPaths.length,
    withFrontmatter,
    noFrontmatter: noFrontmatterPlans.length,
    malformed: malformedPlans.length,
    unreadable: unreadablePlans.length,
    skipIfTotal: rows.length,
    tally,
    byProject: sortedByProject,
    rows,
    noFrontmatterPlans,
    malformedPlans,
    unreadablePlans,
    affected,
  };
}

// The rows a human asked for. Used by `--class`, `--grep` and `--plan`, and
// exported so a test can assert the query without shelling out. Never mutates.
export function selectRows(rows, { cls = null, grep = null, project = null, plan = null } = {}) {
  return rows.filter((r) => {
    if (cls !== null && r.class !== cls) return false;
    if (project !== null && r.project !== project) return false;
    if (plan !== null && !r.plan.includes(plan)) return false;
    if (grep !== null && !r.cmd.includes(grep)) return false;
    return true;
  });
}

const TALLY_ORDER = ['sentinel', 'behavioural', 'loose', 'unknown', 'empty'];

function renderAffected(data, { limit = 0 } = {}) {
  const out = [];
  const rows = limit > 0 ? data.affected.slice(0, limit) : data.affected;
  if (data.affected.length === 0) {
    out.push('   (none — every skip_if in the registry classifies identically under both classifiers)');
    return out;
  }
  out.push('   project     plan                                            task  before        after         command');
  for (const a of rows) {
    out.push(
      `   ${a.project.padEnd(11)} ${a.plan.padEnd(48)} ${a.taskId.padEnd(5)} ${a.before.padEnd(13)} ${a.after.padEnd(13)} ${a.cmd}`,
    );
  }
  if (rows.length < data.affected.length) {
    out.push(`   … ${data.affected.length - rows.length} more (raise --limit, or use --json)`);
  }
  return out;
}

function renderRows(rows, { title, note = null } = {}) {
  const out = [title];
  if (rows.length === 0) {
    out.push('   (no row matches)');
    return out;
  }
  out.push('   project     plan                                            task  class        command');
  for (const r of rows) {
    out.push(`   ${r.project.padEnd(11)} ${r.plan.padEnd(48)} ${r.taskId.padEnd(5)} ${r.class.padEnd(12)} ${r.cmd}`);
  }
  if (note) out.push(`   ${note}`);
  return out;
}

export function renderReport(data) {
  const out = [];
  out.push(`🔎 skip_if registry audit — ${data.generated}`);
  out.push(`   registry: ${data.config}`);
  out.push(`   vault:    ${data.vault}`);
  out.push(`   classify: ${data.classifiers.after}   (before: ${data.classifiers.before ?? 'not compared'})`);
  out.push('');

  out.push(`   plans enumerated       ${data.plans}`);
  out.push(`   plans with frontmatter ${data.withFrontmatter}`);
  out.push(`   skip_if values         ${data.skipIfTotal}`);
  out.push('');

  out.push('   tally by class:');
  for (const c of TALLY_ORDER) {
    if (!(c in data.tally)) continue;
    out.push(`     ${c.padEnd(13)} ${String(data.tally[c]).padStart(4)}   ${CLASS_LABELS[c] ?? '(class the classifier invented)'}`);
  }
  const summed = TALLY_ORDER.reduce((n, c) => n + (data.tally[c] ?? 0), 0);
  out.push(`     ${'(sum)'.padEnd(13)} ${String(summed).padStart(4)}`);

  out.push('');
  out.push('   by project:');
  const names = Object.keys(data.byProject);
  if (names.length === 0) out.push('     (no project in the registry holds a plan)');
  for (const n of names) {
    const p = data.byProject[n];
    const t = TALLY_ORDER.filter((c) => (p.tally[c] ?? 0) > 0).map((c) => `${c} ${p.tally[c]}`).join(' · ') || 'no skip_if';
    out.push(`     ${n.padEnd(12)} plans ${String(p.plans).padStart(3)}  fm ${String(p.withFrontmatter).padStart(3)}  skip_if ${String(p.skipIf).padStart(3)}   ${t}`);
  }

  // The four buckets, stated as the header argues they must be. A number that
  // silently omits a plan reads as a claim about a file nobody looked at.
  const buckets = [
    ['plans with frontmatter', data.withFrontmatter, 'their tasks were classified'],
    ['plans, no frontmatter', data.noFrontmatter, 'counted and named; no skip_if to classify'],
    ['plans, malformed frontmatter', data.malformed, 'counted and named; ONE broken file must not zero this report'],
    ['plans, unreadable', data.unreadable, 'counted separately — never folded into "no frontmatter"'],
  ];
  out.push('');
  out.push('   the four buckets:');
  for (const [label, n, why] of buckets) out.push(`     ${label.padEnd(32)} ${String(n).padStart(3)}   ${why}`);
  if (data.malformed > 0) for (const p of data.malformedPlans) out.push(`       - ${p.path}: ${p.error}`);
  if (data.unreadable > 0) for (const p of data.unreadablePlans) out.push(`       - ${p.path}: ${p.error}`);
  if (data.noFrontmatter > 0 && data.malformed === 0 && data.unreadable === 0) {
    out.push(`     (the ${data.noFrontmatter} no-frontmatter plan(s) are listed in --json)`);
  }

  // The class a change has to look at first, always printed, because "which
  // plans are affected" is the question the file exists to answer and a reader
  // should not have to know which class to ask for.
  const unknown = data.rows.filter((r) => r.class === 'unknown');
  out.push('');
  out.push(...renderRows(unknown, {
    title: `   the ${unknown.length} \`unknown\` row(s) — matches neither rule, so the classifier says so:`,
  }));

  out.push('');
  if (data.classifiers.before === null) {
    out.push('   affected: not computed — no BEFORE classifier was injected.');
    out.push('   Re-run with `--compare-to-frozen` to see what the live rule changed since the 2026-09-30 freeze,');
    out.push('   or with `--compare-to <live|frozen>` to compare two named classifiers.');
  } else {
    out.push(`   affected: ${data.affected.length} task(s) whose class differs between ${data.classifiers.before} and ${data.classifiers.after}`);
    out.push(...renderAffected(data));
  }

  out.push('');
  out.push('   Exit code is always 0 for a measurement: this is a report, not a gate. No expected count');
  out.push('   is asserted here. The plan count and the frontmatter count move every time a plan is');
  out.push('   written, and a report that failed on a moved number would be a gate on a growing directory.');
  out.push('');
  out.push(`   ${USAGE}`);
  return out.join('\n');
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv.slice(2));
  } catch (e) {
    // A usage error is exit 1, unlike plan-lifecycle-audit.mjs's always-zero
    // report: a mistyped `--class` that printed an empty table would be read as
    // "no rows of that class exist", which is a measurement nobody made. Silence
    // about a failed query is worse here than a non-zero exit that breaks `&&`.
    console.error(`❌ ${e.message}\n\n${USAGE}`);
    return 1;
  }

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  if (opts.cls !== null && !CLASS_ORDER.includes(opts.cls)) {
    console.error(`❌ unknown class "${opts.cls}": expected one of ${CLASS_ORDER.join(' | ')}\n\n${USAGE}`);
    return 1;
  }

  let classify = opts.classify === 'live' ? classifySkipIf : null;
  let compareTo = null;
  let afterLabel = 'classifySkipIf';
  let beforeLabel = null;
  if (opts.compareToFrozen) compareTo = classifySpikeSkipIf;
  if (opts.compareTo !== null) compareTo = resolveClassifier(opts.compareTo);
  if (opts.classify !== 'live') {
    classify = resolveClassifier(opts.classify);
    afterLabel = opts.classify === 'frozen' || opts.classify === 'spike' ? FROZEN_LABEL : opts.classify;
  }
  if (compareTo !== null) {
    beforeLabel = compareTo === classifySpikeSkipIf && !opts.compareTo ? FROZEN_LABEL : (opts.compareTo ?? 'the injected candidate');
  }

  // PLAN_PUBLISH_CONFIG first, then this file's own repo config — the same
  // precedence plan-publish.mjs uses, so a test that injects a registry gets the
  // same behaviour from every command that reads one.
  const configPath = process.env.PLAN_PUBLISH_CONFIG || DEFAULT_CONFIG;

  let registry;
  let data;
  try {
    registry = loadRegistry(configPath);
    data = auditRegistry(registry, { classify, compareTo, configPath, afterLabel, beforeLabel });
  } catch (e) {
    // A registry that cannot be loaded is a fact about the machine. Exit 1,
    // because nothing was measured and printing an empty table would be a lie.
    console.error(`❌ ${e.message}`);
    console.error('   nothing was measured; fix the registry and re-run.');
    return 1;
  }

  // An empty enumeration is the most dangerous possible "answer": every count
  // below reads as "no impact". Said out loud, once.
  if (data.plans === 0) {
    console.error('⚠️  E_PRECOND_INPUT: the registry enumerated 0 plans.');
    console.error('   Every number below would read as "nothing to fix", and that would be a registry');
    console.error('   problem, not a clean result. Check plans.publish.json roots and the plans directories.');
  }

  if (opts.cls !== null || opts.grep !== null || opts.plan !== null) {
    const rows = selectRows(data.rows, { cls: opts.cls, grep: opts.grep, plan: opts.plan });
    if (opts.json) {
      console.log(JSON.stringify({ ...data, rows, filtered: true }, null, 2));
    } else {
      const label = [
        opts.cls !== null ? `class ${opts.cls}` : null,
        opts.grep !== null ? `command contains "${opts.grep}"` : null,
        opts.plan !== null ? `plan contains "${opts.plan}"` : null,
      ].filter(Boolean).join(' AND ');
      console.log([
        `🔎 skip_if rows — ${label} (${rows.length} of ${data.skipIfTotal})`,
        ...renderRows(rows, { title: '' }).slice(1),
      ].join('\n'));
    }
    return 0;
  }

  if (opts.json) console.log(JSON.stringify(data, null, 2));
  else console.log(renderReport(data));
  return 0;
}

const isMain = process.argv[1] && process.argv[1].endsWith('skipif-registry-audit.mjs');
if (isMain) process.exit(main(process.argv));
