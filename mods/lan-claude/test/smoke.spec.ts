// Smoke run of the whole server without Telegram, in a temporary HOME: it starts, logs `started`, answers an
// unknown job on the hook socket with `none`, says why the LAN page is off, and (when the machine has a private
// IPv4 and openssl) refuses a wrong pairing token with 403. LAN_CLAUDE_SMOKE_ENTRY points at another entry file,
// which is how the RED control proves a server that never starts fails this spec.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ENTRY = process.env.LAN_CLAUDE_SMOKE_ENTRY ?? join(import.meta.dir, "../src/server.ts");
const tmp = mkdtempSync(join(tmpdir(), "lan-claude-smoke-"));
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterAll(() => {
  for (const c of children) c.kill();
  rmSync(tmp, { recursive: true, force: true });
});

function privateIpv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

type Started = { event: string; telegram: boolean; web: string };

async function start(name: string, port: number): Promise<{ child: ReturnType<typeof Bun.spawn>; started: Started; socket: string }> {
  const home = join(tmp, name);
  mkdirSync(home, { recursive: true });
  const socket = join(home, "lc.sock");
  const child = Bun.spawn([process.execPath, ENTRY], {
    env: { PATH: process.env.PATH ?? "", HOME: home, LAN_CLAUDE_TELEGRAM: "0", LAN_CLAUDE_PORT: String(port), LAN_CLAUDE_SOCKET: socket, XDG_RUNTIME_DIR: home },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  children.push(child);
  const log = join(home, ".local/state/lan-claude/log.jsonl");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(log)) {
      for (const line of readFileSync(log, "utf8").split("\n")) {
        if (!line) continue;
        const ev = JSON.parse(line) as Started;
        if (ev.event === "started") return { child, started: ev, socket };
      }
    }
    await Bun.sleep(100);
  }
  child.kill();
  throw new Error(`server did not log "started" within 10 s (entry ${ENTRY})`);
}

const ip = privateIpv4();
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe("server smoke run", () => {
  test("starts without Telegram, explains the LAN page, answers an unknown hook job with none", async () => {
    const { started, socket } = await start("plain", freePort());
    expect(started.telegram).toBe(false);
    expect(started.web).toBe(ip ? "TLS cert or key missing" : "no private LAN subnet");
    expect(statSync(socket).mode & 0o777).toBe(0o600); // owner-only hook socket
    const res = await fetch("http://lan-claude/hook/permission", { unix: socket, method: "POST", body: JSON.stringify({ job: "000000000000" }) });
    expect(await res.json()).toEqual({ decision: "none" });
  }, 20_000);

  test.skipIf(!ip || !hasOpenssl)("a wrong pairing token gets 403 over HTTPS", async () => {
    const home = join(tmp, "tls");
    const tlsDir = join(home, ".config/lan-claude/tls");
    mkdirSync(tlsDir, { recursive: true });
    const cert = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(tlsDir, "key.pem"), "-out", join(tlsDir, "cert.pem")]);
    expect(cert.status).toBe(0);
    const port = freePort();
    const { started } = await start("tls", port);
    expect(started.web).toContain(`web on :${port}`);
    const res = await fetch(`https://${ip}:${port}/pair?t=wrong`, { tls: { rejectUnauthorized: false }, redirect: "manual" });
    expect(res.status).toBe(403);
  }, 20_000);

  test.skipIf(!!ip && hasOpenssl)(`the pairing case is skipped: ${ip ? "no openssl" : "no private IPv4"} on this machine`, () => {
    expect(true).toBe(true);
  });
});
