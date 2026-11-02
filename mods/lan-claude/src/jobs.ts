// Jobs: one voice note or typed command, from draft (transcribed + refined) to a launched session.
// Each job lives in ~/.local/state/lan-claude/jobs/<id>/ (mode 700): job.json, prompt.txt, audio.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Job = {
  id: string;
  createdAt: number;
  source: "voice" | "text";
  /** Entry point that created the job. Older jobs have none (LAN web). */
  via?: "web" | "telegram";
  transcript: string;
  prompt: string;
  folder: string;
  note: string;
  status: "draft" | "launched" | "cancelled" | "failed";
  windowId?: string;
  launchedAt?: number;
  turns: number;
  lastReply?: string;
  waiting?: boolean;
  error?: string;
};

export class JobStore {
  private jobs = new Map<string, Job>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(dir)) {
      const f = join(dir, id, "job.json");
      if (!existsSync(f)) continue;
      try {
        this.jobs.set(id, JSON.parse(readFileSync(f, "utf8")));
      } catch {}
    }
  }

  static newId(): string {
    return randomBytes(6).toString("hex");
  }

  folderOf(id: string): string {
    const d = join(this.dir, id);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  save(job: Job): Job {
    this.jobs.set(job.id, job);
    writeFileSync(join(this.folderOf(job.id), "job.json"), JSON.stringify(job, null, 1), { mode: 0o600 });
    return job;
  }

  get(id: string): Job | undefined {
    return /^[a-f0-9]{12}$/.test(id) ? this.jobs.get(id) : undefined;
  }

  update(id: string, patch: Partial<Job>): Job | undefined {
    const j = this.get(id);
    return j ? this.save({ ...j, ...patch }) : undefined;
  }

  recent(n = 12): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
  }

  launchesSince(ts: number): number {
    return [...this.jobs.values()].filter((j) => (j.launchedAt ?? 0) >= ts).length;
  }

  writePrompt(id: string, prompt: string): void {
    writeFileSync(join(this.folderOf(id), "prompt.txt"), prompt, { mode: 0o600 });
  }
}
