// Launch target: the tmux session shown in an open Alacritty window (a tmux client whose parent
// process is alacritty). No such client means the terminal is closed, and nothing is launched.
import { readFileSync } from "node:fs";

export type Client = { pid: number; session: string; activity: number };

export function parseClients(out: string): Client[] {
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length === 3 && /^\d+$/.test(p[0]) && p[1] !== "")
    .map(([pid, session, activity]) => ({ pid: Number(pid), session, activity: Number(activity) || 0 }));
}

export function parentComm(pid: number, read = (p: string) => readFileSync(p, "utf8")): string | null {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm may contain spaces, so split after ')'.
    const stat = read(`/proc/${pid}/stat`);
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!ppid) return null;
    return read(`/proc/${ppid}/comm`).trim();
  } catch {
    return null;
  }
}

export function pickSession(clients: Client[], commOf: (pid: number) => string | null): string | null {
  const inAlacritty = clients.filter((c) => commOf(c.pid) === "alacritty");
  if (inAlacritty.length === 0) return null;
  return inAlacritty.reduce((a, b) => (b.activity > a.activity ? b : a)).session;
}

/** `-d`: create the window in the background so the screen the user is looking at does not jump. */
export function newWindowArgs(session: string, name: string, cwd: string, launcher: string, jobId: string): string[] {
  return ["new-window", "-d", "-t", `${session}:`, "-n", name, "-c", cwd, "-P", "-F", "#{window_id}", "--", launcher, jobId];
}

async function tmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

export async function findTargetSession(): Promise<string | null> {
  const r = await tmux(["list-clients", "-F", "#{client_pid}\t#{session_name}\t#{client_activity}"]);
  if (r.code !== 0) return null;
  return pickSession(parseClients(r.out), (pid) => parentComm(pid));
}

export async function openWindow(session: string, name: string, cwd: string, launcher: string, jobId: string): Promise<string> {
  const r = await tmux(newWindowArgs(session, name, cwd, launcher, jobId));
  if (r.code !== 0 || !r.out.trim().startsWith("@")) throw new Error(`tmux new-window failed: ${r.err.trim() || r.code}`);
  return r.out.trim();
}

export async function capture(windowId: string, lines = 80): Promise<string | null> {
  if (!/^[@%]\d+$/.test(windowId)) return null;
  const r = await tmux(["capture-pane", "-p", "-J", "-t", windowId, "-S", `-${lines}`]);
  return r.code === 0 ? r.out.replace(/\s+$/, "") : null;
}

/** The foreground command of the window's pane ("claude" while the session runs), or null if gone. */
export async function paneCommand(windowId: string): Promise<string | null> {
  if (!/^@\d+$/.test(windowId)) return null;
  const r = await tmux(["display-message", "-p", "-t", windowId, "#{pane_current_command}"]);
  return r.code === 0 ? r.out.trim() : null;
}

/**
 * Types a message into the session and submits it: the text goes through a tmux buffer and a
 * bracketed paste (`-p`), so newlines stay part of one message instead of submitting early; then Enter.
 */
export async function pasteText(windowId: string, text: string): Promise<void> {
  if (!/^[@%]\d+$/.test(windowId)) throw new Error("bad window or pane id");
  const buf = `lan-claude-${process.pid}`;
  const load = Bun.spawn(["tmux", "load-buffer", "-b", buf, "-"], { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "pipe" });
  if ((await load.exited) !== 0) throw new Error("tmux load-buffer failed");
  const paste = await tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", windowId]);
  if (paste.code !== 0) throw new Error(`tmux paste-buffer failed: ${paste.err.trim()}`);
  await Bun.sleep(400); // let the TUI finish the paste before Enter submits it
  const enter = await tmux(["send-keys", "-t", windowId, "Enter"]);
  if (enter.code !== 0) throw new Error("tmux send-keys failed");
}

/** Name, pane count and the number of windows in its tmux session; null when the window is gone. */
export async function windowInfo(windowId: string): Promise<{ name: string; panes: number; sessionWindows: number } | null> {
  if (!/^@\d+$/.test(windowId)) return null;
  const r = await tmux(["display-message", "-p", "-t", windowId, "#{window_name}\t#{window_panes}\t#{session_windows}"]);
  if (r.code !== 0) return null;
  const [name, panes, sw] = r.out.trim().split("\t");
  return { name, panes: Number(panes), sessionWindows: Number(sw) };
}

/** Closes a tmux window (tab) and everything running in it. */
export async function killWindow(windowId: string): Promise<void> {
  if (!/^@\d+$/.test(windowId)) throw new Error("bad window id");
  const r = await tmux(["kill-window", "-t", windowId]);
  if (r.code !== 0) throw new Error(`tmux kill-window failed: ${r.err.trim()}`);
}

export type PickerRow = { index: number; label: string; cursor: boolean };

/** Rows of Claude Code's /model picker ("❯ 4.  Sonnet 5.5   Most efficient…"), in screen order. */
export function parsePicker(screen: string): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const line of screen.split("\n")) {
    const m = /^\s*(❯)?\s*(?:↓|↑)?\s*(\d+)\.\s+(.+?)(?:\s+✔)?(?:\s{2,}.*)?$/.exec(line);
    if (m) rows.push({ index: Number(m[2]), label: m[3].replace(/\s+✔$/, "").trim(), cursor: m[1] === "❯" });
  }
  return rows;
}

/** First picker row for an alias: sonnet -> "Sonnet 5.5" (the list puts the newest version first). */
export function pickerTarget(rows: PickerRow[], alias: string): PickerRow | undefined {
  const want = alias === "default" ? "default" : alias;
  return rows.find((r) => r.label.toLowerCase().startsWith(want));
}

const keys = (target: string, ...k: string[]) => tmux(["send-keys", "-t", target, ...k]);

/** Sends named keys (Enter, Escape, Up, ...) to a pane id; the id is checked. */
export async function pressKeys(pane: string, ...k: string[]): Promise<void> {
  if (!/^[@%]\d+$/.test(pane)) throw new Error("bad pane or window id");
  const r = await keys(pane, ...k);
  if (r.code !== 0) throw new Error(`tmux send-keys failed: ${r.err.trim()}`);
}

/**
 * Switches the model of a running session for that session only: opens /model, moves the cursor to
 * the target, presses "s" ("use this session only"), confirms "Switch model?". Every step checks the
 * screen; anything unexpected presses Esc and throws. Measured 2026-11-02 on Claude Code 2.1.316:
 * "Set model to Sonnet 5.5 for this session only", settings.json model unchanged.
 */
export async function switchModelSessionOnly(pane: string, alias: string): Promise<string> {
  if (!/^%\d+$/.test(pane)) throw new Error("bad pane id");
  const screen = async () => (await capture(pane, 60)) ?? "";
  const abort = async (why: string) => {
    await keys(pane, "Escape");
    await Bun.sleep(300);
    await keys(pane, "Escape");
    throw new Error(why);
  };
  await keys(pane, "-l", "/model");
  await Bun.sleep(600);
  await keys(pane, "Enter");
  await Bun.sleep(1500);
  let s = await screen();
  if (!s.includes("Select model") || !s.includes("s to use this session only")) await abort("menu /model tidak muncul");
  const rows = parsePicker(s.slice(s.lastIndexOf("Select model")));
  const target = pickerTarget(rows, alias);
  const cur = rows.find((r) => r.cursor);
  if (!target || !cur) return abort(`model ${alias} tidak ada di menu`);
  const delta = target.index - cur.index;
  for (let i = 0; i < Math.abs(delta); i++) {
    await keys(pane, delta > 0 ? "Down" : "Up");
    await Bun.sleep(120);
  }
  await Bun.sleep(400);
  s = await screen();
  const now = parsePicker(s.slice(s.lastIndexOf("Select model"))).find((r) => r.cursor);
  if (now?.label !== target.label) return abort("kursor tidak berada di model tujuan");
  await keys(pane, "s");
  await Bun.sleep(1500);
  s = await screen();
  if (s.includes("Switch model?")) {
    if (!new RegExp(`❯\\s*1\\.\\s*Yes, switch to ${target.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(s)) return abort("dialog konfirmasi tidak sesuai");
    await keys(pane, "Enter");
    await Bun.sleep(1500);
    s = await screen();
  }
  const tail = s.slice(-1500);
  if (/for this session only/.test(tail)) return target.label;
  if (/Kept model as/.test(tail)) return target.label;
  if (/saved as your default/.test(tail)) throw new Error("Claude Code menyimpannya sebagai default global (tidak diharapkan)");
  throw new Error("tidak ada konfirmasi pergantian model di layar");
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Levels on the /effort slider and the one the ▲ marker sits under (nearest label centre). */
export function parseEffortScale(screen: string): { labels: string[]; current: string } | null {
  const lines = screen.split("\n");
  let m = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("▲") && lines[i].includes("─")) {
      m = i;
      break;
    }
  }
  if (m < 0) return null;
  const labelLine = lines.slice(m + 1, m + 3).find((l) => /\blow\b/.test(l));
  if (!labelLine) return null;
  const col = lines[m].indexOf("▲");
  const found = [...labelLine.matchAll(/low|medium|high|xhigh|max/g)].map((x) => ({ label: x[0], centre: x.index! + x[0].length / 2 }));
  if (found.length === 0) return null;
  const nearest = found.reduce((a, b) => (Math.abs(b.centre - col) < Math.abs(a.centre - col) ? b : a));
  return { labels: found.map((f) => f.label), current: nearest.label };
}

/**
 * Sets the effort of a running session for that session only: opens /effort, moves the slider
 * (Left to the end, then Right), checks the marker, presses "s", and checks the result line says
 * "(this session only)". Typing `/effort <level>` is never used: it saves the model's default in
 * settings.json (measured 2026-11-02, Claude Code 2.1.316). Anything unexpected presses Esc and throws.
 */
export async function switchEffortSessionOnly(pane: string, level: string): Promise<string> {
  if (!/^%\d+$/.test(pane)) throw new Error("bad pane id");
  if (!(EFFORT_LEVELS as readonly string[]).includes(level)) throw new Error("level effort tidak dikenal");
  const screen = async () => (await capture(pane, 60)) ?? "";
  const abort = async (why: string): Promise<never> => {
    await keys(pane, "Escape");
    await Bun.sleep(300);
    await keys(pane, "Escape");
    throw new Error(why);
  };
  await keys(pane, "-l", "/effort");
  await Bun.sleep(600);
  await keys(pane, "Enter");
  await Bun.sleep(1500);
  let s = await screen();
  if (!s.includes("s for this session only")) return abort("menu /effort tidak muncul");
  const scale = parseEffortScale(s);
  if (!scale || !scale.labels.includes(level)) return abort(`level ${level} tidak tersedia untuk model ini`);
  for (let i = 0; i < scale.labels.length; i++) {
    await keys(pane, "Left");
    await Bun.sleep(120);
  }
  for (let i = 0; i < scale.labels.indexOf(level); i++) {
    await keys(pane, "Right");
    await Bun.sleep(120);
  }
  await Bun.sleep(400);
  if (parseEffortScale(await screen())?.current !== level) return abort("penanda tidak berada di level tujuan");
  await keys(pane, "s");
  await Bun.sleep(1500);
  const last = [...(await screen()).matchAll(/Set effort level to (\w+) \(([^)]*)\)/g)].pop();
  if (last && last[1] === level && last[2] === "this session only") return level;
  if (last && /saved as your default/.test(last[2])) throw new Error("Claude Code menyimpannya sebagai default (tidak diharapkan)");
  throw new Error("tidak ada konfirmasi pergantian effort di layar");
}
