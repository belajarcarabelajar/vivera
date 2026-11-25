import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decideNudge, NUDGE_SOURCE } from "../opencode/vivera-plugin.ts";
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
