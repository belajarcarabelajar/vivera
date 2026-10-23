# telegram-ask

Mirrors every `AskUserQuestion` dialog of every Claude Code session on the machine to a Telegram chat. The terminal dialog opens as usual; the same question arrives in Telegram with one button per option. The first answer wins: a Telegram answer closes the terminal dialog, and a terminal answer marks the Telegram message as answered there.

Spec: `docs/code-plan/specs/2026-10-23-telegram-ask-design.md` (local, gitignored). Plan: issue #164.

## Parts

- `hooks/register.ts`: the mod. A `tool.call` hook on `AskUserQuestion` runs `next(e)` (the dialog) and, beside it, posts the question to the bridge and long-polls for the answer. Returning `{ result }` while `next(e)` is pending aborts the dialog.
- `bridge/`: the daemon (Bun). One bridge serves every session on the machine and polls its bot with `getUpdates`. API over a Unix socket: `POST /ask`, `GET /wait/:id` (25 s long-poll), `POST /resolve/:id`, `POST /update` (updates forwarded by another poller, see below).
- `deploy/telegram-ask-bridge.service`: the systemd user unit. `deploy/forwarded.conf.example`: a drop-in for the forwarded setup.

## Telegram

- Single choice: tap the option. Multi-select: tap to toggle (✅), then `Kirim`. Free text: tap `✏️ Lainnya`, then send the answer as a normal message.
- A call with several questions resolves only when every question is answered.
- Only updates from `TELEGRAM_CHAT_ID` count; any other chat is ignored.
- The message names the project and the first 8 characters of the session id, and quotes Claude's latest text (cut so the message stays within 4096 characters).

## Install

1. Create a dedicated bot: talk to [@BotFather](https://t.me/BotFather), send `/newbot`, and keep the token it gives you.
2. Find your chat id: send your new bot any message, then, before the bridge runs (Telegram allows only one poller per bot):

   ```bash
   curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" | jq '.result[].message.chat.id'
   ```

3. Write the env file the bridge reads (`$XDG_CONFIG_HOME/vivera-telegram-ask/.env`, by default `~/.config/vivera-telegram-ask/.env`; `TELEGRAM_ASK_ENV` overrides the path):

   ```bash
   mkdir -p ~/.config/vivera-telegram-ask
   install -m 600 /dev/null ~/.config/vivera-telegram-ask/.env
   printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n' "$TOKEN" "$CHAT_ID" > ~/.config/vivera-telegram-ask/.env
   ```

4. Install the unit and the mod:

   ```bash
   cp ~/vivera/mods/telegram-ask/deploy/telegram-ask-bridge.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now telegram-ask-bridge.service
   claude plugin marketplace add ~/vivera/mods    # once, shared with sprite-model-router
   claude plugin install telegram-ask@vivera-mods
   ```

   Then `/reload-plugins` in a running session.

- The bridge never copies or logs the token. Never set a webhook on the bot: Telegram stops `getUpdates` while one is set.
- Socket: `$XDG_RUNTIME_DIR/vivera-telegram-ask.sock`, mode 0600. Override with `TELEGRAM_ASK_SOCKET` for the bridge and the `socketPath` option in `/config` for the mod.

## When another program already polls the bot

Telegram answers 409 to a second `getUpdates` poller on one token. If another program already polls the bot you want to use, that program stays the only poller, the bridge stops polling, and the program forwards each update to the bridge's `POST /update`. The bridge answers `{ consumed }` within about a second: a tap on a telegram-ask button is always consumed, a text message only while a question waits for its `✏️ Lainnya` answer, and nothing from another chat. The forwarding program keeps every update that is not consumed.

Snipset desktop does this when its `telegram_bridge_socket` preference names the bridge socket (`$XDG_RUNTIME_DIR/vivera-telegram-ask.sock` unless overridden; Snipset PR belajarcarabelajar/Snipset#730).

```bash
mkdir -p ~/.config/systemd/user/telegram-ask-bridge.service.d
cp ~/vivera/mods/telegram-ask/deploy/forwarded.conf.example ~/.config/systemd/user/telegram-ask-bridge.service.d/forwarded.conf
# edit forwarded.conf: uncomment TELEGRAM_ASK_ENV and point it at the env file holding that bot's token and your chat id
systemctl --user daemon-reload && systemctl --user restart telegram-ask-bridge.service
```

The drop-in sets `TELEGRAM_ASK_POLL=0`; the bridge then logs `polling off (updates are forwarded to POST /update)` and only serves the socket.

## Logs and failure

- `journalctl --user -u telegram-ask-bridge -f`: ask ids and counts only, never question text, answers, or the token.
- Bridge stopped or crashed: the dialog shows `telegram-ask: bridge offline` and works as before. A pending ask is lost when the bridge restarts; its buttons then answer "Pertanyaan ini sudah selesai".
- An ask that nobody resolves (its session died) is dropped after 6 h. A `✏️ Lainnya` tap stops taking text messages after 10 min, so later messages stay with the forwarding program, if any.
- `telegram-ask: not sent to Telegram (<status>)` under the dialog: the bridge is up but refused the question; the terminal dialog works as usual.
- Exit 2 at start: a missing env file, key, or socket path (the unit does not restart on it). The log line names the missing file or key, never a value.
- `getUpdates 409` in the log: another program polls the same bot; use the forwarded setup above.

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
rm -r ~/.config/systemd/user/telegram-ask-bridge.service.d    # only if you installed the drop-in
rm ~/.config/systemd/user/telegram-ask-bridge.service && systemctl --user daemon-reload
claude plugin uninstall telegram-ask@vivera-mods
```
