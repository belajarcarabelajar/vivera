// The launcher finds its own folder and the claude and bun binaries from the environment, renders the hook
// settings into the job folder, and refuses to start on bad input before it writes anything.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const MOD = join(import.meta.dir, "..");
const LAUNCHER = join(MOD, "bin/launch-claude.sh");
const JOB = "abcdef012345";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lc-launch-"));
  dirs.push(root);
  const state = join(root, "state");
  const dir = join(state, "jobs", JOB);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.txt"), "do the thing");
  writeFileSync(join(dir, "model.txt"), "opus\n");
  writeFileSync(join(dir, "effort.txt"), "high\n");
  const args = join(root, "args.txt");
  const claude = join(root, "fake-claude");
  writeFileSync(claude, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(args)}\n`);
  chmodSync(claude, 0o755);
  const bun = join(root, "fake-bun");
  writeFileSync(bun, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(bun, 0o755);
  return { root, state, dir, args, claude, bun };
}

function run(f: ReturnType<typeof fixture>, job: string, extra: Record<string, string> = {}) {
  return spawnSync("bash", [LAUNCHER, job], {
    input: "\n",
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: f.root, LAN_CLAUDE_STATE_DIR: f.state, LAN_CLAUDE_CLAUDE_BIN: f.claude, LAN_CLAUDE_BUN: f.bun, ...extra },
  });
}

describe("launch-claude.sh", () => {
  test("passes the per-job settings file, model, effort and prompt to claude", () => {
    const f = fixture();
    const r = run(f, JOB);
    expect(r.status).toBe(0);
    const argv = readFileSync(f.args, "utf8").trim().split("\n");
    expect(argv).toEqual(["--model", "opus", "--effort", "high", "--settings", join(f.dir, "settings.json"), "-n", `HP ${JOB}`, "do the thing"]);
    expect(JSON.parse(readFileSync(join(f.dir, "exit.json"), "utf8"))).toEqual({ exit: 0 });
  });

  test("the rendered settings hold the bun and app paths and no placeholder", () => {
    const f = fixture();
    run(f, JOB);
    const text = readFileSync(join(f.dir, "settings.json"), "utf8");
    expect(text).not.toContain("__APP__");
    expect(text).not.toContain("__BUN__");
    const s = JSON.parse(text);
    expect(s.hooks.PermissionRequest[0].hooks[0].command).toBe(`${f.bun} ${MOD}/hooks/permission-hook.ts`);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(`${f.bun} ${MOD}/hooks/stop-hook.ts`);
  });

  test("a bad job id exits 2 before anything is written", () => {
    const f = fixture();
    const r = run(f, "../etc");
    expect(r.status).toBe(2);
    expect(existsSync(join(f.dir, "settings.json"))).toBe(false);
    expect(existsSync(join(f.dir, "exit.json"))).toBe(false);
  });

  test("a bun path with a double quote or a newline is refused before anything is written", () => {
    for (const name of ['we"ird', "line\nbreak"]) {
      const f = fixture();
      const odd = join(f.root, name);
      mkdirSync(odd);
      const bun = join(odd, "bun");
      writeFileSync(bun, "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(bun, 0o755);
      const r = run(f, JOB, { LAN_CLAUDE_BUN: bun });
      expect(r.status).toBe(2);
      expect(existsSync(join(f.dir, "settings.json"))).toBe(false);
    }
  });

  test("a missing claude binary is reported before any file is written", () => {
    const f = fixture();
    const r = run(f, JOB, { LAN_CLAUDE_CLAUDE_BIN: join(f.root, "nope") });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain("claude");
    expect(existsSync(join(f.dir, "settings.json"))).toBe(false);
  });
});
