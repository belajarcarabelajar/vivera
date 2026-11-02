// Telegram Bot API client, the env and socket paths, and forwarding of updates to the bridge.
import { config } from "../config";
import type { Update } from "./types";

export class TgError extends Error {
  constructor(readonly code: number, description: string) {
    super(`Telegram ${code}: ${description}`);
  }
}

export function telegramApi(token: string) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Never pass the original error on: its message can carry the URL, which holds the token.
      throw new Error(`Telegram ${method}: ${(e as Error).name}`);
    }
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string };
    if (!j.ok) throw new TgError(j.error_code ?? res.status, j.description ?? "unknown");
    return j.result as T;
  }
  async function download(filePath: string): Promise<ArrayBuffer> {
    try {
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (e) {
      throw new Error(`Unduh audio Telegram gagal (${(e as Error).name})`);
    }
  }
  return { call, download };
}

export function telegramEnvPath(): string {
  const env = process.env;
  return env.TELEGRAM_ASK_ENV || `${env.XDG_CONFIG_HOME || `${config.home}/.config`}/vivera-telegram-ask/.env`;
}

export function bridgeSocket(): string {
  const env = process.env;
  return env.TELEGRAM_ASK_SOCKET || `${env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`}/vivera-telegram-ask.sock`;
}

export async function forwardToBridge(u: Update): Promise<boolean> {
  try {
    const res = await fetch("http://bridge/update", {
      method: "POST",
      unix: bridgeSocket(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(u),
      signal: AbortSignal.timeout(2_000),
    } as RequestInit);
    if (!res.ok) return false;
    return ((await res.json()) as { consumed?: boolean }).consumed === true;
  } catch {
    return false; // bridge offline: its asks still work in the terminal
  }
}
