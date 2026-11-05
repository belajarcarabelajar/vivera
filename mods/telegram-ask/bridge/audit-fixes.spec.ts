import { describe, expect, spyOn, test } from 'bun:test'
import { statSync } from 'node:fs'
import { markdownToHtml } from './markdown'
import { ask, calls, post, sock, start, tap, text, useBridgeFixtures } from './spec-helpers'

useBridgeFixtures()

describe('heading parse', () => {
  test('a heading line with 4,000 inner spaces renders in under 50 ms', () => {
    const line = '# a' + ' '.repeat(4000) + 'b'
    const t0 = performance.now()
    const html = markdownToHtml(line)
    const ms = performance.now() - t0
    expect(html).toBe(`<b>a${' '.repeat(4000)}b</b>`)
    expect(ms).toBeLessThan(50)
  })

  test('normal headings keep their rendering', () => {
    expect(markdownToHtml('# Judul')).toBe('<b>Judul</b>')
    expect(markdownToHtml('## Judul ##')).toBe('<b>Judul</b>')
    expect(markdownToHtml('###   Judul   ###   ')).toBe('<b>Judul</b>')
    expect(markdownToHtml('   # Judul  ')).toBe('<b>Judul</b>')
    expect(markdownToHtml('# C#')).toBe('<b>C</b>')
    expect(markdownToHtml('# a # b')).toBe('<b>a # b</b>')
    expect(markdownToHtml('# #')).toBe('<b></b>')
    expect(markdownToHtml('#Judul')).toBe('#Judul')
    expect(markdownToHtml('####### Judul')).toBe('####### Judul')
  })
})

describe('typed Other answer with two asks', () => {
  const consumed = async (u: unknown) => ((await (await post('/update', u)).json()) as { consumed: boolean }).consumed

  test('only the newest Other tap waits for text and the older ask is re-rendered', async () => {
    let n = 0
    await start({ rand: () => (n++ < 6 ? 0 : 0.05) })
    const older = await ask()
    const newer = await ask()
    // The fake Telegram numbers messages 100 + call count, so the first ask is 101.
    const olderMsg = 101
    expect(await consumed(tap(`${older}:0:o`))).toBe(true)
    expect(await consumed(tap(`${newer}:0:o`))).toBe(true)
    const olderEdits = calls.filter((c) => c.method === 'editMessageText' && c.body.message_id === olderMsg)
    expect(olderEdits.length).toBeGreaterThan(1)
    expect(olderEdits.at(-1)!.body.text).not.toContain('Ketik jawaban')
    expect(await consumed(text('Nanti saja'))).toBe(true)
    expect(await consumed(text('Teks lain'))).toBe(false)
  })
})

describe('socket permissions', () => {
  test('the socket has no group or other bits when created and the umask is restored', async () => {
    const before = process.umask(0o022)
    const real = Bun.serve
    const modes: number[] = []
    const spy = spyOn(Bun, 'serve').mockImplementation(((o: Parameters<typeof Bun.serve>[0]) => {
      const server = real.call(Bun, o)
      const unix = (o as { unix?: string }).unix
      if (unix) modes.push(statSync(unix).mode & 0o777)
      return server
    }) as typeof Bun.serve)
    let after: number
    try {
      await start()
      after = process.umask()
    } finally {
      spy.mockRestore()
      process.umask(before)
    }
    expect(modes.length).toBe(1)
    expect(modes[0] & 0o077).toBe(0)
    expect(after).toBe(0o022)
    expect(statSync(sock).mode & 0o777).toBe(0o600)
  })
})
