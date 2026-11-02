// Handlers behind the persistent bottom keyboard, the session list, the model/effort picker and the
// close card. They take the shared context; state lives on it, not here.
import {
  board, exitSession, findLive, killSessionWindow, launchEffort, launchModel, live, killed, log, setLaunchEffort, setLaunchModel,
  switchSessionEffort, switchSessionModel, watchSession,
} from "../core";
import type { LiveSession } from "../sessions";
import { capture, findTargetSession, windowInfo } from "../tmux";
import { cut, sessionLabel, sessionsKeyboard, stateLabel } from "./cards";
import type { Ctx } from "./ctx";
import { closeCard, cycleKey, EFFORT_CHOICES, MODEL_CHOICES, NEW_SCOPE, pickCard, sortSessions } from "./menu";
import type { ButtonAct, LcTap, MenuHandlers } from "./types";

export function createMenuHandlers(ctx: Ctx): MenuHandlers {
  const { send, sendRich, edit, ack, userMessage, remember, menuMarkup, focusKey } = ctx;

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
    ctx.setFocus(`s:${s.key}`);
    watchSession(s.key);
    const all = sortSessions(live());
    const pos = all.findIndex((x) => x.key === s.key);
    const last = ctx.lastReplyOf(s);
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

  async function showPick(kind: "model" | "effort", scope: string, label: string) {
    const current = scope === NEW_SCOPE ? (kind === "model" ? launchModel() : launchEffort()) : "";
    const card = pickCard(kind, scope, label, current);
    const prev = ctx.pickCards.get(`${kind}:${scope}`);
    if (prev) edit(prev, "⌛ Diganti pilihan yang lebih baru.").catch(() => {});
    const m = await send(card.text, card.keyboard);
    ctx.pickCards.set(`${kind}:${scope}`, m.message_id);
  }

  async function onPickTap(cqId: string, messageId: number | undefined, tap: LcTap) {
    const kind = tap.act === "mp" ? "model" : "effort";
    const scope = tap.id;
    if (messageId === undefined || ctx.pickCards.get(`${kind}:${scope}`) !== messageId) return void (await ack(cqId, "Pilihan ini sudah tidak aktif.", true));
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
      ctx.pickCards.delete(`${kind}:${scope}`);
      await ack(cqId, "Tersimpan");
      return void (await edit(messageId, `${kind === "model" ? "🤖" : "🧠"} ${noun} sesi baru dari HP: ${choice === "default" ? "default PC" : choice}. Sesi yang sedang jalan dan default di PC tidak berubah.`));
    }
    const s = findLive(scope);
    if (!s) {
      ctx.pickCards.delete(`${kind}:${scope}`);
      return void (await ack(cqId, "Sesi itu sudah selesai.", true));
    }
    await ack(cqId, `Mengganti ${noun.toLowerCase()}…`);
    await edit(messageId, `⏳ Mengganti ${noun.toLowerCase()} ${sessionLabel(s)} ke ${choice}…`);
    try {
      const done = kind === "model"
        ? `🤖 ${sessionLabel(s)} sekarang memakai ${(await switchSessionModel(scope, choice, "telegram")).label}`
        : `🧠 ${sessionLabel(s)} sekarang memakai effort ${(await switchSessionEffort(scope, choice, "telegram")).level}`;
      ctx.pickCards.delete(`${kind}:${scope}`);
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
    const prev = ctx.cardKeep.get(s.key);
    if (prev) edit(prev, "⌛ Diganti kartu yang lebih baru.").catch(() => {});
    const m = await send(card.text, card.keyboard);
    ctx.cardKeep.set(s.key, m.message_id);
  }

  async function onCloseTap(cqId: string, messageId: number | undefined, tap: LcTap) {
    if (messageId === undefined || ctx.cardKeep.get(tap.id) !== messageId) return void (await ack(cqId, "Kartu ini sudah tidak aktif.", true));
    const s = findLive(tap.id);
    const label = s ? sessionLabel(s) : tap.id;
    if (tap.act === "cx") {
      ctx.cardKeep.delete(tap.id);
      await ack(cqId);
      return void (await edit(messageId, `❌ Tidak ditutup: ${label}`));
    }
    if (!s) {
      ctx.cardKeep.delete(tap.id);
      return void (await ack(cqId, "Sesi itu sudah selesai.", true));
    }
    ctx.cardKeep.delete(tap.id);
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
      if (ctx.focus === `s:${tap.id}` || ctx.resolveTarget(ctx.focus ?? undefined) === tap.id) ctx.setFocus(null);
      await edit(messageId, done);
      await send("Pilih sesi lain dengan ◀️ ▶️, atau kirim pesan untuk draf sesi baru.", undefined, menuMarkup());
    } catch (e) {
      await edit(messageId, `❌ ${userMessage(e)}`);
    }
  }

  return { showStatus, showSessions, focusOn, onButton, showPick, onPickTap, askClose, onCloseTap };
}
