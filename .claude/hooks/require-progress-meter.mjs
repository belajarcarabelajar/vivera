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
// no existing file matches. Over-catches: a plain answer in a session that has an open plan is asked
// for the meter too (one bounce at most), and a later mention of another open plan takes over. A plan
// whose status is Complete, Abandoned or Superseded is skipped. `+1 item` may follow N/M or the item.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const PLAN_DIR = "docs/code-plan/plans/";
const PLAN_NAME = /[\w.-]+\.md/y;
const PATH_CHAR = /[\w.@+~\/-]/;
const STEP = /^\s*[-*] \[([ xX])\]\s*(.*)$/;
const TASK = /^###\s+(Task\b.*)$/;
const FENCE = /^\s*(\`\`\`|~~~)/;
const BAR = /^`?([▰▱]{10})`?\s+(\d{1,3})%\s*·\s*(\d+)\/(\d+)\s*(?:\(?\+\d+ items?\)?\s*)?·\s*\S/;
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

// Every `docs/code-plan/plans/<name>.md` mention, last first. A literal search plus a bounded walk
// left over path characters keeps this linear: a regex with a repeated directory group backtracks
// quadratically on base64-shaped output (14.7 s on 200 KB, review round 1).
function* planMentions(transcript) {
  let at = transcript.lastIndexOf(PLAN_DIR);
  while (at !== -1) {
    PLAN_NAME.lastIndex = at + PLAN_DIR.length;
    const name = PLAN_NAME.exec(transcript);
    if (name) {
      let start = at;
      while (start > 0 && at - start < 400 && PATH_CHAR.test(transcript[start - 1])) start--;
      yield transcript.slice(start, at) + PLAN_DIR + name[0];
    }
    at = at === 0 ? -1 : transcript.lastIndexOf(PLAN_DIR, at - 1);
  }
}

// The last mentioned plan that exists and is still open. A closed plan mentioned later (a git log,
// an ls) is skipped, so it neither ends enforcement nor replaces the plan in progress.
function resolvePlan(transcript, cwd) {
  for (const raw of planMentions(transcript)) {
    const p = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : join(cwd ?? ".", raw);
    if (!existsSync(p)) continue;
    const md = readFileSync(p, "utf8");
    if (CLOSED.test(md.slice(0, 2000))) continue;
    return { path: p, md };
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

export function checkMeter(input) {
  if (!input || input.stop_hook_active || !input.transcript_path) return null;
  // No message field means a harness that does not send it: fail open, like require-exit-code.
  if (input.last_assistant_message == null) return null;
  if (!existsSync(input.transcript_path)) return null;
  return meterReason({ transcript: readFileSync(input.transcript_path, "utf8"), cwd: input.cwd, message: input.last_assistant_message });
}

// The check on transcript text, for a harness with no transcript file (the OpenCode plugin passes
// its session context as JSON).
export function meterReason({ transcript, cwd, message }) {
  const found = resolvePlan(String(transcript ?? ""), cwd);
  if (!found) return null;
  const plan = found.path;
  const steps = countSteps(found.md);
  if (steps.total === 0) return null;
  const first = String(message ?? "").split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
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
    const reason = checkMeter(JSON.parse(await Bun.stdin.text()));
    if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } catch {
    // Unparseable input or an unreadable file lets the stop through.
  }
  process.exit(0);
}
