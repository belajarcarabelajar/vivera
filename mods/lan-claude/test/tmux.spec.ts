import { describe, expect, test } from "bun:test";
import { newWindowArgs, parentComm, parseClients, pickSession } from "../src/tmux";

describe("tmux target", () => {
  const clients = parseClients("101\tmain\t50\n202\twork\t90\n303\tssh\t99\nbad line\n");

  test("parses client lines and drops junk", () => {
    expect(clients).toEqual([
      { pid: 101, session: "main", activity: 50 },
      { pid: 202, session: "work", activity: 90 },
      { pid: 303, session: "ssh", activity: 99 },
    ]);
  });

  test("picks the most recently active client inside Alacritty, ignoring others", () => {
    const comm = (pid: number) => (pid === 303 ? "sshd" : "alacritty");
    expect(pickSession(clients, comm)).toBe("work");
  });

  test("no Alacritty client means no target", () => {
    expect(pickSession(clients, () => "sshd")).toBeNull();
    expect(pickSession([], () => "alacritty")).toBeNull();
  });

  test("reads the parent comm even when comm has spaces and parens", () => {
    const files: Record<string, string> = {
      "/proc/42/stat": "42 (tmux: client (x)) S 7 42 42 0",
      "/proc/7/comm": "alacritty\n",
    };
    expect(parentComm(42, (p) => files[p])).toBe("alacritty");
    expect(parentComm(43, () => { throw new Error("gone"); })).toBeNull();
  });

  test("new window is detached and the job id is the only launcher argument", () => {
    expect(newWindowArgs("main", "hp-abc", "/home/u/Proyek/x", "/app/bin/launch-claude.sh", "abc")).toEqual([
      "new-window", "-d", "-t", "main:", "-n", "hp-abc", "-c", "/home/u/Proyek/x", "-P", "-F", "#{window_id}", "--", "/app/bin/launch-claude.sh", "abc",
    ]);
  });
});

import { parsePicker, pickerTarget } from "../src/tmux";
test("parses the /model picker and finds the newest version for an alias", () => {
  const screen = [
    "   Select model",
    "     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks",
    "     2.  Opus 5.5               For complex work and everyday tasks",
    "     3.  Fable 5.2              For your toughest challenges",
    "     4.  Sonnet 5.5             Most efficient for simpler tasks",
    "   ❯ 5.  Haiku 5.5 ✔            Fastest for quick answers",
    "     7.  Sonnet 5               Efficient for routine tasks",
    "   ↓ 10. Opus 4.8               Best for everyday, complex tasks",
    "   Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");
  const rows = parsePicker(screen);
  expect(rows.find((r) => r.cursor)).toEqual({ index: 5, label: "Haiku 5.5", cursor: true });
  expect(pickerTarget(rows, "sonnet")?.index).toBe(4);
  expect(pickerTarget(rows, "opus")?.index).toBe(2);
  expect(pickerTarget(rows, "fable")?.index).toBe(3);
  expect(pickerTarget(rows, "default")?.index).toBe(1);
  expect(rows.find((r) => r.index === 10)?.label).toBe("Opus 4.8");
  expect(pickerTarget(rows, "gpt")).toBeUndefined();
});

import { parseEffortScale } from "../src/tmux";
test("reads the /effort slider and the level under the marker", () => {
  // Label centres from a real screen (2026-11-02): low 45.5, medium 55, high 65, xhigh 74.5, max 84.5.
  const screen = (markerCol: number) =>
    [
      "   Effort",
      " ".repeat(44) + "─".repeat(markerCol - 44) + "▲" + "─".repeat(40),
      " ".repeat(44) + "low     medium     high     xhigh      max      Tab to toggle",
    ].join("\n");
  const cols: Record<string, number> = { low: 45, medium: 54, high: 64, xhigh: 74, max: 84 };
  for (const [level, col] of Object.entries(cols)) expect(parseEffortScale(screen(col))?.current).toBe(level);
  expect(parseEffortScale(screen(45))?.labels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(parseEffortScale("tidak ada slider")).toBeNull();
});
