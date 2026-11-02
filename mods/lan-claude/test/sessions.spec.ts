import { describe, expect, test } from "bun:test";
import { isReady, lastTextFromJsonl, parseSessionFile, sessionKey } from "../src/sessions";

const file = (o: Record<string, unknown>) => JSON.stringify({
  pid: 2916437, sessionId: "11111111-2222-4333-8444-555555555555", cwd: "/home/x/Proyek/app", kind: "interactive",
  tmux: "main:@16.%32", name: "app-01", status: "idle", statusUpdatedAt: 5, ...o,
});

describe("sessions", () => {
  test("parses Claude Code's session file into pane, window, status", () => {
    expect(parseSessionFile(file({}))).toMatchObject({ pane: "%32", window: "@16", status: "idle", name: "app-01", statusUpdatedAt: 5 });
    expect(sessionKey("11111111-2222-4333-8444-555555555555")).toBe("111111112222");
  });

  test("skips sessions outside tmux, non-interactive ones, odd ids, and broken files", () => {
    expect(parseSessionFile(file({ tmux: undefined }))).toBeNull();
    expect(parseSessionFile(file({ tmux: "main:@16.%32; rm -rf ~" }))).toBeNull();
    expect(parseSessionFile(file({ kind: "sdk" }))).toBeNull();
    expect(parseSessionFile(file({ sessionId: "../../x" }))).toBeNull();
    expect(parseSessionFile("{nope")).toBeNull();
  });

  test("last assistant text skips tool-only turns and subagent lines", () => {
    const lines = [
      { type: "assistant", message: { content: [{ type: "text", text: "lama" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "jawaban akhir" }] } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagen" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
      { type: "user", message: { content: "assistant" } },
    ].map((l) => JSON.stringify(l));
    expect(lastTextFromJsonl("partial line\n" + lines.join("\n"))).toBe("jawaban akhir");
    expect(lastTextFromJsonl("")).toBe("");
  });
});

test("a session at its prompt with a background shell running counts as ready", () => {
  expect(["idle", "shell"].map(isReady)).toEqual([true, true]);
  expect(["busy", "waiting", "", "starting"].map(isReady)).toEqual([false, false, false, false]);
});
