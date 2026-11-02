// Pending permission requests from sessions this tool launched. The hook script long-polls
// `wait(id)`; the phone answers with `decide(id, ...)`. No answer within the wait window resolves
// to "none", and the hook then prints nothing so Claude Code shows its normal terminal dialog.
import { randomBytes } from "node:crypto";

export type Decision = "allow" | "deny" | "none";
export type Pending = {
  id: string;
  job: string;
  tool: string;
  summary: string;
  createdAt: number;
};

type Entry = Pending & { resolve: (d: Decision) => void; promise: Promise<Decision> };

export function summarizeTool(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const s =
    tool === "Bash" ? pick("command")
    : ["Edit", "Write", "Read", "NotebookEdit"].includes(tool) ? pick("file_path") || pick("notebook_path")
    : tool === "WebFetch" ? pick("url")
    : JSON.stringify(i);
  return s.length > 600 ? s.slice(0, 600) + " …" : s;
}

export type BoardEvent =
  | { type: "open"; pending: Pending }
  | { type: "close"; pending: Pending; decision: Decision; by: string };

export class PermissionBoard {
  private entries = new Map<string, Entry>();
  private listeners: ((e: BoardEvent) => void)[] = [];

  /** Listeners run synchronously; their errors are swallowed so a hook never fails because of them. */
  subscribe(fn: (e: BoardEvent) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: BoardEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {}
    }
  }

  constructor(private waitMs: number, private now = () => Date.now()) {}

  open(job: string, tool: string, input: unknown): Pending {
    const id = randomBytes(6).toString("hex");
    let resolve!: (d: Decision) => void;
    const promise = new Promise<Decision>((r) => (resolve = r));
    const entry: Entry = { id, job, tool, summary: summarizeTool(tool, input), createdAt: this.now(), resolve, promise };
    this.entries.set(id, entry);
    const t = setTimeout(() => this.finish(id, "none", "timeout"), this.waitMs);
    promise.finally(() => clearTimeout(t));
    const view = this.view(entry);
    this.emit({ type: "open", pending: view });
    return view;
  }

  wait(id: string): Promise<Decision> {
    return this.entries.get(id)?.promise ?? Promise.resolve("none");
  }

  decide(id: string, d: "allow" | "deny", by = "web"): boolean {
    return this.finish(id, d, by);
  }

  list(): Pending[] {
    return [...this.entries.values()].map((e) => this.view(e));
  }

  private finish(id: string, d: Decision, by: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    e.resolve(d);
    this.emit({ type: "close", pending: this.view(e), decision: d, by });
    return true;
  }

  private view(e: Entry): Pending {
    return { id: e.id, job: e.job, tool: e.tool, summary: e.summary, createdAt: e.createdAt };
  }
}

/** Hook stdout for a decision; "none" prints nothing so the terminal dialog appears. */
export function hookOutput(d: Decision): string {
  if (d === "none") return "";
  const decision = d === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "Ditolak dari HP (lan-claude)." };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}
