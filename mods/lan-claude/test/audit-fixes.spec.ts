// Audit fixes (plan 2026-11-05-audit-fixes, T2). The core checks run once in a child process
// (test/audit-fixes.scenario.ts) with HOME in a scratch dir and fake `tmux`, `claude` and `alacritty`
// on PATH; each test below asserts one behaviour from that run. Board and card checks run in-process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBoard } from "../src/permissions";
import { permissionCard } from "../src/telegram/cards";

const scratch = mkdtempSync(join(tmpdir(), "lan-claude-audit-"));
const fakeDir = join(scratch, "fake");
type R = Record<string, any>;
let run: R = {};

// Fake tmux: logs each call (args joined by spaces) and answers like the real one for what the core reads.
const FAKE_TMUX = `#!/bin/sh
d="$FAKE_TMUX_DIR"
echo "$*" >> "$d/tmux.log"
case "$1" in
  list-clients) cat "$d/client" 2>/dev/null ;;
  new-window) echo "@99" ;;
  capture-pane) cat "$d/screen" 2>/dev/null ;;
  load-buffer) cat > /dev/null ;;
esac
exit 0
`;

beforeAll(async () => {
  mkdirSync(join(scratch, "bin"), { recursive: true });
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(join(scratch, "bin/tmux"), FAKE_TMUX);
  chmodSync(join(scratch, "bin/tmux"), 0o755);
  copyFileSync("/usr/bin/sleep", join(scratch, "bin/claude"));
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const p = Bun.spawn(["bun", join(import.meta.dir, "audit-fixes.scenario.ts")], {
    cwd: scratch,
    env: { PATH: `${join(scratch, "bin")}:${process.env.PATH}`, HOME: home, AUDIT_SCRATCH: scratch, FAKE_TMUX_DIR: fakeDir, XDG_RUNTIME_DIR: scratch },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`scenario exited ${code}: ${err.slice(-600)}`);
  run = JSON.parse(out.trim().split("\n").pop()!) as R;
}, 60_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("kill switch", () => {
  test("freezes the follow-up queue: nothing pasted, queue and queues.json kept, delivered after /on", () => {
    const r = run.killFreeze;
    expect(r.error).toBeUndefined();
    expect(r.queuedResult).toBe("queued");
    expect(r.pastedWhileKilled).toBe(0);
    expect(r.queuedWhileKilled).toBe(1);
    expect(r.fileKept).toBe(true);
    expect(r.pastedAfter).toBe(1);
    expect(r.queuedAfter).toBe(0);
  });

  test("turning it on denies every pending request, and allow is refused while it is on (deny still works)", () => {
    const r = run.killDeniesPending;
    expect(r.error).toBeUndefined();
    expect(r.first).toBe("deny");
    expect(r.allowOk).toBe(false);
    expect(r.stillPending).toBe(true);
    expect(r.denyOk).toBe(true);
  });
});

describe("follow-up delivery", () => {
  test("a message to a session whose /model picker is being driven is queued, not pasted", () => {
    const r = run.switchingQueues;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("queued");
    expect(r.pasted).toBe(0);
    expect(r.queued).toBe(1);
  });

  test("a session that turned busy during the settle pause gets nothing; the text goes back to the queue", () => {
    const r = run.rereadAfterSleep;
    expect(r.error).toBeUndefined();
    expect(r.pasted).toBe(0);
    expect(r.queued).toBe(1);
    expect(r.fileHasText).toBe(true);
  });

  test("a message sent during the settle pause queues behind the text being delivered", () => {
    const r = run.orderDuringPause;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("queued");
    expect(r.pastedDuringPause).toBe(0);
    expect(r.pastedAfter).toBe(1);
    expect(r.left).toEqual(["pesan baru"]);
  });
});

describe("launch", () => {
  test("two concurrent launches of one job open one window; the second is refused", () => {
    const r = run.launchSameJob;
    expect(r.error).toBeUndefined();
    expect(r.newWindows).toBe(1);
    expect(r.results.filter((x: string) => x === "ok").length).toBe(1);
  });

  test("launches still in flight count toward the hourly limit", () => {
    const r = run.launchHourlyLimit;
    expect(r.error).toBeUndefined();
    expect(r.newWindows).toBe(1);
    expect(r.results.filter((x: string) => x.includes("per jam")).length).toBe(1);
  });
});

describe("start-up dialog", () => {
  test("a double tap presses the key once; the second answer is refused", () => {
    const r = run.startupLock;
    expect(r.error).toBeUndefined();
    expect(r.escapes).toBe(1);
    expect(r.results.some((x: string) => x.includes("sedang diproses"))).toBe(true);
  });
});

describe("truncated permission summary", () => {
  const long = { command: "echo " + "x".repeat(700) };

  test("the pending entry records the cut, and allow is refused for it while deny works", async () => {
    const b = new PermissionBoard(5_000);
    const p = b.open("abcdef012345", "Bash", long);
    expect(p.truncated).toBe(true);
    expect(b.open("abcdef012345", "Bash", { command: "ls" }).truncated).toBe(false);
    expect(b.decide(p.id, "allow")).toBe(false);
    expect(b.list().some((x) => x.id === p.id)).toBe(true);
    const w = b.wait(p.id);
    expect(b.decide(p.id, "deny")).toBe(true);
    expect(await w).toBe("deny");
  });

  test("the Telegram card of a cut request offers only Tolak and says to answer on the PC", () => {
    const b = new PermissionBoard(5_000);
    const card = permissionCard(b.open("abcdef012345", "Bash", long), undefined);
    const buttons = card.keyboard.flat().map((x) => x.callback_data);
    expect(buttons.some((d) => d.includes(":pa:"))).toBe(false);
    expect(buttons.some((d) => d.includes(":pd:"))).toBe(true);
    expect(card.text).toContain("jawab di PC");
  });
});
