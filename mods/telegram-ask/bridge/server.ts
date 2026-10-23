import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import {
  answersIfComplete,
  applyTap,
  applyText,
  newAskId,
  newState,
  parseCallback,
  renderAnswered,
  renderAsk,
  type Ask,
  type AskState,
  type Button,
} from './format'
import type { ChatId, Telegram, Update } from './telegram'

type WaitResult = { status: 'answered'; answers: Record<string, string> } | { status: 'closed' } | { status: 'pending' }

type Entry = {
  state: AskState
  messageId: number
  waiters: Set<(r: WaitResult) => void>
  result?: Record<string, string>
  otherSeq: number
  lastSeen: number
  edits: Promise<void>
}

export type BridgeOptions = {
  socketPath: string
  telegram: Telegram
  chatId: ChatId
  waitMs?: number
  keepMs?: number
  rand?: () => number
  log?: (line: string) => void
  staleMs?: number
  now?: () => number
}

export type Bridge = { stop(): Promise<void>; handleUpdate(update: Update): Promise<boolean> }

type Dispatch = { consumed: boolean; done: Promise<void> }

// Kept well under any client timeout; the hook simply polls again after a pending reply.
export const DEFAULT_WAIT_MS = 25_000
const EXPIRED = 'Pertanyaan ini sudah selesai'
// Snipset forwards each update with a 2 s timeout, so /update replies before that.
const UPDATE_REPLY_MS = 1_000
const DONE: Promise<void> = Promise.resolve()
const NO: Dispatch = { consumed: false, done: DONE }

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function parseAskBody(body: unknown): Omit<Ask, 'id'> | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (!isString(b.project) || !isString(b.session) || !isString(b.context)) return null
  if (!Array.isArray(b.questions) || b.questions.length === 0) return null
  for (const q of b.questions) {
    if (!q || typeof q !== 'object' || !isString(q.question) || !isString(q.header) || typeof q.multiSelect !== 'boolean') return null
    if (!Array.isArray(q.options) || q.options.length === 0) return null
    for (const o of q.options) {
      if (!o || typeof o !== 'object' || !isString(o.label)) return null
      if (o.description !== undefined && !isString(o.description)) return null
    }
  }
  return { project: b.project, session: b.session, context: b.context, questions: b.questions }
}

function errStatus(e: unknown): string {
  return String((e as { status?: number }).status ?? 'error')
}

function isNotModified(e: unknown): boolean {
  return String((e as { description?: string }).description ?? '').includes('message is not modified')
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const { socketPath, telegram, chatId } = opts
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS
  const keepMs = opts.keepMs ?? 60_000
  const rand = opts.rand ?? Math.random
  // No answer deadline while a session waits: a live hook re-polls /wait at least every
  // waitMs, so only an ask nobody has polled for staleMs (its session is gone) is dropped.
  const staleMs = opts.staleMs ?? 120_000
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.error(`telegram-ask: ${line}`))
  const asks = new Map<string, Entry>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let otherSeq = 0

  // Only a leftover socket is removed; any other file at the path is left alone.
  try {
    if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath)
  } catch {}

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
  }

  const wake = (entry: Entry, r: WaitResult) => {
    for (const w of entry.waiters) w(r)
    entry.waiters.clear()
  }

  // Edits for one ask run in order, so a slow edit cannot land after a newer one.
  function queueEdit(id: string, entry: Entry, render: () => { text: string; keyboard?: Button[][] } | null): Promise<void> {
    entry.edits = entry.edits.then(async () => {
      const view = render()
      if (!view) return
      try {
        await telegram.editMessageText(chatId, entry.messageId, view.text, view.keyboard)
      } catch (e) {
        if (!isNotModified(e)) log(`edit failed for ${id}: ${errStatus(e)}`)
      }
    })
    return entry.edits
  }

  function settle(id: string, entry: Entry): Promise<void> {
    const answers = answersIfComplete(entry.state)
    if (!answers) return queueEdit(id, entry, () => (entry.result ? null : renderAsk(entry.state)))
    entry.result = answers
    log(`ask ${id} answered in telegram (${Object.keys(answers).length} answers)`)
    wake(entry, { status: 'answered', answers })
    later(keepMs, () => asks.delete(id))
    return queueEdit(id, entry, () => ({ text: renderAnswered(entry.state.ask, answers, 'telegram') }))
  }

  async function answerCallback(id: string, text?: string) {
    try {
      await telegram.answerCallbackQuery(id, text)
    } catch (e) {
      log(`answerCallbackQuery failed: ${errStatus(e)}`)
    }
  }

  const fromOwner = (chat: { id: ChatId } | undefined) =>
    !!chat && typeof chat === 'object' && String(chat.id) === String(chatId)

  // State changes happen synchronously here; `done` covers the Telegram calls.
  function sweep() {
    const t = now()
    for (const [id, entry] of asks) {
      if (entry.waiters.size > 0 || t - entry.lastSeen <= staleMs) continue
      asks.delete(id)
      wake(entry, { status: 'closed' })
      log(`ask ${id} dropped: not polled for ${Math.round((t - entry.lastSeen) / 1000)} s`)
    }
  }

  function dispatch(update: Update): Dispatch {
    sweep()
    const cq = update.callback_query
    if (cq && typeof cq === 'object') {
      if (!fromOwner(cq.message?.chat)) return NO
      const tap = typeof cq.data === 'string' ? parseCallback(cq.data) : null
      if (!tap) return NO
      const entry = asks.get(tap.id)
      if (!entry || entry.result) return { consumed: true, done: answerCallback(cq.id, EXPIRED) }
      const next = applyTap(entry.state, tap)
      const ack = answerCallback(cq.id)
      if (next === entry.state) return { consumed: true, done: ack }
      if (tap.kind === 'other') entry.otherSeq = ++otherSeq
      entry.state = next
      return { consumed: true, done: Promise.all([ack, settle(tap.id, entry)]).then(() => {}) }
    }
    const msg = update.message
    if (!msg || typeof msg !== 'object' || !fromOwner(msg.chat) || typeof msg.text !== 'string') return NO
    let target: [string, Entry] | undefined
    for (const pair of asks) {
      const e = pair[1]
      if (e.result || e.state.awaitingOther === null) continue
      if (!target || e.otherSeq > target[1].otherSeq) target = pair
    }
    if (!target) return NO
    const next = applyText(target[1].state, msg.text)
    if (next === target[1].state) return { consumed: true, done: DONE }
    target[1].state = next
    return { consumed: true, done: settle(target[0], target[1]) }
  }

  async function handleUpdate(update: Update): Promise<boolean> {
    const d = dispatch(update)
    await d.done
    return d.consumed
  }

  async function onUpdate(req: Request): Promise<Response> {
    const body = await req.json().catch(() => undefined)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response('bad request', { status: 400 })
    let d: Dispatch
    try {
      d = dispatch(body as Update)
    } catch (e) {
      log(`update failed: ${(e as Error).name}`)
      return Response.json({ consumed: false })
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t)
        resolve()
      }, UPDATE_REPLY_MS)
      timers.add(t)
      d.done.then(() => {
        clearTimeout(t)
        timers.delete(t)
        resolve()
      })
    })
    return Response.json({ consumed: d.consumed })
  }

  async function onAsk(req: Request): Promise<Response> {
    sweep()
    const body = parseAskBody(await req.json().catch(() => null))
    if (!body) return new Response('bad request', { status: 400 })
    let id = newAskId(rand)
    // Bounded so a broken random source cannot freeze the daemon's event loop.
    for (let tries = 1; asks.has(id); tries++) {
      if (tries >= 100) {
        log('no free ask id after 100 draws')
        return new Response('no free id', { status: 503 })
      }
      id = newAskId(rand)
    }
    const state = newState({ id, ...body })
    const { text, keyboard } = renderAsk(state)
    // Reserve the id before the await so a parallel ask cannot draw it too.
    const entry: Entry = { state, messageId: 0, waiters: new Set(), otherSeq: 0, lastSeen: now(), edits: DONE }
    asks.set(id, entry)
    try {
      entry.messageId = (await telegram.sendMessage(chatId, text, keyboard)).message_id
    } catch (e) {
      asks.delete(id)
      log(`ask ${id} send failed: ${errStatus(e)}`)
      return new Response('telegram error', { status: 502 })
    }
    log(`ask ${id} sent (${body.questions.length} questions)`)
    return Response.json({ id })
  }

  function onWait(id: string): Promise<Response> | Response {
    const entry = asks.get(id)
    if (!entry) return new Response('unknown ask', { status: 404 })
    entry.lastSeen = now()
    if (entry.result) return Response.json({ status: 'answered', answers: entry.result })
    return new Promise((resolve) => {
      const waiter = (r: WaitResult) => {
        clearTimeout(timer)
        timers.delete(timer)
        entry.lastSeen = now()
        resolve(Response.json(r))
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        entry.waiters.delete(waiter)
        entry.lastSeen = now()
        resolve(Response.json({ status: 'pending' }))
      }, waitMs)
      timers.add(timer)
      entry.waiters.add(waiter)
    })
  }

  async function onResolve(id: string, req: Request): Promise<Response> {
    const entry = asks.get(id)
    if (!entry) return new Response('unknown ask', { status: 404 })
    const body = (await req.json().catch(() => null)) as { by?: unknown; answers?: unknown } | null
    const by = body?.by
    if (by !== 'terminal' && by !== 'cancelled') return new Response('bad request', { status: 400 })
    const answers = body?.answers && typeof body.answers === 'object' ? (body.answers as Record<string, string>) : {}
    asks.delete(id)
    wake(entry, { status: 'closed' })
    log(`ask ${id} resolved: ${by}`)
    // A terminal answer that arrives after a Telegram answer is the one Claude used, so it replaces the text.
    const lateTerminal = by === 'terminal' && Object.keys(answers).length > 0
    if (!entry.result || lateTerminal) await queueEdit(id, entry, () => ({ text: renderAnswered(entry.state.ask, answers, by) }))
    return Response.json({ ok: true })
  }

  const server = Bun.serve({
    unix: socketPath,
    // Bun's default idleTimeout (10 s) would cut the /wait long-poll; seconds, capped at 255.
    idleTimeout: Math.min(255, Math.ceil(waitMs / 1000) + 10),
    async fetch(req) {
      const parts = new URL(req.url).pathname.split('/').filter(Boolean)
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'ask') return onAsk(req)
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'update') return onUpdate(req)
      if (req.method === 'GET' && parts.length === 2 && parts[0] === 'wait') return onWait(parts[1])
      if (req.method === 'POST' && parts.length === 2 && parts[0] === 'resolve') return onResolve(parts[1], req)
      return new Response('not found', { status: 404 })
    },
  })
  chmodSync(socketPath, 0o600)

  return {
    handleUpdate,
    async stop() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const entry of asks.values()) wake(entry, { status: 'pending' })
      await server.stop(true)
    },
  }
}
