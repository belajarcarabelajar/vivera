// scripts/require-exit-code.test.mjs
//
// The Stop hook that sends a final message back when it claims a pass without an exit code.
// Unit cases go through check(); the spawn cases feed the hook JSON on stdin the way Claude Code
// does, and the frontmatter case runs the orchestrator's own hook command under sh.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { check } from "../.claude/hooks/require-exit-code.mjs";

const ROOT = path.join(import.meta.dir, "..");
const HOOK = path.join(ROOT, ".claude", "hooks", "require-exit-code.mjs");
const MASTER = path.join(ROOT, "Super Ultra Code Plan Implementation.md");

// The final message of a failing evidence-exit-code-cited run: pass counts, no exit code.
const OBSERVED_FAIL = "Done. Added `multiply(a, b)` to math.mjs with a test in math.test.mjs. `bun test`: 4 passed, 0 failed.";

// A failing run with the hook installed: the pipe-safe capture `echo "exit=${PIPESTATUS[0]}"` was
// denied, the plain rerun printed no code, and this wording slipped past the first pass patterns.
const OBSERVED_SLIP = "I wrote the test first. It failed because `math.mjs` had no `multiply` export yet. After I added the function, `bun test` passed all 4 tests with 0 failures.";

const BLOCKED = [
  OBSERVED_FAIL,
  OBSERVED_SLIP,
  // The red run's code is not the green run's: a pass claim needs exit 0.
  "Test first: `bun test` exit 1 (multiply missing). After adding it: 4 pass, 0 fail.",
  "Done: multiply added, test green.",
  "`bun test`: 0 failures.",
  // The rule asks for the words "exit 0"; the scenario does not read "with".
  "`bun test` exits with code 0: 4 pass, 0 fail.",
  "All tests pass.",
  "The suite is green.",
  "Tests now pass after the fix.",
  "bun test: 12 pass, 0 fail",
  "Typecheck passes and lint passes.",
  "Semua tes lulus.",
];

const ALLOWED = [
  "Done. `bun test` exit 0, 4 pass, 0 fail.",
  "`bun test` exited 0 (4 pass, 0 fail).",
  "Ran `bun test; echo \"exit=$?\"`: exit=0, 4 pass.",
  "`bun test` exit code 0: all tests pass.",
  // A failing report names a nonzero code and the failures; it claims no pass.
  "`bun test` exits with code 1: 3 pass, 1 fail.",
  "`bun test` exit 1: 3 passed, 2 failed.",
  // No pass claim at all: a gate, a plan, a question.
  "Which approach should I take?\n\n1. Add multiply inline\n2. Split into a module",
  "The new test should pass once the function exists.",
  "Acceptance: `bun test` passes with the new multiply test.\n\n1. Approve\n2. Change the design",
  "I have not run the tests yet.",
  "",
];

describe("check", () => {
  for (const message of BLOCKED) {
    test(`blocks: ${JSON.stringify(message)}`, () => {
      expect(check({ last_assistant_message: message })).toContain("exit 0");
    });
  }
  for (const message of ALLOWED) {
    test(`allows: ${JSON.stringify(message)}`, () => {
      expect(check({ last_assistant_message: message })).toBeNull();
    });
  }

  test("allows the rewrite a block already asked for, so it never loops", () => {
    expect(check({ last_assistant_message: OBSERVED_FAIL, stop_hook_active: true })).toBeNull();
  });

  test("allows input without a message", () => {
    expect(check({})).toBeNull();
    expect(check(null)).toBeNull();
  });
});

function spawn(stdin, opts = {}) {
  const r = Bun.spawnSync(opts.cmd ?? ["bun", HOOK], { stdin: Buffer.from(stdin), env: opts.env });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("hook process", () => {
  test("prints a block decision with the reason", () => {
    const r = spawn(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: OBSERVED_FAIL }));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("exit 0");
  });

  test("prints nothing when the message names its exit code", () => {
    const r = spawn(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: ALLOWED[0] }));
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
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
  const command = fm.hooks?.Stop?.[0]?.hooks?.[0]?.command;

  test("registers the hook on Stop", () => {
    expect(fm.hooks.Stop[0].hooks[0].type).toBe("command");
    expect(command).toContain("require-exit-code.mjs");
  });

  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "require-exit-code-"));
  const install = (skillsDir) => {
    const dir = path.join(skillsDir, "super-ultra-code-plan");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(HOOK, path.join(dir, "require-exit-code.mjs"));
  };
  const payload = JSON.stringify({ hook_event_name: "Stop", last_assistant_message: OBSERVED_FAIL });
  const baseEnv = { PATH: process.env.PATH };

  test("finds the script in the project's skills directory", () => {
    const project = scratch();
    const home = scratch();
    install(path.join(project, ".claude", "skills"));
    const r = spawn(payload, { cmd: ["sh", "-c", command], env: { ...baseEnv, HOME: home, CLAUDE_PROJECT_DIR: project } });
    expect(JSON.parse(r.stdout).decision).toBe("block");
  });

  test("finds the script in the user's skills directory, also under CLAUDE_CONFIG_DIR", () => {
    const project = scratch();
    const home = scratch();
    install(path.join(home, ".claude", "skills"));
    const r = spawn(payload, { cmd: ["sh", "-c", command], env: { ...baseEnv, HOME: home, CLAUDE_PROJECT_DIR: project } });
    expect(JSON.parse(r.stdout).decision).toBe("block");

    const config = scratch();
    install(path.join(config, "skills"));
    const r2 = spawn(payload, { cmd: ["sh", "-c", command], env: { ...baseEnv, HOME: scratch(), CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project } });
    expect(JSON.parse(r2.stdout).decision).toBe("block");
  });

  test("lets the stop through when the script is not installed", () => {
    const r = spawn(payload, { cmd: ["sh", "-c", command], env: { ...baseEnv, HOME: scratch(), CLAUDE_PROJECT_DIR: scratch() } });
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
