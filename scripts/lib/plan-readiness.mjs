// scripts/lib/plan-readiness.mjs
//
// Readiness evidence for a plan: open step boxes, the verdict, and each task's
// skip_if result. Lives apart from plan-closeout.mjs so other tools can measure
// readiness without loading the merge gate; it must never import plan-closeout.mjs.

import { extractFrontmatter, parseUltraPlanYaml, classifySkipIf } from '../ultra-plan-runner.mjs';
import { planTaskIds, taskSectionRange, stepLineIndices } from '../plan-mark-done.mjs';
import { missingTestPaths } from './test-paths.mjs';

const OPEN_STEP = /^[ \t]*[-*+][ \t]+\[ \]/;
// Mirrors plan-mark-done's unexported STEP_RE and FENCE_RE, so both tools agree on what a box and a fence are.
const OTHER_BOX = /^[ \t]*[-*+][ \t]+\[ \](?=[ \t]|$)/;
const CODE_FENCE = /^[ \t]*(?:```|~~~)/;
export const BOXES_SHOWN = 5;

export const tickCommand = (plan) =>
  `bun scripts/plan-closeout.mjs --readiness ${plan} --evidence readiness.log; bun scripts/plan-mark-done.mjs ${plan} --from readiness.log`;

// The gate counts only what plan-mark-done can tick, so its printed fix always clears it.
export function openStepBoxes(planText) {
  const lines = planText.split('\n');
  const rows = [];
  for (const task of planTaskIds(planText).ids) {
    const range = taskSectionRange(lines, task);
    if (!range) continue;
    for (const i of stepLineIndices(lines, range.start, range.end)) {
      if (OPEN_STEP.test(lines[i])) rows.push({ line: i + 1, text: lines[i].replace(/\r$/, '').trim(), task });
    }
  }
  return rows.sort((a, b) => a.line - b.line);
}

export function otherOpenBoxes(planText) {
  const lines = planText.split('\n');
  const owned = new Set();
  for (const task of planTaskIds(planText).ids) {
    const range = taskSectionRange(lines, task);
    if (range) for (let i = range.start; i < range.end; i++) owned.add(i);
  }
  let body = planText;
  // checkCloseout runs inside the merge gate, where a malformed plan must still be measured, not throw.
  try {
    ({ body } = extractFrontmatter(planText));
  } catch {}
  // The body is a suffix of the file, so the lines before it give the whole-file offset.
  const offset = lines.length - body.split('\n').length;
  const rows = [];
  let inFence = false;
  for (let i = offset; i < lines.length; i++) {
    // plan-mark-done starts each section outside a fence, so each stretch between task sections does too.
    if (owned.has(i)) {
      inFence = false;
      continue;
    }
    const line = lines[i].replace(/\r$/, '');
    if (CODE_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && OTHER_BOX.test(line)) rows.push({ line: i + 1, text: line.trim() });
  }
  return rows;
}

const STATES = ['DONE', 'OPEN', 'UNREAD', 'UNPROVEN'];
// Counted as done but kept out of STATES, so counts only names it when a task has it.
const ASSERTED = 'DONE-ASSERTED';

export function readinessVerdict({ tasks, openNow = 0, openBoxes = 0 }) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  const asserted = counts[ASSERTED] ?? 0;
  if (counts.OPEN > 0 || counts.UNREAD > 0 || openNow > 0 || openBoxes > 0) return { verdict: 'NOT-READY', exit: 1, counts, asserted };
  // A plan with no tasks measured nothing, so READY would recommend Complete without evidence.
  if (tasks.length === 0 || counts.UNPROVEN > 0) return { verdict: 'NEEDS-HUMAN', exit: 3, counts, asserted };
  return { verdict: 'READY', exit: 0, counts, asserted };
}

const TAIL_LINES = 5;
const TAIL_COLS = 200;

// ledgerTrace in ultra-plan-runner.mjs joins and escapes lines into one table
// cell; here each line is printed on its own row, so it gets a plain list.
export function outputTail({ stdout, stderr }) {
  const raw = stderr && String(stderr).trim() ? stderr : (stdout || '');
  const lines = String(raw).replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  return lines.slice(-TAIL_LINES).map((l) => (l.length > TAIL_COLS ? `${l.slice(0, TAIL_COLS)}…` : l));
}

export function taskReadiness(planText, { run, cwd, timeoutMs, onOutput }) {
  const { frontmatter } = extractFrontmatter(planText);
  const { tasks } = parseUltraPlanYaml(frontmatter);
  const lines = planText.split('\n');
  return tasks.map((t) => {
    const skipIf = typeof t.skip_if === 'string' ? t.skip_if : '';
    const kind = classifySkipIf(skipIf);
    // No command means no machine proof, so only fully ticked step boxes stand in for it, labelled as asserted.
    if (kind === 'empty' || kind === 'sentinel') return { id: t.id, state: assertedState(lines, t.id), skipIf };
    // bun test exits 0 when a named file is missing, which would read an unmerged task as DONE.
    const missing = missingTestPaths(skipIf, cwd);
    if (missing.length) return { id: t.id, state: 'OPEN', skipIf, missing, tail: ['not run: a named test file is missing'] };
    const r = run(skipIf, { cwd, timeoutMs });
    const state = r.timedOut ? 'UNREAD' : r.exit === 0 ? 'DONE' : 'OPEN';
    if (onOutput) onOutput(t.id, r);
    return { id: t.id, state, skipIf, tail: outputTail(r) };
  });
}

// The same step lines plan-mark-done ticks, so a box in a code fence never counts.
function assertedState(lines, id) {
  const range = taskSectionRange(lines, id);
  const steps = range ? stepLineIndices(lines, range.start, range.end) : [];
  return steps.length && steps.every((i) => !OPEN_STEP.test(lines[i])) ? ASSERTED : 'UNPROVEN';
}

// Only a skip_if that exited 0 is evidence; an asserted task never enters the log.
export function evidenceLines(tasks) {
  return tasks.filter((t) => t.state === 'DONE').map((t) => `${t.id}: SKIPPED-IDEMPOTENT (readiness: skip_if exit 0)`);
}

// plan-mark-done reads a status line only when it is indented, as the runner prints it.
export const evidenceLog = (tasks) => evidenceLines(tasks).map((l) => `  ${l}\n`).join('');

export function openNowRows(body) {
  let n = 0;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/`/g, '').trim());
    // Plans annotate the class and state cells ("`NOW` bila sempat"), so only the leading word decides.
    if (cells.some((c) => /^NOW\b/.test(c)) && cells.some((c) => /^OPEN\b/.test(c))) n++;
  }
  return n;
}
