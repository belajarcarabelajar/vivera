import { describe, expect, test } from "bun:test";
import { hookOutput, PermissionBoard, summarizeTool } from "../src/permissions";

describe("permission board", () => {
  test("a tap resolves the waiting hook and removes the request", async () => {
    const b = new PermissionBoard(5_000);
    const p = b.open("job1", "Bash", { command: "rm -rf build" });
    expect(b.list().map((x) => x.summary)).toEqual(["rm -rf build"]);
    const w = b.wait(p.id);
    expect(b.decide(p.id, "deny")).toBe(true);
    expect(await w).toBe("deny");
    expect(b.list()).toEqual([]);
    expect(b.decide(p.id, "allow")).toBe(false);
  });

  test("no answer in time resolves to none (terminal dialog takes over)", async () => {
    const b = new PermissionBoard(20);
    const p = b.open("job1", "Write", { file_path: "/x" });
    expect(await b.wait(p.id)).toBe("none");
    expect(b.list()).toEqual([]);
  });

  test("unknown id waits for nothing", async () => {
    expect(await new PermissionBoard(1000).wait("nope")).toBe("none");
  });
});

describe("hook output", () => {
  test("allow and deny follow the PermissionRequest schema; none prints nothing", () => {
    expect(JSON.parse(hookOutput("allow"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(JSON.parse(hookOutput("deny")).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(hookOutput("none")).toBe("");
  });

  test("summaries show the part a human needs to judge", () => {
    expect(summarizeTool("Edit", { file_path: "/a.ts", old_string: "x" })).toBe("/a.ts");
    expect(summarizeTool("Bash", { command: "x".repeat(700) }).endsWith(" …")).toBe(true);
  });
});

import { PermissionBoard as Board2, type BoardEvent } from "../src/permissions";

test("board emits open and close with who decided, also on timeout", async () => {
  const b = new Board2(30);
  const seen: string[] = [];
  b.subscribe((e: BoardEvent) => seen.push(e.type === "open" ? `open:${e.pending.tool}` : `close:${e.decision}:${e.by}`));
  b.subscribe(() => { throw new Error("listener bug"); });
  const p = b.open("abcdef012345", "Bash", { command: "ls" });
  expect(b.decide(p.id, "deny", "Telegram")).toBe(true);
  const q = b.open("abcdef012345", "Edit", { file_path: "/x" });
  expect(await b.wait(q.id)).toBe("none");
  expect(seen).toEqual(["open:Bash", "close:deny:Telegram", "open:Edit", "close:none:timeout"]);
});
