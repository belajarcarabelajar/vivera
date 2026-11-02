// Configuration is neutral: folders come from the environment or from the home directory, the Anthropic key
// from the environment or a file outside the repository, and no source file names the owner's machine.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { anthropicKey } from "../src/refine";

const MOD = join(import.meta.dir, "..");
// Built from fragments so this file never contains a denylisted string itself.
const DENY = new RegExp(
  [["/home/", "belajarcarabelajar"], ["batch-", "didline"], ["Proyek/", "lan-claude"], ["wans", "daily"], ["snipset", "-03"], ["belajarcarabelajar", "-4b"]]
    .map((p) => p.join(""))
    .join("|"),
);

function loadConfig(extra: Record<string, string>, home: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("LAN_CLAUDE_")) env[k] = v;
  const code = `import { config, paths } from ${JSON.stringify(join(MOD, "src/config.ts"))}; console.log(JSON.stringify({ config, paths }));`;
  const r = spawnSync(process.execPath, ["-e", code], { env: { ...env, HOME: home, ...extra }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as { config: Record<string, unknown>; paths: Record<string, string> };
}

describe("config folders", () => {
  test("defaults sit under the home directory and the app folder is the mod folder", () => {
    const home = mkdtempSync(join(tmpdir(), "lc-cfg-"));
    try {
      const { config, paths } = loadConfig({}, home);
      expect(config.configDir).toBe(join(home, ".config/lan-claude"));
      expect(config.stateDir).toBe(join(home, ".local/state/lan-claude"));
      expect(config.appDir).toBe(MOD);
      expect(paths.token).toBe(join(home, ".config/lan-claude/token"));
      expect(paths.jobs).toBe(join(home, ".local/state/lan-claude/jobs"));
      expect("anthropicEnv" in config).toBe(false);
      expect("claudeSettings" in paths).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("LAN_CLAUDE_CONFIG_DIR and LAN_CLAUDE_STATE_DIR override the defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "lc-cfg-"));
    try {
      const { config, paths } = loadConfig({ LAN_CLAUDE_CONFIG_DIR: "/c/lc", LAN_CLAUDE_STATE_DIR: "/s/lc" }, home);
      expect(config.configDir).toBe("/c/lc");
      expect(config.stateDir).toBe("/s/lc");
      expect(paths.tlsCert).toBe("/c/lc/tls/cert.pem");
      expect(paths.log).toBe("/s/lc/log.jsonl");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("config.ts and refine.ts name nothing of the owner's machine", () => {
    for (const f of ["src/config.ts", "src/refine.ts"]) expect(DENY.test(readFileSync(join(MOD, f), "utf8"))).toBe(false);
  });
});

describe("anthropicKey", () => {
  const FILE = "/cfg/.env";
  const reading = (text: string | null) => (p: string) => {
    if (text === null || p !== FILE) throw new Error("ENOENT");
    return text;
  };

  test("the environment variable wins and is trimmed", () => {
    expect(anthropicKey({ env: { ANTHROPIC_API_KEY: "  sk-x1  " }, readFile: reading("ANTHROPIC_API_KEY=other"), envPath: FILE })).toBe("sk-x1");
  });

  test("an empty variable falls back to the file", () => {
    expect(anthropicKey({ env: { ANTHROPIC_API_KEY: "   " }, readFile: reading("# c\nANTHROPIC_API_KEY=sk-file # note\n"), envPath: FILE })).toBe("sk-file");
  });

  test("LAN_CLAUDE_ENV picks the file when no explicit path is given", () => {
    const seen: string[] = [];
    const key = anthropicKey({ env: { LAN_CLAUDE_ENV: "/elsewhere/k.env" }, readFile: (p) => (seen.push(p), "ANTHROPIC_API_KEY=sk-e") });
    expect(key).toBe("sk-e");
    expect(seen).toEqual(["/elsewhere/k.env"]);
  });

  test("no key anywhere: the error names the file and never a value", () => {
    for (const text of [null, "OTHER=1", "ANTHROPIC_API_KEY="]) {
      let msg = "";
      try {
        anthropicKey({ env: {}, readFile: reading(text), envPath: FILE });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("ANTHROPIC_API_KEY is not set");
      expect(msg).toContain(FILE);
    }
  });
});
