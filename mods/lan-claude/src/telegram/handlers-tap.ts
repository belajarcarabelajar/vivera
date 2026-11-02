// Handlers for inline-button taps and the router that sends each update to the right handler. They take
// the shared context; state lives on it, not here.
import { dirname, join } from "node:path";
import {
  answerStartupDialog, answerTerminalPermission, board, cancel, findLive, folderLabel, folders, jobs, killed, launch, listSubdirs, log, validateFolder,
} from "../core";
import { config } from "../config";
import { BROWSE_PAGE, browseKeyboard, browseText, cut, draftCard, folderKeyboard } from "./cards";
import { parseButton } from "./menu";
import { parseLcCallback } from "./callbacks";
import { randomId, type Ctx } from "./ctx";
import type { LcTap, Update } from "./types";

export function createTapHandlers(ctx: Ctx): { onTap(cqId: string, messageId: number | undefined, tap: LcTap): Promise<void>; handle(u: Update): Promise<void> } {
  const { send, edit, ack, userMessage, remember } = ctx;

  async function onTap(cqId: string, messageId: number | undefined, tap: LcTap) {
    if (tap.act === "mp" || tap.act === "ep") return ctx.menu.onPickTap(cqId, messageId, tap);
    if (tap.act === "ce" || tap.act === "ck" || tap.act === "cx") return ctx.menu.onCloseTap(cqId, messageId, tap);
    if (tap.act === "pa" || tap.act === "pd") {
      const ok = board.decide(tap.id, tap.act === "pa" ? "allow" : "deny", "Telegram");
      log("permission", { id: tap.id, decision: tap.act === "pa" ? "allow" : "deny", ok, via: "telegram" });
      return void (await ack(cqId, ok ? undefined : "Permintaan izin ini sudah selesai."));
    }
    if (tap.act === "ta" || tap.act === "td") {
      const card = ctx.startupCards.get(tap.id);
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
      const card = ctx.termCards.get(tap.id);
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
      const f = ctx.followups.get(tap.id);
      if (!f || messageId === undefined) return void (await ack(cqId, "Pesan ini sudah tidak aktif.", true));
      ctx.followups.delete(tap.id);
      await ack(cqId);
      if (tap.act === "fx") return void (await edit(messageId, `❌ Tidak dikirim\n\n${cut(f.text, 3000)}`));
      if (tap.act === "fe") {
        const fid = randomId();
        ctx.followups.set(fid, f);
        ctx.editing = { kind: "followup", id: fid };
        await edit(messageId, `✏️ Diubah\n\n${cut(f.text, 3000)}`);
        return void (await send("✏️ Kirim teks penggantinya. Teks itu langsung dikirim ke sesi. /batal untuk batal."));
      }
      if (killed()) return void (await edit(messageId, `⛔ Kill switch aktif; tidak dikirim\n\n${cut(f.text, 3000)}`));
      await edit(messageId, `📨 ${cut(f.text, 3000)}`);
      return ctx.text.deliver(f.key, f.text);
    }
    if (tap.act === "ss") {
      const s = findLive(tap.id);
      if (!s) return void (await ack(cqId, "Sesi itu sudah selesai.", true));
      await ack(cqId);
      return void (await ctx.menu.focusOn(s));
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
          ctx.setFocus(`j:${saved.id}`);
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
        ctx.folderSnap.set(job.id, fs.map((f) => f.path));
        await ack(cqId);
        return void (await edit(messageId, draftCard(job).text, folderKeyboard(job.id, fs.map((f) => f.label))));
      }
      case "sf": {
        const path = ctx.folderSnap.get(job.id)?.[Number(tap.arg)];
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
        const st = ctx.browse.get(job.id);
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
        ctx.browse.set(job.id, { dir, names, page });
        await ack(cqId);
        return void (await edit(messageId, browseText(dir, names.length, page), browseKeyboard(job.id, names, page, dir === "/")));
      }
      case "ed":
        ctx.editing = { kind: "draft", id: job.id };
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
    if (btn && !m.reply_to_message) return ctx.menu.onButton(btn);
    // A reply to a session's message talks to that session; otherwise the session in focus (session
    // mode); otherwise the message starts a new draft. Commands are never sent to a session.
    const isCommand = typeof m.text === "string" && m.text.trim().startsWith("/");
    const replyTarget = m.reply_to_message ? ctx.targets.get(m.reply_to_message.message_id) : undefined;
    const chosen = replyTarget ?? (isCommand || ctx.editing ? undefined : (ctx.focus ?? undefined));
    let target = ctx.resolveTarget(chosen);
    if (target === "starting") return void (await send("Sesinya masih dibuka di PC; kirim lagi beberapa detik lagi."));
    if (chosen && !target) {
      if (chosen === ctx.focus) ctx.setFocus(null);
      return void (await send("Sesi itu sudah selesai atau window-nya ditutup, mode sesi dimatikan. Kirim lagi untuk draf baru, atau /sesi untuk pilih sesi lain."));
    }
    const sessionCtx = isCommand ? ctx.resolveTarget(replyTarget ?? ctx.focus ?? undefined) : undefined;
    if (isCommand) target = undefined;
    if (m.voice) return ctx.text.onAudio(m.voice, target, m.message_id);
    if (m.audio) return ctx.text.onAudio(m.audio, target, m.message_id);
    if (typeof m.text === "string") return ctx.text.onText(m.text, target, sessionCtx === "starting" ? undefined : sessionCtx);
  }

  return { onTap, handle };
}
