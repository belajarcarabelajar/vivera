// Shared shapes of the Telegram front end: Bot API payloads, cards, callback acts, and the handler
// groups that app.ts wires together through the context (see ctx.ts).
import type { LiveSession } from "../sessions";

export type Chat = { id: number | string; type?: string };
export type Msg = {
  message_id: number;
  chat: Chat;
  text?: string;
  reply_to_message?: { message_id: number };
  voice?: { file_id: string; file_size?: number; mime_type?: string };
  audio?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
};
export type Update = {
  update_id: number;
  message?: Msg;
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: Chat } };
};
export type Button = { text: string; callback_data: string };
export type Keyboard = Button[][];
export type ReplyKeyboard = { keyboard: { text: string }[][]; resize_keyboard: true; is_persistent: true };
export type ReplyMarkup = ReplyKeyboard | { remove_keyboard: true };
export type Card = { text: string; keyboard: Keyboard };
export type AudioFile = { file_id: string; file_size?: number; mime_type?: string; file_name?: string };

// go/no/fd/sf/bk/ed: draft card; pa/pd: permission of a launched session (hook); ss: pick a session;
// fs/fe/fx: follow-up card; xa/xd: terminal permission dialog of any session (id = session key);
// ta/td: start-up dialog (trust, imports) of a launched job; bf/br/bu/bn/bp: folder browser of a draft;
// mp/ep: model/effort picker (id = session key, or NEW_SCOPE for phone-launched sessions; arg = option index);
// ce/ck/cx: close card of a session (exit Claude, kill the tmux tab, cancel; id = session key).
export type LcAct = "go" | "no" | "fd" | "sf" | "bk" | "ed" | "pa" | "pd" | "ss" | "fs" | "fe" | "fx" | "xa" | "xd" | "ta" | "td" | "bf" | "br" | "bu" | "bp" | "bn" | "ce" | "ck" | "cx" | "mp" | "ep";
export type LcTap = { act: LcAct; id: string; arg: string };
export type ButtonAct = "prev" | "next" | "screen" | "close" | "model" | "status" | "label";

/** Handlers behind the bottom keyboard, the session picker and the close card (handlers-menu.ts). */
export type MenuHandlers = {
  showStatus(): Promise<void>;
  showSessions(): Promise<void>;
  focusOn(s: LiveSession, hint?: string): Promise<void>;
  onButton(act: ButtonAct): Promise<void>;
  showPick(kind: "model" | "effort", scope: string, label: string): Promise<void>;
  onPickTap(cqId: string, messageId: number | undefined, tap: LcTap): Promise<void>;
  askClose(key: string | undefined): Promise<void>;
  onCloseTap(cqId: string, messageId: number | undefined, tap: LcTap): Promise<void>;
};

/** Handlers for plain text, voice and audio (handlers-text.ts). */
export type TextHandlers = {
  deliver(key: string, text: string): Promise<void>;
  onAudio(file: AudioFile, target?: string, voiceMsgId?: number): Promise<void>;
  onText(text: string, target?: string, sessionCtx?: string): Promise<void>;
};
