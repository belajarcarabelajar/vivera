import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SCRATCH = join(process.env.HOME ?? '', '.cache/tmp/telegram-ask-scratch')

let dir: string
let fakeBridge: ReturnType<typeof Bun.serve>
let fakeServer: ReturnType<typeof Bun.serve>
let plugin: { setup(ctx: unknown): Promise<void> }
let notices: string[]
let resolves: unknown[]
let replyStatuses: number[]
let replies: number
let push: (ev: unknown) => void
let stopStream: () => void

beforeAll(async () => {
  mkdirSync(SCRATCH, { recursive: true })
  dir = mkdtempSync(join(SCRATCH, 'oc-'))
  const sock = join(dir, 'bridge.sock')
  fakeBridge = Bun.serve({
    unix: sock,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/ask') return Response.json({ id: 'abcdef' })
      if (path === '/wait/abcdef') return Response.json({ status: 'answered', answers: { 'Lanjut?': 'Ya' } })
      if (path === '/notify') {
        notices.push(((await req.json()) as { text: string }).text)
        return Response.json({ ok: true })
      }
      if (path.startsWith('/resolve/')) {
        resolves.push(await req.json())
        return Response.json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
  })
  // The plugin finds the OpenCode API among this process's own listening TCP ports.
  fakeServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/reply')) return new Response('no', { status: 404 })
      const status = replyStatuses[replies++] ?? 500
      return new Response(null, { status })
    },
  })
  const saved = process.env.TELEGRAM_ASK_SOCKET
  process.env.TELEGRAM_ASK_SOCKET = sock
  plugin = (await import('./telegram-ask')).default as typeof plugin
  if (saved === undefined) delete process.env.TELEGRAM_ASK_SOCKET
  else process.env.TELEGRAM_ASK_SOCKET = saved

  const queue: unknown[] = []
  let wakeUp: (() => void) | null = null
  let stopped = false
  push = (ev) => {
    queue.push(ev)
    wakeUp?.()
  }
  stopStream = () => {
    stopped = true
    wakeUp?.()
  }
  async function* events() {
    while (!stopped) {
      if (queue.length === 0) await new Promise<void>((r) => (wakeUp = r))
      wakeUp = null
      while (queue.length > 0) yield queue.shift()
    }
  }
  await plugin.setup({ location: { directory: '/x/proj' }, event: { subscribe: () => events() } })
})

afterAll(async () => {
  stopStream()
  await fakeBridge.stop(true)
  await fakeServer.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  notices = []
  resolves = []
  replies = 0
})

let formSeq = 0
function askForm() {
  push({
    type: 'form.created',
    location: { directory: '/x/proj' },
    data: {
      form: {
        id: `frm${++formSeq}`,
        sessionID: 'ses_abc12345',
        metadata: { kind: 'question' },
        fields: [{ key: 'q0', title: 'Gate', description: 'Lanjut?', type: 'string', options: [{ value: 'Ya', label: 'Ya' }, { value: 'Tidak', label: 'Tidak' }] }],
      },
    },
  })
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await Bun.sleep(20)
}

describe('opencode plugin, Telegram answer that cannot reach the form', () => {
  test('retries the form reply once and stays quiet when the retry works', async () => {
    replyStatuses = [500, 200]
    askForm()
    await until(() => replies >= 2)
    await Bun.sleep(150)
    expect(replies).toBe(2)
    expect(notices).toEqual([])
  })

  test('tells Telegram to answer in the TUI when both replies fail', async () => {
    replyStatuses = [500, 500]
    askForm()
    await until(() => notices.length > 0)
    expect(replies).toBe(2)
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('TUI')
  })
})
