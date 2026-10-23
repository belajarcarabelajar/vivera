# telegram-ask

Mirrors every `AskUserQuestion` dialog of every Claude Code session on this machine to a Telegram chat. The terminal dialog opens as usual; the same question arrives in Telegram with one button per option. The first answer wins: a Telegram answer closes the terminal dialog, and a terminal answer marks the Telegram message as answered there.

Spec: `docs/code-plan/specs/2026-10-23-telegram-ask-design.md` (local, gitignored). Plan: issue #164.

## Parts

- `hooks/register.ts`: the mod. A `tool.call` hook on `AskUserQuestion` runs `next(e)` (the dialog) and, beside it, posts the question to the bridge and long-polls for the answer. Returning `{ result }` while `next(e)` is pending aborts the dialog.
- `bridge/`: the daemon (Bun). One bridge serves every session on this machine; it does not poll Telegram itself (see below). API over a Unix socket: `POST /ask`, `GET /wait/:id` (50 s long-poll), `POST /resolve/:id`, `POST /update`.
- `deploy/telegram-ask-bridge.service`: the systemd user unit.

## Updates come from Snipset

Snipset desktop already polls this bot, and Telegram answers 409 to a second `getUpdates` poller on one token. So Snipset stays the bot's only poller and forwards each update to the bridge's `POST /update`, which answers `{ consumed }` within about a second: a tap on a telegram-ask button is always consumed, a text message only while a question waits for its `✏️ Lainnya` answer, and nothing from another chat. Snipset keeps every update that is not consumed.

- Set the Snipset preference `telegram_bridge_socket` to the bridge socket path (`$XDG_RUNTIME_DIR/vivera-telegram-ask.sock` unless overridden).
- `TELEGRAM_ASK_POLL=1` makes the bridge poll Telegram itself. Use it only with a dedicated bot that nobody else polls; without it the bridge logs `polling off (Snipset forwards updates)` and only serves the socket.

## Telegram

- Single choice: tap the option. Multi-select: tap to toggle (✅), then `Kirim`. Free text: tap `✏️ Lainnya`, then send the answer as a normal message.
- A call with several questions resolves only when every question is answered.
- Only updates from `TELEGRAM_CHAT_ID` count; any other chat is ignored.
- The message names the project and the first 8 characters of the session id, and quotes Claude's latest text (cut so the message stays within 4096 characters).

## Install

```bash
cp ~/vivera/mods/telegram-ask/deploy/telegram-ask-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now telegram-ask-bridge.service
claude plugin marketplace add ~/vivera/mods    # once, shared with sprite-model-router
claude plugin install telegram-ask@vivera-mods
```

Then `/reload-plugins` in a running session.

- The bridge reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from `~/Proyek/gmail-otp-telegram/.env` in place (override with `TELEGRAM_ASK_ENV`); it never copies or logs the token. That bot also carries the OTP Worker, which only calls `sendMessage`; never set a webhook on it, or polling stops.
- Socket: `$XDG_RUNTIME_DIR/vivera-telegram-ask.sock`, mode 0600. Override with `TELEGRAM_ASK_SOCKET` for the bridge and the `socketPath` option in `/config` for the mod.

## Logs and failure

- `journalctl --user -u telegram-ask-bridge -f`: ask ids and counts only, never question text, answers, or the token.
- Bridge stopped or crashed: the dialog shows `telegram-ask: bridge offline` and works as before. A pending ask is lost when the bridge restarts; its buttons then answer "Pertanyaan ini sudah selesai".
- Exit 2 at start: a missing env file, key, or socket path (the unit does not restart on it).

## Tests

```bash
bun test ./mods/telegram-ask/bridge/          # bridge, Bun tests named *.spec.ts
claude plugin test mods/telegram-ask          # the hook, *.test.ts
bun test scripts/telegram-ask.test.mjs        # both, as the repository suite runs them
```

The bridge tests end in `.spec.ts` because `claude plugin test` runs every `*.test.ts` under the mod and refuses a `bun:test` import.

## Revert

```bash
systemctl --user disable --now telegram-ask-bridge.service
rm ~/.config/systemd/user/telegram-ask-bridge.service && systemctl --user daemon-reload
claude plugin uninstall telegram-ask@vivera-mods
```
