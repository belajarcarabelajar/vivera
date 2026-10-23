import { describe, expect, test } from 'bun:test'
import { DEFAULT_WAIT_MS } from './server'
import {
  CHAT,
  OTHER_CHAT,
  ask,
  call,
  calls,
  delay,
  post,
  sent,
  start,
  tap,
  text,
  useBridgeFixtures,
} from './spec-helpers'

useBridgeFixtures()

describe('update endpoint', () => {
  const consumed = async (u: unknown) => {
    const res = await post('/update', u)
    expect(res.status).toBe(200)
    return ((await res.json()) as { consumed: boolean }).consumed
  }

  test('update endpoint consumes a tap on a pending ask and applies it', async () => {
    await start()
    const id = await ask()
    expect(await consumed(tap(`${id}:0:0`))).toBe(true)
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Ya' } })
  })

  test('update endpoint consumes a tap for an unknown ask and answers it as expired', async () => {
    await start()
    expect(await consumed(tap('qqqqqq:0:0'))).toBe(true)
    await Bun.sleep(50)
    expect(sent('answerCallbackQuery').map((c) => c.body.text)).toEqual(['Pertanyaan ini sudah selesai'])
  })

  test('update endpoint consumes a tap on an answered ask and answers it as expired', async () => {
    await start()
    const id = await ask()
    expect(await consumed(tap(`${id}:0:0`))).toBe(true)
    expect(await consumed(tap(`${id}:0:1`))).toBe(true)
    await Bun.sleep(50)
    expect(sent('answerCallbackQuery').map((c) => c.body.text)).toEqual([undefined, 'Pertanyaan ini sudah selesai'])
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Ya' } })
  })

  test('update endpoint does not consume a callback whose data is not a tap', async () => {
    await start()
    await ask()
    expect(await consumed(tap('snipset:copy:42'))).toBe(false)
    expect(await consumed({ update_id: 1, callback_query: { id: 'x', message: { message_id: 1, chat: { id: CHAT } } } })).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(['sendMessage'])
  })

  test('update endpoint consumes text while an ask awaits Other text', async () => {
    await start()
    const id = await ask()
    await consumed(tap(`${id}:0:o`))
    expect(await consumed(text('Nanti saja'))).toBe(true)
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Nanti saja' } })
  })

  test('update endpoint does not consume text when no ask awaits Other text', async () => {
    await start()
    await ask()
    expect(await consumed(text('/start'))).toBe(false)
  })

  test('update endpoint does not consume updates from another chat', async () => {
    await start()
    const id = await ask()
    expect(await consumed(tap(`${id}:0:0`, OTHER_CHAT))).toBe(false)
    expect(await consumed(tap(`${id}:0:o`))).toBe(true)
    expect(await consumed(text('Ya', OTHER_CHAT))).toBe(false)
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'pending' })
  })

  test('update endpoint does not consume a message without text or an unrelated update', async () => {
    await start()
    const id = await ask()
    await consumed(tap(`${id}:0:o`))
    expect(await consumed({ update_id: 1, message: { message_id: 2, chat: { id: CHAT }, sticker: {} } })).toBe(false)
    expect(await consumed({ update_id: 2, edited_message: { message_id: 2, chat: { id: CHAT }, text: 'x' } })).toBe(false)
  })

  test('update endpoint rejects invalid JSON and non-object bodies with 400', async () => {
    await start()
    expect((await call('/update', { method: 'POST', body: '{nope' })).status).toBe(400)
    expect((await post('/update', [1, 2])).status).toBe(400)
    expect((await post('/update', 'text')).status).toBe(400)
    expect((await post('/update', null)).status).toBe(400)
  })

  test('update endpoint answers within 1.5 s while Telegram is slow', async () => {
    await start({ waitMs: 2000 })
    const id = await ask()
    delay.answerCallbackQuery = 3000
    delay.editMessageText = 3000
    const t0 = performance.now()
    expect(await consumed(tap(`${id}:0:1`))).toBe(true)
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Tidak' } })
  })
})

describe('review follow-ups', () => {
  const counting = () => {
    let n = 0
    return () => (n++ < 6 ? 0 : 0.05)
  }

  test('an ask older than askTtlMs is dropped on the next ask and its wait closes', async () => {
    let clock = 0
    await start({ waitMs: 2000, askTtlMs: 1000, now: () => clock, rand: counting() })
    const old = await ask()
    const waiting = call(`/wait/${old}`)
    await Bun.sleep(30)
    clock = 1001
    await ask()
    expect(await (await waiting).json()).toEqual({ status: 'closed' })
    expect((await call(`/wait/${old}`)).status).toBe(404)
  })

  test('an ask younger than askTtlMs survives the sweep', async () => {
    let clock = 0
    await start({ askTtlMs: 1000, now: () => clock, rand: counting() })
    const young = await ask()
    clock = 1000
    await ask()
    expect(await (await call(`/wait/${young}`)).json()).toEqual({ status: 'pending' })
  })

  test('an expired ask is swept on an update, so its tap answers as expired', async () => {
    let clock = 0
    const b = await start({ askTtlMs: 1000, now: () => clock })
    const id = await ask()
    clock = 5000
    expect(await b.handleUpdate(tap(`${id}:0:0`))).toBe(true)
    expect(sent('answerCallbackQuery').map((c) => c.body.text)).toEqual(['Pertanyaan ini sudah selesai'])
    expect((await call(`/wait/${id}`)).status).toBe(404)
  })

  test('a stale Other wait no longer swallows plain text', async () => {
    let clock = 0
    const b = await start({ otherTtlMs: 1000, now: () => clock })
    const id = await ask()
    await b.handleUpdate(tap(`${id}:0:o`))
    clock = 1001
    expect(await b.handleUpdate(text('pesan biasa'))).toBe(false)
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'pending' })
  })

  test('a fresh Other wait still takes the text', async () => {
    let clock = 0
    const b = await start({ otherTtlMs: 1000, now: () => clock })
    const id = await ask()
    await b.handleUpdate(tap(`${id}:0:o`))
    clock = 1000
    expect(await b.handleUpdate(text('jawaban'))).toBe(true)
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'jawaban' } })
  })

  test('a terminal resolve after a Telegram answer shows the terminal answer', async () => {
    const b = await start()
    const id = await ask()
    await b.handleUpdate(tap(`${id}:0:0`))
    expect((await post(`/resolve/${id}`, { by: 'terminal', answers: { 'Lanjut?': 'Tidak' } })).status).toBe(200)
    expect(sent('editMessageText').at(-1)!.body.text).toBe('🌾 vivera · s1\nGate: Tidak\n✅ Dijawab di terminal')
  })

  test('the default long-poll is 25 seconds', () => {
    expect(DEFAULT_WAIT_MS).toBe(25_000)
  })
})
