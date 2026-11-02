// lan-claude: phone -> voice note or text -> transcript -> Haiku-refined prompt -> reviewed on the
// phone -> new Claude Code session (same settings as a manual one) in a background tmux window of the open
// Alacritty. Two entry points share one process: the LAN web page (same Wi-Fi only) and Telegram
// (the bot, forwarded with vivera's telegram-ask bridge). Permission requests from launched
// sessions can be answered from either; the first answer wins.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isAuthorized, loadOrCreateToken, pairCookie, safeEqual } from "./auth";
import { config, paths } from "./config";
import {
  board, cancel, draftFromAudio, draftFromText, folders, jobs, killed, launch, log, onTurnEnd, setKilled, UserError, watchTick,
} from "./core";
import type { Job } from "./jobs";
import { isAllowedClient, localSubnets } from "./lan";
import { startTelegram } from "./telegram";
import { capture, findTargetSession } from "./tmux";

// dup-defs: allow the mod ships on its own and must not import another mod's internals; small local helper
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
// dup-defs: allow the mod ships on its own and must not import another mod's internals; small local helper
const fail = (msg: string, status = 400) => json({ error: msg }, status);
const failFrom = (e: unknown) => (e instanceof UserError ? fail(e.message, e.status) : fail((e as Error).message, 500));
const publicJob = (j: Job) => j;

async function api(req: Request, url: URL, ip: string): Promise<Response> {
  const p = url.pathname;
  if (req.method === "GET" && p === "/api/state") {
    return json({
      killed: killed(),
      terminalOpen: (await findTargetSession()) !== null,
      folders: folders().map((f) => ({ path: f.path, label: f.label })),
      jobs: jobs.recent().map(publicJob),
      pending: board.list(),
    });
  }
  if (req.method === "GET" && p === "/api/screen") {
    const job = jobs.get(url.searchParams.get("job") ?? "");
    if (!job?.windowId) return fail("Belum ada sesi.");
    return json({ screen: (await capture(job.windowId)) ?? "(window sudah ditutup)" });
  }
  if (req.method !== "POST") return fail("Not found", 404);
  try {
    if (p === "/api/voice") {
      const form = await req.formData().catch(() => null);
      const audio = form?.get("audio");
      if (!(audio instanceof File)) return fail("Tidak ada file audio.");
      const ext = (audio.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "webm").toLowerCase();
      return json({ job: publicJob(await draftFromAudio(audio, ext, "web")) });
    }
    if (p === "/api/text") {
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
      return json({ job: publicJob(await draftFromText(typeof body?.text === "string" ? body.text : "", "web")) });
    }
    if (p === "/api/launch") {
      const b = (await req.json().catch(() => null)) as { job?: unknown; prompt?: unknown; folder?: unknown } | null;
      const job = await launch(String(b?.job ?? ""), typeof b?.prompt === "string" ? b.prompt : "", String(b?.folder ?? ""), "web");
      return json({ job: publicJob(job) });
    }
  } catch (e) {
    return failFrom(e);
  }
  if (p === "/api/cancel") {
    const b = (await req.json().catch(() => null)) as { job?: string } | null;
    if (b?.job) cancel(b.job);
    return json({ ok: true });
  }
  if (p === "/api/permission") {
    const b = (await req.json().catch(() => null)) as { id?: string; decision?: string } | null;
    if (!b?.id || (b.decision !== "allow" && b.decision !== "deny")) return fail("Keputusan tidak valid.");
    const ok = board.decide(b.id, b.decision, "halaman LAN");
    log("permission", { id: b.id, decision: b.decision, ok, ip });
    return json({ ok });
  }
  if (p === "/api/kill") {
    const b = (await req.json().catch(() => null)) as { on?: boolean } | null;
    setKilled(!!b?.on);
    log("kill_switch", { on: !!b?.on, ip });
    return json({ killed: killed() });
  }
  return fail("Not found", 404);
}

/** The LAN page needs a private subnet and the TLS files; without them only Telegram runs. */
function startWeb(): string {
  const subnets = localSubnets();
  if (subnets.length === 0) return "no private LAN subnet";
  if (!existsSync(paths.tlsCert) || !existsSync(paths.tlsKey)) return "TLS cert or key missing";
  const token = loadOrCreateToken(paths.token);
  const indexHtml = Bun.file(join(config.appDir, "public/index.html"));
  const web = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    tls: { cert: Bun.file(paths.tlsCert), key: Bun.file(paths.tlsKey) },
    maxRequestBodySize: config.maxAudioBytes + 1024 * 1024,
    idleTimeout: 255,
    async fetch(req, server) {
      const ip = server.requestIP(req)?.address ?? "";
      // Interfaces can change (Wi-Fi reconnect); re-read them when a request does not match.
      if (!isAllowedClient(ip, subnets) && !isAllowedClient(ip, localSubnets())) {
        log("refused_ip", { ip });
        return new Response("Forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      try {
        if (url.pathname === "/pair") {
          if (!safeEqual(url.searchParams.get("t") ?? "", token)) {
            log("pair_failed", { ip });
            return new Response("Token salah.", { status: 403 });
          }
          log("paired", { ip });
          return new Response(null, { status: 303, headers: { location: "/", "set-cookie": pairCookie(token) } });
        }
        if (url.pathname === "/" && req.method === "GET") {
          return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
        if (!isAuthorized(req, token)) return fail("Belum dipasangkan. Scan QR pairing di PC.", 401);
        return await api(req, url, ip);
      } catch (e) {
        log("error", { path: url.pathname, error: (e as Error).message });
        return fail((e as Error).message, 500);
      }
    },
  });
  return `web on :${web.port} (subnets ${subnets.map((s) => s.cidr).join(", ")})`;
}

// Hook side: only processes of this user reach the Unix socket (mode 600).
if (existsSync(config.socketPath)) rmSync(config.socketPath);
// A socket is created with the default umask (mode 755, measured), so the chmod below alone leaves a short
// window: create it owner-only from the first instant.
const prevUmask = process.umask(0o177);
const hooks = Bun.serve({
  unix: config.socketPath,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const job = typeof body?.job === "string" ? jobs.get(body.job) : undefined;
    if (!job) return json({ decision: "none" });
    if (url.pathname === "/hook/permission") {
      jobs.update(job.id, { waiting: false });
      const pending = board.open(job.id, String(body!.tool ?? "?"), body!.input);
      log("permission_asked", { job: job.id, id: pending.id, tool: pending.tool });
      const decision = await board.wait(pending.id);
      log("permission_result", { job: job.id, id: pending.id, decision });
      return json({ decision });
    }
    if (url.pathname === "/hook/stop") {
      const saved = jobs.update(job.id, { turns: job.turns + 1, lastReply: String(body!.last ?? ""), waiting: true })!;
      log("turn_end", { job: job.id });
      for (const fn of onTurnEnd) {
        try {
          fn(saved);
        } catch {}
      }
      return json({ ok: true });
    }
    return json({ decision: "none" }, 404);
  },
});
process.umask(prevUmask);
Bun.spawnSync(["chmod", "600", config.socketPath]);

let web: string;
try {
  web = startWeb();
} catch (e) {
  web = `web failed: ${(e as Error).message}`;
}
const telegram = process.env.LAN_CLAUDE_TELEGRAM === "0" ? null : startTelegram();
// Watches live Claude sessions (status files) for turn ends, dialogs, and queued follow-ups.
let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  watchTick().catch((e) => log("watch_error", { error: (e as Error).message })).finally(() => (ticking = false));
}, 3000);
log("started", { web, telegram: telegram !== null });
console.log(`lan-claude: ${web}; telegram ${telegram ? "on" : "off"}; hooks on ${hooks.url}`);
