// Telegram entry point on the bot that vivera's telegram-ask bridge also uses.
// Telegram allows one getUpdates poller per bot, so lan-claude is the poller and forwards every update
// to the bridge's POST /update first (the bridge runs with TELEGRAM_ASK_POLL=0, see README). Only what
// the bridge does not consume is handled here: voice notes, audio files, plain text, and buttons whose
// callback_data is "lc:<act>:<id>:<arg>" (four parts, so the bridge's three-part parser never matches).
// Only TELEGRAM_CHAT_ID counts; the token is never logged.
import { readFileSync } from "node:fs";
import { log, watchSession } from "../core";
import { parseEnvFile } from "../envfile";
import { bridgeSocket, forwardToBridge, telegramApi, telegramEnvPath, TgError } from "./api";
import { createCtx } from "./ctx";
import { createMenuHandlers } from "./handlers-menu";
import { createTapHandlers } from "./handlers-tap";
import { createTextHandlers } from "./handlers-text";
import { pollOnce } from "./poll";
import type { Update } from "./types";
import { subscribeEvents } from "./watch-events";

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
  const ctx = createCtx(tg, chatId);
  {
    const key = ctx.resolveTarget(ctx.focus ?? undefined);
    if (key && key !== "starting") watchSession(key);
  }
  // Late binding: the handler groups call each other through ctx, so they are assigned only after every
  // factory has run.
  ctx.menu = createMenuHandlers(ctx);
  ctx.text = createTextHandlers(ctx);
  const { handle } = createTapHandlers(ctx);
  subscribeEvents(ctx);

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
