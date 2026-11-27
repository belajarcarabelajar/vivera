// scripts/require-progress-meter.test.mjs
//
// The Stop hook that sends a turn-end message back when a plan checklist exists and the
// message does not open with the progress meter. Unit cases go through check() with a real
// transcript and plan on disk; the spawn cases feed the hook JSON on stdin the way Claude Code does.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, countSteps } from "../.claude/hooks/require-progress-meter.mjs";
import { parse } from "yaml";
import { planStatus } from "./plan-status.mjs";

const ROOT = path.join(import.meta.dir, "..");
const HOOK = path.join(ROOT, ".claude", "hooks", "require-progress-meter.mjs");
const MASTER = path.join(ROOT, "VIVERA.md");

// Two of five task steps checked; a fenced example and a non-task box must not count.
const PLAN = [
  "---",
  "schema: ultra-plan/v1",
  "plan_id: 2026-11-27-demo",
  "status: Approved",
  "---",
  "# Demo",
  "- [ ] not a step: outside any Task section",
  "```",
  "- [ ] fenced example",
  "```",
  "### Task T1: Hook",
  "- [x] Step 1 (RED)",
  "- [x] Step 2 (GREEN)",
  "### Task T2: Rule text",
  "- [ ] Step 1: edit",
  "- [ ] Step 2: validate",
  "### Task T3: Pull request",
  "- [ ] Step 1: open",
  "## Approval",
  "- [ ] Merge",
  "",
].join("\n");

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "require-progress-meter-"));

// A transcript line in Claude Code's JSONL shape: an assistant tool_use that touched a path.
const touch = (p) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: p } }] } });

function session({ plan = PLAN, planName = "2026-11-27-demo.md", lines } = {}) {
  const dir = scratch();
  const plans = path.join(dir, "docs", "code-plan", "plans");
  fs.mkdirSync(plans, { recursive: true });
  const planPath = path.join(plans, planName);
  if (plan !== null) fs.writeFileSync(planPath, plan);
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(transcript, (lines ?? [touch(planPath)]).join("\n") + "\n");
  return { dir, planPath, transcript };
}

const input = (s, message, extra = {}) => ({ hook_event_name: "Stop", cwd: s.dir, transcript_path: s.transcript, last_assistant_message: message, ...extra });

const BAR = "▰▰▰▰▱▱▱▱▱▱ 40% · 2/5 · Task T2: Rule text";

describe("countSteps", () => {
  test("counts only boxes inside Task sections, outside code fences", () => {
    expect(countSteps(PLAN)).toEqual({ done: 2, total: 5, current: "Task T2: Rule text" });
  });

  test("agrees with plan-status on the fixture and on every plan in this checkout", () => {
    const dir = path.join(ROOT, "docs", "code-plan", "plans");
    const real = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")) : [];
    for (const md of [PLAN, ...real]) {
      const { done, total } = countSteps(md);
      expect({ done, total }).toEqual(planStatus(md).task_steps);
    }
  });
});

describe("check", () => {
  test("blocks a message without a meter and hands back the computed bar", () => {
    const s = session();
    const reason = check(input(s, "T1 is done; moving on to the rule text."));
    expect(reason).toContain("▰▰▰▰▱▱▱▱▱▱ 40% · 2/5 · Task T2: Rule text");
    expect(reason).toContain(s.planPath);
  });

  test("blocks a bar whose N/M differs from the plan file", () => {
    const s = session();
    expect(check(input(s, "▰▰▰▰▰▰▱▱▱▱ 60% · 3/5 · Task T2\n\nUpdate."))).toContain("2/5");
  });

  test("blocks a bar whose segments or percent disagree with its own N/M", () => {
    const s = session();
    expect(check(input(s, "▰▰▰▰▰▱▱▱▱▱ 50% · 2/5 · Task T2"))).not.toBeNull();
  });

  test("allows a correct bar on the first non-empty line", () => {
    const s = session();
    expect(check(input(s, `\n${BAR}\n\nT1 done.`))).toBeNull();
    expect(check(input(s, `${BAR} (+1 item)\n\nFound one more step.`))).toBeNull();
  });

  test("allows a debt-sweep star line", () => {
    const s = session();
    expect(check(input(s, "★★★☆☆\n\nThree of five debts closed."))).toBeNull();
  });

  test("allows the rewrite a block already asked for, so it never loops", () => {
    const s = session();
    expect(check(input(s, "No meter here.", { stop_hook_active: true }))).toBeNull();
  });

  test("allows a session that never touched a plan", () => {
    const s = session({ lines: [JSON.stringify({ type: "user", message: { content: "hello" } })] });
    expect(check(input(s, "Plain answer."))).toBeNull();
  });

  test("allows when the plan file is gone, has no steps, or is Complete", () => {
    expect(check(input(session({ plan: null }), "Plain answer."))).toBeNull();
    expect(check(input(session({ plan: "# Empty\n- [ ] loose box\n" }), "Plain answer."))).toBeNull();
    expect(check(input(session({ plan: PLAN.replace("status: Approved", "status: Complete") }), "Plain answer."))).toBeNull();
  });

  test("allows input without a transcript or a message", () => {
    expect(check({})).toBeNull();
    expect(check(null)).toBeNull();
    expect(check({ transcript_path: "/nonexistent/transcript.jsonl", last_assistant_message: "x" })).toBeNull();
  });

  test("uses the last plan the session touched, resolving a relative path against cwd", () => {
    const s = session();
    const other = path.join(s.dir, "docs", "code-plan", "plans", "2026-11-28-other.md");
    fs.writeFileSync(other, PLAN.replace("- [ ] Step 1: edit", "- [x] Step 1: edit"));
    fs.writeFileSync(s.transcript, [touch(s.planPath), touch("docs/code-plan/plans/2026-11-28-other.md")].join("\n") + "\n");
    expect(check(input(s, "Update."))).toContain("3/5");
  });

  test("skips a later path that does not exist and falls back to an earlier one", () => {
    const s = session();
    fs.writeFileSync(s.transcript, [touch(s.planPath), touch("/nowhere/docs/code-plan/plans/2026-01-01-gone.md")].join("\n") + "\n");
    expect(check(input(s, "Update."))).toContain("2/5");
  });
});

function spawn(stdin) {
  const r = Bun.spawnSync(["bun", HOOK], { stdin: Buffer.from(stdin) });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("hook process", () => {
  test("prints a block decision with the reason", () => {
    const s = session();
    const r = spawn(JSON.stringify(input(s, "Update without a meter.")));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("2/5");
  });

  test("prints nothing when the message opens with the right bar", () => {
    const s = session();
    expect(spawn(JSON.stringify(input(s, BAR)))).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("lets the stop through on input it cannot parse", () => {
    const r = spawn("not json");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("orchestrator frontmatter", () => {
  const text = fs.readFileSync(MASTER, "utf8");
  const fm = parse(text.slice(4, text.indexOf("\n---", 3)));
  const stop = fm.hooks?.Stop?.[0]?.hooks ?? [];
  const entry = stop.find((h) => h.command?.includes("require-progress-meter.mjs"));
  const command = entry?.command;

  test("registers the hook on Stop after require-exit-code", () => {
    expect(entry?.type).toBe("command");
    expect(stop[0].command).toContain("require-exit-code.mjs");
  });

  const install = (skillsDir) => {
    const dir = path.join(skillsDir, "vivera");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(HOOK, path.join(dir, "require-progress-meter.mjs"));
  };
  const run = (stdin, env) => {
    const r = Bun.spawnSync(["sh", "-c", command], { stdin: Buffer.from(stdin), env: { PATH: process.env.PATH, ...env } });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };

  test("finds the script in the project's skills directory", () => {
    const s = session();
    const project = scratch();
    install(path.join(project, ".claude", "skills"));
    const r = run(JSON.stringify(input(s, "Update without a meter.")), { HOME: scratch(), CLAUDE_PROJECT_DIR: project });
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  test("finds the script in the user's skills directory", () => {
    const s = session();
    const home = scratch();
    install(path.join(home, ".claude", "skills"));
    const r = run(JSON.stringify(input(s, "Update without a meter.")), { HOME: home, CLAUDE_PROJECT_DIR: scratch() });
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  test("lets the stop through when the script is not installed", () => {
    const s = session();
    const r = run(JSON.stringify(input(s, "Update without a meter.")), { HOME: scratch(), CLAUDE_PROJECT_DIR: scratch() });
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
