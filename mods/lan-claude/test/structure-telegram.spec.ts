import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Guards the split of src/telegram.ts: every file stays under the repository's byte limit, the barrel
// keeps every name it exported before the split, and no handler module imports app.ts (no cycles).
const SRC = join(import.meta.dir, "..", "src");
const DIR = join(SRC, "telegram");
const LIMIT = 20_000;

const parts = () => (existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".ts")) : []);

const VALUES = [
  "startTelegram", "pollOnce", "parseLcCallback", "lcData", "draftCard", "folderKeyboard", "browseKeyboard", "browseText",
  "startupCard", "permissionCard", "terminalPermissionCard", "followupCard", "sessionsKeyboard", "closedPermissionText",
  "stateLabel", "sessionLabel", "escapeMd", "parseEnvFile", "isOwner", "chatOf", "BTN", "parseButton", "replyKeyboard",
  "sortSessions", "cycleKey", "closeCard", "pickCard", "MODEL_CHOICES", "EFFORT_CHOICES", "NEW_SCOPE", "BROWSE_PAGE",
  "telegramEnvPath", "bridgeSocket",
];
const TYPES = ["Update", "Card", "LcAct", "LcTap", "ReplyMarkup", "ReplyKeyboard", "ButtonAct"];

describe("telegram split", () => {
  test("the modules exist under src/telegram/", () => {
    for (const f of ["types", "callbacks", "cards", "menu", "poll", "api", "ctx", "handlers-text", "handlers-tap", "handlers-menu", "watch-events", "app"]) {
      expect(parts()).toContain(`${f}.ts`);
    }
  });

  test("src/telegram.ts and every file under src/telegram/ is at most 20000 bytes", () => {
    const files = [join(SRC, "telegram.ts"), ...parts().map((f) => join(DIR, f))];
    for (const f of files) expect([f, statSync(f).size <= LIMIT]).toEqual([f, true]);
  });

  test("src/telegram.ts exports every value it exported before the split", async () => {
    const mod = (await import("../src/telegram")) as Record<string, unknown>;
    for (const name of VALUES) expect([name, typeof mod[name]]).not.toEqual([name, "undefined"]);
    expect(typeof mod.startTelegram).toBe("function");
    expect(typeof mod.pollOnce).toBe("function");
    expect(typeof mod.BTN).toBe("object");
    expect(typeof mod.NEW_SCOPE).toBe("string");
    expect(typeof mod.BROWSE_PAGE).toBe("number");
  });

  test("src/telegram.ts re-exports every type it exported before the split", () => {
    const text = readFileSync(join(SRC, "telegram.ts"), "utf8");
    for (const name of TYPES) expect([name, new RegExp(`\\b${name}\\b`).test(text)]).toEqual([name, true]);
  });

  test("no file under src/telegram/ imports ./app except app.ts itself", () => {
    for (const f of parts().filter((p) => p !== "app.ts")) {
      const text = readFileSync(join(DIR, f), "utf8");
      expect([f, /from\s+["']\.\/app["']/.test(text)]).toEqual([f, false]);
    }
  });
});
