// Subscriptions to the permission board and the session watcher: they turn core events into Telegram
// cards and notices. They take the shared context; state lives on it, not here.
import { board, folderLabel, jobs, log, onWatch, queuedCount } from "../core";
import type { BoardEvent } from "../permissions";
import { closedPermissionText, cut, permissionCard, sessionLabel, startupCard, terminalPermissionCard } from "./cards";
import type { Ctx } from "./ctx";

export function subscribeEvents(ctx: Ctx): void {
  const { send, sendRich, edit, remember } = ctx;

  board.subscribe((ev: BoardEvent) => {
    if (ev.type === "open") {
      const card = permissionCard(ev.pending, jobs.get(ev.pending.job));
      ctx.permMsg.set(ev.pending.id, send(card.text, card.keyboard).then((m) => m.message_id).catch(() => null));
      return;
    }
    const msg = ctx.permMsg.get(ev.pending.id);
    ctx.permMsg.delete(ev.pending.id);
    msg?.then((id) => id !== null && edit(id, closedPermissionText(ev.pending, ev.decision, ev.by)));
  });

  onWatch.push((ev) => {
    if (ev.type === "gone") return;
    if (ev.type === "permission_dialog") {
      const label = sessionLabel(ev.session);
      const card = terminalPermissionCard(label, ev.session.key, ev.dialog.summary);
      send(card.text, card.keyboard)
        .then((m) => {
          ctx.termCards.set(ev.session.key, { messageId: m.message_id, label, summary: ev.dialog.summary, decided: false });
          remember(m.message_id, `s:${ev.session.key}`);
        })
        .catch((e) => log("telegram_send_failed", { error: (e as Error).message }));
      return;
    }
    if (ev.type === "startup_dialog") {
      const label = folderLabel(ev.job.folder);
      const prev = ctx.startupCards.get(ev.job.id);
      if (prev && !prev.decided) {
        prev.decided = true;
        edit(prev.messageId, `⌛ Dijawab di PC: ${prev.label}\n\n${cut(prev.summary, 3000)}`).catch(() => {});
      }
      const card = startupCard(label, ev.dialog.kind, ev.dialog.summary, ev.job.id);
      send(card.text, card.keyboard)
        .then((m) => ctx.startupCards.set(ev.job.id, { messageId: m.message_id, label, summary: ev.dialog.summary, decided: false }))
        .catch((e) => log("telegram_send_failed", { error: (e as Error).message }));
      return;
    }
    if (ev.type === "startup_closed") {
      const card = ctx.startupCards.get(ev.jobId);
      if (card && !card.decided) {
        card.decided = true;
        edit(card.messageId, `⌛ Dijawab di PC: ${card.label}\n\n${cut(card.summary, 3000)}`).catch(() => {});
      }
      return;
    }
    if (ev.type === "permission_closed") {
      const card = ctx.termCards.get(ev.key);
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
}
