// Telegram entry point on the bot that vivera's telegram-ask bridge also uses.
// Telegram allows one getUpdates poller per bot, so lan-claude is the poller and forwards every update
// to the bridge's POST /update first (the bridge runs with TELEGRAM_ASK_POLL=0, see README). Only what
// the bridge does not consume is handled here: voice notes, audio files, plain text, and buttons whose
// callback_data is "lc:<act>:<id>:<arg>" (four parts, so the bridge's three-part parser never matches).
// Only TELEGRAM_CHAT_ID counts; the token is never logged.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnvFile } from "./envfile";
import { config } from "./config";
import {
  board, cancel, draftFromAudio, draftFromText, findLive, folderLabel, folders, jobs, killed, launch, live, liveForJob, log, onWatch,
  answerStartupDialog, answerTerminalPermission, exitSession, killSessionWindow, launchEffort, launchModel, queuedCount, sendToSession, setKilled, setLaunchEffort, setLaunchModel, switchSessionEffort, switchSessionModel,
  listSubdirs, transcribeFollowup, UserError, validateFolder, watchSession,
} from "./core";
import { countTableBlocks, countTables, escapeHtml, htmlToPlain, markdownToHtml } from "./markdown";
import { lastAssistantText, type LiveSession } from "./sessions";
import type { Job } from "./jobs";
import type { BoardEvent, Decision, Pending } from "./permissions";
import { capture, findTargetSession, windowInfo } from "./tmux";

type Chat = { id: number | string; type?: string };
type Msg = {
  message_id: number;
  chat: Chat;
  text?: string;
  reply_to_message?: { message_id: number };
  voice?: { file_id: string; file_size?: number; mime_type?: string };
  audio?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
};
export type Update = {
  update_id: number;
  message?: Msg;
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: Chat } };
};
type Button = { text: string; callback_data: string };
type Keyboard = Button[][];
export type ReplyKeyboard = { keyboard: { text: string }[][]; resize_keyboard: true; is_persistent: true };
export type ReplyMarkup = ReplyKeyboard | { remove_keyboard: true };
export type Card = { text: string; keyboard: Keyboard };

const TG_MAX_DOWNLOAD = 20 * 1024 * 1024; // Bot API getFile limit
const TEXT_MAX = 4000;
const randomId = () => randomBytes(6).toString("hex");

// ---------- pure helpers (tested) ----------

export { parseEnvFile };

// go/no/fd/sf/bk/ed: draft card; pa/pd: permission of a launched session (hook); ss: pick a session;
// fs/fe/fx: follow-up card; xa/xd: terminal permission dialog of any session (id = session key);
// ta/td: start-up dialog (trust, imports) of a launched job; bf/br/bu/bn/bp: folder browser of a draft;
// mp/ep: model/effort picker (id = session key, or NEW_SCOPE for phone-launched sessions; arg = option index);
// ce/ck/cx: close card of a session (exit Claude, kill the tmux tab, cancel; id = session key).
export type LcAct = "go" | "no" | "fd" | "sf" | "bk" | "ed" | "pa" | "pd" | "ss" | "fs" | "fe" | "fx" | "xa" | "xd" | "ta" | "td" | "bf" | "br" | "bu" | "bp" | "bn" | "ce" | "ck" | "cx" | "mp" | "ep";
export type LcTap = { act: LcAct; id: string; arg: string };
const LC_RE = /^lc:(go|no|fd|sf|bk|ed|pa|pd|ss|fs|fe|fx|xa|xd|ta|td|bf|br|bu|bp|bn|ce|ck|cx|mp|ep):([a-f0-9]{12}):([0-9]{0,3})$/;

export const NEW_SCOPE = "000000000000";
export const MODEL_CHOICES = ["sonnet", "opus", "haiku", "fable", "default"] as const;
export const EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "max", "default"] as const;

/** Model or effort picker: one button per option. Session scope has no "default" effort (not settable per session). */
export function pickCard(kind: "model" | "effort", scope: string, label: string, current: string): Card {
  const opts: readonly string[] = kind === "model" ? MODEL_CHOICES : scope === NEW_SCOPE ? EFFORT_CHOICES : EFFORT_CHOICES.filter((o) => o !== "default");
  const what = kind === "model" ? "🤖 Model" : "🧠 Effort";
  const where = scope === NEW_SCOPE
    ? `untuk sesi BARU dari HP (sekarang: ${current || "default PC"}). Sesi yang sedang jalan tidak berubah.`
    : `untuk sesi ${label} saja. Default PC tidak berubah.`;
  const btns = opts.map((o, i) => ({ text: `${o === current ? "✓ " : ""}${o === "default" ? "default PC" : o}`, callback_data: lcData(kind === "model" ? "mp" : "ep", scope, String(i)) }));
  const rows: Keyboard = [];
  for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
  return { text: `${what} ${where}\nPilih:`, keyboard: rows };
}

export const lcData = (act: LcAct, id: string, arg = "") => `lc:${act}:${id}:${arg}`;

export function parseLcCallback(data: string): LcTap | null {
  const m = LC_RE.exec(data);
  return m ? { act: m[1] as LcAct, id: m[2], arg: m[3] } : null;
}

export function chatOf(u: Update): Chat | undefined {
  return u.message?.chat ?? u.callback_query?.message?.chat;
}

export function isOwner(u: Update, chatId: string): boolean {
  const c = chatOf(u);
  return c !== undefined && String(c.id) === chatId;
}

// dup-defs: allow the mod ships on its own and must not import another mod's internals; small local helper
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);

/** Our own text (labels, hints) inside a rich Markdown message: backslash-escape every marker. */
export const escapeMd = (s: string) => s.replace(/([\\`*_~=|[\]()<>#+\-!$.{}])/g, "\\$1");

export function draftCard(job: Job): Card {
  const lines = [
    "📝 Draf sesi Claude Code",
    "",
    `🗣️ ${cut(job.transcript, 900)}`,
    "",
    "Prompt:",
    cut(job.prompt, 2400),
    "",
    job.folder ? `📁 ${folderLabel(job.folder)}` : "📁 ⚠️ Folder belum dipilih (perintahmu tidak menyebut proyek). Pilih dulu atau ketik /folder <path>, baru bisa dijalankan.",
    `🤖 ${launchModel() || "model default PC"} · 🧠 ${launchEffort() || "effort default"}`,
  ];
  if (job.note) lines.push(`⚠️ ${job.note}`);
  const cancelEdit = [{ text: "❌ Batal", callback_data: lcData("no", job.id) }, { text: "✏️ Ubah prompt", callback_data: lcData("ed", job.id) }];
  return {
    text: cut(lines.join("\n"), TEXT_MAX),
    // Without a folder there is no Jalankan: the only way forward is to pick one.
    keyboard: job.folder
      ? [
        [{ text: "▶️ Jalankan", callback_data: lcData("go", job.id) }, { text: "❌ Batal", callback_data: lcData("no", job.id) }],
        [{ text: "📁 Ganti folder", callback_data: lcData("fd", job.id) }, { text: "✏️ Ubah prompt", callback_data: lcData("ed", job.id) }],
      ]
      : [[{ text: "📁 Pilih folder", callback_data: lcData("fd", job.id) }], cancelEdit],
  };
}

export function folderKeyboard(jobId: string, labels: string[]): Keyboard {
  const rows: Keyboard = [];
  const max = Math.min(labels.length, 20);
  for (let i = 0; i < max; i += 2) {
    rows.push(labels.slice(i, i + 2).map((l, k) => ({ text: l, callback_data: lcData("sf", jobId, String(i + k)) })));
  }
  rows.push([{ text: "📂 Jelajahi folder…", callback_data: lcData("bf", jobId) }]);
  rows.push([{ text: "⬅️ Kembali", callback_data: lcData("bk", jobId) }]);
  return rows;
}

export const BROWSE_PAGE = 14;

/** Folder browser: sub-folders of the current directory, paged, with up / use-this / back. */
export function browseKeyboard(jobId: string, names: string[], page: number, atRoot: boolean): Keyboard {
  const start = page * BROWSE_PAGE;
  const slice = names.slice(start, start + BROWSE_PAGE);
  const rows: Keyboard = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((n, k) => ({ text: `${cut(n, 26)}/`, callback_data: lcData("br", jobId, String(i + k)) })));
  }
  const nav: Button[] = [];
  if (!atRoot) nav.push({ text: "⬆️ Naik", callback_data: lcData("bu", jobId) });
  if (page > 0) nav.push({ text: "⏮", callback_data: lcData("bn", jobId, String(page - 1)) });
  if (start + BROWSE_PAGE < names.length) nav.push({ text: "⏭", callback_data: lcData("bn", jobId, String(page + 1)) });
  if (nav.length > 0) rows.push(nav);
  rows.push([
    { text: "✅ Pakai folder ini", callback_data: lcData("bp", jobId) },
    { text: "⬅️ Kembali", callback_data: lcData("bk", jobId) },
  ]);
  return rows;
}

export function browseText(dir: string, count: number, page: number): string {
  const pages = Math.max(1, Math.ceil(count / BROWSE_PAGE));
  return `📂 ${dir}\n${count} subfolder · halaman ${page + 1}/${pages}\nTap subfolder untuk masuk, atau ✅ untuk memakai folder ini.`;
}

/** Card for a start-up dialog of a launched session (trust this folder / allow external imports). */
export function startupCard(label: string, kind: "trust" | "imports", summary: string, jobId: string): Card {
  const hint =
    kind === "trust"
      ? '✅ Percaya = pilihan "Yes, I trust this folder": Claude Code boleh membaca, mengubah, dan menjalankan file di folder ini, termasuk hook dari folder itu. Hanya untuk folder yang kamu percaya. ⛔ Batal = Esc, sesi keluar.'
      : '✅ Izinkan = pilihan "Yes, allow external imports". ⛔ Tolak = Esc (sesi jalan tanpa impor itu).';
  return {
    text: cut(`🔐 Sesi di ${label} berhenti di dialog awal:\n\n${cut(summary, 2400)}\n\n${hint}`, TEXT_MAX),
    keyboard: [[
      { text: kind === "trust" ? "✅ Percaya & lanjut" : "✅ Izinkan impor", callback_data: lcData("ta", jobId) },
      { text: kind === "trust" ? "⛔ Batal" : "⛔ Tolak", callback_data: lcData("td", jobId) },
    ]],
  };
}

export function permissionCard(p: Pending, job: Job | undefined): Card {
  const where = job ? `${folderLabel(job.folder)} · ${cut(job.prompt, 120)}` : p.job;
  return {
    text: cut(`🔐 Minta izin: ${p.tool}\n\n${p.summary}\n\n${where}`, TEXT_MAX),
    keyboard: [[
      { text: "✅ Izinkan", callback_data: lcData("pa", p.id) },
      { text: "⛔ Tolak", callback_data: lcData("pd", p.id) },
    ]],
  };
}

export function stateLabel(status: string): string {
  return status === "idle" ? "🟢 menunggu pesan"
    : status === "shell" ? "🟢 menunggu pesan (shell latar belakang jalan)"
    : status === "waiting" ? "🔐 ada dialog/izin"
    : "🟡 bekerja";
}

export const sessionLabel = (s: LiveSession) => `${folderLabel(s.cwd)}${s.name ? ` (${s.name})` : ""}`;

export function followupCard(fid: string, label: string, text: string): Card {
  return {
    text: cut(`📨 Kirim ke sesi ${label}?\n\n${text}`, TEXT_MAX),
    keyboard: [[
      { text: "✅ Kirim", callback_data: lcData("fs", fid) },
      { text: "✏️ Ubah", callback_data: lcData("fe", fid) },
      { text: "❌ Batal", callback_data: lcData("fx", fid) },
    ]],
  };
}

export function sessionsKeyboard(sessions: LiveSession[]): Keyboard {
  return sessions.slice(0, 12).map((s) => [{
    text: cut(`${stateLabel(s.status).split(" ")[0]} ${sessionLabel(s)}`, 60),
    callback_data: lcData("ss", s.key),
  }]);
}

/** Card for a permission dialog read off a session's terminal (buttons answer it, see core.answerTerminalPermission). */
export function terminalPermissionCard(label: string, key: string, summary: string): Card {
  return {
    text: cut(`🔐 ${label} minta izin:\n\n${cut(summary, 2800)}\n\n✅ Izinkan = pilihan "Yes" (sekali ini saja). ⛔ Tolak = Esc.`, TEXT_MAX),
    keyboard: [[
      { text: "✅ Izinkan", callback_data: lcData("xa", key) },
      { text: "⛔ Tolak", callback_data: lcData("xd", key) },
    ]],
  };
}

export function closedPermissionText(p: Pending, d: Decision, by: string): string {
  const head =
    d === "allow" ? `✅ Diizinkan (${by})`
    : d === "deny" ? `⛔ Ditolak (${by})`
    : "⌛ Tidak dijawab; dialog izin muncul di terminal PC";
  return cut(`${head}: ${p.tool}\n\n${p.summary}`, TEXT_MAX);
}

/** Texts of the persistent bottom keyboard (ReplyKeyboard); a tap arrives as a plain text message. */
export const BTN = {
  prev: "◀️ Kiri",
  next: "Kanan ▶️",
  screen: "🖥️ Layar",
  close: "🛑 Tutup",
  model: "🤖 Model",
  status: "📊 Status",
} as const;
export type ButtonAct = "prev" | "next" | "screen" | "close" | "model" | "status" | "label";

export function parseButton(text: string | undefined): ButtonAct | null {
  const t = (text ?? "").trim();
  for (const act of ["prev", "next", "screen", "close", "model", "status"] as const) if (t === BTN[act]) return act;
  return t.startsWith("🎯 ") && t.length <= 40 ? "label" : null;
}

/** Bottom keyboard: ◀ [session in focus] ▶ on top, actions below. `label` null = no session in focus. */
export function replyKeyboard(label: string | null): ReplyKeyboard {
  return {
    keyboard: [
      [{ text: BTN.prev }, { text: `🎯 ${cut(label ?? "—", 22)}` }, { text: BTN.next }],
      [{ text: BTN.screen }, { text: BTN.close }, { text: BTN.model }, { text: BTN.status }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/** Stable order for ◀ ▶ (project name, then key); listLiveSessions orders by activity, which jumps around. */
export function sortSessions(sessions: LiveSession[]): LiveSession[] {
  return [...sessions].sort((a, b) => sessionLabel(a).localeCompare(sessionLabel(b)) || a.key.localeCompare(b.key));
}

/** Next (+1) or previous (-1) session key, wrapping around; with no current one, +1 gives the first and -1 the last. */
export function cycleKey(sessions: LiveSession[], current: string | null, dir: 1 | -1): string | null {
  const list = sortSessions(sessions);
  if (list.length === 0) return null;
  const i = list.findIndex((s) => s.key === current);
  if (i < 0) return list[dir === 1 ? 0 : list.length - 1].key;
  return list[(i + dir + list.length) % list.length].key;
}

export function closeCard(label: string, key: string, tab: { name: string; panes: number; sessionWindows: number } | null, state: string): Card {
  const last = tab !== null && tab.sessionWindows <= 1;
  const lines = [
    `🛑 Tutup sesi ${label}?`,
    state,
    tab ? `Tab tmux: ${tab.name || "(tanpa nama)"} · ${tab.panes} pane${last ? " · ini tab terakhir, tidak bisa di-kill dari HP" : ""}` : "Tab tmux tidak terbaca.",
    "",
    "🚪 Exit Claude = Claude Code keluar (kalau sedang bekerja, dihentikan dulu); tab ikut tertutup bila isinya cuma sesi itu.",
    "💥 Kill tab = tab tmux dimatikan paksa beserta semua isinya.",
  ];
  const row: Button[] = [{ text: "🚪 Exit Claude", callback_data: lcData("ce", key) }];
  if (!last) row.push({ text: "💥 Kill tab", callback_data: lcData("ck", key) });
  return { text: cut(lines.join("\n"), TEXT_MAX), keyboard: [row, [{ text: "❌ Batal", callback_data: lcData("cx", key) }]] };
}

/**
 * One getUpdates round: every update goes to the bridge first; what it does not consume and comes
 * from the owner chat is handed to `handle` without waiting (transcription takes ~30 s and must not
 * delay telegram-ask taps behind it). Returns the next offset.
 */
export async function pollOnce(
  offset: number,
  deps: {
    getUpdates(offset: number): Promise<Update[]>;
    forward(u: Update): Promise<boolean>;
    handle(u: Update): Promise<void>;
    chatId: string;
    onError?(e: unknown): void;
  },
): Promise<number> {
  const updates = await deps.getUpdates(offset);
  let next = offset;
  for (const u of updates) {
    next = Math.max(next, u.update_id + 1);
    if (await deps.forward(u).catch(() => false)) continue;
    if (!isOwner(u, deps.chatId)) continue;
    deps.handle(u).catch((e) => deps.onError?.(e));
  }
  return next;
}

// ---------- Telegram API ----------

class TgError extends Error {
  constructor(readonly code: number, description: string) {
    super(`Telegram ${code}: ${description}`);
  }
}

function telegramApi(token: string) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Never pass the original error on: its message can carry the URL, which holds the token.
      throw new Error(`Telegram ${method}: ${(e as Error).name}`);
    }
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string };
    if (!j.ok) throw new TgError(j.error_code ?? res.status, j.description ?? "unknown");
    return j.result as T;
  }
  async function download(filePath: string): Promise<ArrayBuffer> {
    try {
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (e) {
      throw new Error(`Unduh audio Telegram gagal (${(e as Error).name})`);
    }
  }
  return { call, download };
}

// ---------- the app ----------

export function telegramEnvPath(): string {
  const env = process.env;
  return env.TELEGRAM_ASK_ENV || `${env.XDG_CONFIG_HOME || `${config.home}/.config`}/vivera-telegram-ask/.env`;
}

export function bridgeSocket(): string {
  const env = process.env;
  return env.TELEGRAM_ASK_SOCKET || `${env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`}/vivera-telegram-ask.sock`;
}

async function forwardToBridge(u: Update): Promise<boolean> {
  try {
    const res = await fetch("http://bridge/update", {
      method: "POST",
      unix: bridgeSocket(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(u),
      signal: AbortSignal.timeout(2_000),
    } as RequestInit);
    if (!res.ok) return false;
    return ((await res.json()) as { consumed?: boolean }).consumed === true;
  } catch {
    return false; // bridge offline: its asks still work in the terminal
  }
}

const HELP = [
  "lan-claude: kirim voice note atau teks perintah, nanti aku rapikan jadi prompt Claude Code untuk dicek dulu.",
  "",
  "/status  keadaan PC",
  "/off  aktifkan kill switch (tolak semua perintah baru)",
  "/on  matikan kill switch",
  "/sesi  pilih sesi Claude yang aktif di PC untuk dikirimi pesan",
  "/menu  tombol di bawah kolom ketik: ◀️ ▶️ pindah sesi (berputar), 🖥️ layar, 🛑 tutup, 🤖 model, 📊 status; tombol 🎯 di tengah = daftar sesi (/menu off untuk menyembunyikan)",
  "/tutup  tutup sesi yang sedang dipilih: exit Claude atau kill tab tmux",
  "/folder ~/Unduhan  pilih folder apa saja (path bebas) untuk draf yang sedang aktif",
  "/baru  keluar dari mode sesi (pesan berikutnya jadi draf sesi baru)",
  "/effort high  sama seperti /model, untuk effort (low, medium, high, xhigh, max, default)",
  "/model sonnet  di mode sesi: ganti model sesi itu saja; di luar mode sesi: model untuk sesi baru dari HP (opus, haiku, fable, default)",
  "/batal  batal ubah prompt",
  "",
  "Reply pesan dari sebuah sesi (▶️, 💬, 🎯, 📨) untuk mengirim teks atau VN ke sesi itu. Pesan diketik hanya saat sesi menunggu input; kalau sedang bekerja, diantrekan.",
].join("\n");

export function startTelegram(): { stop(): void } | null {
  let env: Record<string, string>;
  try {
    env = parseEnvFile(readFileSync(telegramEnvPath(), "utf8"));
  } catch {
    log("telegram_off", { reason: "env file unreadable" });
    return null;
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("telegram_off", { reason: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing" });
    return null;
  }
  const tg = telegramApi(token);
  let stopped = false;
  // The next text message replaces a draft prompt or a follow-up text.
  let editing: { kind: "draft" | "followup"; id: string } | null = null;
  const folderSnap = new Map<string, string[]>(); // job id -> folder paths shown as buttons
  const permMsg = new Map<string, Promise<number | null>>();
  const followups = new Map<string, { key: string; text: string }>();
  // Terminal permission cards per session key: the message that holds the buttons now. A tap on any
  // other (older) message is refused; "decided" = answered from here, so the watcher does not edit it again.
  const termCards = new Map<string, { messageId: number; label: string; summary: string; decided: boolean }>();
  const startupCards = new Map<string, { messageId: number; label: string; summary: string; decided: boolean }>(); // by job id
  const browse = new Map<string, { dir: string; names: string[]; page: number }>(); // by draft job id

  // Telegram message id -> "s:<session key>" or "j:<job id>" (a launched job; its session is looked up
  // by tmux window). A reply to such a message talks to that session. Kept across restarts.
  const targetsFile = join(config.stateDir, "telegram-targets.json");
  const targets = new Map<number, string>();
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(targetsFile, "utf8")) as Record<string, string>)) targets.set(Number(k), v);
  } catch {}
  const remember = (messageId: number, target: string) => {
    targets.set(messageId, target);
    const keep = [...targets.entries()].slice(-500);
    writeFileSync(targetsFile, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
  };
  /** A session key, "starting" (launched under 90 s ago, status file not there yet), or undefined (gone). */
  const resolveTarget = (t: string | undefined): string | undefined => {
    if (!t) return undefined;
    if (t.startsWith("s:")) return findLive(t.slice(2)) ? t.slice(2) : undefined;
    const job = jobs.get(t.slice(2));
    if (!job) return undefined;
    const key = liveForJob(job)?.key;
    if (key) return key;
    return job.status === "launched" && Date.now() - (job.launchedAt ?? 0) < 90_000 ? "starting" : undefined;
  };

  // Session mode: after ▶️ Jalankan or picking a session in /sesi, plain messages go to that session
  // until /baru. Kept across restarts.
  const focusFile = join(config.stateDir, "telegram-focus.txt");
  let focus: string | null = null;
  try {
    focus = readFileSync(focusFile, "utf8").trim() || null;
  } catch {}
  const setFocus = (t: string | null) => {
    focus = t;
    writeFileSync(focusFile, t ?? "", { mode: 0o600 });
  };
  {
    const key = resolveTarget(focus ?? undefined);
    if (key && key !== "starting") watchSession(key);
  }

  const send = (text: string, keyboard?: Keyboard, markup?: ReplyMarkup, replyTo?: number) =>
    tg.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: cut(text, TEXT_MAX),
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : markup ? { reply_markup: markup } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    }).then((m) => (log("telegram_sent", { message: m.message_id }), m));
  /**
   * Plain head and tail around a Markdown body (Claude's reply). First choice: sendRichMessage (Bot API
   * 10.3, 2026-08-24), which takes the Markdown as is and draws real tables, headings, code blocks, task
   * lists (limit 32,768 characters). If Telegram refuses it, fall back to sendMessage with HTML (tables
   * as aligned blocks or lists), and if that is refused too, plain text.
   */
  const sendRich = async (head: string, body: string, tail = ""): Promise<{ message_id: number }> => {
    try {
      const markdown = [escapeMd(head), cut(body, 30_000), escapeMd(tail)].filter(Boolean).join("\n\n");
      const m = await tg.call<{ message_id: number; rich_message?: unknown }>("sendRichMessage", { chat_id: chatId, rich_message: { markdown } });
      // Read Telegram's own parse back: every Markdown table must have become a table block, otherwise
      // the message is deleted and sent again through the fallback below (a raw pipe table is unreadable).
      const expected = countTables(markdown);
      const found = countTableBlocks(m.rich_message);
      if (found >= expected) {
        log("telegram_sent", { message: m.message_id, rich: true, tables: expected });
        return m;
      }
      log("telegram_table_not_parsed", { message: m.message_id, expected, found });
      await tg.call("deleteMessage", { chat_id: chatId, message_id: m.message_id }).catch(() => {});
    } catch (e) {
      log("telegram_rich_refused", { error: (e as Error).message });
    }
    for (const max of [3000, 1500]) {
      const md = cut(body, max);
      const html = [escapeHtml(head), markdownToHtml(md), escapeHtml(tail)].filter(Boolean).join("\n\n");
      if (html.length > 4096) continue;
      try {
        const m = await tg.call<{ message_id: number }>("sendMessage", {
          chat_id: chatId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        log("telegram_sent", { message: m.message_id, html: true });
        return m;
      } catch (e) {
        if (!(e instanceof TgError && e.code === 400)) throw e;
        log("telegram_html_refused", { error: e.message });
        return send([head, htmlToPlain(markdownToHtml(md)), tail].filter(Boolean).join("\n\n"));
      }
    }
    return send([head, cut(body, 1500), tail].filter(Boolean).join("\n\n"));
  };
  const edit = (messageId: number, text: string, keyboard?: Keyboard) =>
    tg.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: cut(text, TEXT_MAX),
      reply_markup: { inline_keyboard: keyboard ?? [] },
    }).catch((e) => log("telegram_edit_failed", { error: (e as Error).message }));
  const ack = (id: string, text?: string, alert = false) =>
    tg.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: cut(text, 190), show_alert: alert } : {}) }).catch(() => {});
  const userMessage = (e: unknown) => (e instanceof UserError ? e.message : `Gagal: ${(e as Error).message}`);

  /**
   * Result of a background job (a voice note being transcribed): a NEW message under the voice note,
   * so it shows up at the bottom of the chat (with a notification) whatever the owner did while the
   * job ran. Editing the old "Mentranskripsi…" message in place buried the result above newer
   * messages, and a refused edit lost it silently. The status message only gets a pointer; if the
   * send itself fails, the result goes into the status message as before.
   */
  async function showResult(statusMsgId: number, replyTo: number | undefined, text: string, keyboard?: Keyboard): Promise<number> {
    try {
      const m = await send(text, keyboard, undefined, replyTo);
      await edit(statusMsgId, "✅ Selesai, hasilnya ada di pesan baru di bawah.");
      return m.message_id;
    } catch (e) {
      log("telegram_result_send_failed", { error: (e as Error).message });
      await edit(statusMsgId, text, keyboard);
      return statusMsgId;
    }
  }

  async function showDraft(statusMsgId: number, work: () => Promise<Job>, replyTo?: number): Promise<void> {
    try {
      const job = await work();
      const card = draftCard(job);
      if (!job.folder) {
        // Ask right away instead of guessing: show the folder picker under the draft.
        const fs = folders();
        folderSnap.set(job.id, fs.map((f) => f.path));
        await showResult(statusMsgId, replyTo, card.text, folderKeyboard(job.id, fs.map((f) => f.label)));
      } else {
        await showResult(statusMsgId, replyTo, card.text, card.keyboard);
      }
    } catch (e) {
      await showResult(statusMsgId, replyTo, `❌ ${userMessage(e)}`);
    }
  }

  type AudioFile = { file_id: string; file_size?: number; mime_type?: string; file_name?: string };

  async function fetchAudio(file: AudioFile): Promise<{ buf: ArrayBuffer; ext: string }> {
    const f = await tg.call<{ file_path?: string }>("getFile", { file_id: file.file_id });
    if (!f.file_path) throw new UserError("Telegram tidak memberi file audionya.");
    const buf = await tg.download(f.file_path);
    const ext = (file.file_name?.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? f.file_path.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "ogg").toLowerCase();
    return { buf, ext };
  }

  async function deliver(key: string, text: string): Promise<void> {
    try {
      const r = await sendToSession(key, text, "telegram");
      const label = sessionLabel(r.session);
      const m = await send(
        r.result === "sent"
          ? `📨 Dikirim ke ${label}.`
          : `🕒 ${label} sedang ${r.session.status === "waiting" ? "menampilkan dialog" : "bekerja"}; pesan dikirim begitu gilirannya selesai (antrean: ${queuedCount(key)}).`,
      );
      remember(m.message_id, `s:${key}`);
    } catch (e) {
      await send(`❌ ${userMessage(e)}`);
    }
  }

  async function onAudio(file: AudioFile, target?: string, voiceMsgId?: number) {
    if (killed()) return void (await send("Kill switch aktif. Kirim /on untuk mematikannya."));
    if ((file.file_size ?? 0) > Math.min(TG_MAX_DOWNLOAD, config.maxAudioBytes)) {
      return void (await send("Audio terlalu besar (maksimal 20 MB lewat Telegram)."));
    }
    const status = await send("🎧 Mentranskripsi… (±30–60 detik)");
    if (target) {
      try {
        const s = findLive(target);
        if (!s) throw new UserError("Sesi itu sudah selesai atau tidak ditemukan.");
        const { buf, ext } = await fetchAudio(file);
        const text = await transcribeFollowup(target, buf, ext);
        // The session may have been closed while whisper ran: still show what was said, but no Kirim button.
        const now = findLive(target);
        if (!now) {
          await showResult(status.message_id, voiceMsgId, `🎧 Transkrip untuk sesi ${sessionLabel(s)}, tapi sesi itu sudah ditutup jadi tidak dikirim:\n\n${text}`);
          return;
        }
        const fid = randomId();
        followups.set(fid, { key: target, text });
        const card = followupCard(fid, sessionLabel(now), text);
        await showResult(status.message_id, voiceMsgId, card.text, card.keyboard);
      } catch (e) {
        await showResult(status.message_id, voiceMsgId, `❌ ${userMessage(e)}`);
      }
      return;
    }
    await showDraft(status.message_id, async () => {
      const { buf, ext } = await fetchAudio(file);
      return draftFromAudio(buf, ext, "telegram");
    }, voiceMsgId);
  }

  // Persistent bottom keyboard. The key shows the session in focus; Telegram keeps the last keyboard it
  // got until another one (or remove_keyboard) arrives, so it is only re-sent when the label changes.
  let menuOn = true;
  const focusKey = (): string | null => {
    const k = resolveTarget(focus ?? undefined);
    return k && k !== "starting" ? k : null;
  };
  const menuMarkup = (): ReplyMarkup | undefined => {
    if (!menuOn) return undefined;
    const s = focusKey() ? findLive(focusKey()!) : undefined;
    return replyKeyboard(s ? folderLabel(s.cwd) : null);
  };
  const cardKeep = new Map<string, number>(); // session key -> message id of its open close card

  async function showStatus() {
    const sessions = live();
    const lines = [
      `Kill switch: ${killed() ? "AKTIF" : "mati"}`,
      `Terminal (Alacritty + tmux): ${(await findTargetSession()) ? "terbuka" : "tertutup"}`,
      `Izin menunggu (sesi lan-claude): ${board.list().length}`,
      `Sesi Claude aktif: ${sessions.length}`,
      ...sortSessions(sessions).slice(0, 8).map((s) => `• ${stateLabel(s.status)} · ${sessionLabel(s)}${s.key === focusKey() ? " ◀ dipilih" : ""}`),
    ];
    await send(lines.join("\n"));
  }

  async function showSessions() {
    const sessions = live();
    if (sessions.length === 0) return void (await send("Tidak ada sesi Claude Code yang aktif di tmux."));
    await send("Pilih sesi:", sessionsKeyboard(sortSessions(sessions)));
  }

  /** Puts a session in focus: message with the refreshed bottom keyboard, then its last reply. */
  async function focusOn(s: LiveSession, hint = "Mode sesi: pesan berikutnya (teks/VN) masuk ke sesi ini. /baru untuk draf sesi baru.") {
    setFocus(`s:${s.key}`);
    watchSession(s.key);
    const all = sortSessions(live());
    const pos = all.findIndex((x) => x.key === s.key);
    const last = lastReplyOf(s);
    const head = await send(
      `🎯 ${sessionLabel(s)} (${pos + 1}/${all.length}) · ${stateLabel(s.status)}`,
      undefined,
      menuMarkup() ?? undefined,
    );
    remember(head.message_id, `s:${s.key}`);
    const m = await sendRich(last ? "Balasan terakhir:" : "", last ? cut(last, 1500) : "(belum ada balasan teks)", hint);
    remember(m.message_id, `s:${s.key}`);
  }

  async function onButton(act: ButtonAct) {
    if (act === "status") return showStatus();
    if (act === "model") {
      // Session in focus: that session only; otherwise the model for sessions launched from the phone.
      const key = focusKey();
      const s = key ? findLive(key) : undefined;
      return showPick("model", s ? s.key : NEW_SCOPE, s ? sessionLabel(s) : "");
    }
    if (act === "close" || act === "screen" || act === "label") {
      const key = focusKey();
      if (!key) return void (await send("Belum ada sesi yang dipilih. Tekan ◀️ atau ▶️ dulu, atau /sesi.", undefined, menuMarkup()));
      if (act === "label") return showSessions();
      if (act === "close") return askClose(key);
      const s = findLive(key);
      if (!s) return void (await send("Sesi itu sudah selesai.", undefined, menuMarkup()));
      const shot = (await capture(s.pane).catch(() => null)) ?? "";
      const tail = shot.split("\n").filter((l) => l.trim() && !/^[─━\s]+$/.test(l)).slice(-25).join("\n");
      const m = await sendRich(`🖥️ ${sessionLabel(s)} · ${stateLabel(s.status)}`, "```\n" + cut(tail || "(layar kosong)", 3000) + "\n```");
      return void remember(m.message_id, `s:${s.key}`);
    }
    const sessions = live();
    if (sessions.length === 0) return void (await send("Tidak ada sesi Claude Code yang aktif di tmux.", undefined, menuMarkup()));
    const next = cycleKey(sessions, focusKey(), act === "next" ? 1 : -1);
    const s = next ? sessions.find((x) => x.key === next) : undefined;
    if (s) await focusOn(s);
  }

  const pickCards = new Map<string, number>(); // "<kind>:<scope>" -> message id of the open picker

  async function showPick(kind: "model" | "effort", scope: string, label: string) {
    const current = scope === NEW_SCOPE ? (kind === "model" ? launchModel() : launchEffort()) : "";
    const card = pickCard(kind, scope, label, current);
    const prev = pickCards.get(`${kind}:${scope}`);
    if (prev) edit(prev, "⌛ Diganti pilihan yang lebih baru.").catch(() => {});
    const m = await send(card.text, card.keyboard);
    pickCards.set(`${kind}:${scope}`, m.message_id);
  }

  async function onPickTap(cqId: string, messageId: number | undefined, tap: LcTap) {
    const kind = tap.act === "mp" ? "model" : "effort";
    const scope = tap.id;
    if (messageId === undefined || pickCards.get(`${kind}:${scope}`) !== messageId) return void (await ack(cqId, "Pilihan ini sudah tidak aktif.", true));
    const opts: readonly string[] = kind === "model" ? MODEL_CHOICES : EFFORT_CHOICES;
    const sessionOpts = kind === "model" ? opts : opts.filter((o) => o !== "default");
    const choice = (scope === NEW_SCOPE ? opts : sessionOpts)[Number(tap.arg)];
    if (!choice) return void (await ack(cqId, "Pilihan tidak dikenal.", true));
    const noun = kind === "model" ? "Model" : "Effort";
    if (scope === NEW_SCOPE) {
      try {
        if (kind === "model") setLaunchModel(choice);
        else setLaunchEffort(choice);
      } catch (e) {
        return void (await ack(cqId, userMessage(e), true));
      }
      log(kind === "model" ? "launch_model" : "launch_effort", { [kind]: choice, via: "telegram" });
      pickCards.delete(`${kind}:${scope}`);
      await ack(cqId, "Tersimpan");
      return void (await edit(messageId, `${kind === "model" ? "🤖" : "🧠"} ${noun} sesi baru dari HP: ${choice === "default" ? "default PC" : choice}. Sesi yang sedang jalan dan default di PC tidak berubah.`));
    }
    const s = findLive(scope);
    if (!s) {
      pickCards.delete(`${kind}:${scope}`);
      return void (await ack(cqId, "Sesi itu sudah selesai.", true));
    }
    await ack(cqId, `Mengganti ${noun.toLowerCase()}…`);
    await edit(messageId, `⏳ Mengganti ${noun.toLowerCase()} ${sessionLabel(s)} ke ${choice}…`);
    try {
      const done = kind === "model"
        ? `🤖 ${sessionLabel(s)} sekarang memakai ${(await switchSessionModel(scope, choice, "telegram")).label}`
        : `🧠 ${sessionLabel(s)} sekarang memakai effort ${(await switchSessionEffort(scope, choice, "telegram")).level}`;
      pickCards.delete(`${kind}:${scope}`);
      await edit(messageId, `${done}, untuk sesi ini saja. Default PC tidak berubah.`);
    } catch (e) {
      // Keep the picker usable: show the reason on the same card with the buttons back.
      const card = pickCard(kind, scope, sessionLabel(s), "");
      await edit(messageId, `❌ ${userMessage(e)}\n\n${card.text}`, card.keyboard);
    }
  }

  async function askClose(key: string | undefined) {
    const s = key ? findLive(key) : undefined;
    if (!s) return void (await send("Belum ada sesi yang dipilih. Tekan ◀️ atau ▶️ dulu, atau /sesi.", undefined, menuMarkup()));
    const tab = await windowInfo(s.window);
    const card = closeCard(sessionLabel(s), s.key, tab, stateLabel(s.status));
    const prev = cardKeep.get(s.key);
    if (prev) edit(prev, "⌛ Diganti kartu yang lebih baru.").catch(() => {});
    const m = await send(card.text, card.keyboard);
    cardKeep.set(s.key, m.message_id);
  }

  async function onCloseTap(cqId: string, messageId: number | undefined, tap: LcTap) {
    if (messageId === undefined || cardKeep.get(tap.id) !== messageId) return void (await ack(cqId, "Kartu ini sudah tidak aktif.", true));
    const s = findLive(tap.id);
    const label = s ? sessionLabel(s) : tap.id;
    if (tap.act === "cx") {
      cardKeep.delete(tap.id);
      await ack(cqId);
      return void (await edit(messageId, `❌ Tidak ditutup: ${label}`));
    }
    if (!s) {
      cardKeep.delete(tap.id);
      return void (await ack(cqId, "Sesi itu sudah selesai.", true));
    }
    cardKeep.delete(tap.id);
    await ack(cqId, tap.act === "ce" ? "Menutup Claude…" : "Mematikan tab…");
    await edit(messageId, `⏳ ${tap.act === "ce" ? "Keluar dari" : "Mematikan tab"} ${label}…`);
    try {
      let done: string;
      if (tap.act === "ce") {
        const r = await exitSession(tap.id, "telegram");
        if (r === "still-running") return void (await edit(messageId, `⚠️ ${label} belum keluar (masih bekerja atau menampilkan dialog). Cek 🖥️ Layar, atau pakai Kill tab.`));
        done = `✅ Claude Code di ${label} sudah keluar.`;
      } else {
        const r = await killSessionWindow(tap.id, "telegram");
        done = `✅ Tab ${r.name || ""} (${r.panes} pane) ditutup: ${label}.`;
      }
      if (focus === `s:${tap.id}` || resolveTarget(focus ?? undefined) === tap.id) setFocus(null);
      await edit(messageId, done);
      await send("Pilih sesi lain dengan ◀️ ▶️, atau kirim pesan untuk draf sesi baru.", undefined, menuMarkup());
    } catch (e) {
      await edit(messageId, `❌ ${userMessage(e)}`);
    }
  }

  async function onText(text: string, target?: string, sessionCtx?: string) {
    const cmd = text.trim().split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
    if (cmd === "/start" || cmd === "/help") return void (await send(HELP, undefined, menuMarkup()));
    if (cmd === "/menu") {
      if (text.trim().split(/\s+/)[1]?.toLowerCase() === "off") {
        menuOn = false;
        return void (await send("Tombol bawah disembunyikan. /menu untuk menampilkannya lagi.", undefined, { remove_keyboard: true }));
      }
      menuOn = true;
      return void (await send("Tombol bawah aktif. ◀️ ▶️ pindah sesi, 🖥️ lihat layar, 🛑 tutup sesi.", undefined, menuMarkup()));
    }
    if (cmd === "/tutup") return askClose(sessionCtx ?? (focus ? resolveTarget(focus) : undefined));
    if (cmd === "/status") return showStatus();
    if (cmd === "/off" || cmd === "/on") {
      setKilled(cmd === "/off");
      log("kill_switch", { on: cmd === "/off", via: "telegram" });
      return void (await send(cmd === "/off" ? "Kill switch AKTIF. Perintah baru dan pesan ke sesi ditolak." : "Kill switch mati."));
    }
    if (cmd === "/batal") {
      editing = null;
      return void (await send("Ubah dibatalkan."));
    }
    if (cmd === "/effort" && sessionCtx) {
      const arg = text.trim().split(/\s+/)[1];
      const s = findLive(sessionCtx);
      if (!arg) return void (await showPick("effort", sessionCtx, s ? sessionLabel(s) : ""));
      const status = await send(`🧠 Mengganti effort ${s ? sessionLabel(s) : "sesi"} ke ${arg}…`);
      try {
        const r = await switchSessionEffort(sessionCtx, arg, "telegram");
        await edit(status.message_id, `🧠 ${sessionLabel(r.session)} sekarang memakai effort ${r.level}, untuk sesi ini saja. Default PC tidak berubah.`);
        remember(status.message_id, `s:${sessionCtx}`);
      } catch (e) {
        await edit(status.message_id, `❌ ${userMessage(e)}`);
      }
      return;
    }
    if (cmd === "/effort") {
      const arg = text.trim().split(/\s+/)[1];
      if (!arg) return void (await showPick("effort", NEW_SCOPE, ""));
      try {
        setLaunchEffort(arg);
      } catch (e) {
        return void (await send(`❌ ${userMessage(e)}`));
      }
      log("launch_effort", { effort: launchEffort() || "default", via: "telegram" });
      return void (await send(`🧠 Sesi baru dari HP akan memakai effort ${launchEffort() || "default PC"}. Sesi yang sedang jalan dan default di PC tidak berubah.`));
    }
    if (cmd === "/model" && sessionCtx) {
      // Session mode: switch the model of that running session only.
      const arg = text.trim().split(/\s+/)[1];
      const s = findLive(sessionCtx);
      if (!arg) return void (await showPick("model", sessionCtx, s ? sessionLabel(s) : ""));
      const status = await send(`🤖 Mengganti model ${s ? sessionLabel(s) : "sesi"} ke ${arg}…`);
      try {
        const r = await switchSessionModel(sessionCtx, arg, "telegram");
        await edit(status.message_id, `🤖 ${sessionLabel(r.session)} sekarang memakai ${r.label}, untuk sesi ini saja. Default PC tidak berubah.`);
        remember(status.message_id, `s:${sessionCtx}`);
      } catch (e) {
        await edit(status.message_id, `❌ ${userMessage(e)}`);
      }
      return;
    }
    if (cmd === "/model") {
      const arg = text.trim().split(/\s+/)[1];
      if (!arg) return void (await showPick("model", NEW_SCOPE, ""));
      try {
        setLaunchModel(arg);
      } catch (e) {
        return void (await send(`❌ ${userMessage(e)}`));
      }
      log("launch_model", { model: launchModel() || "default", via: "telegram" });
      return void (await send(`🤖 Sesi baru dari HP akan memakai ${launchModel() || "model default PC"}. Sesi yang sedang jalan dan default di PC tidak berubah.`));
    }
    if (cmd === "/folder") {
      const arg = text.trim().replace(/^\S+\s*/, "");
      const draft = jobs.recent().find((j) => j.status === "draft");
      if (!draft) return void (await send("Tidak ada draf aktif. Kirim perintah (teks atau VN) dulu, lalu /folder <path>."));
      if (!arg) return void (await send("Pakai: /folder ~/Unduhan atau /folder /etc"));
      const p = validateFolder(arg, config.home);
      if (!p) return void (await send(`❌ ${arg}: tidak ada atau bukan folder.`));
      const saved = jobs.update(draft.id, { folder: p })!;
      const card = draftCard(saved);
      return void (await send(card.text, card.keyboard));
    }
    if (cmd === "/baru") {
      setFocus(null);
      return void (await send("Mode sesi selesai. Pesan berikutnya jadi draf sesi baru."));
    }
    if (cmd === "/sesi") return showSessions();
    if (killed()) return void (await send("Kill switch aktif. Kirim /on untuk mematikannya."));
    if (editing?.kind === "followup") {
      const fid = editing.id;
      editing = null;
      const f = followups.get(fid);
      followups.delete(fid);
      if (!f) return void (await send("Pesan itu sudah tidak aktif."));
      return deliver(f.key, text);
    }
    if (editing?.kind === "draft") {
      const job = jobs.get(editing.id);
      editing = null;
      if (!job || job.status !== "draft") return void (await send("Draf itu sudah tidak aktif."));
      const prompt = text.trim().replace(/^-+\s*/, "");
      if (!prompt || prompt.length > 8000) return void (await send("Prompt kosong atau terlalu panjang."));
      const saved = jobs.update(job.id, { prompt })!;
      const card = draftCard(saved);
      return void (await send(card.text, card.keyboard));
    }
    if (target) return deliver(target, text);
    if (text.trim().startsWith("/")) return void (await send("Perintah tidak dikenal. /help untuk daftar perintah."));
    const status = await send("✨ Merapikan…");
    await showDraft(status.message_id, () => draftFromText(text, "telegram"));
  }

  async function onTap(cqId: string, messageId: number | undefined, tap: LcTap) {
    if (tap.act === "mp" || tap.act === "ep") return onPickTap(cqId, messageId, tap);
    if (tap.act === "ce" || tap.act === "ck" || tap.act === "cx") return onCloseTap(cqId, messageId, tap);
    if (tap.act === "pa" || tap.act === "pd") {
      const ok = board.decide(tap.id, tap.act === "pa" ? "allow" : "deny", "Telegram");
      log("permission", { id: tap.id, decision: tap.act === "pa" ? "allow" : "deny", ok, via: "telegram" });
      return void (await ack(cqId, ok ? undefined : "Permintaan izin ini sudah selesai."));
    }
    if (tap.act === "ta" || tap.act === "td") {
      const card = startupCards.get(tap.id);
      if (!card || card.messageId !== messageId || card.decided) return void (await ack(cqId, "Dialog ini sudah selesai.", true));
      try {
        await answerStartupDialog(tap.id, tap.act === "ta", "telegram");
        card.decided = true;
        await ack(cqId, tap.act === "ta" ? "Dilanjutkan" : "Dibatalkan");
        await edit(messageId, `${tap.act === "ta" ? "✅ Dilanjutkan" : "⛔ Dibatalkan"} (Telegram): ${card.label}\n\n${cut(card.summary, 3000)}`);
      } catch (e) {
        await ack(cqId, userMessage(e), true);
      }
      return;
    }
    if (tap.act === "xa" || tap.act === "xd") {
      const card = termCards.get(tap.id);
      if (!card || card.messageId !== messageId || card.decided) return void (await ack(cqId, "Permintaan izin ini sudah selesai.", true));
      try {
        await answerTerminalPermission(tap.id, tap.act === "xa", "telegram");
        card.decided = true;
        await ack(cqId, tap.act === "xa" ? "Diizinkan" : "Ditolak");
        await edit(messageId, `${tap.act === "xa" ? "✅ Diizinkan" : "⛔ Ditolak"} (Telegram): ${card.label}\n\n${cut(card.summary, 3000)}`);
      } catch (e) {
        await ack(cqId, userMessage(e), true);
      }
      return;
    }
    if (tap.act === "fs" || tap.act === "fe" || tap.act === "fx") {
      const f = followups.get(tap.id);
      if (!f || messageId === undefined) return void (await ack(cqId, "Pesan ini sudah tidak aktif.", true));
      followups.delete(tap.id);
      await ack(cqId);
      if (tap.act === "fx") return void (await edit(messageId, `❌ Tidak dikirim\n\n${cut(f.text, 3000)}`));
      if (tap.act === "fe") {
        const fid = randomId();
        followups.set(fid, f);
        editing = { kind: "followup", id: fid };
        await edit(messageId, `✏️ Diubah\n\n${cut(f.text, 3000)}`);
        return void (await send("✏️ Kirim teks penggantinya. Teks itu langsung dikirim ke sesi. /batal untuk batal."));
      }
      if (killed()) return void (await edit(messageId, `⛔ Kill switch aktif; tidak dikirim\n\n${cut(f.text, 3000)}`));
      await edit(messageId, `📨 ${cut(f.text, 3000)}`);
      return deliver(f.key, f.text);
    }
    if (tap.act === "ss") {
      const s = findLive(tap.id);
      if (!s) return void (await ack(cqId, "Sesi itu sudah selesai.", true));
      await ack(cqId);
      return void (await focusOn(s));
    }
    const job = jobs.get(tap.id);
    if (!job || job.status !== "draft" || messageId === undefined) {
      return void (await ack(cqId, "Draf ini sudah tidak aktif.", true));
    }
    switch (tap.act) {
      case "go":
        try {
          const saved = await launch(job.id, job.prompt, job.folder, "telegram");
          await ack(cqId, "Sesi dibuka");
          await edit(messageId, `▶️ Dijalankan di ${folderLabel(saved.folder)} (window ${saved.windowId})\n\n${cut(saved.prompt, 3000)}\n\n↩️ Reply pesan ini untuk kirim pesan ke sesi ini.`);
          remember(messageId, `j:${saved.id}`);
          setFocus(`j:${saved.id}`);
          await send(`🎯 Mode sesi: pesan berikutnya (teks/VN) masuk ke sesi ${folderLabel(saved.folder)}. /baru untuk draf sesi baru, /sesi untuk pindah sesi.`);
        } catch (e) {
          await ack(cqId, userMessage(e), true);
        }
        return;
      case "no":
        cancel(job.id);
        await ack(cqId);
        return void (await edit(messageId, `❌ Dibatalkan\n\n${cut(job.prompt, 3000)}`));
      case "fd": {
        const fs = folders();
        folderSnap.set(job.id, fs.map((f) => f.path));
        await ack(cqId);
        return void (await edit(messageId, draftCard(job).text, folderKeyboard(job.id, fs.map((f) => f.label))));
      }
      case "sf": {
        const path = folderSnap.get(job.id)?.[Number(tap.arg)];
        if (!path || !folders().some((f) => f.path === path)) return void (await ack(cqId, "Folder tidak ada di daftar.", true));
        const saved = jobs.update(job.id, { folder: path })!;
        await ack(cqId, folderLabel(path));
        const card = draftCard(saved);
        return void (await edit(messageId, card.text, card.keyboard));
      }
      case "bk": {
        await ack(cqId);
        const card = draftCard(job);
        return void (await edit(messageId, card.text, card.keyboard));
      }
      case "bf":
      case "br":
      case "bu":
      case "bn":
      case "bp": {
        const st = browse.get(job.id);
        let dir: string | null = null;
        let page = 0;
        if (tap.act === "bf") dir = config.home;
        else if (!st) return void (await ack(cqId, "Daftar sudah kedaluwarsa; tap 📂 Jelajahi lagi.", true));
        else if (tap.act === "bp") {
          const saved = jobs.update(job.id, { folder: st.dir })!;
          await ack(cqId, folderLabel(st.dir));
          const card = draftCard(saved);
          return void (await edit(messageId, card.text, card.keyboard));
        } else if (tap.act === "bu") dir = dirname(st.dir);
        else if (tap.act === "bn") {
          dir = st.dir;
          page = Math.min(Number(tap.arg), Math.max(0, Math.ceil(st.names.length / BROWSE_PAGE) - 1));
        } else {
          const child = st.names[st.page * BROWSE_PAGE + Number(tap.arg)];
          dir = child ? validateFolder(join(st.dir, child), config.home) : null;
        }
        if (!dir) return void (await ack(cqId, "Folder itu tidak bisa dibuka.", true));
        const names = listSubdirs(dir);
        browse.set(job.id, { dir, names, page });
        await ack(cqId);
        return void (await edit(messageId, browseText(dir, names.length, page), browseKeyboard(job.id, names, page, dir === "/")));
      }
      case "ed":
        editing = { kind: "draft", id: job.id };
        await ack(cqId);
        return void (await send("✏️ Kirim prompt baru sebagai pesan teks. Isinya dipakai apa adanya, tanpa dirapikan. /batal untuk batal."));
    }
  }

  async function handle(u: Update): Promise<void> {
    const cq = u.callback_query;
    const kind = cq ? `tap:${cq.data?.split(":").slice(0, 2).join(":") ?? "?"}` : u.message?.voice ? "voice" : u.message?.audio ? "audio" : u.message?.text?.startsWith("/") ? u.message.text.split(/\s/)[0] : "text";
    log("telegram_update", { id: u.update_id, kind, reply: u.message?.reply_to_message ? true : undefined });
    if (cq) {
      const tap = typeof cq.data === "string" ? parseLcCallback(cq.data) : null;
      if (!tap) return void (await ack(cq.id)); // stale button of something else: stop the spinner
      return onTap(cq.id, cq.message?.message_id, tap);
    }
    const m = u.message;
    if (!m) return;
    const btn = parseButton(m.text);
    if (btn && !m.reply_to_message) return onButton(btn);
    // A reply to a session's message talks to that session; otherwise the session in focus (session
    // mode); otherwise the message starts a new draft. Commands are never sent to a session.
    const isCommand = typeof m.text === "string" && m.text.trim().startsWith("/");
    const replyTarget = m.reply_to_message ? targets.get(m.reply_to_message.message_id) : undefined;
    const chosen = replyTarget ?? (isCommand || editing ? undefined : (focus ?? undefined));
    let target = resolveTarget(chosen);
    if (target === "starting") return void (await send("Sesinya masih dibuka di PC; kirim lagi beberapa detik lagi."));
    if (chosen && !target) {
      if (chosen === focus) setFocus(null);
      return void (await send("Sesi itu sudah selesai atau window-nya ditutup, mode sesi dimatikan. Kirim lagi untuk draf baru, atau /sesi untuk pilih sesi lain."));
    }
    const sessionCtx = isCommand ? resolveTarget(replyTarget ?? focus ?? undefined) : undefined;
    if (isCommand) target = undefined;
    if (m.voice) return onAudio(m.voice, target, m.message_id);
    if (m.audio) return onAudio(m.audio, target, m.message_id);
    if (typeof m.text === "string") return onText(m.text, target, sessionCtx === "starting" ? undefined : sessionCtx);
  }

  const lastReplyOf = (s: LiveSession) => {
    try {
      return lastAssistantText(config.home, s);
    } catch {
      return "";
    }
  };

  board.subscribe((ev: BoardEvent) => {
    if (ev.type === "open") {
      const card = permissionCard(ev.pending, jobs.get(ev.pending.job));
      permMsg.set(ev.pending.id, send(card.text, card.keyboard).then((m) => m.message_id).catch(() => null));
      return;
    }
    const msg = permMsg.get(ev.pending.id);
    permMsg.delete(ev.pending.id);
    msg?.then((id) => id !== null && edit(id, closedPermissionText(ev.pending, ev.decision, ev.by)));
  });

  onWatch.push((ev) => {
    if (ev.type === "gone") return;
    if (ev.type === "permission_dialog") {
      const label = sessionLabel(ev.session);
      const card = terminalPermissionCard(label, ev.session.key, ev.dialog.summary);
      send(card.text, card.keyboard)
        .then((m) => {
          termCards.set(ev.session.key, { messageId: m.message_id, label, summary: ev.dialog.summary, decided: false });
          remember(m.message_id, `s:${ev.session.key}`);
        })
        .catch((e) => log("telegram_send_failed", { error: (e as Error).message }));
      return;
    }
    if (ev.type === "startup_dialog") {
      const label = folderLabel(ev.job.folder);
      const prev = startupCards.get(ev.job.id);
      if (prev && !prev.decided) {
        prev.decided = true;
        edit(prev.messageId, `⌛ Dijawab di PC: ${prev.label}\n\n${cut(prev.summary, 3000)}`).catch(() => {});
      }
      const card = startupCard(label, ev.dialog.kind, ev.dialog.summary, ev.job.id);
      send(card.text, card.keyboard)
        .then((m) => startupCards.set(ev.job.id, { messageId: m.message_id, label, summary: ev.dialog.summary, decided: false }))
        .catch((e) => log("telegram_send_failed", { error: (e as Error).message }));
      return;
    }
    if (ev.type === "startup_closed") {
      const card = startupCards.get(ev.jobId);
      if (card && !card.decided) {
        card.decided = true;
        edit(card.messageId, `⌛ Dijawab di PC: ${card.label}\n\n${cut(card.summary, 3000)}`).catch(() => {});
      }
      return;
    }
    if (ev.type === "permission_closed") {
      const card = termCards.get(ev.key);
      if (card && !card.decided) {
        card.decided = true;
        edit(card.messageId, `⌛ Dijawab di PC: ${card.label}\n\n${cut(card.summary, 3000)}`).catch(() => {});
      }
      return;
    }
    if (ev.type === "stuck") {
      const tail = ev.screen.split("\n").filter((l) => l.trim() && !/^[─━\s]+$/.test(l)).slice(-15).join("\n");
      sendRich(`⚠️ Sesi di ${folderLabel(ev.job.folder)} belum mulai; tertahan di layar awal di PC (window ${ev.job.windowId}):`, "```\n" + cut(tail, 2500) + "\n```", "Jawab di PC atau tutup window-nya.").catch(() => {});
      return;
    }
    const s = ev.session;
    const label = sessionLabel(s);
    let text: string;
    if (ev.type === "turn_end") {
      const queued = queuedCount(s.key);
      const tail = `${queued ? `🕒 ${queued} pesan antrean segera dikirim.\n` : ""}↩️ Reply untuk membalas sesi ini.`;
      sendRich(`💬 ${label} selesai satu giliran:`, ev.text || "(tanpa teks)", tail)
        .then((m) => remember(m.message_id, `s:${s.key}`))
        .catch((e) => log("telegram_send_failed", { error: (e as Error).message }));
      return;
    } else if (ev.type === "delivered") {
      text = `📨 Antrean dikirim ke ${label}:\n\n${cut(ev.text, 1500)}`;
    } else {
      // Permission requests of lan-claude sessions already arrive as a card with buttons.
      const job = jobs.recent(40).find((j) => j.windowId === s.window);
      if (job && board.list().some((p) => p.job === job.id)) return;
      text = `🔐 ${label} menunggu di PC${s.waitingFor ? `: ${cut(s.waitingFor, 300)}` : ""}. Jawab di terminal (pertanyaan pilihan tetap lewat telegram-ask).`;
    }
    send(text).then((m) => remember(m.message_id, `s:${s.key}`)).catch(() => {});
  });

  (async () => {
    let offset = 0;
    log("telegram_on", { bridgeSocket: bridgeSocket() });
    while (!stopped) {
      try {
        offset = await pollOnce(offset, {
          getUpdates: (o) => tg.call<Update[]>("getUpdates", { offset: o, timeout: 25, allowed_updates: ["message", "callback_query"] }, 40_000),
          forward: forwardToBridge,
          handle,
          chatId,
          onError: (e) => log("telegram_handle_error", { error: (e as Error).message }),
        });
      } catch (e) {
        const conflict = e instanceof TgError && e.code === 409;
        log(conflict ? "telegram_409" : "telegram_poll_error", { error: (e as Error).message });
        await Bun.sleep(conflict ? 30_000 : 5_000);
      }
    }
  })();

  return { stop: () => void (stopped = true) };
}
