# lan-claude

Control Claude Code sessions from a phone on the same Wi-Fi, by voice or text, over a LAN-only web page and an optional Telegram bot.

The phone sends a voice note or typed text. The PC transcribes it offline (faster-whisper, CPU), Claude Haiku 5.5 turns the transcript into a clean prompt and suggests a working folder, you review and edit on the phone, and the PC opens a new Claude Code session in a background tmux window. Permission requests of launched sessions, and of any other live session, can be answered from the phone. A follow-up can be sent to a running session.

This tool controls tmux and Claude Code on the machine it runs on. Read the security section before you run it.

## Requirements

| Need | Why |
|---|---|
| [Bun](https://bun.sh) 1.4 | runs the server and the specs |
| `tmux` and the `claude` CLI | sessions are opened as tmux windows |
| An open Alacritty window with a tmux client in it | a launch attaches to the tmux session of an Alacritty window; without one it fails with a 409 message |
| `uv`, `ffmpeg`, `ffprobe` | voice notes: `scripts/transcribe.py` runs faster-whisper through `uv` |
| `openssl` | the LAN page is HTTPS only; you create a self-signed certificate once |
| `qrencode` (optional) | `bin/pair-qr.sh` shows the pairing QR code |
| An Anthropic API key | the prompt refinement step (Haiku 5.5) |

## Install

1. Clone vivera to `~/vivera` (the shipped unit file assumes that path) and install the two dependencies: `bun install --cwd ~/vivera/mods/lan-claude`.
2. Make the key available: export `ANTHROPIC_API_KEY`, or put `ANTHROPIC_API_KEY=...` in `<config dir>/.env` (default `~/.config/lan-claude/.env`, or the file named by `LAN_CLAUDE_ENV`).
3. Create the certificate: `mkdir -p <config dir>/tls && openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj /CN=localhost -keyout <config dir>/tls/key.pem -out <config dir>/tls/cert.pem`.
4. Install the unit: copy `deploy/lan-claude.service` to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now lan-claude.service`. For another clone location run `systemctl --user edit lan-claude.service` and override `WorkingDirectory=` and `ExecStart=`.
5. Restrict the port at the firewall to your LAN, for example an nftables rule that accepts TCP port 8443 only from `<your LAN subnet>`.
6. Run `bin/pair-qr.sh` (or `bin/pair-qr.sh --terminal`) and scan the code with the phone. Accept the self-signed certificate warning once.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `LAN_CLAUDE_CONFIG_DIR` | `~/.config/lan-claude` | holds `token`, `tls/cert.pem`, `tls/key.pem`, optional `.env` |
| `LAN_CLAUDE_STATE_DIR` | `~/.local/state/lan-claude` | holds `log.jsonl`, `jobs/`, the kill switch file `off`, queues, follow-ups |
| `LAN_CLAUDE_ENV` | `<config dir>/.env` | env file read for `ANTHROPIC_API_KEY` when the variable is not set |
| `ANTHROPIC_API_KEY` | none | wins over the file |
| `LAN_CLAUDE_PORT` | `8443` | HTTPS port of the LAN page |
| `LAN_CLAUDE_SOCKET` | `$XDG_RUNTIME_DIR/lan-claude.sock` | Unix socket the permission hooks talk to |
| `LAN_CLAUDE_CLAUDE_BIN`, `LAN_CLAUDE_BUN` | found on `PATH` | binaries the launcher uses |
| `LAN_CLAUDE_WHISPER_MODEL`, `LAN_CLAUDE_WHISPER_LANG` | `large-v3`, `id` | transcription model and language |
| `LAN_CLAUDE_TELEGRAM` | on | set to `0` to run without the Telegram bot |

Telegram uses the same env file as vivera's `telegram-ask` bridge (`TELEGRAM_ASK_ENV`, default `~/.config/vivera-telegram-ask/.env`, keys `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`). The bot token never lives in this repository. Without that file the server runs the LAN page only.

## Telegram

Telegram allows one `getUpdates` poller per bot. lan-claude is that poller and forwards every update to the bridge's `POST /update`, so the bridge keeps answering its own buttons. Set up the bridge for forwarded updates with `mods/telegram-ask/deploy/forwarded.conf.example` (the bridge then runs with `TELEGRAM_ASK_POLL=0`). If lan-claude is down, answers to bridge questions wait at Telegram until it polls again.

- Only the chat id in the env file is served. Voice notes, audio files, plain text and buttons are handled here; everything else goes to the bridge.
- `/menu` shows a persistent keyboard: previous and next session, screen, close, model, status. `/model` and `/effort` without an argument open button pickers for the focused session.
- Replies are sent as rich messages; the bot reads Telegram's parse back and resends a table that did not render as a table.
- A finished voice job arrives as a new message that replies to the voice note, so it is visible whatever you did in the chat meanwhile.
- Permission prompts of any live session appear as a card with allow and deny buttons. The dialog is read from the tmux screen strictly, and read again before a key is pressed.

## Session states

Claude Code reports `busy`, `waiting` (a dialog is open), `idle`, and `shell` (the turn is over and a background shell still runs). `idle` and `shell` mean the input box is ready, so a follow-up is typed at once. `busy` and `waiting` queue it; the queue is kept in `<state dir>/queues.json` and survives restarts.

## Security

The tool lets anyone who passes its checks start Claude Code sessions in your trusted folders and answer their permission prompts. Treat it like remote shell access.

| Layer | What it does |
|---|---|
| Network | The server refuses client addresses outside the machine's own private subnets (so loopback and public addresses get 403). Add a firewall rule as well |
| Pairing | A random 32-byte token in `<config dir>/token` (mode 600), shown as a QR code on the PC screen only. The phone then holds an HttpOnly, Secure, SameSite=Strict cookie |
| CSRF | Every POST needs the header `x-lan-claude: 1` |
| Launch | Any existing directory can be launched: the quick list shows folders Claude Code already trusts in `~/.claude.json`, but a typed or browsed path is accepted too, and Claude Code's trust and external-import dialogs for it can be answered from Telegram. At most 6 launches per hour. A kill switch on the page creates `<state dir>/off` |
| Hooks | `PermissionRequest` and `Stop` hooks are added per job through a generated settings file and talk to a Unix socket (mode 600) |
| Telegram | Only the configured chat id is served; the token is never logged |
| Secrets | The Anthropic key comes from the environment or a file outside the repository, and error messages name the file, never a value |

Not covered: a paired phone or the configured chat can start Claude Code in any directory of the machine, the self-signed certificate is not pinned, anyone on your LAN who steals the pairing cookie is you, and rules in your Claude Code `allow` list run without asking even in default permission mode. Messages through Telegram pass Telegram's servers (bot chats are not end-to-end encrypted).

## Tests

`bun test scripts/lan-claude.test.mjs` from the repository root runs every spec of the mod, checks that no file names a personal path or address, and checks the unit file. Inside the mod folder: `bun test ./test/<name>.spec.ts` and `bunx tsc --noEmit` after `bun install`. The specs need no network, no tmux and no installed dependencies.

## Revert

```bash
systemctl --user disable --now lan-claude.service
rm ~/.config/systemd/user/lan-claude.service && systemctl --user daemon-reload
rm -r ~/.config/lan-claude ~/.local/state/lan-claude   # token, certificate, logs, jobs
```

If you set the bridge up for forwarded updates, remove its drop-in and restart the bridge so it polls the bot itself again.
