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
  const HOUR = 60 * 60_000
  // A live hook re-polls /wait; each poll here returns pending at once because waitMs is 1.
  const pollEvery = async (id: string, stepMs: number, untilMs: number, setClock: (t: number) => void) => {
    for (let t = stepMs; t <= untilMs; t += stepMs) {
      setClock(t)
      expect((await call(`/wait/${id}`)).status).toBe(200)
    }
  }

  test('an ask that keeps being polled survives far past 6 hours', async () => {
    let clock = 0
    const b = await start({ waitMs: 1, now: () => clock })
    const id = await ask()
    await pollEvery(id, 100_000, 7 * HOUR, (t) => (clock = t))
    await b.handleUpdate(tap(`${id}:0:0`))
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Ya' } })
  })

  test('an ask nobody polls for more than staleMs is dropped and its tap answers as expired', async () => {
    let clock = 0
    const b = await start({ now: () => clock })
    const id = await ask()
    clock = 120_001
    expect(await b.handleUpdate(tap(`${id}:0:0`))).toBe(true)
    expect(sent('answerCallbackQuery').map((c) => c.body.text)).toEqual(['Pertanyaan ini sudah selesai'])
    expect((await call(`/wait/${id}`)).status).toBe(404)
  })

  test('an ask polled exactly staleMs ago is kept', async () => {
    let clock = 0
    const b = await start({ staleMs: 1000, now: () => clock })
    const id = await ask()
    clock = 1000
    await b.handleUpdate(tap(`${id}:0:0`))
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Ya' } })
  })

  test('an Other wait on a live ask still takes text after 11 minutes', async () => {
    let clock = 0
    const b = await start({ waitMs: 1, now: () => clock })
    const id = await ask()
    await b.handleUpdate(tap(`${id}:0:o`))
    await pollEvery(id, 60_000, 11 * 60_000, (t) => (clock = t))
    expect(await b.handleUpdate(text('jawaban'))).toBe(true)
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'jawaban' } })
  })

  test('an Other wait on a dropped ask does not take text', async () => {
    let clock = 0
    const b = await start({ now: () => clock })
    const id = await ask()
    await b.handleUpdate(tap(`${id}:0:o`))
    clock = 120_001
    expect(await b.handleUpdate(text('pesan biasa'))).toBe(false)
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
