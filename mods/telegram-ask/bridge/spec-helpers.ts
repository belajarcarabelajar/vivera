import { afterEach, beforeEach, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startBridge } from './server'
import { createTelegram } from './telegram'

export const TOKEN = '123456:TEST-secret-token-xyz'
export const CHAT = 4242
export const OTHER_CHAT = 999
export const SCRATCH = join(process.env.HOME ?? '', '.cache/tmp/telegram-ask-scratch')

export type Call = { method: string; path: string; body: any }
export type Fail = { status: number; description: string }

export let calls: Call[]
export let fail: Record<string, Fail>
export let delay: Record<string, number>
export let fake: ReturnType<typeof Bun.serve>
export let dir: string
export let sock: string
export let logs: string[]
export let bridge: Awaited<ReturnType<typeof startBridge>> | null
const saved = { log: console.log, error: console.error, warn: console.warn }

// Each spec file calls this once at top level so every test gets a fresh fake Telegram and socket.
export function useBridgeFixtures() {
  beforeEach(() => {
    calls = []
    fail = {}
    delay = {}
    logs = []
    bridge = null
    for (const k of ['log', 'error', 'warn'] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(' '))
    fake = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        const method = path.split('/').pop() ?? ''
        calls.push({ method, path, body: await req.json() })
        if (delay[method]) await Bun.sleep(delay[method])
        const f = fail[method]
        if (f) return Response.json({ ok: false, error_code: f.status, description: f.description }, { status: f.status })
        if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: 100 + calls.length } })
        if (method === 'getUpdates') return Response.json({ ok: true, result: [{ update_id: 7 }] })
        return Response.json({ ok: true, result: true })
      },
    })
    mkdirSync(SCRATCH, { recursive: true })
    dir = mkdtempSync(join(SCRATCH, 'srv-'))
    sock = join(dir, 'bridge.sock')
  })

  afterEach(async () => {
    await bridge?.stop()
    await fake.stop(true)
    Object.assign(console, saved)
    rmSync(dir, { recursive: true, force: true })
  })
}

export const telegram = () => createTelegram({ token: TOKEN, base: fake.url.origin })

export type StartOpts = { waitMs?: number; rand?: () => number; askTtlMs?: number; otherTtlMs?: number; now?: () => number }
export async function start(opts: StartOpts = {}) {
  bridge = await startBridge({
    socketPath: sock,
    telegram: telegram(),
    chatId: String(CHAT),
    waitMs: opts.waitMs ?? 300,
    rand: opts.rand ?? (() => 0),
    askTtlMs: opts.askTtlMs,
    otherTtlMs: opts.otherTtlMs,
    now: opts.now,
  })
  return bridge
}

export const call = (path: string, init: RequestInit = {}) => fetch(`http://bridge${path}`, { ...init, unix: sock } as RequestInit)
export const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) })
export const sent = (method: string) => calls.filter((c) => c.method === method)

export const single = {
  project: 'vivera',
  session: 's1',
  context: 'Rencana siap.',
  questions: [{ question: 'Lanjut?', header: 'Gate', multiSelect: false, options: [{ label: 'Ya' }, { label: 'Tidak' }] }],
}
export const multi = {
  ...single,
  questions: [{ question: 'Cek apa?', header: 'Cek', multiSelect: true, options: [{ label: 'Tes' }, { label: 'Lint' }, { label: 'Docs' }] }],
}

export let updateId = 1
export const tap = (data: string, chat = CHAT) => ({
  update_id: updateId++,
  callback_query: { id: `cq${updateId}`, data, from: { id: chat }, message: { message_id: 101, chat: { id: chat } } },
})
export const text = (t: string, chat = CHAT) => ({ update_id: updateId++, message: { message_id: 500, chat: { id: chat }, text: t } })

export async function ask(body: unknown = single): Promise<string> {
  const res = await post('/ask', body)
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: string }).id
}

