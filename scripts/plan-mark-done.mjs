#!/usr/bin/env bun
// scripts/plan-mark-done.mjs
//
// WHY THIS FILE EXISTS
//
// A plan is executed by an agent, and every step of it is a `- [ ]` line that
// nobody ticks. The runner knows which tasks passed, and it prints that — but it
// prints it to stdout and then exits, so the record of "T1 passed" lives in a
// scrollback buffer and nowhere else. Three sessions later the plan still reads
// as if nothing was done, the Obsidian mirror says `Draft`, and the only honest
// way to close the plan is to retype what the log already said.
//
// This command is the step that applies those ticks. It reads the runner's own
// status lines, decides which tasks reached a terminal success, and rewrites the
// single `[ ]` token on the step lines of exactly those tasks.
//
// WHY THE EVIDENCE, AND NOT A FLAG
//
// `--task T1` with nothing behind it is a way to type a checkbox, and a checkbox
// you can type is not a record of anything: it would be set the same way whether
// the work happened or not. So the default input is EVIDENCE — a runner log from
// `--from <file>` or stdin — and a task is ticked from it only when the log
// records a terminal success. `--task` remains available for an agent that ran
// the steps itself, and the output says `asserted, no evidence` on every such
// line, because the difference between "there is a log that says so" and "the
// operator said so" is the whole point of this command and must stay visible in
// the output rather than in the design notes.
//
// WHAT COUNTS AS SUCCESS, AND WHY ONLY TWO THINGS DO
//
// The runner prints five terminal statuses (ultra-plan-runner.mjs, lines
// 365-403). Exactly two mean the work is done:
//
//   `T1: PASSED`                       every step command exited as expected
//   `T1: SKIPPED-IDEMPOTENT (...)`     skip_if exited 0, so the work was already
//                                      done and this run changed nothing
//
// The other three are NOT success and are refused, each for a different reason:
//
//   `NEEDS-AGENT`   the runner had no `run[]` to execute and handed the task
//                   back to an agent. Nobody verified anything.
//   `READY (dry-run)` nothing was executed. A dry run is a planning tool; letting
//                   it tick boxes would make `--help` output close a plan.
//   `HALTED-UPSTREAM` a dependency failed, so this task never ran. Its steps are
//                   untouched by definition.
//
// An unrecognised status is also not success. The rule is one-directional on
// purpose: a log that records something this build has never heard of is
// evidence of nothing, and treating an unknown token as a pass would make every
// future change to the runner silently permissive.
//
// WHICH LINES COUNT AS STEPS
//
// A line is a step only if it is a LIST ITEM whose first content is a checkbox:
// `^indent[-*+] spaces [[] x]` and the `]` is followed by end-of-line or a space.
// Four things are deliberately excluded, and each exclusion has been observed as
// a real hazard in the plan corpus rather than imagined:
//
//   - a `- [ ]` inside a fenced code block. The plans put command lines in
//     fences, and a fence that shows a checklist is an example, not work.
//   - a `- [ ]` inside a prose sentence. The anchor is the start of the line
//     (after indent), not the presence of the token, so "remember to tick - [ ]
//     this" is not a step.
//   - a `- [ ]` outside every `### Task <id>` section. Section 7 and section 8 of
//     a plan are full of unticked boxes that belong to no task and are not
//     closed by any task's completion.
//   - an ALREADY-TICKED line, in either case. Ticking rewrites one character; it
//     never normalises `[X]` to `[x]`, because that is a second edit nobody asked
//     for and a diff nobody reviewed.
//
// The replacement is byte-minimal by construction: the matched prefix, an `x`,
// the matched `]`, and the original remainder of the line. Every other byte,
// including CRLF endings, is the string it was.
//
// WHICH ID IS TRUSTED
//
// The frontmatter `tasks[].id` list, and nothing else. That is the plan's own
// machine-checked contract — it is what `topoSort` builds the DAG from and what
// the runner reports against — so a `### Task T9` heading with no frontmatter
// entry describes a task the runner never ran and can therefore never have
// produced evidence about. Refusing here is also the fail-closed direction: a
// looser rule would still refuse the id-nobody-declared case, and would refuse
// nothing extra. (`schema: ultra-plan/v1` is deliberately NOT enforced: this
// command edits text, the runner owns the schema contract, and refusing on a
// schema string would block a plan the runner rejects with a better message.)
//
// FAIL CLOSED, BEFORE ANY WRITE
//
// Every id in the log is checked against the frontmatter list BEFORE a single
// byte is written. A log that mentions a task this plan does not have is not
// about this plan — it is truncated output from another run, or a plan merged
// into another plan — and the safe reading of a record that does not match the
// document is to write nothing at all, including for the ids that DO match.
// Ticking T1 because a mixed-up log said T1 passed is how a plan ends up with a
// ticked box above a red step.
//
// Exit codes: 0 every task considered was ticked or was already ticked ·
// 1 an unknown id, a log that does not match the plan, or any task the evidence
// did not close · 2 usage error.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
//   - It does not touch the Obsidian mirror. A mirror is derived state, and it is
//     overwritten on every publish, so ticking it here would be a write that the
//     next publish undoes. The ticks belong in the SOURCE plan; publishing after
//     is a separate, visible step.
//   - It does not run the runner, and it does not shell out to anything. It reads
//     text and writes text.
//   - It does not set `status:` in the frontmatter, does not publish, does not
//     `git add`, and does not commit. Closing a plan and recording that it is
//     closed are different acts, and this command does only the first one.
//   - It has no `--all` and no `--dry-run`. `--all` would be a bulk write across
//     every plan in the registry from one flag, and a dry run that needs a second
//     command to actually work is a mode nobody uses. Check what it would do by
//     reading the plan or by running it against a copy.
//
// HOW TO REVERT IT
//
//   git checkout -- <plan.md>
//
// The only mutation is one character per line: a space inside a `[ ]` on a line
// under one `### Task <id>` heading. Nothing is deleted, so a revert loses
// nothing, and `git diff` shows the change in full.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { writeFileAtomic } from './lib/atomic-write.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The runner's own frontmatter and YAML-subset parsers, IMPORTED rather than
// re-derived. Two implementations of "which ids does this plan declare?" is how
// this command ends up accepting an id the runner has never heard of, and then
// ticking a task that was never part of the DAG. `ultra-plan/v1` is the
// runner's contract, so the runner is where it is parsed.
import { extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';

const USAGE = [
  'usage:',
  '  bun scripts/plan-mark-done.mjs <plan.md> --from <runner.log>   # tick from evidence',
  '  bun scripts/plan-mark-done.mjs <plan.md> --from -             # read the log from stdin',
  '  bun scripts/plan-mark-done.mjs <plan.md> --task <id>           # asserted, no evidence',
  '  bun scripts/plan-mark-done.mjs --help',
  '',
  'A task is ticked from a log only when the log records PASSED or',
  'SKIPPED-IDEMPOTENT for it. NEEDS-AGENT, READY (dry-run), HALTED-UPSTREAM and',
  'any FAILED-* are not successes and leave the steps untouched. --from and --task',
  'cannot be combined: they are different claims about the same work.',
  '',
  'exit: 0 ticked or already ticked · 1 unknown id, mismatched log, or a task the',
  'evidence did not close · 2 usage error',
].join('\n');

class UsageError extends Error {}

// ---------- the runner's status lines ----------

// `  T1: PASSED` — the shape ultra-plan-runner.mjs logs (`  ${id}: ${status}`).
//
// The leading-whitespace requirement is a real filter, not decoration: the
// runner's own header line (`Plan: 2099-01-01-fixture  schema=...`) is at column
// 0, so a prose line that happens to say "T1: PASSED is what the runner prints"
// is not mistaken for the runner's verdict. What remains — `  WARN: ...` and
// `  ERROR: ...` — is discarded by the classification below, because only the
// runner's known status tokens may become a task record.
const STATUS_LINE_RE = /^[ \t]+([A-Za-z][A-Za-z0-9_.-]*):[ \t]+(\S.*?)[ \t]*$/;

// A row of the runner's rendered Error Ledger, `| T1 | 2 | code | ... |`.
//
// The first cell must be an id-shaped token and not all dashes, and the LAST cell
// must be a backticked status — `renderLedger` (ultra-plan-runner.mjs:411) emits
// `` `FAILED-BLOCKING` `` there and emits the bare word `Status` in that same
// column of the header row. Requiring the backticks is what rejects the header
// and the `|---|` separator BY SHAPE rather than by position, so a column added
// to the ledger later cannot shift the check. The literal word `Task` is
// id-shaped and would otherwise become a phantom task.
const LEDGER_ROW_RE = /^[ \t]*\|[ \t]*([^|]*?)[ \t]*\|/;
const LEDGER_STATUS_CELL_RE = /^`[A-Z][A-Z-]*`$/;
const ID_SHAPED_RE = /^[A-Za-z0-9_.-]+$/;

function ledgerRowId(line) {
  const m = LEDGER_ROW_RE.exec(line);
  if (!m) return null;
  if (!ID_SHAPED_RE.test(m[1]) || /^-+$/.test(m[1])) return null;
  // split('|') leaves an empty element at each end for the outer pipes.
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  const last = cells[cells.length - 1];
  return last !== undefined && LEDGER_STATUS_CELL_RE.test(last) ? m[1] : null;
}

// Split a recorded status into a class. The names are the class, not a prettified
// label, so a caller can branch on one and print the runner's own wording.
export function classifyStatus(detail) {
  if (detail === 'PASSED') return 'success';
  if (detail.startsWith('SKIPPED-IDEMPOTENT')) return 'success';
  if (detail.startsWith('NEEDS-AGENT')) return 'needs-agent';
  if (detail.startsWith('READY')) return 'dry-run';
  if (detail.startsWith('HALTED-UPSTREAM')) return 'halted';
  if (detail.startsWith('FAILED-')) return 'failed';
  // Deliberately not 'success'. See the header: the rule is one-directional.
  return 'unknown';
}

// Reads a runner log into per-task records plus the ledger rows it printed.
//
// `order` is first-seen order, which is the order the runner executed in, so the
// output can be printed in the order the work happened rather than sorted.
export function parseRunnerLog(text) {
  const byId = new Map();
  const ledger = new Map();
  for (const line of text.split(/\r?\n/)) {
    const ledId = ledgerRowId(line);
    if (ledId !== null) {
      if (!ledger.has(ledId)) ledger.set(ledId, []);
      ledger.get(ledId).push(line.trim());
      continue;
    }
    const m = STATUS_LINE_RE.exec(line);
    if (!m) continue;
    const klass = classifyStatus(m[2]);
    if (klass === 'unknown') continue; // not a runner status line: not a record
    byId.set(m[1], { id: m[1], detail: m[2], klass, success: klass === 'success' });
  }
  return { order: [...byId.keys()], byId, ledger };
}

// ---------- the plan's task ids ----------

// Returns { ids, error }. A malformed plan is an error rather than an empty id
// list, because "no ids" is indistinguishable from "ids I could not read" and
// the second must not be treated as a plan that declares nothing.
export function planTaskIds(planText) {
  let frontmatter;
  try {
    ({ frontmatter } = extractFrontmatter(planText));
  } catch (e) {
    return { ids: [], error: `cannot read the plan's frontmatter: ${e.message}` };
  }
  let plan;
  try {
    plan = parseUltraPlanYaml(frontmatter);
  } catch (e) {
    return { ids: [], error: `cannot parse the plan's frontmatter: ${e.message}` };
  }
  const ids = (plan.tasks || []).map((t) => t.id).filter(Boolean);
  if (ids.length === 0) {
    return {
      ids: [],
      error: 'the plan declares no frontmatter tasks[].id, so there is no contract to check a task id against',
    };
  }
  return { ids, error: null };
}

// ---------- which lines are steps ----------

// `  - [ ] `, `* [x] `, `+ [X] ` — a list item whose FIRST content is a checkbox.
// The lookahead requires end-of-line or a space after `]`, so a `- [ ]x` typo is
// left alone rather than "fixed".
const STEP_RE = /^([ \t]*[-*+][ \t]+\[)( |x|X)(\])(?=[ \t]|$)/;
const HEADING_RE = /^#{1,6}[ \t]+/;
const FENCE_RE = /^[ \t]*(?:```|~~~)/;

// The heading of a task, and the end of its section: the next ATX heading at ANY
// level. A `## 5. Verification Matrix` ends T1's section just as surely as the
// next `### Task` does, and relying on the next `### Task` alone is how a step
// list quietly absorbs a neighbouring section's checkboxes.
//
// `(?![A-Za-z0-9_-])` after the id, so `Task T1` is not matched while looking for
// `T10`.
//
// Built by concatenation rather than a template literal on purpose: the escape
// regex contains the two characters `${`, which a template literal would read as
// the start of an interpolation and the file would not parse.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function taskSectionRange(lines, id) {
  const re = new RegExp('^#{1,6}[ \\t]+Task[ \\t]+' + escapeRegExp(id) + '(?![A-Za-z0-9_-])');
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

// Indices of the step lines inside a section. Fence state is tracked because the
// plans put example commands in fenced blocks, and a `- [ ]` in a fence is a
// sample of text rather than an instruction to perform.
export function stepLineIndices(lines, start, end) {
  const out = [];
  let inFence = false;
  for (let i = start + 1; i < end; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (STEP_RE.test(lines[i])) out.push(i);
  }
  return out;
}

// Ticks one task's steps in a copy of the text. Returns the new line array rather
// than a string so a caller can decide whether to write at all, which is how the
// already-ticked case becomes a true no-op (no write, no mtime bump).
export function tickSteps(text, id) {
  const lines = text.split('\n');
  const range = taskSectionRange(lines, id);
  if (!range) return { lines, sectionFound: false, ticked: 0, already: 0, steps: 0 };
  const idx = stepLineIndices(lines, range.start, range.end);
  let ticked = 0;
  let already = 0;
  for (const i of idx) {
    const m = STEP_RE.exec(lines[i]);
    // `[X]` counts as already ticked and is left byte-identical: normalising the
    // case would be a second, unrequested edit on a line that needed none.
    if (m[2] === ' ') {
      lines[i] = `${m[1]}x${m[3]}${lines[i].slice(m[0].length)}`;
      ticked++;
    } else already++;
  }
  return { lines, sectionFound: true, ticked, already, steps: idx.length };
}

// ---------- the decision ----------

function notTicked(id, mode, why, extra = {}) {
  return { id, outcome: 'not-ticked', mode, why, ...extra };
}

function tickOne(text, id, mode, st) {
  const r = tickSteps(text, id);
  const evidence = st ? `[evidence: ${st.detail}]` : '[asserted, no evidence]';
  if (!r.sectionFound) {
    return {
      row: notTicked(id, mode, `the plan declares ${id} but its body has no "### Task ${id}" heading, so there is no step list to tick`),
      text,
    };
  }
  if (r.ticked === 0) {
    return {
      row: { id, outcome: 'no-op', mode, why: `no-op — already ticked (${r.steps} step line(s), 0 changed)`, evidence },
      text,
    };
  }
  return {
    row: {
      id,
      outcome: 'ticked',
      // Loud for the unverified case on purpose: a warning glyph AND the words
      // "asserted, no evidence", because the glyph alone is not searchable.
      mode,
      why: `ticked ${r.ticked} of ${r.steps} step line(s)`,
      evidence,
    },
    text: r.lines.join('\n'),
  };
}

function failure(code, message) {
  return { text: null, changed: false, rows: [], error: { code, message } };
}

/**
 * Decide what to tick, and return the new text. Pure: it never touches the file
 * system, and `error` short-circuits before any edit so a refusal is total.
 *
 * `logText` and `assertId` are the two claims. Exactly one may be given; the CLI
 * refuses the combination because they assert different things, and silently
 * preferring one would make an asserted tick look like a verified one.
 */
export function markDone(planText, { logText = null, assertId = null } = {}) {
  const { ids, error: idError } = planTaskIds(planText);
  if (idError) return failure('E_PLAN_FRONTMATTER', idError);
  const known = new Set(ids);
  const declared = ids.join(', ');

  const rows = [];
  let text = planText;

  if (logText !== null) {
    const log = parseRunnerLog(logText);
    if (log.order.length === 0) {
      return failure(
        'E_NO_EVIDENCE',
        'the log contains no runner status lines, so it is evidence of nothing. Expected lines like '
        + '"  T1: PASSED" — pass the runner\'s own output, e.g. '
        + '`bun scripts/ultra-plan-runner.mjs <plan> --execute 2>&1 | tee run.log`.',
      );
    }
    // EVERY id checked before ANY write. A log that mentions a task this plan
    // does not declare is not about this plan, and a partial application of a
    // mismatched record is worse than doing nothing.
    const strangers = log.order.filter((id) => !known.has(id));
    if (strangers.length > 0) {
      return failure(
        'E_UNKNOWN_TASK_IN_LOG',
        `refusing: the log names task ${strangers.join(', ')}, which this plan's frontmatter does not declare. `
        + `Declared: ${declared}. That log is not about this plan, so nothing was written — including for the `
        + `tasks it does declare.`,
      );
    }
    for (const id of log.order) {
      const st = log.byId.get(id);
      // Declared outside the branch: `const` inside the two arms would be two
      // different block-scoped bindings and the code below could see neither.
      let t;
      if (st.success) {
        t = tickOne(text, id, 'evidence', st);
      } else {
        t = {
          row: notTicked(id, 'evidence', `evidence says ${st.detail}`, { ledger: log.ledger.get(id) || [] }),
          text,
        };
      }
      rows.push(t.row);
      text = t.text;
    }
  } else if (assertId) {
    if (!known.has(assertId)) {
      return failure(
        'E_UNKNOWN_TASK',
        `unknown task id: ${assertId} — the plan's frontmatter declares: ${declared}`,
      );
    }
    const t = tickOne(text, assertId, 'asserted', null);
    rows.push(t.row);
    text = t.text;
  }

  return { text, changed: text !== planText, rows, error: null };
}

// ---------- argument parsing ----------

function parseArgs(args) {
  const opts = { plan: null, from: null, task: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--help':
      case '-h': opts.help = true; break;
      case '--from': {
        const v = args[++i];
        if (v === undefined) throw new UsageError('--from needs a log file path, or - for stdin');
        opts.from = v;
        break;
      }
      case '--task': {
        const v = args[++i];
        if (v === undefined) throw new UsageError('--task needs a task id');
        opts.task = v;
        break;
      }
      default:
        if (a.startsWith('-') && a !== '-') throw new UsageError(`unknown flag "${a}"`);
        if (opts.plan) throw new UsageError(`only one plan file may be given (already have "${opts.plan}")`);
        opts.plan = a;
    }
  }
  return opts;
}

function validateArgs(opts) {
  if (opts.help) return 'help';
  if (!opts.plan) throw new UsageError('no plan file given');
  if (!opts.from && !opts.task) {
    throw new UsageError('nothing to do: pass --from <log> for evidence, or --task <id> to assert it with none');
  }
  // Refused rather than one-wins: a caller who passes both wants a tick they can
  // defend, and picking either one silently is how an assertion ends up printed
  // with an evidence tag on it.
  if (opts.from && opts.task) {
    throw new UsageError(
      `--from and --task cannot be combined: the log is evidence that ${opts.task} is done, `
      + 'and the flag is a claim that it is. Pass one.',
    );
  }
  return 'mark';
}

function readLog(opts) {
  if (opts.from === '-') {
    if (process.stdin.isTTY) {
      throw new UsageError('--from - reads the log from stdin, but stdin is a terminal. Pipe the log in, or pass a path.');
    }
    try {
      return readFileSync(0, 'utf8');
    } catch (e) {
      throw new Error(`cannot read the log from stdin: ${e.message}`);
    }
  }
  if (!existsSync(opts.from)) throw new Error(`log file not found: ${path.resolve(opts.from)}`);
  return readFileSync(opts.from, 'utf8');
}

// ---------- main ----------

// One line per task the run CONSIDERED, not per task it touched. A task it
// declined to tick is exactly the one a reader needs to be told about, and a line
// that is only printed on success is how a red step ends up under a ticked box.
function printRow(row) {
  const tag = row.evidence ?? (row.outcome === 'not-ticked' ? '' : '');
  if (row.outcome === 'ticked') {
    const glyph = row.mode === 'evidence' ? '✅' : '⚠️ ';
    console.log(`${glyph} ${row.id}: ${row.why} ${tag}`);
  } else if (row.outcome === 'no-op') {
    console.log(`⏭️  ${row.id}: ${row.why} ${tag}`);
  } else {
    console.log(`❌ ${row.id}: NOT ticked — ${row.why}${tag ? ` ${tag}` : ''}`);
    for (const led of row.ledger || []) {
      // The runner's own ledger row, verbatim: the operator does not have to go
      // back to the log to learn which step went red.
      console.log(`     ledger: ${led}`);
    }
  }
}

function main(argv) {
  let opts;
  let action;
  try {
    opts = parseArgs(argv.slice(2));
    action = validateArgs(opts);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`❌ ${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  if (action === 'help') {
    console.log(USAGE);
    process.exit(0);
  }

  const planPath = path.resolve(opts.plan);
  if (!existsSync(planPath)) {
    console.error(`❌ plan file not found: ${planPath}`);
    process.exit(1);
  }

  let logText = null;
  if (opts.from) {
    try {
      logText = readLog(opts);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  }

  const planText = readFileSync(planPath, 'utf8');
  const result = markDone(planText, { logText, assertId: opts.task });

  if (result.error) {
    console.error(`❌ ${result.error.message}`);
    process.exit(1);
  }

  // Atomic, with one generation of backup. Only now, after every check has
  // passed, and only if a byte actually changes: a no-op must leave the file's
  // mtime alone, so "already ticked" stays distinguishable from "ticked" after
  // the fact. The atomic part matters more than it looks — these plans run to
  // 40KB and upwards, so a write interrupted half way would leave a document
  // that still parses but has lost every task after the cut, and the next run
  // would faithfully rewrite the truncation over the good copy.
  if (result.changed) writeFileAtomic(planPath, result.text, { keepBackup: true });

  console.log(`plan: ${planPath}`);
  for (const row of result.rows) printRow(row);
  const count = (o) => result.rows.filter((r) => r.outcome === o).length;
  console.log(
    `   tally: ${result.rows.length} considered · ${count('ticked')} ticked · `
    + `${count('no-op')} no-op · ${count('not-ticked')} not-ticked`,
  );
  if (count('ticked') > 0) {
    console.log('   The mirror is still the old snapshot: publish after this, or the vault keeps reading the previous state.');
  }

  // A run that could not close everything it saw does not report success, even
  // though the tasks it could close WERE closed. A caller in a `&&` chain needs
  // to know there is still an open task; the tally above says how many.
  process.exit(count('not-ticked') > 0 ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv);
