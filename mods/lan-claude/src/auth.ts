// Pairing token: one random secret in ~/.config/lan-claude/token (mode 600). The phone gets it once
// through /pair?t=<token> (QR shown on the PC) and keeps it as an HttpOnly, SameSite=Strict cookie.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const COOKIE = "lc_token";

export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (t.length >= 32) return t;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString("base64url");
  writeFileSync(path, t + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return t;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function cookieToken(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/** API calls need the cookie; state-changing calls also need the custom header, which a
 * cross-site form or image cannot send (it would trigger a CORS preflight we never answer). */
export function isAuthorized(req: Request, token: string): boolean {
  const t = cookieToken(req.headers.get("cookie"));
  if (!t || !safeEqual(t, token)) return false;
  if (req.method !== "GET" && req.headers.get("x-lan-claude") !== "1") return false;
  return true;
}

export function pairCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 24 * 365}`;
}
