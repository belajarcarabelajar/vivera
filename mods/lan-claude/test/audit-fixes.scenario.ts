// Scenario driver for test/audit-fixes.spec.ts (not a test file itself: no .spec/.test suffix).
// Runs the real core (watch, launch, kill switch, permission board) in its own process with HOME in a
// scratch dir, so no state of the live service is touched. Boundaries are faked through PATH: `tmux`
// (a shell script that logs every call and prints canned output), `claude` (a renamed `sleep`, so
// /proc/<pid>/comm says "claude") and `alacritty` (a renamed `bash`, the parent of the fake tmux client).
// Prints one JSON line with what every check observed; a check that throws records its error instead.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scratch = process.env.AUDIT_SCRATCH!;
if (!scratch || !process.env.HOME?.startsWith(scratch)) {
  console.error("refusing to run: HOME is not inside the scratch dir");
  process.exit(3);
}
const fake = process.env.FAKE_TMUX_DIR!;

const core = await import("../src/core");
const watchMod = await import("../src/core/watch");
const { config } = await import("../src/config");
if (!config.stateDir.startsWith(scratch)) throw new Error("state dir outside scratch");

const tmuxLog = join(fake, "tmux.log");
const clearLog = () => writeFileSync(tmuxLog, "");
const calls = () => readFileSync(tmuxLog, "utf8").split("\n").filter(Boolean);
const count = (pred: (line: string) => boolean) => calls().filter(pred).length;
const pastes = () => count((l) => l.startsWith("paste-buffer"));
const queueFile = join(config.stateDir, "queues.json");
const readQueues = () => {
  try {
    return readFileSync(queueFile, "utf8");
  } catch {
    return "";
  }
};

// One live session A in pane %1 of window @1.
const sessionId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const key = sessionId.replace(/-/g, "").slice(0, 12);
const claude = Bun.spawn([join(scratch, "bin/claude"), "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const sessDir = join(config.home, ".claude/sessions");
mkdirSync(sessDir, { recursive: true });
let ts = 1;
const setStatus = (status: string) =>
  writeFileSync(join(sessDir, `${claude.pid}.json`), JSON.stringify({
    pid: claude.pid, sessionId, cwd: "/home/x/alpha-proj", kind: "interactive", tmux: "main:@1.%1", name: "", status, statusUpdatedAt: ts++,
  }));
const dropQueue = () => {
  const w = watchMod.watches.get(key);
  if (w) w.queued = [];
  watchMod.saveQueues();
};

const out: Record<string, unknown> = {};
async function check(name: string, fn: () => Promise<Record<string, unknown>>) {
  try {
    out[name] = await fn();
  } catch (e) {
    out[name] = { error: (e as Error).message };
  } finally {
    core.setKilled(false);
  }
}

await check("killFreeze", async () => {
  setStatus("busy");
  core.watchSession(key);
  const q = await core.sendToSession(key, "pesan satu", "web");
  const before = readQueues();
  setStatus("idle");
  core.setKilled(true);
  clearLog();
  await core.watchTick();
  const r = { queuedResult: q.result, pastedWhileKilled: pastes(), queuedWhileKilled: core.queuedCount(key), fileKept: readQueues() === before };
  core.setKilled(false);
  clearLog();
  await core.watchTick();
  return { ...r, pastedAfter: pastes(), queuedAfter: core.queuedCount(key) };
});
dropQueue();

await check("switchingQueues", async () => {
  setStatus("idle");
  await core.watchTick(); // settle the turn-end notice for this status
  watchMod.switching.add(key);
  clearLog();
  try {
    const r = await core.sendToSession(key, "pesan dua", "web");
    return { result: r.result, pasted: pastes(), queued: core.queuedCount(key) };
  } finally {
    watchMod.switching.delete(key);
  }
});
dropQueue();

await check("rereadAfterSleep", async () => {
  setStatus("busy");
  await core.sendToSession(key, "pesan tiga", "web");
  setStatus("idle");
  clearLog();
  const tick = core.watchTick();
  await Bun.sleep(500); // inside the 1.5 s settle pause before the paste
  setStatus("busy");
  await tick;
  return { pasted: pastes(), queued: core.queuedCount(key), fileHasText: readQueues().includes("pesan tiga") };
});
dropQueue();

await check("orderDuringPause", async () => {
  setStatus("busy");
  await core.sendToSession(key, "pesan lama", "web");
  setStatus("idle");
  clearLog();
  const tick = core.watchTick();
  await Bun.sleep(500); // inside the 1.5 s settle pause: the old text is not pasted yet
  const r = await core.sendToSession(key, "pesan baru", "web");
  const pastedDuringPause = pastes();
  await tick;
  const w = watchMod.watches.get(key);
  return { result: r.result, pastedDuringPause, pastedAfter: pastes(), left: w?.queued ?? [] };
});
dropQueue();

await check("killDeniesPending", async () => {
  const p = core.board.open("abcdef012345", "Bash", { command: "ls" });
  const waiting = core.board.wait(p.id); // the hook waits right after open
  core.setKilled(true);
  const first = await Promise.race([waiting, Bun.sleep(200).then(() => "still pending")]);
  const q = core.board.open("abcdef012345", "Bash", { command: "ls -la" });
  const allowOk = core.board.decide(q.id, "allow", "test");
  const stillPending = core.board.list().some((x) => x.id === q.id);
  const denyOk = core.board.decide(q.id, "deny", "test");
  return { first, allowOk, stillPending, denyOk };
});

// The fake tmux client: a process whose parent is named "alacritty".
copyFileSync("/usr/bin/bash", join(scratch, "bin/alacritty"));
const alac = Bun.spawn([join(scratch, "bin/alacritty"), "-c", "sleep 60 & echo $!; wait"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
const reader = alac.stdout.getReader();
const clientPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
writeFileSync(join(fake, "client"), `${clientPid}\tmain\t1\n`);

const draft = (id: string) => core.jobs.save({ id, createdAt: Date.now(), source: "text", via: "web", transcript: "t", prompt: "p", folder: "", note: "", status: "draft", turns: 0 });
const settled = async (ps: Promise<unknown>[]) =>
  (await Promise.allSettled(ps)).map((r) => (r.status === "fulfilled" ? "ok" : String((r.reason as Error).message)));
const newWindows = () => count((l) => l.startsWith("new-window"));

await check("launchSameJob", async () => {
  draft("111111111111");
  clearLog();
  const results = await settled([1, 2].map(() => core.launch("111111111111", "tes", config.home, "web")));
  return { results, newWindows: newWindows() };
});

await check("launchHourlyLimit", async () => {
  const now = Date.now();
  const launched = core.jobs.launchesSince(now - 3600_000);
  for (let i = launched; i < config.maxLaunchesPerHour - 1; i++) {
    core.jobs.save({ id: `5555555555${String(i).padStart(2, "0")}`, createdAt: 1, source: "text", transcript: "", prompt: "", folder: "", note: "", status: "launched", launchedAt: now, turns: 0 });
  }
  draft("222222222222");
  draft("333333333333");
  clearLog();
  const results = await settled(["222222222222", "333333333333"].map((id) => core.launch(id, "tes", config.home, "web")));
  return { results, newWindows: newWindows() };
});
for (const id of ["111111111111", "222222222222", "333333333333"]) core.jobs.update(id, { status: "cancelled" });

await check("startupLock", async () => {
  const id = "444444444444";
  core.jobs.save({ id, createdAt: Date.now(), source: "text", transcript: "", prompt: "p", folder: config.home, note: "", status: "launched", windowId: "@7", launchedAt: Date.now() - 5000, turns: 0 });
  writeFileSync(join(fake, "screen"), readFileSync(join(import.meta.dir, "fixtures/trust.txt"), "utf8"));
  await core.watchTick();
  clearLog();
  const results = await settled([1, 2].map(() => core.answerStartupDialog(id, false, "web")));
  rmSync(join(fake, "screen"), { force: true });
  return { results, escapes: count((l) => l.startsWith("send-keys") && l.endsWith("Escape")) };
});

claude.kill();
alac.kill();
try {
  process.kill(clientPid);
} catch {}
console.log(JSON.stringify(out));
process.exit(0);
