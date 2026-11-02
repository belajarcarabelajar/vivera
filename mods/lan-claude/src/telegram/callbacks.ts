// The callback_data grammar ("lc:<act>:<id>:<arg>", four parts so the bridge's three-part parser never
// matches) and the owner check: only TELEGRAM_CHAT_ID counts.
import type { Chat, LcAct, LcTap, Update } from "./types";

const LC_RE = /^lc:(go|no|fd|sf|bk|ed|pa|pd|ss|fs|fe|fx|xa|xd|ta|td|bf|br|bu|bp|bn|ce|ck|cx|mp|ep):([a-f0-9]{12}):([0-9]{0,3})$/;

export const lcData = (act: LcAct, id: string, arg = "") => `lc:${act}:${id}:${arg}`;

export function parseLcCallback(data: string): LcTap | null {
  const m = LC_RE.exec(data);
  return m ? { act: m[1] as LcAct, id: m[2], arg: m[3] } : null;
}

export function chatOf(u: Update): Chat | undefined {
  return u.message?.chat ?? u.callback_query?.message?.chat;
}

export function isOwner(u: Update, chatId: string): boolean {
  const c = chatOf(u);
  return c !== undefined && String(c.id) === chatId;
}
