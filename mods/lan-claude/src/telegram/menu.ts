// The persistent bottom keyboard, the model/effort picker and close cards, and ◀ ▶ cycling.
import type { LiveSession } from "../sessions";
import { lcData } from "./callbacks";
import { cut, sessionLabel, TEXT_MAX } from "./cards";
import type { ButtonAct, Button, Card, Keyboard, ReplyKeyboard } from "./types";

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

/** Texts of the persistent bottom keyboard (ReplyKeyboard); a tap arrives as a plain text message. */
export const BTN = {
  prev: "◀️ Kiri",
  next: "Kanan ▶️",
  screen: "🖥️ Layar",
  close: "🛑 Tutup",
  model: "🤖 Model",
  status: "📊 Status",
} as const;

export function parseButton(text: string | undefined): ButtonAct | null {
  const t = (text ?? "").trim();
  for (const act of ["prev", "next", "screen", "close", "model", "status"] as const) if (t === BTN[act]) return act;
  return t.startsWith("🎯 ") && t.length <= 40 ? "label" : null;
}

/** Bottom keyboard: ◀ [session in focus] ▶ on top, actions below. `label` null = no session in focus. */
export function replyKeyboard(label: string | null): ReplyKeyboard {
  return {
    keyboard: [
      [{ text: BTN.prev }, { text: `🎯 ${cut(label ?? "-", 22)}` }, { text: BTN.next }],
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
