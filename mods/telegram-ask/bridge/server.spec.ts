import { describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { defaultEnvPath, pollEnabled } from './main'
import {
  CHAT,
  OTHER_CHAT,
  TOKEN,
  ask,
  call,
  calls,
  fail,
  logs,
  multi,
  post,
  rawGet,
  sent,
  single,
  sock,
  start,
  tap,
  telegram,
  text,
  updateId,
  useBridgeFixtures,
} from './spec-helpers'
import { createTelegram } from './telegram'

useBridgeFixtures()

describe('telegram client', () => {
  test('posts JSON with an inline keyboard, no parse mode, and link previews off', async () => {
    const tg = telegram()
    expect(await tg.sendMessage(CHAT, 'halo *x*', [[{ text: 'A', callback_data: 'abcdef:0:0' }]])).toEqual({ message_id: 101 })
    expect(calls[0].path).toBe(`/bot${TOKEN}/sendMessage`)
    expect(calls[0].body).toEqual({
      chat_id: CHAT,
      text: 'halo *x*',
      reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'abcdef:0:0' }]] },
      link_preview_options: { is_disabled: true },
    })
  })

  test('asks getUpdates for messages and callback queries from an offset', async () => {
    expect(await telegram().getUpdates(8, 30)).toEqual([{ update_id: 7 }])
    expect(calls[0].body).toEqual({ offset: 8, timeout: 30, allowed_updates: ['message', 'callback_query'] })
  })

  test('throws an error carrying the HTTP status without the token', async () => {
    fail.getUpdates = { status: 409, description: 'Conflict: terminated by other getUpdates request' }
    const err = (await telegram().getUpdates(0, 30).catch((e) => e)) as Error & { status?: number }
    expect(err.status).toBe(409)
    expect(String(err.message) + String(err.stack)).not.toContain(TOKEN)
  })

  test('hides the token when the network fails', async () => {
    const tg = createTelegram({ token: TOKEN, base: 'http://127.0.0.1:1' })
    const err = (await tg.answerCallbackQuery('x').catch((e) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toContain(TOKEN)
  })
})

describe('bridge socket', () => {
  test('replaces a stale socket and restricts the new one to the owner', async () => {
    const made = Bun.spawnSync(['python3', '-I', '-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', sock])
    expect(made.exitCode).toBe(0)
    await start()
    expect(statSync(sock).mode & 0o777).toBe(0o600)
    expect((await call('/wait/zzzzzz')).status).toBe(404)
  })
})

describe('POST /ask', () => {
  test('sends one message with the rendered keyboard and returns the id', async () => {
    await start()
    expect(await ask()).toBe('aaaaaa')
    expect(sent('sendMessage').length).toBe(1)
    const body = sent('sendMessage')[0].body
    expect(body.chat_id).toBe(String(CHAT))
    expect(body.text).toContain('[1/1] Gate: Lanjut?')
    expect(body.reply_markup.inline_keyboard).toEqual([
      [{ text: '1.1 Ya', callback_data: 'aaaaaa:0:0' }],
      [{ text: '1.2 Tidak', callback_data: 'aaaaaa:0:1' }],
      [{ text: '✏️ Lainnya', callback_data: 'aaaaaa:0:o' }],
    ])
  })

  test('draws a new id when the first one is taken', async () => {
    let n = 0
    await start({ rand: () => (n++ < 12 ? 0 : 0.05) })
    expect(await ask()).toBe('aaaaaa')
    expect(await ask()).toBe('bbbbbb')
  })

  test('gives up with 503 instead of spinning when every drawn id is taken', async () => {
    await start({ rand: () => 0 })
    expect(await ask()).toBe('aaaaaa')
    expect((await post('/ask', single)).status).toBe(503)
    expect(sent('sendMessage').length).toBe(1)
  })

  test('rejects a malformed body with 400 and sends nothing', async () => {
    await start()
    expect((await call('/ask', { method: 'POST', body: 'not json' })).status).toBe(400)
    expect((await post('/ask', { ...single, questions: [] })).status).toBe(400)
    expect((await post('/ask', { ...single, questions: [{ question: 'Q', header: 'H', multiSelect: false, options: [{}] }] })).status).toBe(400)
    expect(calls.length).toBe(0)
  })

  test('answers 502 when Telegram refuses the message', async () => {
    fail.sendMessage = { status: 400, description: 'Bad Request: chat not found' }
    await start()
    expect((await post('/ask', single)).status).toBe(502)
    expect((await call('/wait/aaaaaa')).status).toBe(404)
  })
})

describe('answering from Telegram', () => {
  test('a tap from the owner chat answers a pending wait with the label', async () => {
    const b = await start({ waitMs: 2000 })
    const id = await ask()
    const waiting = call(`/wait/${id}`)
    await Bun.sleep(30)
    await b.handleUpdate(tap(`${id}:0:1`))
    expect(await (await waiting).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Tidak' } })
    expect(sent('answerCallbackQuery').length).toBe(1)
    const edit = sent('editMessageText').at(-1)!.body
    expect(edit.message_id).toBe(101)
    expect(edit.text).toBe('🌾 vivera · s1\nGate: Tidak\n✅ Dijawab lewat Telegram')
    expect(edit.reply_markup).toBeUndefined()
  })

  test('a wait after the answer still returns it', async () => {
    const b = await start()
    const id = await ask()
    await b.handleUpdate(tap(`${id}:0:0`))
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Ya' } })
  })

  test('a tap from another chat changes nothing', async () => {
    const b = await start({ waitMs: 200 })
    const id = await ask()
    await b.handleUpdate(tap(`${id}:0:0`, OTHER_CHAT))
    await b.handleUpdate(text('Ya', OTHER_CHAT))
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'pending' })
    expect(calls.map((c) => c.method)).toEqual(['sendMessage'])
  })

  test('multi-select toggles redraw the keyboard and Send answers with joined labels', async () => {
    const b = await start()
    const id = await ask(multi)
    await b.handleUpdate(tap(`${id}:0:2`))
    await b.handleUpdate(tap(`${id}:0:0`))
    expect(sent('editMessageText').at(-1)!.body.reply_markup.inline_keyboard.flat().map((k: { text: string }) => k.text)).toEqual([
      '✅ 1.1 Tes',
      '1.2 Lint',
      '✅ 1.3 Docs',
      '✏️ Lainnya',
      'Kirim',
    ])
    await b.handleUpdate(tap(`${id}:0:s`))
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Cek apa?': 'Tes, Docs' } })
  })

  test('Other then a text message answers with the text', async () => {
    const b = await start()
    const id = await ask()
    await b.handleUpdate(tap(`${id}:0:o`))
    expect(sent('editMessageText').at(-1)!.body.text).toEndWith('✏️ Ketik jawaban untuk pertanyaan 1 sebagai pesan biasa.')
    await b.handleUpdate(text('  Tunggu review  '))
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Tunggu review' } })
  })

  test('typed text goes to the ask whose Other was tapped last', async () => {
    let n = 0
    const b = await start({ rand: () => (n++ < 6 ? 0 : 0.05) })
    const first = await ask()
    const second = await ask()
    await b.handleUpdate(tap(`${second}:0:o`))
    await b.handleUpdate(tap(`${first}:0:o`))
    await b.handleUpdate(text('Nanti'))
    expect(await (await call(`/wait/${first}`)).json()).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Nanti' } })
    expect(await (await call(`/wait/${second}`)).json()).toEqual({ status: 'pending' })
  })

  test('a callback for an unknown ask is answered as expired', async () => {
    const b = await start()
    await b.handleUpdate(tap('qqqqqq:0:0'))
    expect(sent('answerCallbackQuery').map((c) => c.body)).toEqual([{ callback_query_id: `cq${updateId}`, text: 'Pertanyaan ini sudah selesai' }])
  })

  test('a "message is not modified" edit error is swallowed', async () => {
    fail.editMessageText = { status: 400, description: 'Bad Request: message is not modified' }
    const b = await start()
    const id = await ask(multi)
    await b.handleUpdate(tap(`${id}:0:0`))
    expect(sent('answerCallbackQuery').length).toBe(1)
    expect(logs.filter((l) => l.includes('not modified'))).toEqual([])
  })
})

describe('GET /wait and POST /resolve', () => {
  test(
    'a long-poll longer than 10 s stays open until the answer comes',
    async () => {
      // Bun warns at 10 s but drops the idle request at about 12 s, so the tap comes at 14 s.
      const b = await start({ waitMs: 20_000 })
      const id = await ask()
      const waiting = rawGet(`/wait/${id}`)
      await Bun.sleep(14_000)
      await b.handleUpdate(tap(`${id}:0:1`))
      const res = await waiting
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ status: 'answered', answers: { 'Lanjut?': 'Tidak' } })
      expect(logs.join('\n')).not.toContain('timed out a request')
    },
    30_000,
  )

  test('a wait with no answer returns pending after waitMs', async () => {
    await start({ waitMs: 200 })
    const id = await ask()
    const t0 = performance.now()
    expect(await (await call(`/wait/${id}`)).json()).toEqual({ status: 'pending' })
    expect(performance.now() - t0).toBeGreaterThanOrEqual(190)
  })

  test('a terminal resolve edits the message, closes a pending wait, and drops the ask', async () => {
    await start({ waitMs: 2000 })
    const id = await ask()
    const waiting = call(`/wait/${id}`)
    await Bun.sleep(30)
    const res = await post(`/resolve/${id}`, { by: 'terminal', answers: { 'Lanjut?': 'Ya' } })
    expect(res.status).toBe(200)
    expect(await (await waiting).json()).toEqual({ status: 'closed' })
    const edit = sent('editMessageText').at(-1)!.body
    expect(edit.text).toBe('🌾 vivera · s1\nGate: Ya\n✅ Dijawab di terminal')
    expect(edit.reply_markup).toBeUndefined()
    expect((await call(`/wait/${id}`)).status).toBe(404)
  })

  test('a cancelled resolve without answers shows the cancel footer', async () => {
    await start()
    const id = await ask()
    expect((await post(`/resolve/${id}`, { by: 'cancelled' })).status).toBe(200)
    expect(sent('editMessageText').at(-1)!.body.text).toBe('🌾 vivera · s1\n⛔ Dibatalkan')
  })

  test('a resolve still succeeds when the edit fails', async () => {
    fail.editMessageText = { status: 400, description: 'Bad Request: message to edit not found' }
    await start()
    const id = await ask()
    expect((await post(`/resolve/${id}`, { by: 'terminal', answers: {} })).status).toBe(200)
  })

  test('an unknown id is 404 for wait and resolve', async () => {
    await start()
    expect((await call('/wait/qqqqqq')).status).toBe(404)
    expect((await post('/resolve/qqqqqq', { by: 'terminal' })).status).toBe(404)
  })
})

describe('logging', () => {
  test('bridge output never contains the token, question text, or answers', async () => {
    let n = 0
    const b = await start({ rand: () => (n++ < 6 ? 0 : 0.05) })
    const id = await ask()
    fail.editMessageText = { status: 400, description: 'Bad Request: message to edit not found' }
    fail.answerCallbackQuery = { status: 500, description: 'Internal' }
    await b.handleUpdate(tap(`${id}:0:o`))
    await b.handleUpdate(text('Rahasia jawaban'))
    fail.sendMessage = { status: 403, description: 'Forbidden: bot was blocked by the user' }
    await post('/ask', single)
    const out = logs.join('\n')
    expect(out).toContain(id)
    for (const secret of [TOKEN, 'Lanjut?', 'Rencana siap.', 'Rahasia jawaban']) expect(out).not.toContain(secret)
  })
})

describe('main', () => {
  test('polls Telegram by default', () => {
    expect(pollEnabled({})).toBe(true)
    expect(pollEnabled({ TELEGRAM_ASK_POLL: '1' })).toBe(true)
    expect(pollEnabled({ TELEGRAM_ASK_POLL: '' })).toBe(true)
    expect(pollEnabled({ TELEGRAM_ASK_POLL: 'false' })).toBe(true)
  })

  test('stops polling only for TELEGRAM_ASK_POLL=0', () => {
    expect(pollEnabled({ TELEGRAM_ASK_POLL: '0' })).toBe(false)
  })

  test('reads the env file from XDG_CONFIG_HOME when set', () => {
    expect(defaultEnvPath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/u' })).toBe('/x/cfg/vivera-telegram-ask/.env')
  })

  test('falls back to ~/.config for the env file', () => {
    expect(defaultEnvPath({ HOME: '/home/u' })).toBe('/home/u/.config/vivera-telegram-ask/.env')
    expect(defaultEnvPath({ XDG_CONFIG_HOME: '', HOME: '/home/u' })).toBe('/home/u/.config/vivera-telegram-ask/.env')
  })
})
