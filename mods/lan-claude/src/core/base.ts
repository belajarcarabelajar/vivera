// Base of the session core: logging, errors, the shared singletons, launch model and effort, the kill
// switch, folders, drafting (transcribe -> refine), launching a session in tmux and live-session lookups.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, paths } from "../config";
import { listFolders, listSubdirs, trustedPaths, validateFolder, type Folder } from "../folders";
import { JobStore, type Job } from "../jobs";
import { PermissionBoard } from "../permissions";
import { refine } from "../refine";
import { listLiveSessions, type LiveSession } from "../sessions";
import { findTargetSession, openWindow } from "../tmux";
import { probeSeconds, transcribe } from "../transcribe";

mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
export const jobs = new JobStore(paths.jobs);
export const board = new PermissionBoard(config.permissionWaitMs);

// dup-defs: allow the mod ships on its own and must not import another mod's internals; small local helper
export function log(event: string, data: Record<string, unknown> = {}): void {
  appendFileSync(paths.log, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n", { mode: 0o600 });
}

/** An error whose message is meant for the user (Indonesian) and maps to an HTTP status. */
export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Called after a launched session ends a turn (Stop hook). Listeners must not throw. */
export const onTurnEnd: ((job: Job) => void)[] = [];

/**
 * Model for sessions launched from the phone, passed as `claude --model` (per session; unlike typing
 * /model inside a session, it never changes the PC's global default). Empty = the PC default.
 */
const MODEL_RE = /^(sonnet|opus|haiku|fable|claude-[a-z0-9-]+(\[1m\])?)$/;
const modelFile = () => join(config.stateDir, "launch-model");
export function launchModel(): string {
  try {
    const m = readFileSync(modelFile(), "utf8").trim();
    return MODEL_RE.test(m) ? m : "";
  } catch {
    return "";
  }
}
export function setLaunchModel(m: string): void {
  const v = m.trim().toLowerCase();
  if (v === "default" || v === "") return void rmSync(modelFile(), { force: true });
  if (!MODEL_RE.test(v)) throw new UserError("Model tidak dikenal. Pakai: sonnet, opus, haiku, fable, default, atau ID lengkap claude-….");
  writeFileSync(modelFile(), v + "\n", { mode: 0o600 });
}

/** Effort for sessions launched from the phone (`claude --effort`, this session only). Empty = default. */
export const EFFORT_RE = /^(low|medium|high|xhigh|max)$/;
const effortFile = () => join(config.stateDir, "launch-effort");
export function launchEffort(): string {
  try {
    const m = readFileSync(effortFile(), "utf8").trim();
    return EFFORT_RE.test(m) ? m : "";
  } catch {
    return "";
  }
}
export function setLaunchEffort(e: string): void {
  const v = e.trim().toLowerCase();
  if (v === "default" || v === "") return void rmSync(effortFile(), { force: true });
  if (!EFFORT_RE.test(v)) throw new UserError("Effort tidak dikenal. Pakai: low, medium, high, xhigh, max, atau default.");
  writeFileSync(effortFile(), v + "\n", { mode: 0o600 });
}

export const killed = () => existsSync(paths.killSwitch);
export function setKilled(on: boolean): void {
  if (on) writeFileSync(paths.killSwitch, new Date().toISOString() + "\n");
  else rmSync(paths.killSwitch, { force: true });
}
/**
 * Quick list on the phone: folders Claude Code already trusts (no dialog on start) and the home folder.
 * Any other folder is reachable with the folder browser or a typed path (validateFolder).
 */
export const folders = (): Folder[] => [
  ...listFolders(trustedPaths(config.claudeJson), config.home),
  { path: config.home, label: "~", mtimeMs: 0 },
];

/** Folders Haiku may pick: the quick list plus the visible folders directly in home. */
export function folderCandidates(): Folder[] {
  const quick = folders();
  const seen = new Set(quick.map((f) => f.path));
  const extra = listSubdirs(config.home)
    .map((n) => join(config.home, n))
    .filter((p) => !seen.has(p))
    .slice(0, 40)
    .map((path) => ({ path, label: folderLabel(path), mtimeMs: 0 }));
  return [...quick, ...extra];
}

export { listSubdirs, validateFolder };

export type Via = NonNullable<Job["via"]>;

export async function draftFrom(source: Job["source"], via: Via, text: string, id = JobStore.newId()): Promise<Job> {
  const fs = folderCandidates();
  const r = await refine(text, fs.map((f) => f.label));
  // No guess: a command that names no project leaves the folder empty and the phone asks which one.
  const chosen = fs.find((f) => f.label === r.folder);
  const job = jobs.save({
    id, createdAt: Date.now(), source, via, transcript: text, prompt: r.prompt, folder: chosen?.path ?? "", note: r.note,
    status: "draft", turns: 0,
  });
  log("drafted", { job: id, source, via });
  return job;
}

/** Saves an audio file into a new job folder, checks it, transcribes it, and drafts the prompt. */
export async function draftFromAudio(data: Blob | ArrayBuffer, ext: string, via: Via): Promise<Job> {
  if (killed()) throw new UserError("Kill switch aktif.", 423);
  const size = data instanceof Blob ? data.size : data.byteLength;
  if (size === 0 || size > config.maxAudioBytes) throw new UserError(`Ukuran audio harus 1 byte sampai ${config.maxAudioBytes / 1048576} MB.`);
  const id = JobStore.newId();
  const safeExt = /^[a-z0-9]{2,5}$/.test(ext) ? ext : "bin";
  const file = join(jobs.folderOf(id), `audio.${safeExt}`);
  await Bun.write(file, data);
  const secs = await probeSeconds(file);
  if (secs === null) throw new UserError("Audio tidak bisa dibaca.");
  if (secs > config.maxAudioSeconds) throw new UserError(`Audio maksimal ${config.maxAudioSeconds / 60} menit.`);
  const t0 = Date.now();
  const tr = await transcribe(file);
  log("transcribed", { job: id, via, seconds: secs, ms: Date.now() - t0, chars: tr.text.length });
  if (!tr.text) throw new UserError("Tidak ada ucapan yang terdengar.");
  return draftFrom("voice", via, tr.text, id);
}

export async function draftFromText(text: string, via: Via): Promise<Job> {
  if (killed()) throw new UserError("Kill switch aktif.", 423);
  const t = text.trim();
  if (!t || t.length > 8000) throw new UserError("Teks kosong atau terlalu panjang.");
  return draftFrom("text", via, t);
}

export async function launch(jobId: string, promptIn: string, folderIn: string, via: Via): Promise<Job> {
  if (killed()) throw new UserError("Kill switch aktif.", 423);
  const job = jobs.get(jobId);
  if (!job || job.status !== "draft") throw new UserError("Job tidak ditemukan atau sudah dijalankan.");
  const prompt = promptIn.trim().replace(/^[-\s]+/, "");
  if (!prompt || prompt.length > 8000) throw new UserError("Prompt kosong atau terlalu panjang.");
  if (!folderIn.trim()) throw new UserError("Pilih folder dulu.");
  const folder = validateFolder(folderIn, config.home);
  if (!folder) throw new UserError("Folder itu tidak ada atau bukan folder.");
  if (jobs.launchesSince(Date.now() - 3600_000) >= config.maxLaunchesPerHour) {
    throw new UserError(`Batas ${config.maxLaunchesPerHour} sesi per jam tercapai.`, 429);
  }
  const session = await findTargetSession();
  if (!session) throw new UserError("Alacritty dengan tmux tidak terbuka di PC.", 409);
  jobs.writePrompt(job.id, prompt);
  const model = launchModel();
  if (model) writeFileSync(join(jobs.folderOf(job.id), "model.txt"), model + "\n", { mode: 0o600 });
  const effort = launchEffort();
  if (effort) writeFileSync(join(jobs.folderOf(job.id), "effort.txt"), effort + "\n", { mode: 0o600 });
  try {
    const windowId = await openWindow(session, `hp-${job.id.slice(0, 6)}`, folder, paths.launcher, job.id);
    const saved = jobs.update(job.id, { prompt, folder, status: "launched", windowId, launchedAt: Date.now() })!;
    log("launched", { job: job.id, via, session, windowId, folder, model: model || "default", effort: effort || "default", promptChars: prompt.length });
    return saved;
  } catch (e) {
    jobs.update(job.id, { status: "failed", error: (e as Error).message });
    log("launch_failed", { job: job.id, error: (e as Error).message });
    throw new UserError((e as Error).message, 500);
  }
}

export function cancel(jobId: string): boolean {
  const j = jobs.get(jobId);
  if (j?.status !== "draft") return false;
  jobs.update(j.id, { status: "cancelled" });
  return true;
}

export function folderLabel(path: string): string {
  return path.startsWith(config.home + "/") ? "~" + path.slice(config.home.length) : path;
}

export const live = (): LiveSession[] => listLiveSessions(config.home);
export const findLive = (key: string) => live().find((s) => s.key === key);
export const liveForJob = (job: Job) => (job.windowId ? live().find((s) => s.window === job.windowId) : undefined);
