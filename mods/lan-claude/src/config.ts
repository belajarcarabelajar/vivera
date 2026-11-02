import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const env = process.env;

export const config = {
  port: Number(env.LAN_CLAUDE_PORT ?? 8443),
  home: HOME,
  /** The mod folder: the launcher, the public page and the scripts are found relative to it. */
  appDir: join(import.meta.dir, ".."),
  configDir: env.LAN_CLAUDE_CONFIG_DIR ?? join(HOME, ".config/lan-claude"),
  stateDir: env.LAN_CLAUDE_STATE_DIR ?? join(HOME, ".local/state/lan-claude"),
  socketPath: env.LAN_CLAUDE_SOCKET ?? join(env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`, "lan-claude.sock"),
  /** Working folders offered on the phone come from Claude Code's trusted projects in this file. */
  claudeJson: join(HOME, ".claude.json"),
  maxLaunchesPerHour: 6,
  maxAudioBytes: 25 * 1024 * 1024,
  maxAudioSeconds: 600,
  whisperModel: env.LAN_CLAUDE_WHISPER_MODEL ?? "large-v3",
  whisperLanguage: env.LAN_CLAUDE_WHISPER_LANG ?? "id",
  refineModel: "claude-haiku-5-5",
  /** How long a permission request waits for a tap on the phone before the terminal dialog takes over. */
  permissionWaitMs: 10 * 60 * 1000,
};

export const paths = {
  token: join(config.configDir, "token"),
  tlsCert: join(config.configDir, "tls/cert.pem"),
  tlsKey: join(config.configDir, "tls/key.pem"),
  killSwitch: join(config.stateDir, "off"),
  log: join(config.stateDir, "log.jsonl"),
  jobs: join(config.stateDir, "jobs"),
  launcher: join(config.appDir, "bin/launch-claude.sh"),
  transcribeScript: join(config.appDir, "scripts/transcribe.py"),
};
