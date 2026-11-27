#!/usr/bin/env bun
// .claude/hooks/require-progress-meter.mjs
//
// Stop hook that the vivera skill registers in its frontmatter: while the session works from a plan
// checklist, a turn-end message opens with the progress meter ("Progress Meter at Checkpoints" in
// vivera-rules reference 06). Rule text alone did not hold: 7 sessions without a trigger snippet that
// loaded the skill and wrote a plan checklist printed 0 meter lines in about 500 assistant messages
// (transcript scan, 2026-11-27); the rule then sat only in reference 06, which no status message loads.
//
// The plan is the last `docs/code-plan/plans/<name>.md` path in the transcript that exists on disk
// (absolute, or relative to the session cwd). Its steps are counted the way plan-status.mjs counts
// them: boxes inside `### Task` sections, outside code fences. The message passes when its first
// non-empty line is a debt-sweep star line or a bar whose N/M, percent and filled segments match the
// file. A block is {"decision":"block"} on stdout, so Claude rewrites the message once; a rewrite is
// never blocked again (stop_hook_active), and every failure exits 0 with no output, because a crashing
// Stop hook must not trap the session.
//
// Does not catch: a plan path the transcript only spells through a variable (`${dir}/docs/...`), so
// no existing file matches. Over-catches: a plain answer in a session that has touched an open plan is
// asked for the meter too (one bounce at most). A plan whose status is Complete is not enforced.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const PLAN_PATH = /(?:~\/|\/)?(?:[\w.@+-]+\/)*docs\/code-plan\/plans\/[\w.-]+\.md/g;
const STEP = /^\s*[-*] \[([ xX])\]\s*(.*)$/;
const TASK = /^###\s+(Task\b.*)$/;
const FENCE = /^\s*(\`\`\`|~~~)/;
const BAR = /^\`?([▰▱]{10})\`?\s+(\d{1,3})%\s*·\s*(\d+)\/(\d+)\s*·\s*\S/;
const STARS = /^\`?[★☆]+(?:\`|\s|$)/;
const CLOSED = /^\s*status:\s*(Complete|Abandoned|Superseded)\s*$/im;

// Steps of the plan: boxes inside a Task section (which ends at the next level 2 or 3 heading),
// outside code fences. `current` is the first Task section with an open box.
export function countSteps(md) {
  let done = 0;
  let total = 0;
  let current = null;
  let fenced = false;
  let task = null;
  for (const line of String(md).split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const t = TASK.exec(line);
    if (t) {
      task = t[1].trim();
      continue;
    }
    if (/^#{2,3}\s/.test(line)) task = null;
    const s = STEP.exec(line);
    if (!s || task === null) continue;
    total++;
    if (s[1] !== " ") done++;
    else current ??= task;
  }
  return { done, total, current };
}

export function meterLine({ done, total, current }) {
  const filled = Math.floor((done * 10) / total);
  const pct = Math.floor((done * 100) / total);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${pct}% · ${done}/${total} · ${current ?? "done"}`;
}

function resolvePlan(transcript, cwd) {
  const found = transcript.match(PLAN_PATH) ?? [];
  for (let i = found.length - 1; i >= 0; i--) {
    const raw = found[i];
    const p = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : join(cwd ?? ".", raw);
    if (existsSync(p)) return p;
  }
  return null;
}

function meterMatches(first, steps) {
  if (STARS.test(first)) return true;
  const m = BAR.exec(first);
  if (!m) return false;
  const [, bar, pct, n, total] = m;
  const expected = meterLine(steps);
  return Number(n) === steps.done && Number(total) === steps.total && expected.startsWith(`${bar} ${pct}% · `);
}

export function check(input) {
  if (!input || input.stop_hook_active || !input.transcript_path) return null;
  if (!existsSync(input.transcript_path)) return null;
  const plan = resolvePlan(readFileSync(input.transcript_path, "utf8"), input.cwd);
  if (!plan) return null;
  const md = readFileSync(plan, "utf8");
  if (CLOSED.test(md.slice(0, 2000))) return null;
  const steps = countSteps(md);
  if (steps.total === 0) return null;
  const message = String(input.last_assistant_message ?? "");
  const first = message.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
  if (meterMatches(first, steps)) return null;
  return [
    `This session works from the plan ${plan} (${steps.done} of ${steps.total} task steps checked).`,
    "Rewrite your message so its first line is the progress meter computed from that file:\n",
    `${meterLine(steps)}\n`,
    "During the debt sweep use one star per debt instead (★ closed, ☆ open). Keep the rest of the",
    "message as it was and start no new work. The meter stays in chat; never write it into a file.",
  ].join(" ").replace(/ ?\n ?/g, "\n");
}

if (import.meta.main) {
  try {
    const reason = check(JSON.parse(await Bun.stdin.text()));
    if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } catch {
    // Unparseable input or an unreadable file lets the stop through.
  }
  process.exit(0);
}
