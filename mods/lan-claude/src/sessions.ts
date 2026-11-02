// Every interactive Claude Code session on this PC, read from the files Claude Code itself keeps in
// ~/.claude/sessions/<pid>.json: sessionId, cwd, name, tmux pane, and status ("idle" = waiting for
// input, "busy" = working, "waiting" = a dialog such as a permission prompt is open). No hook needed,
// so sessions the user opened by hand count too. Messages are only typed in when status is "idle".
import { openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";

export type LiveSession = {
  key: string; // first 12 hex digits of the sessionId, used in Telegram buttons
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  pane: string; // tmux pane id, e.g. %32
  window: string; // tmux window id, e.g. @16
  status: "idle" | "busy" | "waiting" | string;
  waitingFor?: string;
  statusUpdatedAt: number;
};

/**
 * Claude Code's four session states (from its binary): busy, waiting (a dialog is open), idle, and
 * shell = the turn is over and the prompt is open while a background shell still runs. Idle and shell
 * both mean "the input box is ready"; treating only idle as ready left messages queued for as long as
 * a background shell lived (726 s on 2026-11-02).
 */
export const isReady = (status: string) => status === "idle" || status === "shell";

export const sessionKey = (sessionId: string) => sessionId.replace(/-/g, "").slice(0, 12).toLowerCase();

/** Parses one session file; null for anything that is not a live-able interactive tmux session. */
export function parseSessionFile(text: string): Omit<LiveSession, "key"> | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  const tm = typeof d.tmux === "string" ? /^[^:]*:(@\d+)\.(%\d+)$/.exec(d.tmux) : null;
  if (!tm || d.kind !== "interactive" || typeof d.sessionId !== "string" || typeof d.pid !== "number") return null;
  if (!/^[0-9a-f-]{36}$/i.test(d.sessionId)) return null;
  return {
    pid: d.pid,
    sessionId: d.sessionId,
    name: typeof d.name === "string" ? d.name : "",
    cwd: typeof d.cwd === "string" ? d.cwd : "",
    window: tm[1],
    pane: tm[2],
    status: typeof d.status === "string" ? d.status : "busy",
    waitingFor: typeof d.waitingFor === "string" ? d.waitingFor : undefined,
    statusUpdatedAt: typeof d.statusUpdatedAt === "number" ? d.statusUpdatedAt : 0,
  };
}

function isClaude(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "claude";
  } catch {
    return false;
  }
}

export function listLiveSessions(home: string, alive: (pid: number) => boolean = isClaude): LiveSession[] {
  const dir = join(home, ".claude/sessions");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const n of names) {
    let s: Omit<LiveSession, "key"> | null = null;
    try {
      s = parseSessionFile(readFileSync(join(dir, n), "utf8"));
    } catch {}
    if (s && alive(s.pid)) out.push({ ...s, key: sessionKey(s.sessionId) });
  }
  return out.sort((a, b) => b.statusUpdatedAt - a.statusUpdatedAt);
}

/** Text of the last assistant message that has text, from the session transcript (tail only). */
export function lastAssistantText(home: string, s: { sessionId: string; cwd: string }): string {
  const slug = s.cwd.replace(/[^A-Za-z0-9]/g, "-");
  const candidates = [join(home, ".claude/projects", slug, `${s.sessionId}.jsonl`)];
  let file = candidates.find((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
  if (!file) {
    try {
      for (const d of readdirSync(join(home, ".claude/projects"))) {
        const f = join(home, ".claude/projects", d, `${s.sessionId}.jsonl`);
        try {
          if (statSync(f).isFile()) {
            file = f;
            break;
          }
        } catch {}
      }
    } catch {}
  }
  if (!file) return "";
  return lastTextFromJsonl(readTail(file, 512 * 1024));
}

function readTail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

export function lastTextFromJsonl(tail: string): string {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"assistant"')) continue;
    try {
      const d = JSON.parse(l) as { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
      if (d.type !== "assistant" || d.isSidechain) continue;
      const c = d.message?.content;
      if (!Array.isArray(c)) continue;
      const text = c
        .filter((b): b is { type: string; text: string } => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) return text;
    } catch {}
  }
  return "";
}
