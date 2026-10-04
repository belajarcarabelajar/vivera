#!/usr/bin/env bun
// scripts/plan-lifecycle-audit.mjs
//
// WHY THIS FILE EXISTS
//
// `status: Draft` in a plan mirror means two entirely different things, and the
// single number "236 mirrors read Draft" throws both away:
//
//   * UNTRACKED. The plan file declares no frontmatter at all.
//     plan-publish-frontmatter.mjs emits `verbatimStatus ?? 'status: Draft'`, so
//     the mirror is reporting a FALLBACK DEFAULT chosen by the publisher. It says
//     nothing about the work — the plan has simply never been in a lifecycle.
//     Marking one of these `Complete` would be asserting something nobody
//     measured.
//   * TRACKED. The plan file declares `status: Draft`. That is a real claim about
//     the work, and it may well be a stale one. These are the only plans a
//     backfill may touch, and only one at a time, with a human deciding.
//
// Conflating them is how a maintenance task becomes fabrication, so this script
// does not print a status distribution. It prints a distribution split by CAUSE.
//
//   bun scripts/plan-lifecycle-audit.mjs            # human report
//   bun scripts/plan-lifecycle-audit.mjs --json     # the same data, for quoting
//
// EXIT CODE IS ALWAYS 0. It is a report, never a gate.
//
// Not a stylistic choice. A count that gates would have to be a threshold, and
// any threshold here is a number that drifts the moment a plan is written: the
// registry is a growing directory, so `assert untracked === 227` fails on the day
// a new plan appears, and the failure says nothing true about the work. A report
// that exits non-zero also breaks `cmd && bun scripts/plan-lifecycle-audit.mjs`
// in a pipeline for the same reason. So the numbers move and the exit code does
// not; if a figure is surprising, the report says so in words and a human reads
// it. This is the same convention as `plan-publish.mjs --status`.
//
// NO EXPECTED COUNTS ARE HARDCODED HERE. The 2026-09-27 measurement (271 total,
// 227 untracked, 44 tracked, 0 with frontmatter but no status) is recorded in
// §3.1 of docs/code-plan/plans/2026-09-27-post-execution-vault-sync.md and is
// re-measured by running this script, not asserted by it. A script that fails
// because the world changed is a script that gets deleted.
//
// THE THREE BUCKETS, AND WHY THE THIRD ONE EXISTS
//
//   untracked (no frontmatter)      no leading `---` fence. The mirror's status
//                                   is the publisher's fallback.
//   tracked (declares status)       a fence, and a `status:` line inside it.
//   tracked, frontmatter but NO     a fence with no `status:` line. Measured as
//     status line                   0 on 2026-09-27.
//
// The third bucket is not a rounding error. If it were non-zero, folding those
// plans into `untracked` would say the publisher invented their status, which is
// false — a status line can be absent while the frontmatter block is very much
// declared — and folding them into `tracked` would count them as a claim when
// there is none. So it is counted, labelled, and named by path whenever it is
// non-zero.
//
// WHAT IS VERBATIM
//
// A tracked plan's `status:` value is read exactly as the source spells it: not
// parsed, not unquoted, not remapped onto the ultra-plan enum. That is the same
// rule the transform follows when it copies the line through, so a quoted
// `"Draft"` would stay quoted here and form its own row rather than being
// silently merged into `Draft`. No such plan exists in the registry at the time
// of writing; if one appears, the extra row is the finding, not a bug to hide.
// The single transformation applied anywhere is stripping a trailing `# comment`
// for GROUPING ONLY, because `status: Draft  # published at Draft on purpose`
// is a Draft plan, and the verbatim line is reported beside it so nothing is lost.
//
// WHY enumeratePlans IS REUSED RATHER THAN RE-WALKED
//
// A second directory walk here would be a second source of truth for "what is a
// plan", and the two would disagree the first time a project turned mirror:false
// or moved its plans tree. The registry module already owns that question and
// already gets the `mirror: false` exclusion right, so the audit borrows it.
// Likewise the audit only READS: it never opens a plan for writing, never
// touches a mirror, and never writes to the vault.
//
// CONFIG INJECTION
//
// plans.publish.json is resolved from this file's own directory, and
// PLAN_PUBLISH_CONFIG overrides it — the same documented seam
// plan-publish.mjs uses, which is what lets the tests run against a throwaway
// registry instead of the real one.
//
// HOW TO REVERT IT
//
// Delete the file. Nothing else references it: it writes nothing, so `rm
// scripts/plan-lifecycle-audit.mjs` is the whole revert. Its own test file goes
// with it.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, enumeratePlans, resolveProject } from './plan-publish-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(rootDir, 'plans.publish.json');

const USAGE = [
  'usage:',
  '  bun scripts/plan-lifecycle-audit.mjs            split plans by cause, always exit 0',
  '  bun scripts/plan-lifecycle-audit.mjs --stale-status   list Draft claims that look finished',
  '  bun scripts/plan-lifecycle-audit.mjs --json     the same data as JSON, for quoting',
].join('\n');

// A YAML fence line. The FIRST line only can open one: a `---` further down a
// document is a horizontal rule or a table separator, and treating it as a fence
// would put a plan in the tracked bucket on the strength of its prose.
const FENCE_RE = /^---[ \t]*$/;
// Column 0, like the transform's OWNED_RE. An indented `status:` belongs to
// something nested (a task, a defaults map) and is not the plan's own status.
const STATUS_RE = /^status[ \t]*:[ \t]*(.*)$/;
// YAML needs whitespace before an inline `#` for it to start a comment, so
// `Draft#x` is one scalar while `Draft  # x` is a scalar plus a comment.
const TRAILING_COMMENT_RE = /[ \t]+#.*$/;

// The grouping key for a status value that exists but is blank (`status:` with
// nothing after it). Not a real lifecycle value; named so the row is visible
// instead of appearing as an empty label nobody can act on.
const EMPTY_STATUS = '(empty)';

// Local date, not UTC — the same reasoning as plan-publish.mjs `today()`: this
// is a human date in a human's report.
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- classify: one plan file's text ----------

// What a single plan file claims, and WHY it claims it.
//
//   { declaresFrontmatter, statusLine, statusValue, status, bucket }
//     bucket: 'untracked' | 'tracked' | 'tracked-no-status'
//
// `statusValue` is the raw text after `status:`, trailing whitespace trimmed —
// the whole source line minus its key, which is what the publisher copies into
// the mirror. `status` is `statusValue` with a trailing `# comment` removed, and
// is the ONLY thing used for grouping.
export function classifyPlan(planText) {
  const src = typeof planText === 'string' ? planText : '';
  const lines = src.split('\n');
  const declaresFrontmatter = lines.length > 0 && FENCE_RE.test(lines[0]);

  let statusLine = null;
  if (declaresFrontmatter) {
    // Scanned INSIDE the fence only: a `status:` in the body is prose, and
    // reading it would invent a lifecycle claim for a plan that declares none.
    //
    // An unclosed fence still counts as declared frontmatter. A plan with broken
    // frontmatter is still a plan, and calling it untracked would attribute its
    // mirror status to the publisher's fallback on no evidence. The scan simply
    // runs to the end of the file when the fence never closes.
    for (let i = 1; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i])) break;
      if (STATUS_RE.test(lines[i])) {
        // FIRST status line wins, matching the transform's own
        // `verbatimStatus === null` guard: a plan that declares two of them
        // publishes the first, so the audit must count what was published.
        statusLine = lines[i];
        break;
      }
    }
  }

  const statusValue = statusLine === null
    ? null
    : STATUS_RE.exec(statusLine)[1].replace(/[ \t]+$/, '');

  const group = statusValue === null
    ? null
    : (statusValue.replace(TRAILING_COMMENT_RE, '').trim() || EMPTY_STATUS);

  return {
    declaresFrontmatter,
    statusLine,
    statusValue,
    status: group,
    bucket: !declaresFrontmatter
      ? 'untracked'
      : (statusLine === null ? 'tracked-no-status' : 'tracked'),
  };
}

// ---------- audit: the whole registry ----------

// Measures the registry. Returns plain data; rendering is a separate function so
// `--json` and the text report cannot disagree about a number — there is only
// one set of numbers, computed once.
export function auditPlans(registry) {
  // The registry module's answer to "what is a plan", reused rather than
  // re-derived. It already excludes mirror:false roots and already knows where
  // the plans live; a second walk would be a second source of truth.
  const plans = enumeratePlans(registry);

  const byStatus = new Map();
  const trackedPlans = [];
  const noStatusPlans = [];
  const unreadablePlans = [];
  const candidates = [];
  let untracked = 0;
  let tracked = 0;
  let trackedNoStatus = 0;
  let unreadable = 0;

  for (const p of plans) {
    let project = '?';
    try {
      project = resolveProject(registry, p).name;
    } catch {
      // enumeratePlans only ever yields paths under a registered root, so this is
      // unreachable in practice. It is caught rather than thrown because a plan
      // whose owner cannot be named is still a plan whose status must be counted.
    }

    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch (e) {
      // A file that exists but cannot be read is a fourth thing, and it is NOT
      // "no frontmatter": claiming that would attribute a publisher fallback to a
      // file nobody managed to look at. Counted separately so the three buckets
      // keep meaning what they say.
      unreadable++;
      unreadablePlans.push({ path: p, project, error: e.message });
      continue;
    }

    const c = classifyPlan(text);
    if (c.bucket === 'untracked') {
      untracked++;
      continue;
    }
    if (c.bucket === 'tracked-no-status') {
      trackedNoStatus++;
      noStatusPlans.push({ path: p, project });
      continue;
    }
    tracked++;
    trackedPlans.push({
      path: p,
      project,
      status: c.status,
      statusValue: c.statusValue,
      statusLine: c.statusLine,
    });
    byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);

    // Stale-claim detection runs here rather than in a second pass so it costs
    // no extra read of any plan file.
    let mtimeMs = null;
    try {
      mtimeMs = statSync(p).mtimeMs;
    } catch {
      // A plan that cannot be stat'd is already counted as unreadable above;
      // it simply has no age, which costs it the weakest signal and nothing else.
    }
    const cand = staleStatusCandidates(text, { mtimeMs });
    // Only a plan that actually carries a signal becomes a candidate. This
    // filter is the whole point of the view: measured on the real registry, an
    // earlier version with no filter printed "8 candidates" with an empty
    // signals column on all eight, which reads as "all eight are suspicious"
    // when the truth is that none of them had said anything. Silence is counted
    // (see draftCount below) and then deliberately not listed.
    if (cand && cand.signals.length > 0) candidates.push({ planPath: p, project, ...cand });
  }
  // Every tracked plan whose claim is Draft, whether or not it carries a signal.
  // The unsignalled ones are counted here rather than left implicit, because the
  // render has to be able to say "8 Draft plans, 0 with evidence" instead of
  // printing an empty evidence column and letting the reader assume otherwise.
  const draftPlans = trackedPlans.filter((p) => p.status === 'Draft');

  // Most common first, ties broken by name. Deterministic, so two runs on the same
  // registry produce byte-identical output and a diff between them means
  // something moved rather than that the sort disagreed with itself.
  const byStatusObject = {};
  for (const [status, count] of [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    byStatusObject[status] = count;
  }

  return {
    generated: today(),
    total: plans.length,
    untracked,
    tracked,
    trackedNoStatus,
    unreadable,
    byStatus: byStatusObject,
    draftCount: draftPlans.length,
    trackedPlans: trackedPlans.sort((a, b) => a.path.localeCompare(b.path)),
    noStatusPlans: noStatusPlans.sort((a, b) => a.path.localeCompare(b.path)),
    unreadablePlans,
    // Strongest evidence first, then oldest, then by path. The ordering is the
    // reading order: a reader works down the list and stops when the evidence
    // stops being about the work.
    candidates: candidates.sort((a, b) => {
      const rank = (x) => x.signals.length;
      return rank(b) - rank(a)
        || (b.ageDays ?? -1) - (a.ageDays ?? -1)
        || a.planPath.localeCompare(b.planPath);
    }),
  };
}

// Attach provenance to a measurement so the JSON says WHICH registry it measured
// and a quoted number cannot be mistaken for one from a different machine.
export function auditRegistry(registry, configPath = DEFAULT_CONFIG) {
  return {
    config: configPath,
    vault: registry.vault,
    ...auditPlans(registry),
  };
}

// ---------- stale-status candidates ----------
//
// A `Draft` claim can go stale: a plan whose work is finished but which was
// never closed leaves the vault saying `Draft` indefinitely, and with no
// Dataview in that vault there is no board that would surface it. This finds the
// CANDIDATES. It never decides they are finished.
//
// The three signals are of deliberately different strength, because they are not
// the same claim:
//
//   CONTRADICTED  the body records Complete while the frontmatter says Draft.
//                 Nothing is inferred; the file disagrees with itself.
//   FULLY-TICKED  every step checkbox inside a `### Task <id>` section is
//                 ticked, and there is at least one step to tick.
//   STALE-BY-AGE  Draft, and the plan file has not changed for a while.
//
// STALE-BY-AGE is the weakest and is labelled as such wherever it is printed:
// an abandoned draft and a finished one look identical from here, and only
// reading the plan can tell them apart. That is the whole reason this is a
// report and not a backfill.

const STALE_AFTER_DAYS = 30;
const STEP_LINE_RE = /^[ \t]*-[ \t]*\[([ xX])\]/;
const TASK_HEADING_RE = /^#{2,4}[ \t]+Task[ \t]+(\S+?)[ \t]*[:—-]?[ \t]*(.*)$/;
const ANY_HEADING_RE = /^#{1,6}[ \t]+/;
// A body line that records the plan as finished. Matched only OUTSIDE the
// frontmatter fence, so it can never read the plan's own `status: Draft` line
// back as a contradiction — that mistake would flag every single Draft plan.
//
// The colon is allowed on EITHER side of the closing emphasis, because both
// spellings occur in real plans: `**Status:** Complete` and `**Status**:
// Complete`. Writing the pattern for only one of them was a real miss, caught
// by a test fixture rather than by reading the plans it was meant to describe.
const BODY_COMPLETE_RE = /^[ \t]*(?:[-*+][ \t]+)?\**[ \t]*status[ \t]*\**[ \t]*:?[ \t]*\**[ \t]*:?[ \t]*`?Complete`?[ \t]*\**[ \t]*$/i;

// Step checkboxes inside `### Task <id>` sections ONLY. The acceptance list in
// section 1 and the approval gate in section 7 are not steps; counting them
// would let a plan look finished because somebody ticked an acceptance box.
// This is the same scoping rule plan-mark-done.mjs applies when it ticks, so
// the report and the tool cannot disagree about what a step is.
//
// Returns null when the plan declares no task section at all, which is NOT the
// same as "zero steps, all ticked": vacuous truth would light up every
// prose-only plan in the registry.
function stepTally(bodyLines) {
  let inTask = false;
  let ticked = 0;
  let unticked = 0;
  for (const line of bodyLines) {
    if (TASK_HEADING_RE.test(line)) { inTask = true; continue; }
    if (ANY_HEADING_RE.test(line)) { inTask = false; continue; }
    if (!inTask) continue;
    const m = STEP_LINE_RE.exec(line);
    if (!m) continue;
    if (m[1] === ' ') unticked++; else ticked++;
  }
  return (ticked + unticked) === 0 ? null : { ticked, unticked };
}

// The body, with the frontmatter fence removed. Returns the lines AND whether
// a fence was actually closed, because an unclosed fence would otherwise make
// the frontmatter's own `status: Draft` line look like body prose.
function bodyLinesOf(text) {
  const lines = text.split('\n');
  if (!FENCE_RE.test(lines[0] ?? '')) return lines;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) return lines.slice(i + 1);
  }
  return [];
}

export function staleStatusCandidates(planText, { mtimeMs = null, nowMs = Date.now(), staleDays = STALE_AFTER_DAYS } = {}) {
  const c = classifyPlan(planText);
  // Only a real claim can be stale. The untracked bucket's Draft is the
  // publisher's fallback and is counted by the main report instead.
  if (c.bucket !== 'tracked') return null;
  if (c.status !== 'Draft') return null;

  const body = bodyLinesOf(planText);
  const steps = stepTally(body);
  const signals = [];

  if (body.some((l) => BODY_COMPLETE_RE.test(l))) signals.push('CONTRADICTED');
  if (steps && steps.unticked === 0) signals.push('FULLY-TICKED');

  let ageDays = null;
  if (mtimeMs != null) {
    ageDays = Math.floor((nowMs - mtimeMs) / 86_400_000);
    if (ageDays >= staleDays) signals.push('STALE-BY-AGE');
  }

  // A candidate with only the weakest signal is still worth printing — that is
  // the whole point, since nothing else surfaces it — but it carries no
  // evidence that the work is done, and the render says so.
  return {
    status: c.status,
    statusValue: c.statusValue,
    signals,
    tickedSteps: steps ? steps.ticked : 0,
    untickedSteps: steps ? steps.unticked : 0,
    hasTaskSection: steps !== null,
    ageDays,
  };
}

// Every tracked plan that declares `status: Draft`, split by whether it carries
// any signal at all. The split is the point: a plan with zero signals is NOT a
// candidate, and printing it in the same list as one that contradicts itself
// would hand the reader a list of eight and imply all eight are suspicious when
// in fact none of them has said anything. That overstatement is how a report
// becomes a nudge to bulk-edit, which is the outcome this whole script exists
// to avoid.
export function splitDraftPlans(registry) {
  const { candidates, trackedPlans } = auditPlans(registry);
  const withSignals = new Set(candidates.map((c) => c.planPath));
  const silent = trackedPlans.filter((p) => p.status === 'Draft' && !withSignals.has(p.path));
  return { candidates, silentDraft: silent };
}

const W = (label, n) => `${label}: ${n}`;

export function renderReport(data) {
  const out = [];
  out.push(`📊 Plan lifecycle audit — ${data.generated}`);
  out.push(`   registry: ${data.config}`);
  out.push(`   vault:    ${data.vault}`);
  out.push('');

  out.push(`   ${W('total plans', data.total)}`);
  // These three labels are the report. T5's skip_if greps for the first of them,
  // and the vault's operating section quotes the second.
  out.push(`   ${W('untracked (no frontmatter)', data.untracked)}`);
  out.push(`   ${W('tracked (declares status)', data.tracked)}`);
  out.push(`   ${W('tracked, frontmatter but NO status line', data.trackedNoStatus)}`);
  if (data.unreadable > 0) {
    out.push(`   ${W('unreadable (excluded from all three above)', data.unreadable)}`);
  }

  out.push('');
  out.push('Tracked plans by declared status:');
  const statuses = Object.keys(data.byStatus);
  if (statuses.length === 0) {
    out.push('   (none — no plan file in the registry declares a `status:` line)');
  } else {
    const width = Math.max(...statuses.map((s) => s.length));
    for (const s of statuses) {
      out.push(`   ${s.padEnd(width)}  ${data.byStatus[s]}`);
    }
    out.push(`   ${'(total)'.padEnd(width)}  ${data.tracked}`);
  }

  out.push('');
  out.push('What the numbers mean:');
  out.push(
    `   • untracked (no frontmatter): the ${data.untracked} plan(s) above declare no frontmatter at all.`
  );
  out.push('     Their mirror reads `status: Draft` only because the publisher FALLS BACK to that');
  out.push('     value when a plan declares no `status:` line.');
  out.push('     For those plans it is a fallback default, not a claim: it says nothing about the work.');
  out.push('     They are not asserting they are unfinished — they have never been in a lifecycle.');
  out.push('     A backfill that read them as a status would be inventing one, so leave them alone.');
  out.push(
    `   • tracked (declares status): the ${data.tracked} plan(s) above declare a \`status:\` line themselves.`
  );
  out.push('     Those are real claims, they may be stale, and they are the only rows a human may');
  out.push('     correct — one plan at a time, with the evidence recorded.');
  out.push('     Values are read verbatim: not parsed, not unquoted, not remapped. The one adjustment');
  out.push('     is that a trailing `# comment` is stripped for GROUPING ONLY; the verbatim line and');
  out.push('     the source path of every tracked plan are in `--json`.');

  if (data.trackedNoStatus === 0) {
    out.push('');
    out.push(
      `   The ${W('tracked, frontmatter but NO status line', data.trackedNoStatus)} is the expected`
    );
    out.push(
      '   case: a plan that declares frontmatter also declares a status. It is still reported as'
    );
    out.push(
      '   its own figure rather than folded into either bucket above, so that a non-zero value'
    );
    out.push('   would be visible as a change of state instead of disappearing into an average.');
  } else {
    out.push('');
    out.push(
      `   ⚠️  ${W('tracked, frontmatter but NO status line', data.trackedNoStatus)} — NOT the expected`
    );
    out.push(
      '   state, and deliberately not folded into either bucket above. These plans declare a'
    );
    out.push(
      '   frontmatter block without a `status:` line, so the mirror status they produce comes'
    );
    out.push(
      '   from somewhere other than either cause the other two buckets describe. The publisher'
    );
    out.push('   falls back to `status: Draft` for them too, so a mirror cannot tell them apart');
    out.push('   from the untracked ones. Each one is listed below and needs a human to say which');
    out.push('   case it is before any of these numbers is acted on.');
    for (const p of data.noStatusPlans) out.push(`     - ${p.path}`);
  }

  if (data.unreadable > 0) {
    out.push('');
    out.push(`   ⚠️  ${data.unreadable} plan file(s) could not be read and are counted in none of the`);
    out.push('      buckets above, so the buckets do not add up to the total for that reason:');
    for (const p of data.unreadablePlans) out.push(`     - ${p.path}: ${p.error}`);
  }

  out.push('');
  out.push('   Exit code is always 0: this is a report, not a gate. No expected count is asserted');
  out.push('   here — the numbers move as plans are written, and only a human judges them.');
  out.push('');
  out.push(`   ${USAGE}`);
  return out.join('\n');
}

// ---------- argument parsing ----------

function parseArgs(argv) {
  const opts = { json: false, help: false, staleStatus: false };
  for (const a of argv) {
    switch (a) {
      case '--json': opts.json = true; break;
      // --stale-status is a VIEW of the same measurement, not a second
      // measurement, so it composes with --json rather than excluding it. Two
      // passes over the registry would be two chances to report different
      // numbers for the same tree.
      case '--stale-status': opts.staleStatus = true; break;
      case '--help':
      case '-h': opts.help = true; break;
      default:
        throw new Error(`unknown flag "${a}"`);
    }
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv.slice(2));
  } catch (e) {
    // A usage error is reported on stderr and STILL exits 0. A report that breaks
    // a `&&` chain over a typo helps nobody, and the whole point of the always-zero
    // contract is that nothing downstream has to know whether the flags were right.
    console.error(`❌ ${e.message}\n\n${USAGE}`);
    return;
  }

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  // PLAN_PUBLISH_CONFIG first, then this file's own repo config — the same
  // precedence plan-publish.mjs uses, so a test that injects a registry gets the
  // same behaviour from both commands.
  const configPath = process.env.PLAN_PUBLISH_CONFIG || DEFAULT_CONFIG;
  let registry;
  let data;
  try {
    registry = loadRegistry(configPath);
    data = auditRegistry(registry, configPath);
  } catch (e) {
    // A registry that cannot be loaded is a fact about the machine, not a failure
    // of the audit. Exiting 1 here would make the command a gate, which is the one
    // thing it must not be, so the error is printed in full — including the path —
    // and the run ends.
    console.error(`❌ ${e.message}`);
    console.error('   nothing was measured; fix the registry and re-run.');
    return;
  }

  if (opts.json) console.log(JSON.stringify(data, null, 2));
  else console.log(renderReport(data));
  if (opts.staleStatus) console.log(renderStaleStatus(data));
}

// The candidate list, rendered. Its job is to be READ, so the wording carries
// the evidence strength all the way to the reader: a line that says only
// STALE-BY-AGE must not read like a line that says CONTRADICTED, or the report
// becomes a nudge to bulk-edit plans on the strength of a file's mtime.
export function renderStaleStatus(data) {
  const out = [];
  const draft = data.draftCount ?? 0;
  const withEvidence = data.candidates.length;
  const silent = Math.max(0, draft - withEvidence);
  out.push('');
  out.push(`🔎 Draft claims that may be stale`);
  out.push(`   ${draft} tracked plan(s) declare \`status: Draft\`; ${withEvidence} carry evidence that the claim is stale.`);
  if (silent > 0) {
    out.push(`   The other ${silent} say nothing either way: not fully ticked, not contradicted, not old enough.`);
    out.push('   They are counted here rather than listed, because a list of Draft plans with an empty');
    out.push('   evidence column reads as "all suspicious" when the truth is "none of them has said');
    out.push('   anything". For those, only reading the plan can settle it.');
  }
  out.push('');
  out.push('Signals, strongest first. They are not the same claim and are not meant to be read as one:');
  out.push('   CONTRADICTED   the plan\'s own body records Complete while its frontmatter says Draft.');
  out.push('                  Nothing is inferred here — the file disagrees with itself.');
  out.push('   FULLY-TICKED   every step checkbox inside every `### Task <id>` section is ticked.');
  out.push('                  A fact about the file, and still not a statement about the work:');
  out.push('                  the acceptance criteria and the approval gate are NOT steps, and are');
  out.push('                  excluded on purpose, so a ticked acceptance box cannot cause this.');
  out.push(`   STALE-BY-AGE   the plan has not changed for ${STALE_AFTER_DAYS}+ days. THE WEAKEST SIGNAL, and`);
  out.push('                  on its own it is not evidence of anything: an abandoned draft and a');
  out.push('                  finished one are indistinguishable from a file\'s mtime. It is listed so');
  out.push('                  the case is visible, not so it can be acted on in bulk.');
  out.push('');
  if (data.candidates.length === 0) {
    out.push('   (no candidate carries evidence — nothing in any plan file points at a stale claim)');
  } else {
    out.push('   plan                                                            project      ticks    age   signals');
    for (const c of data.candidates) {
      const name = c.planPath.split('/').pop();
      const ticks = c.hasTaskSection
        ? `${c.tickedSteps}/${c.tickedSteps + c.untickedSteps}`
        : 'no tasks';
      const age = c.ageDays === null ? '   ?  ' : `${String(c.ageDays).padStart(4)}d `;
      out.push(`   ${name.padEnd(64)} ${c.project.padEnd(12)} ${ticks.padStart(6)}  ${age}  ${c.signals.join(' ')}`);
    }
    out.push('');
    out.push('   Read `source_path` in the mirror and decide one plan at a time. Do NOT bulk-edit:');
    out.push('   a backfill that guesses produces false claims and looks finished while being wrong.');
  }
  out.push('');
  out.push('   This is a report. It exits 0 whether or not it finds candidates, on purpose: a command');
  out.push('   whose failure nobody can resolve without editing hundreds of plans would be ignored.');
  return out.join('\n');
}

const isMain = process.argv[1] && process.argv[1].endsWith('plan-lifecycle-audit.mjs');
if (isMain) main(process.argv);
