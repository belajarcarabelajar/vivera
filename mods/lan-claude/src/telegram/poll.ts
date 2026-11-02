import { isOwner } from "./callbacks";
import type { Update } from "./types";

/**
 * One getUpdates round: every update goes to the bridge first; what it does not consume and comes
 * from the owner chat is handed to `handle` without waiting (transcription takes ~30 s and must not
 * delay telegram-ask taps behind it). Returns the next offset.
 */
export async function pollOnce(
  offset: number,
  deps: {
    getUpdates(offset: number): Promise<Update[]>;
    forward(u: Update): Promise<boolean>;
    handle(u: Update): Promise<void>;
    chatId: string;
    onError?(e: unknown): void;
  },
): Promise<number> {
  const updates = await deps.getUpdates(offset);
  let next = offset;
  for (const u of updates) {
    next = Math.max(next, u.update_id + 1);
    if (await deps.forward(u).catch(() => false)) continue;
    if (!isOwner(u, deps.chatId)) continue;
    deps.handle(u).catch((e) => deps.onError?.(e));
  }
  return next;
}
