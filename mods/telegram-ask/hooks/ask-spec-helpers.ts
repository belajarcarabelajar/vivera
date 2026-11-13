// Fake telegram-ask bridge for ask.spec.ts (not a test file: no .spec.ts suffix).
import { createServer, type Server, type Socket } from 'node:net'

export type Sent = { method: string; path: string; body: unknown }
export type Reply = { status: number; body?: unknown } | 'drop'

// Stands in for the bridge daemon on a Unix socket. Plain node:net so a reply can
// also be a dropped connection, which is how a broken long-poll looks to the hook.
export class FakeBridge {
  sent: Sent[] = []
  askStatus = 200
  // A non-200 here leaves the held /wait open, like a /resolve the bridge never handled.
  resolveStatus = 200
  // Delays the /resolve reply after the held /wait is already closed, like a slow bridge.
  resolveDelayMs = 0
  // Scripted replies per ask id, served before any held /wait.
  waitReplies: Record<string, Reply[]> = {}
  private held = new Map<string, (r: Reply) => void>()
  private ids = new Set<string>()
  private count = 0
  private server: Server | undefined

  constructor(readonly sock: string) {}

  start(): Promise<void> {
    this.server = createServer(socket => this.serve(socket))
    return new Promise(res => this.server!.listen(this.sock, () => res()))
  }

  stop(): Promise<void> {
    for (const h of this.held.values()) h('drop')
    this.held.clear()
    return new Promise(res => (this.server ? this.server.close(() => res()) : res()))
  }

  paths(): string[] {
    return this.sent.map(s => `${s.method} ${s.path}`)
  }

  waits(): string[] {
    return this.paths().filter(p => p.startsWith('GET /wait/'))
  }

  // Answers the held /wait of this ask, or its next one when none is held yet.
  answer(id: string, answers: Record<string, string>) {
    const reply = { status: 200, body: { status: 'answered', answers } }
    const h = this.held.get(id)
    if (h) {
      this.held.delete(id)
      h(reply)
    } else (this.waitReplies[id] ??= []).push(reply)
  }

  async until(pred: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 500; i++) {
      if (pred()) return
      await Bun.sleep(10)
    }
    throw new Error(`timed out waiting for ${what}; sent: ${JSON.stringify(this.paths())}`)
  }

  private serve(socket: Socket) {
    let buf = Buffer.alloc(0)
    socket.on('data', async chunk => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buf.subarray(0, end).toString()
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0)
      if (buf.length < end + 4 + length) return
      const [method, path] = head.split('\r\n')[0].split(' ')
      const raw = buf.subarray(end + 4, end + 4 + length).toString()
      buf = Buffer.alloc(0)
      this.sent.push({ method, path, body: raw ? JSON.parse(raw) : undefined })
      const reply = await this.route(method, path)
      if (reply === 'drop') return void socket.destroy()
      const text = reply.body === undefined ? '' : JSON.stringify(reply.body)
      socket.end(
        `HTTP/1.1 ${reply.status} X\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`,
      )
    })
    socket.on('error', () => {})
  }

  private async route(method: string, path: string): Promise<Reply> {
    if (method === 'POST' && path === '/ask') {
      if (this.askStatus !== 200) return { status: this.askStatus }
      const id = `ask${++this.count}`
      this.ids.add(id)
      return { status: 200, body: { id } }
    }
    const wait = /^\/wait\/(.+)$/.exec(path)
    if (method === 'GET' && wait) {
      const id = wait[1]
      const scripted = this.waitReplies[id]?.shift()
      if (scripted) return scripted
      if (!this.ids.has(id)) return { status: 404 }
      return new Promise<Reply>(res => this.held.set(id, res))
    }
    const resolve = /^\/resolve\/(.+)$/.exec(path)
    if (method === 'POST' && resolve) {
      const id = resolve[1]
      if (!this.ids.has(id)) return { status: 404 }
      if (this.resolveStatus !== 200) return { status: this.resolveStatus }
      this.ids.delete(id)
      const h = this.held.get(id)
      this.held.delete(id)
      h?.({ status: 200, body: { status: 'closed' } })
      if (this.resolveDelayMs) await Bun.sleep(this.resolveDelayMs)
      return { status: 200, body: {} }
    }
    return { status: 404 }
  }
}
