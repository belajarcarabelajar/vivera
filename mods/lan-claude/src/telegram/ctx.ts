// The state and the send, edit, ack helpers that the startTelegram closure used to hold. Everything
// mutable lives on one Ctx object, so two startTelegram calls in one process (tests) share nothing.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { findLive, folderLabel, jobs, liveForJob, log, UserError } from "../core";
import { countTableBlocks, countTables, escapeHtml, htmlToPlain, markdownToHtml } from "../markdown";
import { lastAssistantText, type LiveSession } from "../sessions";
import { TgError, type telegramApi } from "./api";
import { cut, escapeMd, TEXT_MAX } from "./cards";
import { replyKeyboard } from "./menu";
import type { Keyboard, MenuHandlers, ReplyMarkup, TextHandlers } from "./types";

export const randomId = () => randomBytes(6).toString("hex");

/** A card whose buttons answer a dialog; `decided` = answered from here, so the watcher does not edit it again. */
export type DialogCard = { messageId: number; label: string; summary: string; decided: boolean };

export type Ctx = {
  tg: ReturnType<typeof telegramApi>;
  chatId: string;
  // The next text message replaces a draft prompt or a follow-up text.
  editing: { kind: "draft" | "followup"; id: string } | null;
  /** Session mode: "s:<key>" or "j:<job id>"; plain messages go there until /baru. Kept across restarts. */
  focus: string | null;
  menuOn: boolean;
  folderSnap: Map<string, string[]>; // job id -> folder paths shown as buttons
  permMsg: Map<string, Promise<number | null>>;
  followups: Map<string, { key: string; text: string }>;
  // Terminal permission cards per session key: the message that holds the buttons now. A tap on any
  // other (older) message is refused.
  termCards: Map<string, DialogCard>;
  startupCards: Map<string, DialogCard>; // by job id
  browse: Map<string, { dir: string; names: string[]; page: number }>; // by draft job id
  cardKeep: Map<string, number>; // session key -> message id of its open close card
  pickCards: Map<string, number>; // "<kind>:<scope>" -> message id of the open picker
  targets: Map<number, string>;
  remember(messageId: number, target: string): void;
  resolveTarget(t: string | undefined): string | undefined;
  setFocus(t: string | null): void;
  focusKey(): string | null;
  menuMarkup(): ReplyMarkup | undefined;
  send(text: string, keyboard?: Keyboard, markup?: ReplyMarkup, replyTo?: number): Promise<{ message_id: number }>;
  sendRich(head: string, body: string, tail?: string): Promise<{ message_id: number }>;
  edit(messageId: number, text: string, keyboard?: Keyboard): Promise<unknown>;
  ack(id: string, text?: string, alert?: boolean): Promise<unknown>;
  userMessage(e: unknown): string;
  showResult(statusMsgId: number, replyTo: number | undefined, text: string, keyboard?: Keyboard): Promise<number>;
  lastReplyOf(s: LiveSession): string;
  // Late-bound by app.ts once every factory exists; handlers call them at event time, never at build time.
  menu: MenuHandlers;
  text: TextHandlers;
};

export function createCtx(tg: Ctx["tg"], chatId: string): Ctx {
  // Telegram message id -> "s:<session key>" or "j:<job id>" (a launched job; its session is looked up
  // by tmux window). A reply to such a message talks to that session. Kept across restarts.
  const targetsFile = join(config.stateDir, "telegram-targets.json");
  const targets = new Map<number, string>();
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(targetsFile, "utf8")) as Record<string, string>)) targets.set(Number(k), v);
  } catch {}
  const focusFile = join(config.stateDir, "telegram-focus.txt");
  let focus: string | null = null;
  try {
    focus = readFileSync(focusFile, "utf8").trim() || null;
  } catch {}

  const send: Ctx["send"] = (text, keyboard, markup, replyTo) =>
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
  const sendRich: Ctx["sendRich"] = async (head, body, tail = "") => {
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

  const edit: Ctx["edit"] = (messageId, text, keyboard) =>
    tg.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: cut(text, TEXT_MAX),
      reply_markup: { inline_keyboard: keyboard ?? [] },
    }).catch((e) => log("telegram_edit_failed", { error: (e as Error).message }));

  const ctx: Ctx = {
    tg,
    chatId,
    editing: null,
    focus,
    menuOn: true,
    folderSnap: new Map(),
    permMsg: new Map(),
    followups: new Map(),
    termCards: new Map(),
    startupCards: new Map(),
    browse: new Map(),
    cardKeep: new Map(),
    pickCards: new Map(),
    targets,
    remember(messageId, target) {
      targets.set(messageId, target);
      const keep = [...targets.entries()].slice(-500);
      writeFileSync(targetsFile, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
    },
    /** A session key, "starting" (launched under 90 s ago, status file not there yet), or undefined (gone). */
    resolveTarget(t) {
      if (!t) return undefined;
      if (t.startsWith("s:")) return findLive(t.slice(2)) ? t.slice(2) : undefined;
      const job = jobs.get(t.slice(2));
      if (!job) return undefined;
      const key = liveForJob(job)?.key;
      if (key) return key;
      return job.status === "launched" && Date.now() - (job.launchedAt ?? 0) < 90_000 ? "starting" : undefined;
    },
    setFocus(t) {
      ctx.focus = t;
      writeFileSync(focusFile, t ?? "", { mode: 0o600 });
    },
    // Persistent bottom keyboard. The key shows the session in focus; Telegram keeps the last keyboard it
    // got until another one (or remove_keyboard) arrives, so it is only re-sent when the label changes.
    focusKey() {
      const k = ctx.resolveTarget(ctx.focus ?? undefined);
      return k && k !== "starting" ? k : null;
    },
    menuMarkup() {
      if (!ctx.menuOn) return undefined;
      const s = ctx.focusKey() ? findLive(ctx.focusKey()!) : undefined;
      return replyKeyboard(s ? folderLabel(s.cwd) : null);
    },
    send,
    sendRich,
    edit,
    ack: (id, text, alert = false) =>
      tg.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: cut(text, 190), show_alert: alert } : {}) }).catch(() => {}),
    userMessage: (e) => (e instanceof UserError ? e.message : `Gagal: ${(e as Error).message}`),
    /**
     * Result of a background job (a voice note being transcribed): a NEW message under the voice note,
     * so it shows up at the bottom of the chat (with a notification) whatever the owner did while the
     * job ran. Editing the old "Mentranskripsi…" message in place buried the result above newer
     * messages, and a refused edit lost it silently. The status message only gets a pointer; if the
     * send itself fails, the result goes into the status message as before.
     */
    async showResult(statusMsgId, replyTo, text, keyboard) {
      try {
        const m = await send(text, keyboard, undefined, replyTo);
        await edit(statusMsgId, "✅ Selesai, hasilnya ada di pesan baru di bawah.");
        return m.message_id;
      } catch (e) {
        log("telegram_result_send_failed", { error: (e as Error).message });
        await edit(statusMsgId, text, keyboard);
        return statusMsgId;
      }
    },
    lastReplyOf(s) {
      try {
        return lastAssistantText(config.home, s);
      } catch {
        return "";
      }
    },
    // Placeholders until app.ts binds the real handlers.
    menu: undefined as unknown as MenuHandlers,
    text: undefined as unknown as TextHandlers,
  };
  return ctx;
}
