import { describe, expect, test } from "bun:test";
import type { Job } from "../src/jobs";
import type { LiveSession } from "../src/sessions";
import {
  BTN, EFFORT_CHOICES, MODEL_CHOICES, NEW_SCOPE, pickCard, browseKeyboard, browseText, closeCard, cycleKey, draftCard, parseButton, replyKeyboard, sortSessions, folderKeyboard, followupCard, isOwner, sessionsKeyboard, startupCard, terminalPermissionCard, lcData, parseEnvFile, parseLcCallback, permissionCard, pollOnce, type Update,
} from "../src/telegram";

const CHAT = "111";
const job: Job = {
  id: "abcdef012345", createdAt: 1, source: "voice", via: "telegram", transcript: "eh cek tes", prompt: "Cek tes.",
  folder: "/home/x/Proyek/a", note: "", status: "draft", turns: 0,
};
// The bridge's parser (vivera telegram-ask format.ts): exactly three parts, id = six lowercase letters.
const bridgeWouldTake = (data: string) => {
  const p = data.split(":");
  return p.length === 3 && /^[a-z]{6}$/.test(p[0]) && /^(0|[1-9]\d{0,2})$/.test(p[1]);
};

describe("telegram", () => {
  test("env parser keeps quoted # and drops trailing notes", () => {
    expect(parseEnvFile('A=1 # note\nB="x # y"\n# c\nexport C=3')).toEqual({ A: "1", B: "x # y", C: "3" });
  });

  test("lc callbacks round-trip and never look like a telegram-ask button", () => {
    for (const d of [lcData("go", job.id), lcData("sf", job.id, "12"), lcData("pa", "0123456789ab")]) {
      expect(parseLcCallback(d)).not.toBeNull();
      expect(bridgeWouldTake(d)).toBe(false);
      expect(d.length).toBeLessThanOrEqual(64);
    }
    expect(parseLcCallback("abcdef:0:1")).toBeNull();
    expect(parseLcCallback("lc:rm:abcdef012345:")).toBeNull();
    expect(parseLcCallback("lc:go:../../etc:")).toBeNull();
  });

  test("every button on the cards is an lc callback", () => {
    const keyboards = [
      draftCard(job).keyboard,
      folderKeyboard(job.id, Array.from({ length: 25 }, (_, i) => `~/p${i}`)),
      permissionCard({ id: "0123456789ab", job: job.id, tool: "Bash", summary: "ls", createdAt: 1 }, job).keyboard,
      followupCard("0123456789ab", "~/Proyek/a", "lanjutkan").keyboard,
      terminalPermissionCard("~ (demo-4b)", "aaaaaaaaaaaa", "Bash command\ntouch /x").keyboard,
      startupCard("~", "trust", "Accessing workspace: /x", job.id).keyboard,
      startupCard("~", "imports", "Allow external CLAUDE.md file imports?", job.id).keyboard,
      browseKeyboard(job.id, Array.from({ length: 30 }, (_, i) => `folder-${i}`), 1, false),
      sessionsKeyboard([
        { key: "111111112222", pid: 1, sessionId: "11111111-2222-4333-8444-555555555555", name: "app-01", cwd: "/home/x/Proyek/app", pane: "%32", window: "@16", status: "idle", statusUpdatedAt: 1 },
      ]),
    ];
    for (const kb of keyboards) {
      for (const row of kb) {
        for (const b of row) {
          expect(parseLcCallback(b.callback_data)).not.toBeNull();
          expect(bridgeWouldTake(b.callback_data)).toBe(false);
        }
      }
    }
    expect(folderKeyboard(job.id, Array.from({ length: 25 }, (_, i) => `~/p${i}`)).flat().length).toBe(22); // 20 + browse + back
  });

  test("owner check uses the chat of the message or the tapped message", () => {
    expect(isOwner({ update_id: 1, message: { message_id: 1, chat: { id: 111 }, text: "x" } }, CHAT)).toBe(true);
    expect(isOwner({ update_id: 1, message: { message_id: 1, chat: { id: 222 }, text: "x" } }, CHAT)).toBe(false);
    expect(isOwner({ update_id: 1, callback_query: { id: "q", data: "x", message: { message_id: 1, chat: { id: 111 } } } }, CHAT)).toBe(true);
    expect(isOwner({ update_id: 1, callback_query: { id: "q", data: "x" } }, CHAT)).toBe(false);
  });

  test("pollOnce: bridge first, then only owner updates, without waiting for slow handlers", async () => {
    const ups: Update[] = [
      { update_id: 5, callback_query: { id: "a", data: "abcdef:0:1", message: { message_id: 1, chat: { id: 111 } } } },
      { update_id: 6, message: { message_id: 2, chat: { id: 222 }, text: "dari orang lain" } },
      { update_id: 7, message: { message_id: 3, chat: { id: 111 }, voice: { file_id: "f" } } },
      { update_id: 8, message: { message_id: 4, chat: { id: 111 }, text: "teks" } },
    ];
    const forwarded: number[] = [];
    const handled: number[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const next = await pollOnce(0, {
      getUpdates: async () => ups,
      forward: async (u) => (forwarded.push(u.update_id), u.update_id === 5),
      handle: async (u) => {
        handled.push(u.update_id);
        if (u.update_id === 7) await slow; // a long transcription must not block update 8
      },
      chatId: CHAT,
    });
    expect(next).toBe(9);
    expect(forwarded).toEqual([5, 6, 7, 8]);
    expect(handled).toEqual([7, 8]);
    release();
  });

  test("pollOnce treats a failing bridge as not consumed", async () => {
    const handled: number[] = [];
    await pollOnce(0, {
      getUpdates: async () => [{ update_id: 1, message: { message_id: 1, chat: { id: 111 }, text: "x" } }],
      forward: async () => { throw new Error("socket gone"); },
      handle: async (u) => void handled.push(u.update_id),
      chatId: CHAT,
    });
    expect(handled).toEqual([1]);
  });
});

import { escapeMd } from "../src/telegram";
test("escapeMd backslash-escapes markdown markers in our own labels", () => {
  expect(escapeMd("💬 ~/Proyek/social_media (app-01) selesai:")).toBe("💬 \\~/Proyek/social\\_media \\(app\\-01\\) selesai:");
  expect(escapeMd("a|b `c` *d* #e")).toBe("a\\|b \\`c\\` \\*d\\* \\#e");
});

test("terminal permission card shows the command and has exactly Izinkan and Tolak", () => {
  const c = terminalPermissionCard("~/vivera (x)", "aaaaaaaaaaaa", "Bash command\ntouch /x");
  expect(c.text).toContain("touch /x");
  expect(c.keyboard.flat().map((b) => parseLcCallback(b.callback_data)?.act)).toEqual(["xa", "xd"]);
  expect(c.keyboard.flat().every((b) => parseLcCallback(b.callback_data)?.id === "aaaaaaaaaaaa")).toBe(true);
});

test("a draft without a folder offers only 'Pilih folder', never Jalankan", () => {
  const acts = (j: Job) => draftCard(j).keyboard.flat().map((b) => parseLcCallback(b.callback_data)?.act);
  expect(acts({ ...job, folder: "" })).toEqual(["fd", "no", "ed"]);
  expect(draftCard({ ...job, folder: "" }).text).toContain("Folder belum dipilih");
  expect(acts(job)).toEqual(["go", "no", "fd", "ed"]);
});

test("folder browser pages, shows Naik except at the root, and always offers 'Pakai folder ini'", () => {
  const names = Array.from({ length: 30 }, (_, i) => `d${i}`);
  const acts = (page: number, root: boolean) => browseKeyboard(job.id, names, page, root).flat().map((b) => parseLcCallback(b.callback_data)?.act);
  expect(acts(0, false)).toEqual([...Array(14).fill("br"), "bu", "bn", "bp", "bk"]);
  expect(acts(2, true)).toEqual([...Array(2).fill("br"), "bn", "bp", "bk"]);
  expect(browseText("/home/u", 30, 0)).toContain("halaman 1/3");
  const args = browseKeyboard(job.id, names, 0, false).flat().filter((b) => parseLcCallback(b.callback_data)?.act === "br").map((b) => parseLcCallback(b.callback_data)!.arg);
  expect(args).toEqual(Array.from({ length: 14 }, (_, i) => String(i)));
});

const sess = (key: string, cwd: string): LiveSession => ({ key, pid: 1, sessionId: key, name: "", cwd, pane: "%1", window: "@1", status: "idle", statusUpdatedAt: 0 });
const three = [sess("ccc000000000", "/home/x/Proyek/c"), sess("aaa000000000", "/home/x/Proyek/a"), sess("bbb000000000", "/home/x/Proyek/b")];

test("◀ ▶ cycle in a stable order and wrap around", () => {
  expect(sortSessions(three).map((s) => s.key[0])).toEqual(["a", "b", "c"]);
  expect(cycleKey(three, "aaa000000000", 1)).toBe("bbb000000000");
  expect(cycleKey(three, "ccc000000000", 1)).toBe("aaa000000000");
  expect(cycleKey(three, "aaa000000000", -1)).toBe("ccc000000000");
  expect(cycleKey(three, null, 1)).toBe("aaa000000000");
  expect(cycleKey(three, null, -1)).toBe("ccc000000000");
  expect(cycleKey(three, "gone00000000", 1)).toBe("aaa000000000");
  expect(cycleKey([], null, 1)).toBeNull();
  expect(cycleKey([three[0]], "ccc000000000", -1)).toBe("ccc000000000");
});

test("bottom keyboard texts are parsed back, anything else is not a button", () => {
  const kb = replyKeyboard("proyek-a");
  const texts = kb.keyboard.flat().map((b) => b.text);
  for (const t of texts) expect(parseButton(t)).not.toBeNull();
  expect(parseButton(BTN.prev)).toBe("prev");
  expect(parseButton(BTN.next)).toBe("next");
  expect(parseButton(BTN.close)).toBe("close");
  expect(parseButton("🎯 proyek-a")).toBe("label");
  expect(parseButton("tolong kerjakan ini")).toBeNull();
  expect(parseButton("🎯" + "x".repeat(60))).toBeNull();
  expect(parseButton(undefined)).toBeNull();
  expect(replyKeyboard(null).keyboard[0][1].text).toBe("🎯 —");
  expect(replyKeyboard("x".repeat(80)).keyboard[0][1].text.length).toBeLessThan(40);
});

test("close card: kill tab hidden for the last tmux window, all buttons are lc callbacks", () => {
  const many = closeCard("~/Proyek/a", "0123456789ab", { name: "a", panes: 1, sessionWindows: 3 }, "🟢");
  expect(many.keyboard.flat().map((b) => b.text)).toEqual(["🚪 Exit Claude", "💥 Kill tab", "❌ Batal"]);
  const last = closeCard("~/Proyek/a", "0123456789ab", { name: "a", panes: 1, sessionWindows: 1 }, "🟢");
  expect(last.keyboard.flat().map((b) => b.text)).toEqual(["🚪 Exit Claude", "❌ Batal"]);
  for (const b of [...many.keyboard.flat(), ...last.keyboard.flat()]) {
    expect(parseLcCallback(b.callback_data)).not.toBeNull();
    expect(bridgeWouldTake(b.callback_data)).toBe(false);
  }
});

test("model/effort pickers: one lc button per option, current one marked, no per-session 'default' effort", () => {
  const m = pickCard("model", NEW_SCOPE, "", "opus");
  const mb = m.keyboard.flat();
  expect(mb.length).toBe(MODEL_CHOICES.length);
  expect(mb.find((b) => b.text.startsWith("✓"))?.text).toBe("✓ opus");
  const e = pickCard("effort", "0123456789ab", "~/Proyek/a", "");
  expect(e.keyboard.flat().map((b) => b.text)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(pickCard("effort", NEW_SCOPE, "", "").keyboard.flat().length).toBe(EFFORT_CHOICES.length);
  for (const b of [...mb, ...e.keyboard.flat()]) {
    expect(parseLcCallback(b.callback_data)).not.toBeNull();
    expect(bridgeWouldTake(b.callback_data)).toBe(false);
  }
});
