// A voice note is a background job: whatever the owner does in the chat while whisper runs (switch
// session, tap buttons, open a picker), its result must reach the chat as a visible new message for the
// session (or draft) it belongs to. Each scenario runs the real Telegram loop in a child process
// (test/voice-job.scenario.ts) against a fake Telegram/Anthropic fetch, a fake `uv` and a fake `claude`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "lan-claude-voice-"));

// The draft scenario runs refine(), which loads the Anthropic SDK (a fake fetch stands in for the API, but the SDK
// itself must be installed). On a clean clone it is not, so that case is skipped and says why in its name.
const hasSdk = (() => {
  try {
    Bun.resolveSync("@anthropic-ai/sdk", join(import.meta.dir, "../src"));
    return true;
  } catch {
    return false;
  }
})();

type Call = { method: string; body: Record<string, any>; id?: number };
type Result = { calls: Call[]; lastIdBefore: number; statusId: number; tapResult: string | null };

async function scenario(mode: string): Promise<Result> {
  const home = join(scratch, `home-${mode}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "tg.env"), "TELEGRAM_BOT_TOKEN=123:fake-token-for-tests\nTELEGRAM_CHAT_ID=42\n");
  const p = Bun.spawn(["bun", join(import.meta.dir, "voice-job.scenario.ts"), mode], {
    cwd: scratch,
    env: {
      PATH: `${join(scratch, "bin")}:${process.env.PATH}`,
      HOME: home,
      ANTHROPIC_API_KEY: "fake-key-for-tests",
      VOICE_SCRATCH: scratch,
      TELEGRAM_ASK_ENV: join(home, "tg.env"),
      XDG_RUNTIME_DIR: scratch,
    },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`scenario ${mode} exited ${code}: ${err.slice(-600)}`);
  return JSON.parse(out.trim().split("\n").pop()!) as Result;
}

const textOf = (c: Call) => String(c.body.text ?? "");
const withTranscript = (r: Result) => r.calls.filter((c) => JSON.stringify(c.body).includes("halo dunia"));
const keyboardOf = (c: Call) => (c.body.reply_markup?.inline_keyboard ?? []) as { text: string; callback_data: string }[][];

beforeAll(() => {
  mkdirSync(join(scratch, "bin"), { recursive: true });
  // Fake whisper boundary: `uv run ... transcribe.py` takes 1.5 s and prints the JSON the real script prints.
  writeFileSync(join(scratch, "bin/uv"), `#!/bin/sh\nsleep 1.5\necho '{"text":"halo dunia","duration":1,"language":"id"}'\n`);
  chmodSync(join(scratch, "bin/uv"), 0o755);
  copyFileSync("/usr/bin/sleep", join(scratch, "bin/claude")); // comm = "claude", as /proc/<pid>/comm must say
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("voice note while the owner keeps using the chat", () => {
  test("follow-up transcript arrives as a new message at the bottom, for the session it was sent to", async () => {
    const r = await scenario("followup");
    const sent = withTranscript(r).filter((c) => c.method === "sendMessage");
    expect(sent.length).toBe(1);
    expect(sent[0].id!).toBeGreaterThan(r.lastIdBefore); // below everything the owner did meanwhile
    expect(textOf(sent[0])).toContain("alpha-proj");
    expect(textOf(sent[0])).not.toContain("beta-proj");
    expect(keyboardOf(sent[0]).flat().some((b) => b.callback_data.startsWith("lc:fs:"))).toBe(true);
    // Pressing Kirim goes to session A (queued: A is busy), not to the session in focus now (B).
    expect(r.tapResult).toContain("alpha-proj");
    expect(r.tapResult).not.toContain("beta-proj");
    expect(r.calls.some((c) => textOf(c).includes("❌"))).toBe(false);
  }, 60_000);

  test.skipIf(!hasSdk)("new-draft transcript (no session mode; needs bun install --cwd mods/lan-claude) arrives as a new message with the draft buttons", async () => {
    const r = await scenario("draft");
    const sent = withTranscript(r).filter((c) => c.method === "sendMessage");
    expect(sent.length).toBe(1);
    expect(sent[0].id!).toBeGreaterThan(r.lastIdBefore);
    expect(textOf(sent[0])).toContain("Draf sesi Claude Code");
    // No folder named in the voice note: the draft comes with the folder picker (Jelajahi folder…).
    expect(keyboardOf(sent[0]).flat().some((b) => b.callback_data.startsWith("lc:bf:"))).toBe(true);
    expect(r.calls.some((c) => textOf(c).includes("❌"))).toBe(false);
  }, 60_000);

  test("the transcript is not lost when Telegram refuses to edit the old status message", async () => {
    const r = await scenario("edit-refused");
    expect(withTranscript(r).some((c) => c.method === "sendMessage")).toBe(true);
  }, 60_000);

  test("session closed while transcribing: transcript still shown, without a Kirim button", async () => {
    const r = await scenario("session-closed");
    const sent = withTranscript(r).filter((c) => c.method === "sendMessage");
    expect(sent.length).toBe(1);
    expect(textOf(sent[0])).toContain("ditutup");
    expect(keyboardOf(sent[0]).flat().some((b) => b.callback_data.startsWith("lc:fs:"))).toBe(false);
  }, 60_000);
});
