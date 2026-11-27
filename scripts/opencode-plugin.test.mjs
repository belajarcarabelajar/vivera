import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideMeterNudge, decideNudge, METER_SOURCE, NUDGE_SOURCE } from "../opencode/vivera-plugin.ts";
import plugin from "../opencode/vivera-plugin.ts";
import { REASON } from "../.claude/hooks/require-exit-code.mjs";

const skill = { id: "s1", type: "skill", skill: "vivera", name: "vivera", text: "..." };
const user = { id: "u1", type: "user", text: "run the tests" };
const assistant = (id, text) => ({ id, type: "assistant", content: [{ type: "text", text }] });
const claim = assistant("a1", "Done. 12 tests pass, 0 fail.");
const base = { session: { id: "ses1" }, background: false, nudged: new Set() };

describe("decideNudge", () => {
  test("nudges a pass claim without an exit code in a vivera session", () => {
    expect(decideNudge({ ...base, items: [skill, user, claim] })).toEqual({ messageID: "a1", reason: REASON });
  });
  test("lets a pass claim with exit 0 through", () => {
    expect(decideNudge({ ...base, items: [skill, user, assistant("a1", "bun test exit 0, 12 pass, 0 fail")] })).toBeNull();
  });
  test("ignores a session where the vivera skill is not active", () => {
    expect(decideNudge({ ...base, items: [user, claim] })).toBeNull();
  });
  test("ignores a child session", () => {
    expect(decideNudge({ ...base, session: { id: "ses2", parentID: "ses1" }, items: [skill, user, claim] })).toBeNull();
  });
  test("ignores a background idle", () => {
    expect(decideNudge({ ...base, background: true, items: [skill, user, claim] })).toBeNull();
  });
  test("never nudges the same assistant message twice", () => {
    expect(decideNudge({ ...base, nudged: new Set(["a1"]), items: [skill, user, claim] })).toBeNull();
  });
  test("never nudges the rewrite that answers its own nudge", () => {
    const nudge = { id: "n1", type: "synthetic", text: REASON, metadata: { source: NUDGE_SOURCE } };
    expect(decideNudge({ ...base, items: [skill, user, claim, nudge, assistant("a2", "All 12 tests pass.")] })).toBeNull();
  });
  test("returns null for a pass claim on an assistant item without an id", () => {
    const noId = { type: "assistant", content: [{ type: "text", text: "Done. 12 tests pass, 0 fail." }] };
    expect(decideNudge({ ...base, items: [skill, user, noId] })).toBeNull();
  });
  test("returns null when the session is null", () => {
    expect(decideNudge({ ...base, session: null, items: [skill, user, claim] })).toBeNull();
  });
  test("a synthetic item from another source between the user and the answer does not suppress the nudge", () => {
    const foreign = { id: "x1", type: "synthetic", text: "some other plugin's note" };
    expect(decideNudge({ ...base, items: [skill, user, foreign, claim] })).toEqual({ messageID: "a1", reason: REASON });
  });
});

test("never nudges a rewrite turn that ran a tool between the nudge and the final answer", () => {
  const nudge = { id: "n1", type: "synthetic", text: REASON, metadata: { source: NUDGE_SOURCE } };
  const items = [skill, user, claim, nudge, assistant("a2", "Rerunning."), { id: "t1", type: "tool" }, assistant("a3", "All 12 tests pass.")];
  expect(decideNudge({ ...base, items })).toBeNull();
});
test("checks again after the user writes a new message", () => {
  const nudge = { id: "n1", type: "synthetic", text: REASON, metadata: { source: NUDGE_SOURCE } };
  const items = [skill, user, claim, nudge, assistant("a2", "bun test exit 0"), { id: "u2", type: "user", text: "now the lint" }, assistant("a3", "Lint passes.")];
  expect(decideNudge({ ...base, items })).toEqual({ messageID: "a3", reason: REASON });
});

describe("single source", () => {
  test("the plugin imports check() from the Claude Code hook instead of copying its patterns", () => {
    const src = readFileSync(new URL("../opencode/vivera-plugin.ts", import.meta.url), "utf8");
    expect(src).toContain("../.claude/hooks/require-exit-code.mjs");
    expect(src).not.toContain("PASS_CLAIM");
  });
});

describe("package entry", () => {
  test("package.json exports the plugin as the default and the server entry", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.exports?.["."]).toBe("./opencode/vivera-plugin.ts");
    expect(pkg.exports?.["./server"]).toBe("./opencode/vivera-plugin.ts");
  });
});

describe("plugin wiring", () => {
  function fakeCtx(items) {
    const calls = { synthetic: [] };
    let idle;
    const ctx = {
      session: {
        hook: async (name, fn) => { if (name === "experimental.idle") idle = fn; },
        get: async ({ sessionID }) => ({ id: sessionID }),
        context: async () => items,
        synthetic: async (input) => { calls.synthetic.push(input); },
      },
    };
    return { ctx, calls, fire: (e) => idle(e) };
  }
  test("adds one synthetic message tagged with its source on a matching idle, and none on the next idle", async () => {
    const { ctx, calls, fire } = fakeCtx([skill, user, assistant(crypto.randomUUID(), "Done. 12 tests pass, 0 fail.")]);
    await plugin.setup(ctx);
    await fire({ sessionID: "ses1", background: false });
    await fire({ sessionID: "ses1", background: false });
    expect(calls.synthetic).toHaveLength(1);
    expect(calls.synthetic[0]).toMatchObject({ sessionID: "ses1", text: REASON, metadata: { source: NUDGE_SOURCE } });
  });
  test("an error while reading the session ends the turn quietly", async () => {
    const { ctx, calls, fire } = fakeCtx([]);
    ctx.session.context = async () => { throw new Error("boom"); };
    await plugin.setup(ctx);
    await fire({ sessionID: "ses1", background: false });
    expect(calls.synthetic).toHaveLength(0);
  });
  test("a session context that is not an array adds no synthetic message and does not throw", async () => {
    // An array-like that Array methods accept but Array.isArray rejects, so dropping the guard would nudge
    // instead of failing inside the catch.
    const arrayLike = Object.assign(Object.create(Array.prototype), {
      0: skill, 1: user, 2: assistant(crypto.randomUUID(), "Done. 12 tests pass, 0 fail."), length: 3,
    });
    expect(Array.isArray(arrayLike)).toBe(false);
    for (const value of [arrayLike, null, undefined, "items", { items: [skill, user, claim] }]) {
      const { ctx, calls, fire } = fakeCtx([]);
      ctx.session.context = async () => value;
      await plugin.setup(ctx);
      await expect(fire({ sessionID: "ses1", background: false })).resolves.toBeUndefined();
      expect(calls.synthetic).toHaveLength(0);
    }
  });
});

describe("progress meter", () => {
  // One of two task steps checked, so the expected first line is this bar.
  const PLAN = ["---", "status: Approved", "---", "### Task T1: A", "- [x] Step 1", "- [ ] Step 2", ""].join("\n");
  const BAR = "▰▰▰▰▰▱▱▱▱▱ 50% · 1/2 · Task T1: A";
  function planDir() {
    const dir = mkdtempSync(join(tmpdir(), "vivera-plugin-meter-"));
    mkdirSync(join(dir, "docs", "code-plan", "plans"), { recursive: true });
    const planPath = join(dir, "docs", "code-plan", "plans", "2026-11-27-demo.md");
    writeFileSync(planPath, PLAN);
    return { dir, planPath };
  }
  const read = (p) => ({ id: "t1", type: "tool", tool: "read", input: { filePath: p } });

  test("nudges an answer without the meter while the session's plan is open", () => {
    const { dir, planPath } = planDir();
    const verdict = decideMeterNudge({ ...base, cwd: dir, items: [skill, user, read(planPath), assistant("a1", "T1 step 1 done.")] });
    expect(verdict?.messageID).toBe("a1");
    expect(verdict?.reason).toContain(BAR);
    expect(verdict?.reason).toContain(planPath);
  });
  test("lets an answer that opens with the matching meter through", () => {
    const { dir, planPath } = planDir();
    expect(decideMeterNudge({ ...base, cwd: dir, items: [skill, user, read(planPath), assistant("a1", `${BAR}\n\nStep 1 done.`)] })).toBeNull();
  });
  test("resolves a relative plan path against the given directory", () => {
    const { dir } = planDir();
    const verdict = decideMeterNudge({ ...base, cwd: dir, items: [skill, user, read("docs/code-plan/plans/2026-11-27-demo.md"), assistant("a1", "Update.")] });
    expect(verdict?.reason).toContain(BAR);
  });
  test("ignores a session where the vivera skill is not active", () => {
    const { dir, planPath } = planDir();
    expect(decideMeterNudge({ ...base, cwd: dir, items: [user, read(planPath), assistant("a1", "Update.")] })).toBeNull();
  });
  test("never nudges the same assistant message twice", () => {
    const { dir, planPath } = planDir();
    expect(decideMeterNudge({ ...base, cwd: dir, nudged: new Set(["a1"]), items: [skill, user, read(planPath), assistant("a1", "Update.")] })).toBeNull();
  });
  test("never nudges the rewrite that answers a nudge from either source", () => {
    const { dir, planPath } = planDir();
    for (const source of [METER_SOURCE, NUDGE_SOURCE]) {
      const nudge = { id: "n1", type: "synthetic", text: "rewrite", metadata: { source } };
      const items = [skill, user, read(planPath), assistant("a1", "Update."), nudge, assistant("a2", "Still no meter.")];
      expect(decideMeterNudge({ ...base, cwd: dir, items })).toBeNull();
    }
  });
  test("the exit-code check never nudges the rewrite that answers a meter nudge", () => {
    const nudge = { id: "n1", type: "synthetic", text: "meter", metadata: { source: METER_SOURCE } };
    expect(decideNudge({ ...base, items: [skill, user, assistant("a1", "Update."), nudge, assistant("a2", "All 12 tests pass.")] })).toBeNull();
  });

  function wired(items) {
    const calls = { synthetic: [] };
    let idle;
    const ctx = {
      session: {
        hook: async (name, fn) => { if (name === "experimental.idle") idle = fn; },
        get: async ({ sessionID }) => ({ id: sessionID }),
        context: async () => items,
        synthetic: async (input) => { calls.synthetic.push(input); },
      },
    };
    return { ctx, calls, fire: (e) => idle(e) };
  }
  test("the idle hook adds one meter nudge tagged with its own source, and none on the next idle", async () => {
    const { planPath } = planDir();
    const { ctx, calls, fire } = wired([skill, user, read(planPath), assistant(crypto.randomUUID(), "Step 1 done.")]);
    await plugin.setup(ctx);
    await fire({ sessionID: "ses1", background: false });
    await fire({ sessionID: "ses1", background: false });
    expect(calls.synthetic).toHaveLength(1);
    expect(calls.synthetic[0].metadata).toEqual({ source: METER_SOURCE });
    expect(calls.synthetic[0].text).toContain(BAR);
  });
  test("the idle hook sends only the exit-code nudge when both checks fail", async () => {
    const { planPath } = planDir();
    const { ctx, calls, fire } = wired([skill, user, read(planPath), assistant(crypto.randomUUID(), "Done. 12 tests pass, 0 fail.")]);
    await plugin.setup(ctx);
    await fire({ sessionID: "ses1", background: false });
    expect(calls.synthetic).toHaveLength(1);
    expect(calls.synthetic[0]).toMatchObject({ text: REASON, metadata: { source: NUDGE_SOURCE } });
  });
});
