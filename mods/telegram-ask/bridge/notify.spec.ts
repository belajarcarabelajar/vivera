import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { dir, fail, post, sent, sock, start, useBridgeFixtures } from './spec-helpers'

useBridgeFixtures()

const CLI = join(import.meta.dir, 'notify.ts')

async function runCli(args: string[], socket: string) {
  // Async spawn: the bridge under test lives in this process, so a sync spawn would starve it.
  const p = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, TELEGRAM_ASK_SOCKET: socket },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out, err }
}

describe('POST /notify', () => {
  test('sends one message with no keyboard and answers its message id', async () => {
    await start()
    const res = await post('/notify', { text: '**plan-x**: PR #7 opened' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; message_id: number }
    expect(body.ok).toBe(true)
    expect(typeof body.message_id).toBe('number')
    const msgs = sent('sendMessage')
    expect(msgs.length).toBe(1)
    expect(msgs[0].body.reply_markup).toBeUndefined()
    expect(msgs[0].body.parse_mode).toBe('HTML')
    expect(msgs[0].body.text).toContain('<b>plan-x</b>')
  })

  test('a body without non-empty text is rejected with 400 and sends nothing', async () => {
    await start()
    for (const b of [{}, { text: '' }, { text: '   ' }, { text: 5 }]) {
      const res = await post('/notify', b)
      expect(res.status).toBe(400)
    }
    expect(sent('sendMessage').length).toBe(0)
  })

  test('text longer than 4096 characters is cut to fit', async () => {
    await start()
    const res = await post('/notify', { text: 'a & b '.repeat(2000) })
    expect(res.status).toBe(200)
    const t = sent('sendMessage')[0].body.text as string
    expect(t.length).toBeLessThanOrEqual(4096)
    expect(t.endsWith('…')).toBe(true)
  })

  test('a Telegram failure answers 502', async () => {
    await start()
    fail.sendMessage = { status: 500, description: 'boom' }
    const res = await post('/notify', { text: 'hello' })
    expect(res.status).toBe(502)
  })
})

describe('notify CLI', () => {
  test('posts the text to the bridge socket and exits 0', async () => {
    await start()
    const r = await runCli(['plan-x: chunk T4 blocked'], sock)
    expect(r.code).toBe(0)
    const msgs = sent('sendMessage')
    expect(msgs.length).toBe(1)
    expect(msgs[0].body.text).toContain('chunk T4 blocked')
  })

  test('with no bridge on the socket it prints one warning line and exits 0', async () => {
    const missing = join(dir, 'absent.sock')
    const r = await runCli(['hello'], missing)
    expect(r.code).toBe(0)
    const lines = (r.out + r.err).trim().split('\n')
    expect(lines).toEqual([`notify: bridge not running (${missing})`])
  })

  test('no text argument is a usage error, exit 2', async () => {
    const r = await runCli([], join(dir, 'absent.sock'))
    expect(r.code).toBe(2)
  })
})
