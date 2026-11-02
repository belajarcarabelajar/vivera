// Shared state and actions for both entry points (LAN web page and Telegram): jobs, the permission
// board, drafting (transcribe -> refine) and launching a session in tmux. One process, one board.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, paths } from "./config";
import { listFolders, listSubdirs, trustedPaths, validateFolder, type Folder } from "./folders";
import { JobStore, type Job } from "./jobs";
import { PermissionBoard } from "./permissions";
import { refine } from "./refine";
import { parsePermissionDialog, parseStartupDialog, type PermissionDialog, type StartupDialog } from "./dialog";
import { isReady, listLiveSessions, lastAssistantText, type LiveSession } from "./sessions";
import { capture, findTargetSession, killWindow, openWindow, pasteText, pressKeys, switchEffortSessionOnly, switchModelSessionOnly, windowInfo } from "./tmux";
import { probeSeconds, transcribe } from "./transcribe";

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
const EFFORT_RE = /^(low|medium|high|xhigh|max)$/;
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

type Via = NonNullable<Job["via"]>;

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
  const prompt = promptIn.trim().replace(/^-+\s*/, "");
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

/**
 * Follow-up messages to any live Claude session (see sessions.ts). Typed in right away when the
 * session is idle; otherwise queued and typed in by the watcher once it turns idle, so text never
 * lands in a dialog. Sessions you message get a turn-end notice; sessions lan-claude launched always do.
 */
type Watch = { since: number; lastWaitingAt: number; announced: boolean; queued: string[] };
const watches = new Map<string, Watch>(); // session key -> watch
const stuckReported = new Set<string>(); // job ids
const switching = new Set<string>(); // session keys whose /model picker is being driven
// Terminal permission dialogs (see dialog.ts) per session: what was announced, to detect a changed dialog.
type PermState = { updatedAt: number; text?: string; announced: boolean; tries: number };
const permState = new Map<string, PermState>();
const PERMISSION_WAIT = "permission prompt";
// Start-up dialogs (trust, external imports) per launched job that has no live session yet.
const startupState = new Map<string, { text: string; kind: string }>();

export const live = (): LiveSession[] => listLiveSessions(config.home);
export const findLive = (key: string) => live().find((s) => s.key === key);
export const liveForJob = (job: Job) => (job.windowId ? live().find((s) => s.window === job.windowId) : undefined);

export type WatchEvent =
  | { type: "turn_end"; session: LiveSession; text: string }
  | { type: "waiting"; session: LiveSession }
  | { type: "delivered"; session: LiveSession; text: string }
  | { type: "gone"; key: string }
  | { type: "permission_dialog"; session: LiveSession; dialog: PermissionDialog }
  | { type: "permission_closed"; key: string }
  | { type: "startup_dialog"; job: Job; dialog: StartupDialog }
  | { type: "startup_closed"; jobId: string }
  | { type: "stuck"; job: Job; screen: string };
export const onWatch: ((e: WatchEvent) => void)[] = [];
const emitWatch = (e: WatchEvent) => {
  for (const fn of onWatch) {
    try {
      fn(e);
    } catch {}
  }
};

function watch(key: string, since = Date.now()): Watch {
  let w = watches.get(key);
  if (!w) watches.set(key, (w = { since, lastWaitingAt: 0, announced: false, queued: [] }));
  return w;
}

// Queued follow-ups survive a restart of the service (session keys are stable).
const queueFile = () => join(config.stateDir, "queues.json");
function saveQueues(): void {
  const out: Record<string, string[]> = {};
  for (const [k, w] of watches) if (w.queued.length > 0) out[k] = w.queued;
  writeFileSync(queueFile(), JSON.stringify(out), { mode: 0o600 });
}
function loadQueues(): void {
  try {
    for (const [k, q] of Object.entries(JSON.parse(readFileSync(queueFile(), "utf8")) as Record<string, string[]>)) {
      if (/^[0-9a-f]{12}$/.test(k) && Array.isArray(q)) watch(k).queued = q.filter((t) => typeof t === "string");
    }
  } catch {}
}
loadQueues();

export async function sendToSession(key: string, textIn: string, via: Via): Promise<{ result: "sent" | "queued"; session: LiveSession }> {
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  const text = textIn.trim();
  if (!text || text.length > 8000) throw new UserError("Pesan kosong atau terlalu panjang.");
  const w = watch(key);
  if (!isReady(s.status) || w.queued.length > 0) {
    w.queued.push(text);
    saveQueues();
    log("followup_queued", { session: key, via, status: s.status, chars: text.length });
    return { result: "queued", session: s };
  }
  w.since = Date.now();
  await pasteText(s.pane, text);
  log("followup_sent", { session: key, via, chars: text.length });
  return { result: "sent", session: s };
}

/** One watcher pass (every few seconds): delivers queues, reports turn ends and dialogs. */
export async function watchTick(): Promise<void> {
  const sessions = live();
  const byKey = new Map(sessions.map((s) => [s.key, s]));
  // Sessions lan-claude launched are always watched from their launch time. One that has no status
  // file 20 s after launch is stuck on a start-up screen (a dialog the phone cannot answer): report it once.
  for (const j of jobs.recent(40)) {
    if (j.status !== "launched" || !j.windowId) continue;
    const s = sessions.find((x) => x.window === j.windowId);
    if (s) {
      watch(s.key, j.launchedAt ?? Date.now());
      if (startupState.delete(j.id)) emitWatch({ type: "startup_closed", jobId: j.id });
      continue;
    }
    const age = Date.now() - (j.launchedAt ?? 0);
    if (age < 2_000 || age > 600_000) continue;
    const screen = await capture(j.windowId, 40);
    if (screen === null) continue; // window closed
    // A start-up dialog (trust, external imports) is a card with buttons, not a "stuck" notice.
    const sd = parseStartupDialog(screen);
    if (sd) {
      if (startupState.get(j.id)?.text !== sd.text) {
        startupState.set(j.id, { text: sd.text, kind: sd.kind });
        log("startup_dialog", { job: j.id, kind: sd.kind });
        emitWatch({ type: "startup_dialog", job: j, dialog: sd });
      }
      continue;
    }
    if (age > 20_000 && !stuckReported.has(j.id)) {
      stuckReported.add(j.id);
      log("launch_stuck", { job: j.id });
      emitWatch({ type: "stuck", job: j, screen });
    }
  }
  await permissionTick(sessions);
  for (const [key, w] of watches) {
    if (switching.has(key)) continue;
    const s = byKey.get(key);
    if (!s) {
      watches.delete(key);
      emitWatch({ type: "gone", key });
      continue;
    }
    // Permission prompts are handled by permissionTick (a card with buttons); other dialogs get a notice.
    if (s.status === "waiting" && s.waitingFor !== PERMISSION_WAIT && s.statusUpdatedAt > w.since && s.statusUpdatedAt !== w.lastWaitingAt) {
      w.lastWaitingAt = s.statusUpdatedAt;
      emitWatch({ type: "waiting", session: s });
    }
    const ready = isReady(s.status);
    // Turn end: busy/waiting -> ready, announced once. The later shell -> idle change (background shell
    // finished, no new turn) must not announce the same reply again.
    if (!ready) w.announced = false;
    else if (!w.announced && s.statusUpdatedAt > w.since) {
      w.announced = true;
      emitWatch({ type: "turn_end", session: s, text: lastAssistantText(config.home, s) });
    }
    if (!ready || w.queued.length === 0) continue;
    const text = w.queued.join("\n\n");
    w.queued = [];
    saveQueues();
    try {
      await Bun.sleep(1500); // let the TUI settle back to its input box
      await pasteText(s.pane, text);
      w.since = Date.now();
      w.announced = false;
      log("followup_delivered", { session: key, chars: text.length });
      emitWatch({ type: "delivered", session: s, text });
    } catch (e) {
      w.queued.unshift(text);
      saveQueues();
      log("followup_deliver_failed", { session: key, error: (e as Error).message });
    }
  }
}

/**
 * Every live session, hooked or not: when one waits on a permission prompt, read the dialog off the
 * screen and announce it once (a session launched by lan-claude whose hook already put a card on the
 * board is skipped). A dialog that cannot be read after ~12 s falls back to the plain "waiting" notice.
 */
async function permissionTick(sessions: LiveSession[]): Promise<void> {
  for (const s of sessions) {
    const st = permState.get(s.key);
    if (s.status !== "waiting" || s.waitingFor !== PERMISSION_WAIT) {
      if (st?.announced && st.text) emitWatch({ type: "permission_closed", key: s.key });
      permState.delete(s.key);
      continue;
    }
    if (switching.has(s.key)) continue;
    if (st && st.updatedAt === s.statusUpdatedAt && st.announced) continue;
    const cur: PermState = st && st.updatedAt === s.statusUpdatedAt ? st : { updatedAt: s.statusUpdatedAt, announced: false, tries: 0 };
    permState.set(s.key, cur);
    const job = jobs.recent(40).find((j) => j.windowId === s.window);
    if (job && board.list().some((p) => p.job === job.id)) {
      cur.announced = true; // the hook's card on the board covers this one
      continue;
    }
    const dialog = parsePermissionDialog((await capture(s.pane, 80)) ?? "");
    if (dialog) {
      cur.text = dialog.text;
      cur.announced = true;
      log("permission_dialog", { session: s.key });
      emitWatch({ type: "permission_dialog", session: s, dialog });
    } else if (++cur.tries >= 4) {
      cur.announced = true;
      log("permission_dialog_unreadable", { session: s.key });
      emitWatch({ type: "waiting", session: s });
    }
  }
  for (const key of [...permState.keys()]) if (!sessions.some((s) => s.key === key)) permState.delete(key);
}

/**
 * Answers a terminal permission dialog from the phone. Approve = the cursor is checked to be on option
 * "1. Yes" (exactly; never the "always allow" lines) and Enter is pressed; deny = Esc. The screen is
 * read again first and must be the dialog that was announced; anything else refuses and touches nothing.
 */
export async function answerTerminalPermission(key: string, allow: boolean, via: Via): Promise<void> {
  if (killed()) throw new UserError("Kill switch aktif; jawab di PC atau kirim /on dulu.", 423);
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  const st = permState.get(key);
  if (!st?.text) throw new UserError("Permintaan izin itu sudah tidak aktif.");
  if (s.status !== "waiting" || s.waitingFor !== PERMISSION_WAIT) throw new UserError("Permintaan itu sudah dijawab di PC.");
  if (switching.has(key)) throw new UserError("Sesi itu sedang diproses.");
  switching.add(key);
  try {
    let d = parsePermissionDialog((await capture(s.pane, 80)) ?? "");
    if (!d || d.text !== st.text) throw new UserError("Dialog di PC sudah berubah dari yang tampil di kartu; jawab di PC.");
    if (allow) {
      const cur = d.options.find((o) => o.cursor);
      if (!cur) throw new UserError("Kursor dialog tidak terbaca; jawab di PC.");
      for (let i = 1; i < cur.index; i++) {
        await pressKeys(s.pane, "Up");
        await Bun.sleep(120);
      }
      d = parsePermissionDialog((await capture(s.pane, 80)) ?? "");
      const at = d?.options.find((o) => o.cursor);
      if (!d || d.text !== st.text || at?.index !== 1 || at.label !== "Yes") throw new UserError("Kursor tidak berada di pilihan 'Yes'; tidak ada yang ditekan, jawab di PC.");
      await pressKeys(s.pane, "Enter");
    } else {
      await pressKeys(s.pane, "Escape");
    }
    await Bun.sleep(1800);
    const after = parsePermissionDialog((await capture(s.pane, 80)) ?? "");
    if (after && after.text === st.text) throw new UserError("Tombol sudah dikirim tapi dialog masih terbuka; cek di PC.");
    log("terminal_permission", { session: key, decision: allow ? "allow" : "deny", via });
  } finally {
    switching.delete(key);
  }
}

/**
 * Answers a start-up dialog of a session lan-claude launched (trust this folder, allow external
 * imports). Accept moves the cursor to the "Yes" line (the cursor starts on "No") and presses Enter;
 * decline presses Esc (trust: the session exits; imports: continues without them). The screen is read
 * again first and must be the announced dialog.
 */
export async function answerStartupDialog(jobId: string, accept: boolean, via: Via): Promise<void> {
  if (killed()) throw new UserError("Kill switch aktif; jawab di PC atau kirim /on dulu.", 423);
  const job = jobs.get(jobId);
  const st = startupState.get(jobId);
  if (!job?.windowId || !st) throw new UserError("Dialog itu sudah tidak aktif.");
  const read = async () => parseStartupDialog((await capture(job.windowId!, 40)) ?? "");
  let d = await read();
  if (!d || d.text !== st.text) throw new UserError("Dialog di PC sudah berubah atau dijawab di PC.");
  if (accept) {
    const cur = d.options.findIndex((o) => o.cursor);
    if (cur < 0) throw new UserError("Kursor dialog tidak terbaca; jawab di PC.");
    for (let i = 0; i < Math.abs(d.accept - cur); i++) {
      await pressKeys(job.windowId, d.accept > cur ? "Down" : "Up");
      await Bun.sleep(150);
    }
    d = await read();
    if (!d || d.text !== st.text || d.options.findIndex((o) => o.cursor) !== d.accept) {
      throw new UserError("Kursor tidak berada di pilihan 'Yes'; tidak ada yang ditekan, jawab di PC.");
    }
    await pressKeys(job.windowId, "Enter");
  } else {
    await pressKeys(job.windowId, "Escape");
  }
  await Bun.sleep(1800);
  const after = await read();
  if (after && after.text === st.text) throw new UserError("Tombol sudah dikirim tapi dialog masih terbuka; cek di PC.");
  log("startup_dialog_answer", { job: jobId, kind: st.kind, decision: accept ? "accept" : "decline", via });
}

/** Switches a running session's model for that session only (never the PC default). Idle sessions only. */
export async function switchSessionModel(key: string, alias: string, via: Via): Promise<{ label: string; session: LiveSession }> {
  const a = alias.trim().toLowerCase();
  if (!["sonnet", "opus", "haiku", "fable", "default"].includes(a)) throw new UserError("Model tidak dikenal. Pakai: sonnet, opus, haiku, fable, atau default.");
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  if (!isReady(s.status) || queuedCount(key) > 0) throw new UserError("Sesi sedang bekerja; ganti model setelah gilirannya selesai (tunggu pesan 💬).");
  if (switching.has(key)) throw new UserError("Pergantian model untuk sesi ini sedang berjalan.");
  switching.add(key);
  try {
    const label = await switchModelSessionOnly(s.pane, a);
    log("session_model", { session: key, model: label, via });
    return { label, session: s };
  } catch (e) {
    log("session_model_failed", { session: key, error: (e as Error).message });
    throw new UserError(`Gagal ganti model: ${(e as Error).message}`);
  } finally {
    const w = watches.get(key);
    if (w) w.since = Date.now();
    switching.delete(key);
  }
}

/** Sets a running session's effort for that session only. Idle sessions only. */
export async function switchSessionEffort(key: string, level: string, via: Via): Promise<{ level: string; session: LiveSession }> {
  const l = level.trim().toLowerCase();
  if (!EFFORT_RE.test(l)) throw new UserError("Effort tidak dikenal. Pakai: low, medium, high, xhigh, atau max.");
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  if (!isReady(s.status) || queuedCount(key) > 0) throw new UserError("Sesi sedang bekerja; ganti effort setelah gilirannya selesai (tunggu pesan 💬).");
  if (switching.has(key)) throw new UserError("Pergantian untuk sesi ini sedang berjalan.");
  switching.add(key);
  try {
    const done = await switchEffortSessionOnly(s.pane, l);
    log("session_effort", { session: key, effort: done, via });
    return { level: done, session: s };
  } catch (e) {
    log("session_effort_failed", { session: key, error: (e as Error).message });
    throw new UserError(`Gagal ganti effort: ${(e as Error).message}`);
  } finally {
    const w = watches.get(key);
    if (w) w.since = Date.now();
    switching.delete(key);
  }
}

/**
 * Closes the Claude session itself (the tab stays): "/exit" typed in when the input box is ready,
 * Ctrl+C twice when it is working. A session with a dialog open is refused (the keys would answer the
 * dialog). Returns whether the session really ended within ~8 s; a background shell can make Claude ask
 * for confirmation, in which case it is still running and the phone says so.
 */
export async function exitSession(key: string, via: Via): Promise<"exited" | "still-running"> {
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  if (s.status === "waiting") throw new UserError("Ada dialog terbuka di sesi itu; jawab dulu, atau pakai Kill tab.");
  if (switching.has(key)) throw new UserError("Sesi itu sedang diproses.");
  if (!isReady(s.status)) {
    // Measured 2026-11-02: Ctrl+C twice does not exit a working session. One Ctrl+C interrupts the turn;
    // once the input box is ready again, "/exit" does it.
    await pressKeys(s.pane, "C-c");
    let state = s.status;
    for (let i = 0; i < 10 && !isReady(state); i++) {
      await Bun.sleep(700);
      state = findLive(key)?.status ?? "gone";
      if (state === "gone") return "exited";
      if (state === "waiting") throw new UserError("Setelah dihentikan, sesi menampilkan dialog; jawab dulu, atau pakai Kill tab.");
    }
    if (!isReady(state)) return "still-running";
  }
  await pasteText(s.pane, "/exit");
  log("session_exit_sent", { session: key, via, status: s.status });
  for (let i = 0; i < 8; i++) {
    await Bun.sleep(1000);
    if (!findLive(key)) {
      watches.delete(key);
      saveQueues();
      return "exited";
    }
  }
  return "still-running";
}

/**
 * Closes the tmux window (tab) of a session and everything in it. Refused when it is the last window
 * of its tmux session (that would close the terminal itself).
 */
export async function killSessionWindow(key: string, via: Via): Promise<{ name: string; panes: number }> {
  const s = findLive(key);
  if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
  const info = await windowInfo(s.window);
  if (!info) throw new UserError("Tab itu sudah tidak ada.");
  if (info.sessionWindows <= 1) throw new UserError("Ini tab terakhir di tmux; menutupnya menutup terminalnya. Tutup di PC.");
  await killWindow(s.window);
  for (let i = 0; i < 6; i++) {
    await Bun.sleep(500);
    if (!(await windowInfo(s.window))) break;
  }
  log("session_window_killed", { session: key, window: s.window, name: info.name, panes: info.panes, via });
  watches.delete(key);
  saveQueues();
  return { name: info.name, panes: info.panes };
}

/** Starts watching a session for turn ends (e.g. the session in focus after a restart). */
export function watchSession(key: string, since = Date.now()): void {
  watch(key, since);
}

export function queuedCount(key: string): number {
  return watches.get(key)?.queued.length ?? 0;
}

/** Transcribes a follow-up voice note into the session's job folder (no Haiku: you check the text). */
export async function transcribeFollowup(key: string, data: ArrayBuffer, ext: string): Promise<string> {
  if (data.byteLength === 0 || data.byteLength > config.maxAudioBytes) throw new UserError("Ukuran audio tidak valid.");
  const safeExt = /^[a-z0-9]{2,5}$/.test(ext) ? ext : "bin";
  const dir = join(config.stateDir, "followups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${key.replace(/[^a-f0-9]/g, "")}-${Date.now()}.${safeExt}`);
  await Bun.write(file, data);
  const secs = await probeSeconds(file);
  if (secs === null) throw new UserError("Audio tidak bisa dibaca.");
  if (secs > config.maxAudioSeconds) throw new UserError(`Audio maksimal ${config.maxAudioSeconds / 60} menit.`);
  const tr = await transcribe(file);
  log("transcribed", { session: key, followup: true, seconds: secs, chars: tr.text.length });
  if (!tr.text) throw new UserError("Tidak ada ucapan yang terdengar.");
  return tr.text;
}
