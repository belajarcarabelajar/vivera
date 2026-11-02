import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The state dir is read at import time (config.ts), so point it at a scratch dir before any import of core.
const scratch = mkdtempSync(join(tmpdir(), "lan-claude-core-"));
process.env.LAN_CLAUDE_STATE_DIR = join(scratch, "state");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SRC = join(import.meta.dir, "../src");
const LIMIT = 20_000;

// Every name the barrel exported before the split (values; WatchEvent is a type and has no runtime export).
const VALUE_EXPORTS: Record<string, "function" | "object"> = {
  jobs: "object", board: "object", log: "function", UserError: "function", onTurnEnd: "object",
  launchModel: "function", setLaunchModel: "function", launchEffort: "function", setLaunchEffort: "function",
  killed: "function", setKilled: "function", folders: "function", folderCandidates: "function",
  listSubdirs: "function", validateFolder: "function", draftFrom: "function", draftFromAudio: "function",
  draftFromText: "function", launch: "function", cancel: "function", folderLabel: "function",
  live: "function", findLive: "function", liveForJob: "function", onWatch: "object", sendToSession: "function",
  watchTick: "function", answerTerminalPermission: "function", answerStartupDialog: "function",
  switchSessionModel: "function", switchSessionEffort: "function", exitSession: "function",
  killSessionWindow: "function", watchSession: "function", queuedCount: "function", transcribeFollowup: "function",
};

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]!);

describe("core split", () => {
  test("core.ts and every file under src/core stay under the size limit", () => {
    const files = [join(SRC, "core.ts"), ...readdirSync(join(SRC, "core")).filter((f) => f.endsWith(".ts")).map((f) => join(SRC, "core", f))];
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) expect([f, statSync(f).size <= LIMIT]).toEqual([f, true]);
  });

  test("the barrel exports every name it exported before the split", async () => {
    const core = (await import("../src/core")) as Record<string, unknown>;
    for (const [name, type] of Object.entries(VALUE_EXPORTS)) expect([name, typeof core[name]]).toEqual([name, type]);
  });

  test("imports form a chain: control -> watch -> base, nothing imports the barrel", () => {
    const dir = join(SRC, "core");
    const base = importsOf(join(dir, "base.ts"));
    const watch = importsOf(join(dir, "watch.ts"));
    const control = importsOf(join(dir, "control.ts"));
    expect(base.filter((s) => s === "./watch" || s === "./control" || s.includes("core"))).toEqual([]);
    expect(watch).toContain("./base");
    expect(watch.filter((s) => s === "./control" || s.endsWith("/core") || s.includes("core"))).toEqual([]);
    expect(control).toContain("./watch");
    expect(control).toContain("./base");
    expect(control.filter((s) => s.endsWith("/core") || s === "../core")).toEqual([]);
  });

  test("module state is one instance: the barrel and watch.ts share watches and switching", async () => {
    const watch = (await import("../src/core/watch")) as Record<string, unknown>;
    const control = (await import("../src/core/control")) as Record<string, unknown>;
    const core = (await import("../src/core")) as Record<string, unknown>;
    expect(watch.watches).toBeInstanceOf(Map);
    expect(watch.switching).toBeInstanceOf(Set);
    // control.ts must use watch.ts's objects, not copies; the barrel must not declare its own.
    expect(core.watches).toBeUndefined();
    expect(core.switching).toBeUndefined();
    expect(control.watches).toBeUndefined();
    for (const name of ["switchSessionModel", "switchSessionEffort", "exitSession", "killSessionWindow"]) {
      expect(control[name]).toBe(core[name]);
    }
    (core.watchSession as (k: string) => void)("0123456789ab");
    expect((watch.watches as Map<string, unknown>).has("0123456789ab")).toBe(true);
    expect((core.queuedCount as (k: string) => number)("0123456789ab")).toBe(0);
    (watch.watches as Map<string, unknown>).delete("0123456789ab");
  });
});
