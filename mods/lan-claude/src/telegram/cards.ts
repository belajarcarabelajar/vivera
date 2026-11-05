// Pure card and keyboard builders: no I/O, no state, tested directly in test/telegram.spec.ts.
import { folderLabel, launchEffort, launchModel } from "../core";
import type { LiveSession } from "../sessions";
import type { Job } from "../jobs";
import type { Decision, Pending } from "../permissions";
import { lcData } from "./callbacks";
import type { Button, Card, Keyboard } from "./types";

export const TEXT_MAX = 4000;

// dup-defs: allow the mod ships on its own and must not import another mod's internals; small local helper
export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);

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
  const deny = { text: "⛔ Tolak", callback_data: lcData("pd", p.id) };
  // A cut summary hides part of the request, so allowing it from the phone would be allowing unseen text.
  if (p.truncated) {
    return {
      text: cut(`🔐 Minta izin: ${p.tool}\n\n${p.summary}\n\n⚠️ Ringkasan terpotong: Izinkan hanya bisa di PC, jawab di PC. Tolak tetap bisa dari sini.\n\n${where}`, TEXT_MAX),
      keyboard: [[deny]],
    };
  }
  return {
    text: cut(`🔐 Minta izin: ${p.tool}\n\n${p.summary}\n\n${where}`, TEXT_MAX),
    keyboard: [[{ text: "✅ Izinkan", callback_data: lcData("pa", p.id) }, deny]],
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
