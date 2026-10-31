#!/usr/bin/env bun
// scripts/plan-status.mjs
//
// Prints a resumed session's state computed from the plan file and its overnight
// handoff on disk: plan id and status, task steps done/total, current and next
// task, open approval gates, and the handoff's Result and Last update with a
// stale flag. The block comes from the files, never from model text, so a
// poisoned summary cannot steer the resumed session.
//
//   bun scripts/plan-status.mjs <plan.md> [--stale-hours N] [--now <ISO>] [--json]
//
// Exit codes: 0 ok, 1 missing plan file, 2 usage error.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';

const USAGE = 'usage: plan-status.mjs <plan.md> [--stale-hours N] [--now <ISO>] [--json]';
const STEP = /^\s*[-*] \[([ xX])\]\s*(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
// The gate section itself, not a heading that mentions approval in passing
// ("Affected Surfaces - approval gate blocker if empty").
const GATE_HEADING = /^(?:[\d.]+[a-z]?\.?\s+)?(?:(?:human|partner)\s+)?approvals?(?:\s+gates?)?$/i;
const TASK = /^###\s+(Task\b.*)$/;
const FENCE = /^\s*(```|~~~)/;

function frontmatterOf(md) {
  try {
    const { frontmatter } = extractFrontmatter(md);
    const plan = parseUltraPlanYaml(frontmatter);
    return { plan_id: plan.plan_id ?? null, status: plan.status ?? null };
  } catch {
    return { plan_id: null, status: null };
  }
}

// Lines outside code fences, so template examples are never counted as steps.
function proseLines(md) {
  const out = [];
  let fenced = false;
  for (const line of md.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function openGates(lines) {
  const gates = [];
  let inGate = false;
  let header = true;
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      inGate = GATE_HEADING.test(h[2]);
      header = true;
      continue;
    }
    if (!inGate) continue;
    const box = STEP.exec(line);
    if (box) {
      if (box[1] === ' ') gates.push(box[2].replace(/\*\*/g, '').trim());
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    const [gate, answer = ''] = cells(line);
    if (header) {
      header = false;
      continue;
    }
    if (/^:?-+:?$/.test(gate)) continue;
    const a = answer.replace(/`/g, '').trim();
    if (a === '' || a.toLowerCase() === 'pending') gates.push(gate.replace(/`/g, ''));
  }
  return gates;
}

function field(text, name) {
  const re = new RegExp(`^\\s*(?:[-*]\\s+)?\\**${name}\\**\\s*:\\s*\\**\\s*(.+?)\\s*$`, 'im');
  return re.exec(text)?.[1] ?? null;
}

function overnightOf(handoff, now, staleHours) {
  if (handoff == null) return null;
  const result = field(handoff, 'Result');
  const last = field(handoff, 'Last update');
  const when = last ? Date.parse(last.split(/\s+/)[0]) : NaN;
  let stale;
  if (Number.isNaN(when)) stale = 'unknown';
  else stale = /^running\b/i.test(result ?? '') && now.getTime() - when > staleHours * 3_600_000;
  return { result, last_update: last, stale };
}

export function planStatus(md, { handoff = null, now = new Date(), staleHours = 2 } = {}) {
  const { plan_id, status } = frontmatterOf(md);
  const lines = proseLines(md);
  let done = 0;
  let total = 0;
  const tasks = [];
  // Only boxes inside a Task section are steps; a Task section ends at the next
  // heading of level 2 or 3, as plan-closeout reads it.
  let task = null;
  for (const line of lines) {
    const t = TASK.exec(line);
    if (t) {
      task = { title: t[1].trim(), open: false };
      tasks.push(task);
      continue;
    }
    if (/^#{2,3}\s/.test(line)) task = null;
    const s = STEP.exec(line);
    if (!s || !task) continue;
    total++;
    if (s[1] === ' ') task.open = true;
    else done++;
  }
  const open = tasks.filter((t) => t.open);
  return {
    plan_id,
    status,
    task_steps: { done, total },
    current: open[0]?.title ?? null,
    next: open[1]?.title ?? null,
    open_gates: openGates(lines),
    overnight: overnightOf(handoff, now, staleHours),
  };
}

function render(s, handoffPath) {
  const out = [
    `plan: ${s.plan_id ?? 'unknown'}`,
    `status: ${s.status ?? 'unknown'}`,
    `task steps: ${s.task_steps.done}/${s.task_steps.total}`,
    `current: ${s.current ?? 'none'}`,
    `next: ${s.next ?? 'none'}`,
    `open gates: ${s.open_gates.length ? s.open_gates.join(', ') : 'none'}`,
  ];
  if (!s.overnight) out.push('overnight: none');
  else {
    const stale = s.overnight.stale === 'unknown' ? 'unknown' : s.overnight.stale ? 'yes' : 'no';
    out.push(
      `overnight: ${handoffPath}`,
      `result: ${s.overnight.result ?? 'unknown'}`,
      `last update: ${s.overnight.last_update ?? 'unknown'}`,
      `stale: ${stale}`,
    );
  }
  return out.join('\n');
}

function usage(msg) {
  if (msg) console.error(`plan-status: ${msg}`);
  console.error(USAGE);
  process.exit(2);
}

function main(argv) {
  let planPath = null;
  let staleHours = 2;
  let now = new Date();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--stale-hours') {
      staleHours = Number(argv[++i]);
      if (!Number.isFinite(staleHours) || staleHours < 0) usage('--stale-hours needs a number');
    } else if (a === '--now') {
      now = new Date(argv[++i] ?? '');
      if (Number.isNaN(now.getTime())) usage('--now needs an ISO 8601 time');
    } else if (a.startsWith('-')) usage(`unknown flag ${a}`);
    else if (planPath) usage('only one plan file');
    else planPath = a;
  }
  if (!planPath) usage();
  if (!existsSync(planPath)) {
    console.error(`plan-status: no plan file at ${planPath}`);
    process.exit(1);
  }
  const md = readFileSync(planPath, 'utf8');
  const id = frontmatterOf(md).plan_id ?? basename(planPath, '.md');
  const handoffPath = join(dirname(planPath), `${id}-overnight-handoff.md`);
  const handoff = existsSync(handoffPath) ? readFileSync(handoffPath, 'utf8') : null;
  const s = planStatus(md, { handoff, now, staleHours });
  console.log(json ? JSON.stringify({ ...s, handoff: handoff == null ? null : handoffPath }, null, 2) : render(s, handoffPath));
}

if (import.meta.main) main(process.argv.slice(2));
