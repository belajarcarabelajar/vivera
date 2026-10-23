// mods/telegram-ask/opencode/telegram-ask.ts
//
// The OpenCode half of telegram-ask. The Claude Code half is mods/telegram-ask
// (hooks/register.ts); both talk to the same bridge daemon
// (systemd user unit telegram-ask-bridge.service, Unix socket
// $XDG_RUNTIME_DIR/vivera-telegram-ask.sock), so one bot serves both harnesses.
//
// How it works (read from the OpenCode 2.1.3 binary and measured, no public docs):
// - The built-in `question` tool opens a session form (event `form.created`,
//   metadata.kind "question", fields q0..qN) and waits on it.
// - This plugin reads that event from ctx.event.subscribe() (an async iterator;
//   a callback argument is ignored), posts the questions to the bridge, and
//   long-polls it. A Telegram answer goes back through the server's own HTTP
//   API, POST /api/session/<id>/form/<formID>/reply, which closes the TUI
//   dialog exactly like a keypress. A TUI answer (`form.replied`) or a dismiss
//   (`form.cancelled`) marks the Telegram message.
// - Do NOT wrap the tool's execute through ctx.tool.transform: measured
//   2026-10-23, even a pass-through wrapper hides the TUI dialog.
// - Server address: this plugin runs inside the server process, so it finds
//   its own LISTEN port through /proc/self/fd + /proc/self/net/tcp. Basic auth
//   user `opencode`; password from OPENCODE_PASSWORD (standalone) or
//   ~/.config/opencode/service.json (background service).
// - The plugin loads once per location and every instance sees every location's
//   events, so the location directory is filtered and one process-wide Map
//   keeps each form handled once.
//
// Bridge down or refusing the ask: the dialog works exactly as before.
// No runtime import from "@opencode/plugin" (see ~/.config/opencode/plugins/rtk.ts
// for why).
//
// Install: cp mods/telegram-ask/opencode/telegram-ask.ts \
//            ~/.config/opencode/plugins/telegram-ask.ts
// Revert: rm ~/.config/opencode/plugins/telegram-ask.ts

import type { Plugin } from "@opencode/plugin"
import { appendFileSync, readFileSync, readdirSync, readlinkSync } from "node:fs"
import { request } from "node:http"
import { homedir } from "node:os"
import { basename, join } from "node:path"

// Keep in step with the bridge default: mods/telegram-ask/bridge/main.ts. Both
// sides read TELEGRAM_ASK_SOCKET, so one override moves both halves.
const SOCKET = process.env.TELEGRAM_ASK_SOCKET
  ?? `${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/vivera-telegram-ask.sock`

const DEBUG = process.env.TELEGRAM_ASK_DEBUG
function debug(...args: unknown[]): void {
  if (DEBUG) try { appendFileSync(DEBUG, new Date().toISOString() + " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n") } catch {}
}

type Field = { key: string; title?: string; description?: string; type: string; options?: { value: string; label: string; description?: string }[] }
type Form = { id: string; sessionID: string; metadata?: { kind?: string }; fields: Field[] }
type Answers = Record<string, string>

const g = globalThis as { __telegramAskForms?: Map<string, { settle: (by: "terminal" | "cancelled", answer?: unknown) => void }> }
const forms = (g.__telegramAskForms ??= new Map())

function bridge(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; json: any }> {
  return httpCall({ socketPath: SOCKET, path, method, signal }, body)
}

function httpCall(target: { socketPath?: string; host?: string; port?: number; path: string; method: string; signal?: AbortSignal; auth?: string }, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        ...target,
        auth: undefined,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(target.auth ? { authorization: `Basic ${Buffer.from(target.auth).toString("base64")}` } : {}),
        },
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => (text += chunk))
        res.on("end", () => {
          let json: any = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on("error", reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function ownListenPorts(): number[] {
  const inodes = new Set<string>()
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`))
      if (m) inodes.add(m[1])
    } catch {}
  }
  const ports: number[] = []
  for (const file of ["/proc/self/net/tcp", "/proc/self/net/tcp6"]) {
    try {
      for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c.length > 9 && c[3] === "0A" && inodes.has(c[9])) ports.push(parseInt(c[1].split(":")[1], 16))
      }
    } catch {}
  }
  return ports
}

// A standalone server gets OPENCODE_PASSWORD at spawn and removes it from
// process.env after reading it (measured), so read the exec-time environment.
function serverPassword(): string {
  if (process.env.OPENCODE_PASSWORD) return process.env.OPENCODE_PASSWORD
  try {
    const hit = readFileSync("/proc/self/environ", "utf8").split("\0").find((kv) => kv.startsWith("OPENCODE_PASSWORD="))
    if (hit) return hit.slice("OPENCODE_PASSWORD=".length)
  } catch {}
  try {
    return String(JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8")).password ?? "")
  } catch {
    return ""
  }
}

// Tries each port this process listens on; the server's own API answers 2xx.
async function replyForm(form: Form, answer: Record<string, string | string[]>): Promise<boolean> {
  const auth = `opencode:${serverPassword()}`
  const ports = ownListenPorts()
  debug("reply ports", ports, "password set", auth.length > 9)
  for (const port of ports) {
    try {
      const res = await httpCall(
        { host: "127.0.0.1", port, auth, method: "POST", path: `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(form.id)}/reply` },
        { answer },
      )
      debug("reply", port, res.status, res.json)
      if (res.status >= 200 && res.status < 300) return true
    } catch (e) {
      debug("reply error", port, String(e))
    }
  }
  return false
}

function questionOf(f: Field): string {
  return f.description || f.title || f.key
}

// The bridge keys answers by question text and joins a multi-select with ", ".
function toFormAnswer(fields: Field[], answers: Answers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const f of fields) {
    const a = answers[questionOf(f)]
    if (a === undefined || a === "") continue
    if (f.type !== "multiselect") {
      out[f.key] = a
      continue
    }
    const labels = (f.options ?? []).map((o) => o.label)
    if (labels.includes(a)) out[f.key] = [a]
    else {
      const parts = a.split(", ")
      out[f.key] = parts.every((p) => labels.includes(p)) ? parts : [a]
    }
  }
  return out
}

function toBridgeAnswers(fields: Field[], answer: unknown): Answers {
  const out: Answers = {}
  if (!answer || typeof answer !== "object") return out
  const rec = answer as Record<string, unknown>
  for (const f of fields) {
    const v = rec[f.key]
    if (Array.isArray(v) && v.length > 0) out[questionOf(f)] = v.join(", ")
    else if (v !== undefined && v !== "" && !Array.isArray(v)) out[questionOf(f)] = String(v)
  }
  return out
}

async function mirror(form: Form, project: string): Promise<void> {
  const fields = form.fields.filter((f) => (f.type === "string" || f.type === "multiselect") && (f.options?.length ?? 0) > 0)
  if (fields.length !== form.fields.length || fields.length === 0) return

  let settled: { by: "terminal" | "cancelled"; answer?: unknown } | undefined
  let answeredFromTelegram = false
  const poll = new AbortController()
  forms.set(form.id, {
    settle: (by, answer) => {
      settled ??= { by, answer }
      poll.abort()
    },
  })

  try {
    const session = form.sessionID.replace(/^ses_/, "").slice(0, 8)
    let id: string | undefined
    try {
      const asked = await bridge("POST", "/ask", {
        project,
        session: session || "opencode",
        context: "",
        questions: fields.map((f) => ({
          question: questionOf(f),
          header: f.title ?? "",
          multiSelect: f.type === "multiselect",
          options: (f.options ?? []).map((o) => ({ label: o.label, description: o.description })),
        })),
      })
      if (asked.status === 200 && asked.json?.id) id = String(asked.json.id)
    } catch {}
    if (!id) return

    let failures = 0
    while (!settled) {
      try {
        const res = await bridge("GET", `/wait/${id}`, undefined, poll.signal)
        failures = 0
        debug("wait", id, res.status, res.json?.status)
        if (res.status !== 200 || settled) break
        if (res.json?.status === "answered" && res.json.answers) {
          answeredFromTelegram = await replyForm(form, toFormAnswer(fields, res.json.answers))
          break
        }
        if (res.json?.status !== "pending") break
      } catch {
        if (settled || ++failures >= 3) break
      }
    }

    if (answeredFromTelegram) return
    // Poll ended without a TUI event (bridge forgot the id or failed): nothing to mark.
    const final = settled as { by: "terminal" | "cancelled"; answer?: unknown } | undefined
    if (!final) return
    const answers = final.by === "terminal" ? toBridgeAnswers(fields, final.answer) : {}
    await bridge("POST", `/resolve/${id}`, { by: Object.keys(answers).length > 0 ? "terminal" : "cancelled", answers }).catch(() => {})
  } finally {
    forms.delete(form.id)
  }
}

export default {
  id: "telegram-ask",
  async setup(ctx: Plugin.Context) {
    const own = String((ctx as any).location?.directory ?? "")
    const stream = (ctx as any).event.subscribe()
    ;(async () => {
      for await (const ev of stream) {
        const dir = String(ev?.location?.directory ?? "")
        if (dir !== own) continue
        if (ev.type === "form.created") {
          const form = ev.data?.form as Form | undefined
          if (!form || form.metadata?.kind !== "question" || forms.has(form.id)) continue
          mirror(form, basename(dir) || "opencode").catch(() => {})
        } else if (ev.type === "form.replied") {
          forms.get(ev.data?.id)?.settle("terminal", ev.data?.answer)
        } else if (ev.type === "form.cancelled") {
          forms.get(ev.data?.id)?.settle("cancelled")
        }
      }
    })().catch(() => {})
  },
}
