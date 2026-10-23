import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const QUESTIONS = [
  {
    question: 'Which database?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: 'relational' },
      { label: 'SQLite', description: 'one file' },
    ],
  },
]
const TERMINAL = { 'Which database?': 'SQLite' }
const PHONE = { 'Which database?': 'Postgres' }
const XDG = '/run/user/1000'

type Sent = { method: string; path: string; body: unknown; socketPath?: string }
type Reply = { status: number; body?: unknown }

// Stands in for the bridge daemon: /wait holds until the test answers it or a /resolve closes it.
class FakeBridge {
  sent: Sent[] = []
  askStatus = 200
  resolveStatus = 200
  pendingForever = false
  waitReplies: Reply[] = []
  private hold: ((r: Reply) => void) | undefined
  private askedOnce: () => void = () => {}
  asked = new Promise<void>(res => (this.askedOnce = res))
  private waitServed: Array<() => void> = []

  // Settles once the n-th /wait reply has been handed back to the hook.
  waits(n: number): Promise<void> {
    return new Promise(res => (this.waitServed[n - 1] = res))
  }

  constructor(on: On) {
    on('http.fetch', async (_$, e) => {
      const url = new URL(e.url)
      const body = e.init?.body ? JSON.parse(e.init.body) : undefined
      this.sent.push({ method: e.init?.method ?? 'GET', path: url.pathname, body, socketPath: e.init?.socketPath })
      const reply = await this.route(url.pathname)
      const text = reply.body === undefined ? '' : JSON.stringify(reply.body)
      return { value: { status: reply.status, ok: reply.status < 300, headers: {}, text } }
    })
  }

  paths(): string[] {
    return this.sent.map(s => `${s.method} ${s.path}`)
  }

  // Answers the held /wait, or the next one when none is held yet.
  answer(answers: Record<string, string>) {
    const reply = { status: 200, body: { status: 'answered', answers } }
    if (this.hold) this.release(reply)
    else this.waitReplies.push(reply)
  }

  private release(r: Reply) {
    const h = this.hold
    this.hold = undefined
    h?.(r)
  }

  private async route(path: string): Promise<Reply> {
    if (path === '/ask') {
      this.askedOnce()
      return this.askStatus === 200 ? { status: 200, body: { id: 'abcdef' } } : { status: this.askStatus }
    }
    // Capped so a hook that never stops polling fails the assertion instead of hanging the run.
    if (path.startsWith('/wait/') && this.pendingForever) {
      const waits = this.paths().filter(p => p.startsWith('GET /wait/')).length
      return { status: 200, body: { status: waits < 30 ? 'pending' : 'closed' } }
    }
    if (path.startsWith('/wait/')) {
      const served = this.waitServed[this.paths().filter(p => p.startsWith('GET /wait/')).length - 1]
      const next = this.waitReplies.shift() ?? (await new Promise<Reply>(res => (this.hold = res)))
      served?.()
      return next
    }
    if (path.startsWith('/resolve/') && this.resolveStatus !== 200) return { status: this.resolveStatus }
    if (path.startsWith('/resolve/')) {
      this.release({ status: 200, body: { status: 'closed' } })
      return { status: 200, body: {} }
    }
    return { status: 404 }
  }
}

// Stand-ins for the session calls the hook reads; nothing beneath a test answers them otherwise.
function session(on: On, notices: string[] = []) {
  on('session.root', async () => ({ value: '/home/me/Proyek/shop' }))
  on('session.cwd', async () => ({ value: '/home/me/Proyek/shop/app' }))
  on('session.id', async () => ({ value: '0123456789abcdef' }))
  on('session.messages', async () => ({
    value: [
      { role: 'user', content: [{ type: 'text', text: 'pick a db' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Two options fit.' },
          { type: 'text', text: 'Pick one.' },
          { type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: {} },
        ],
      },
    ],
  }))
  on('process.run', async (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('XDG_RUNTIME_DIR') ? `${XDG}\n` : '', stderr: '' },
  }))
  on('ui.notice', async (_$, e) => (notices.push(String(e.text)), { value: undefined }))
}

describe('a call that already carries answers', () => {
  test('goes straight to the dialog with no bridge call', async ($, on) => {
    const bridge = new FakeBridge(on)
    session(on)
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => ({ result: { questions: e.questions, answers: e.answers } }))
    const out = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, answers: TERMINAL })
    expect(out.result).toEqual({ questions: QUESTIONS, answers: TERMINAL })
    expect(bridge.sent).toEqual([])
  })
})

describe('the race', () => {
  test('a Telegram answer wins and aborts the terminal dialog', async ($, on) => {
    const bridge = new FakeBridge(on)
    const notices: string[] = []
    session(on, notices)
    let aborted = false
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$, _e, next) => {
      await new Promise<void>(res => next.signal.addEventListener('abort', () => ((aborted = true), res())))
      return { deny: 'dialog closed' }
    })
    bridge.asked.then(() => bridge.answer(PHONE))
    const out = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
    expect(out.result).toEqual({ questions: QUESTIONS, answers: PHONE })
    expect(aborted).toBe(true)
    expect(notices).toEqual(['telegram-ask: juga dikirim ke Telegram'])
  })

  test('a terminal answer wins, comes back unchanged, and resolves the bridge as terminal', async ($, on) => {
    const bridge = new FakeBridge(on)
    session(on)
    const engine = { result: { questions: QUESTIONS, answers: TERMINAL }, text: 'User answered SQLite' }
    on('tool.call', { tool: 'AskUserQuestion' }, async () => (await bridge.asked, engine))
    const out = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
    expect(out.result).toEqual(engine.result)
    expect(out.text).toBe(engine.text)
    const resolve = bridge.sent.find(s => s.path === '/resolve/abcdef')
    expect(resolve?.body).toEqual({ by: 'terminal', answers: TERMINAL })
  })

  test('a failed resolve after a terminal answer stops the polling', async ($, on) => {
    const bridge = new FakeBridge(on)
    bridge.resolveStatus = 500
    bridge.pendingForever = true
    session(on)
    on('tool.call', { tool: 'AskUserQuestion' }, async () => (await bridge.asked, { result: { questions: QUESTIONS, answers: TERMINAL } }))
    const out = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
    expect(out.result).toEqual({ questions: QUESTIONS, answers: TERMINAL })
    const waits = () => bridge.paths().filter(p => p.startsWith('GET /wait/')).length
    const atResult = waits()
    // Gives a stray poll loop room to run; the test engine's $ offers no clock.
    await new Promise(res => setTimeout(res, 200))
    expect(waits()).toBeLessThanOrEqual(atResult + 1)
  })

  test('a dismissed dialog resolves the bridge as cancelled', async ($, on) => {
    const bridge = new FakeBridge(on)
    session(on)
    on('tool.call', { tool: 'AskUserQuestion' }, async () => (await bridge.asked, { deny: 'User declined to answer' }))
    const out = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
    expect(out.deny).toBe('User declined to answer')
    const resolve = bridge.sent.find(s => s.path === '/resolve/abcdef')
    expect(resolve?.body).toEqual({ by: 'cancelled' })
  })
})

describe('the ask itself', () => {
  test('carries the project, a short session label, the latest Claude text and the questions over the default socket', async ($, on) => {
    const bridge = new FakeBridge(on)
    session(on)
    on('tool.call', { tool: 'AskUserQuestion' }, async () => (await bridge.asked, { result: { questions: QUESTIONS, answers: TERMINAL } }))
    await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
    const ask = bridge.sent[0]
    expect(`${ask.method} ${ask.path}`).toBe('POST /ask')
    expect(ask.body).toEqual({ project: 'shop', session: '01234567', context: 'Two options fit.\nPick one.', questions: QUESTIONS })
    expect(ask.socketPath).toBe(`${XDG}/vivera-telegram-ask.sock`)
  })

  test('the socketPath option overrides the default', { options: { socketPath: '/tmp/x/bridge.sock' } }, async ($, on) => {
    const bridge = new FakeBridge(on)
    session(on)
    on('tool.call', { tool: 'AskUserQuestion' }, async () => (await bridge.asked, { result: { questions: QUESTIONS, answers: TERMINAL } }))
    await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
    expect(bridge.sent.map(s => s.socketPath)).toEqual(bridge.sent.map(() => '/tmp/x/bridge.sock'))
  })
})

describe('fail open', () => {
  test('an offline bridge leaves the terminal answer and shows one notice', async ($, on) => {
    const bridge = new FakeBridge(on)
    bridge.askStatus = 503
    const notices: string[] = []
    session(on, notices)
    on('tool.call', { tool: 'AskUserQuestion' }, async () => (await bridge.asked, { result: { questions: QUESTIONS, answers: TERMINAL } }))
    const out = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
    expect(out.result).toEqual({ questions: QUESTIONS, answers: TERMINAL })
    expect(notices).toEqual(['telegram-ask: bridge offline'])
    expect(bridge.paths()).toEqual(['POST /ask'])
  })

  test('a 404 on wait (bridge restarted) falls back to the terminal answer', async ($, on) => {
    const bridge = new FakeBridge(on)
    bridge.waitReplies = [{ status: 200, body: { status: 'pending' } }, { status: 404 }]
    session(on)
    const secondWait = bridge.waits(2)
    on('tool.call', { tool: 'AskUserQuestion' }, async () => {
      // The dialog answers only after the 404 came back, so the 404 path is what ends the bridge side.
      await secondWait
      for (let i = 0; i < 20; i++) await Promise.resolve()
      return { result: { questions: QUESTIONS, answers: TERMINAL } }
    })
    const out = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS })
    expect(out.result).toEqual({ questions: QUESTIONS, answers: TERMINAL })
    expect(bridge.paths().filter(p => p.startsWith('GET /wait/'))).toEqual(['GET /wait/abcdef', 'GET /wait/abcdef'])
  })
})
