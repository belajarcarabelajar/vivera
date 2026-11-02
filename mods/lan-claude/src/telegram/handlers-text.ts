// Handlers for plain text, slash commands, voice notes and audio files. They take the shared context;
// state lives on it, not here.
import {
  draftFromAudio, draftFromText, findLive, folders, jobs, killed, launchEffort, launchModel, log, queuedCount, sendToSession, setKilled,
  setLaunchEffort, setLaunchModel, switchSessionEffort, switchSessionModel, transcribeFollowup, UserError, validateFolder,
} from "../core";
import { config } from "../config";
import type { Job } from "../jobs";
import { draftCard, folderKeyboard, followupCard, sessionLabel } from "./cards";
import { randomId, type Ctx } from "./ctx";
import { NEW_SCOPE } from "./menu";
import type { AudioFile, TextHandlers } from "./types";

const TG_MAX_DOWNLOAD = 20 * 1024 * 1024; // Bot API getFile limit

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

export function createTextHandlers(ctx: Ctx): TextHandlers {
  const { tg, send, edit, userMessage, remember, menuMarkup, showResult } = ctx;

  async function showDraft(statusMsgId: number, work: () => Promise<Job>, replyTo?: number): Promise<void> {
    try {
      const job = await work();
      const card = draftCard(job);
      if (!job.folder) {
        // Ask right away instead of guessing: show the folder picker under the draft.
        const fs = folders();
        ctx.folderSnap.set(job.id, fs.map((f) => f.path));
        await showResult(statusMsgId, replyTo, card.text, folderKeyboard(job.id, fs.map((f) => f.label)));
      } else {
        await showResult(statusMsgId, replyTo, card.text, card.keyboard);
      }
    } catch (e) {
      await showResult(statusMsgId, replyTo, `❌ ${userMessage(e)}`);
    }
  }

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
        ctx.followups.set(fid, { key: target, text });
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

  async function onText(text: string, target?: string, sessionCtx?: string) {
    const cmd = text.trim().split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
    if (cmd === "/start" || cmd === "/help") return void (await send(HELP, undefined, menuMarkup()));
    if (cmd === "/menu") {
      if (text.trim().split(/\s+/)[1]?.toLowerCase() === "off") {
        ctx.menuOn = false;
        return void (await send("Tombol bawah disembunyikan. /menu untuk menampilkannya lagi.", undefined, { remove_keyboard: true }));
      }
      ctx.menuOn = true;
      return void (await send("Tombol bawah aktif. ◀️ ▶️ pindah sesi, 🖥️ lihat layar, 🛑 tutup sesi.", undefined, menuMarkup()));
    }
    if (cmd === "/tutup") return ctx.menu.askClose(sessionCtx ?? (ctx.focus ? ctx.resolveTarget(ctx.focus) : undefined));
    if (cmd === "/status") return ctx.menu.showStatus();
    if (cmd === "/off" || cmd === "/on") {
      setKilled(cmd === "/off");
      log("kill_switch", { on: cmd === "/off", via: "telegram" });
      return void (await send(cmd === "/off" ? "Kill switch AKTIF. Perintah baru dan pesan ke sesi ditolak." : "Kill switch mati."));
    }
    if (cmd === "/batal") {
      ctx.editing = null;
      return void (await send("Ubah dibatalkan."));
    }
    if (cmd === "/effort" && sessionCtx) {
      const arg = text.trim().split(/\s+/)[1];
      const s = findLive(sessionCtx);
      if (!arg) return void (await ctx.menu.showPick("effort", sessionCtx, s ? sessionLabel(s) : ""));
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
      if (!arg) return void (await ctx.menu.showPick("effort", NEW_SCOPE, ""));
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
      if (!arg) return void (await ctx.menu.showPick("model", sessionCtx, s ? sessionLabel(s) : ""));
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
      if (!arg) return void (await ctx.menu.showPick("model", NEW_SCOPE, ""));
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
      ctx.setFocus(null);
      return void (await send("Mode sesi selesai. Pesan berikutnya jadi draf sesi baru."));
    }
    if (cmd === "/sesi") return ctx.menu.showSessions();
    if (killed()) return void (await send("Kill switch aktif. Kirim /on untuk mematikannya."));
    if (ctx.editing?.kind === "followup") {
      const fid = ctx.editing.id;
      ctx.editing = null;
      const f = ctx.followups.get(fid);
      ctx.followups.delete(fid);
      if (!f) return void (await send("Pesan itu sudah tidak aktif."));
      return deliver(f.key, text);
    }
    if (ctx.editing?.kind === "draft") {
      const job = jobs.get(ctx.editing.id);
      ctx.editing = null;
      if (!job || job.status !== "draft") return void (await send("Draf itu sudah tidak aktif."));
      const prompt = text.trim().replace(/^[-\s]+/, "");
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

  return { deliver, onAudio, onText };
}
