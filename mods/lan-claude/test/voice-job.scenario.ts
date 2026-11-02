// Scenario driver for test/voice-job.test.ts (not a test file itself: no *.test.ts suffix).
// Runs the real startTelegram() loop in its own process with HOME pointing at a scratch dir, so no
// state of the live service is touched. Boundaries are faked: global fetch (Telegram, Anthropic), the
// `uv` executable (whisper) and `claude` (a renamed `sleep`, so /proc/<pid>/comm says "claude").
// Prints one JSON line: every Telegram API call in order, plus what the scenario learned.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] as "followup" | "draft" | "edit-refused" | "session-closed";
const scratch = process.env.VOICE_SCRATCH!;
if (!scratch || !process.env.HOME?.startsWith(scratch)) {
  console.error("refusing to run: HOME is not inside the scratch dir");
  process.exit(3);
}

const { startTelegram, lcData, BTN } = await import("../src/telegram");
const { config } = await import("../src/config");
if (!config.stateDir.startsWith(scratch)) throw new Error("state dir outside scratch");

type Call = { method: string; body: Record<string, any>; id?: number };
const calls: Call[] = [];
const queue: any[] = [];
let nextMsg = 1000;
let failEdits = false;

const wav = (() => {
  const n = 8000;
  const b = new DataView(new ArrayBuffer(44 + n));
  const s = (o: number, t: string) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); b.setUint32(4, 36 + n, true); s(8, "WAVE"); s(12, "fmt "); b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, 8000, true); b.setUint32(28, 8000, true);
  b.setUint16(32, 1, true); b.setUint16(34, 8, true); s(36, "data"); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return new Uint8Array(b.buffer);
})();

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "request-id": "req_fake" } });

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input.url ?? input);
  if (url.startsWith("http://bridge/")) return json({ consumed: false });
  if (url.startsWith("https://api.telegram.org/file/")) return new Response(wav);
  if (url.startsWith("https://api.anthropic.com/")) {
    const text = JSON.stringify({ prompt: "Buka proyeknya", folder: "", note: "" });
    return json({ id: "msg_fake", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(url);
  if (!m) throw new Error(`unexpected fetch: ${url.replace(/bot[^/]+/, "bot<REDACTED>")}`);
  const method = m[1];
  const body = JSON.parse(init?.body ?? "{}");
  if (method === "getUpdates") {
    if (queue.length === 0) {
      await Bun.sleep(20);
      return json({ ok: true, result: [] });
    }
    return json({ ok: true, result: queue.splice(0) });
  }
  const call: Call = { method, body };
  calls.push(call);
  if (method === "getFile") return json({ ok: true, result: { file_path: "voice/note.wav" } });
  if (method === "editMessageText") {
    if (failEdits) return json({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, 400);
    return json({ ok: true, result: true });
  }
  if (method === "sendMessage" || method === "sendRichMessage") {
    call.id = nextMsg++;
    return json({ ok: true, result: { message_id: call.id } });
  }
  return json({ ok: true, result: true });
}) as typeof fetch;

// Two live sessions A (busy, so a send is queued and never pastes into a real tmux pane) and B.
const claudeBin = join(scratch, "bin/claude");
const sessions = [
  { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", cwd: "/home/x/alpha-proj", status: "busy", ts: 2 },
  { id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", cwd: "/home/x/beta-proj", status: "busy", ts: 1 },
].map((s, i) => {
  const proc = Bun.spawn([claudeBin, "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  mkdirSync(join(config.home, ".claude/sessions"), { recursive: true });
  writeFileSync(join(config.home, ".claude/sessions", `${proc.pid}.json`), JSON.stringify({
    pid: proc.pid, sessionId: s.id, cwd: s.cwd, kind: "interactive", tmux: `main:@${i + 1}.%${i + 1}`, name: "", status: s.status, statusUpdatedAt: s.ts,
  }));
  return { ...s, key: s.id.replace(/-/g, "").slice(0, 12), proc };
});
const [A, B] = sessions;

let uid = 1;
const chat = { id: 42 };
// dup-defs: allow the mod ships on its own and must not import another mod's internals; small local helper
const text = (t: string, extra: Record<string, unknown> = {}) => queue.push({ update_id: uid++, message: { message_id: 500 + uid, chat, text: t, ...extra } });
// dup-defs: allow the mod ships on its own and must not import another mod's internals; small local helper
const tap = (data: string, messageId: number) => queue.push({ update_id: uid++, callback_query: { id: `cq${uid}`, data, message: { message_id: messageId, chat } } });
const until = async (pred: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await Bun.sleep(25);
  return pred();
};
const mentions = (c: Call, s: string) => JSON.stringify(c.body).includes(s);

const app = startTelegram();
if (!app) throw new Error("startTelegram returned null");

if (mode !== "draft") {
  tap(lcData("ss", A.key), 1); // focus on session A: voice notes are follow-ups for A
  await until(() => calls.some((c) => c.method === "sendMessage" && mentions(c, "alpha")));
}
failEdits = mode === "edit-refused";

queue.push({ update_id: uid++, message: { message_id: 100, chat, voice: { file_id: "f1", file_size: wav.length } } });
await until(() => calls.some((c) => mentions(c, "Mentranskripsi")));
const statusCall = calls.find((c) => mentions(c, "Mentranskripsi"))!;

// While whisper runs: the owner moves on, taps buttons and opens a picker (fake edits fail only in edit-refused mode).
text(BTN.next);
tap(lcData("ss", B.key), 1);
text("/model");
await until(() => calls.some((c) => c.method === "sendMessage" && mentions(c, "Pilih:")));
const lastIdBefore = nextMsg - 1;
if (mode === "session-closed") {
  A.proc.kill();
  await Bun.sleep(200);
}

await until(() => calls.some((c) => mentions(c, "halo dunia")), 15_000);
await Bun.sleep(300);

const carriers = calls.filter((c) => mentions(c, "halo dunia"));
const carrier = carriers[carriers.length - 1];
let tapResult: string | null = null;
if (carrier && (mode === "followup" || mode === "edit-refused")) {
  const msgId = carrier.method === "editMessageText" ? statusCall.id! : carrier.id!;
  const kb = (carrier.body.reply_markup?.inline_keyboard ?? []) as { text: string; callback_data: string }[][];
  const send = kb.flat().find((b) => b.text.includes("Kirim"));
  if (send) {
    const before = calls.length;
    tap(send.callback_data, msgId);
    await until(() => calls.length > before + 1, 3000);
    await Bun.sleep(200);
    tapResult = calls.slice(before).map((c) => String(c.body.text ?? "")).join(" || ");
  }
}

app.stop();
for (const s of sessions) s.proc.kill();
console.log(JSON.stringify({ mode, lastIdBefore, statusId: statusCall.id, statusKeyboard: null, calls, tapResult, keyA: A.key, keyB: B.key }));
process.exit(0);
