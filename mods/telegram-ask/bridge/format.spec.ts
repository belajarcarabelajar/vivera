import { describe, expect, test } from 'bun:test'
import {
  answersIfComplete,
  applyTap,
  applyText,
  newAskId,
  newState,
  parseCallback,
  renderAnswered,
  renderAsk,
  unanswered,
  type Ask,
  type AskState,
  type Question,
} from './format'

const ask2: Ask = {
  id: 'abcdef',
  project: 'vivera',
  session: 'telegram-ask',
  context: 'Rencana siap.',
  questions: [
    {
      question: 'Lanjut ke T2?',
      header: 'Gate',
      multiSelect: false,
      options: [{ label: 'Ya', description: 'Mulai T2' }, { label: 'Tidak' }],
    },
    {
      question: 'Cek apa saja?',
      header: 'Cek',
      multiSelect: true,
      options: [{ label: 'Tes' }, { label: 'Lint' }, { label: 'Docs' }],
    },
  ],
}

function withState(over: Partial<AskState>, ask: Ask = ask2): AskState {
  return { ...newState(ask), ...over }
}

function bigAsk(contextLen: number, descLen: number): Ask {
  const questions: Question[] = [0, 1, 2, 3].map((n) => ({
    question: `Pertanyaan nomor ${n + 1}?`,
    header: `H${n + 1}`,
    multiSelect: n % 2 === 1,
    options: [0, 1, 2, 3].map((i) => ({ label: `Opsi ${n + 1}${i + 1}`, description: 'd'.repeat(descLen) })),
  }))
  return { id: 'abcdef', project: 'vivera', session: 's1', context: 'c'.repeat(contextLen), questions }
}

describe('newAskId', () => {
  test('returns six lowercase letters by default', () => {
    expect(newAskId()).toMatch(/^[a-z]{6}$/)
  })

  test('maps the injected random source onto a to z', () => {
    expect(newAskId(() => 0)).toBe('aaaaaa')
    expect(newAskId(() => 0.9999)).toBe('zzzzzz')
  })
})

describe('newState', () => {
  test('starts every question unanswered with nothing awaited', () => {
    expect(newState(ask2)).toEqual({
      ask: ask2,
      q: [
        { picked: [], done: false },
        { picked: [], done: false },
      ],
      awaitingOther: null,
    })
  })
})

describe('renderAsk text', () => {
  test('shows project, Claude context, numbered questions and options', () => {
    expect(renderAsk(newState(ask2)).text).toBe(
      [
        '🌾 vivera · telegram-ask',
        '<b>Claude:</b>',
        'Rencana siap.',
        '',
        '<b>[1/2] Gate:</b> Lanjut ke T2?',
        ' 1. Ya - Mulai T2',
        ' 2. Tidak',
        '',
        '<b>[2/2] Cek:</b> Cek apa saja? (pilih beberapa)',
        ' 1. Tes',
        ' 2. Lint',
        ' 3. Docs',
      ].join('\n'),
    )
  })

  test('omits the Claude block when the context is empty', () => {
    const text = renderAsk(newState({ ...ask2, context: '  ' })).text
    expect(text.startsWith('🌾 vivera · telegram-ask\n\n<b>[1/2] Gate:</b> Lanjut ke T2?\n')).toBe(true)
  })

  test('ends with the Other prompt while waiting for typed text', () => {
    const text = renderAsk(withState({ awaitingOther: 1 })).text
    expect(text.endsWith(' 3. Docs\n\n✏️ Ketik jawaban untuk pertanyaan 2 sebagai pesan biasa.')).toBe(true)
  })

  test('renders Markdown in the text and strips it from buttons', () => {
    const ask: Ask = {
      ...ask2,
      questions: [{ question: 'Mana **dulu**?', header: 'Pilih', multiSelect: false, options: [{ label: '🚀 *Rilis* _now_ [x](y)' }, { label: 'B <C>' }] }],
    }
    const { text, keyboard } = renderAsk(newState(ask))
    expect(text).toContain('<b>[1/1] Pilih:</b> Mana <b>dulu</b>?\n 1. 🚀 <i>Rilis</i> <i>now</i> [x](y)\n 2. B &lt;C&gt;')
    expect(keyboard[0]).toEqual([{ text: '1.1 🚀 Rilis now x', callback_data: 'abcdef:0:0' }])
  })

  test('renders a table in Claude context as an aligned block', () => {
    const text = renderAsk(newState({ ...ask2, context: 'Hasil:\n\n| A | B |\n|---|---|\n| 1 | 22 |' })).text
    expect(text).toContain('<b>Claude:</b>\nHasil:\n\n<pre>A │ B\n──┼───\n1 │ 22</pre>\n\n<b>[1/2]')
  })

  test('never contains an em dash or en dash', () => {
    const state = withState({ awaitingOther: 0, q: [{ picked: [0], done: true }, { picked: [1, 2], done: false }] })
    const all = renderAsk(state).text + renderAnswered(ask2, { 'Lanjut ke T2?': 'Ya', 'Cek apa saja?': 'Lint, Docs' }, 'telegram')
    expect(all).not.toContain('\u2014')
    expect(all).not.toContain('\u2013')
  })
})

describe('renderAsk length limits', () => {
  test('cuts a 3000-character context to 1500 characters ending in an ellipsis', () => {
    const text = renderAsk(newState({ ...ask2, context: 'c'.repeat(3000) })).text
    expect(text).toContain('<b>Claude:</b>\n' + 'c'.repeat(1499) + '…\n\n<b>[1/2]')
  })

  test('cuts the context further before touching descriptions', () => {
    const text = renderAsk(newState(bigAsk(3000, 150))).text
    expect(text.length).toBe(4096)
    expect(text).toContain('\n 1. Opsi 11 - ' + 'd'.repeat(150) + '\n')
    expect(text).toContain('\n 4. Opsi 44 - ' + 'd'.repeat(150))
    expect(text).not.toContain('c'.repeat(1400))
    expect(text).toContain('c…\n\n<b>[1/4]')
  })

  test('cuts option descriptions once the context alone cannot make it fit', () => {
    const text = renderAsk(newState(bigAsk(3000, 400))).text
    expect(text.length).toBeLessThanOrEqual(4096)
    for (const label of ['Opsi 11', 'Opsi 24', 'Opsi 33', 'Opsi 44']) expect(text).toContain(`${label} - d`)
    expect(text).not.toContain('d'.repeat(400))
    expect(text).toContain('<b>Claude:</b>\n…\n\n<b>[1/4]')
  })

  test('keeps every callback within 64 bytes for four questions of four options', () => {
    const { keyboard } = renderAsk(newState(bigAsk(10, 10)))
    const data = keyboard.flat().map((b) => b.callback_data)
    expect(data.length).toBe(4 + 4 * 4 + 4 + 1)
    expect(data.at(-1)).toBe('abcdef:0:s')
    for (const d of data) expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(64)
  })

  test('cuts a long button label to 64 characters', () => {
    const ask: Ask = { ...ask2, questions: [{ ...ask2.questions[0], options: [{ label: 'x'.repeat(70) }, { label: 'B' }] }] }
    const button = renderAsk(newState(ask)).keyboard[0][0]
    expect(button.text).toBe('1.1 ' + 'x'.repeat(59) + '…')
    expect(button.text.length).toBe(64)
  })
})

describe('renderAsk keyboard', () => {
  test('opens each section with a header row and ends with one Send for every multi-select question', () => {
    expect(renderAsk(newState(ask2)).keyboard).toEqual([
      [{ text: '━━ 1/2 · Gate ━━', callback_data: 'abcdef:0:h' }],
      [{ text: '1.1 Ya', callback_data: 'abcdef:0:0' }],
      [{ text: '1.2 Tidak', callback_data: 'abcdef:0:1' }],
      [{ text: '✏️ Lainnya', callback_data: 'abcdef:0:o' }],
      [{ text: '━━ 2/2 · Cek (pilih beberapa) ━━', callback_data: 'abcdef:1:h' }],
      [{ text: '2.1 Tes', callback_data: 'abcdef:1:0' }],
      [{ text: '2.2 Lint', callback_data: 'abcdef:1:1' }],
      [{ text: '2.3 Docs', callback_data: 'abcdef:1:2' }],
      [{ text: '✏️ Lainnya', callback_data: 'abcdef:1:o' }],
      [{ text: '📨 Kirim semua jawaban', callback_data: 'abcdef:0:s' }],
    ])
  })

  test('a single question gets no header row', () => {
    const one: Ask = { ...ask2, questions: [ask2.questions[1]] }
    expect(renderAsk(newState(one)).keyboard.flat().map((b) => b.text)).toEqual(['1.1 Tes', '1.2 Lint', '1.3 Docs', '✏️ Lainnya', '📨 Kirim'])
  })

  test('single-select questions only get no Send button', () => {
    const singles: Ask = { ...ask2, questions: [ask2.questions[0], { ...ask2.questions[0], question: 'Lagi?' }] }
    expect(renderAsk(newState(singles)).keyboard.flat().some((b) => b.callback_data.endsWith(':s'))).toBe(false)
  })

  test('marks picked options with a check', () => {
    const kb = renderAsk(withState({ q: [{ picked: [1], done: true }, { picked: [0, 2], done: false }] })).keyboard
    expect(kb.flat().map((b) => b.text)).toEqual([
      '━━ 1/2 · Gate ━━',
      '1.1 Ya',
      '✅ 1.2 Tidak',
      '✏️ Lainnya',
      '━━ 2/2 · Cek (pilih beberapa) ━━',
      '✅ 2.1 Tes',
      '2.2 Lint',
      '✅ 2.3 Docs',
      '✏️ Lainnya',
      '📨 Kirim semua jawaban',
    ])
  })

  test('marks Other with a check once its text is set', () => {
    const kb = renderAsk(withState({ q: [{ picked: [], other: 'Nanti', done: true }, { picked: [], done: false }] })).keyboard
    expect(kb[3]).toEqual([{ text: '✅ ✏️ Lainnya', callback_data: 'abcdef:0:o' }])
  })
})

describe('parseCallback', () => {
  test('parses an option tap', () => {
    expect(parseCallback('abcdef:1:2')).toEqual({ id: 'abcdef', q: 1, kind: 'option', option: 2 })
  })

  test('parses Send, Other and header taps', () => {
    expect(parseCallback('abcdef:3:s')).toEqual({ id: 'abcdef', q: 3, kind: 'send' })
    expect(parseCallback('abcdef:0:o')).toEqual({ id: 'abcdef', q: 0, kind: 'other' })
    expect(parseCallback('abcdef:2:h')).toEqual({ id: 'abcdef', q: 2, kind: 'header' })
  })

  test('returns null for malformed data', () => {
    for (const bad of ['', 'abcdef', 'abcdef:1', 'abcdef:1:2:3', 'abcde:1:2', 'abcdefg:1:2', 'ABCDEF:1:2', 'abc1ef:1:2', 'abcdef:x:2', 'abcdef:1:x', 'abcdef:-1:2', 'abcdef:1:2.5', 'abcdef::2', 'abcdef:1:']) {
      expect(parseCallback(bad)).toBeNull()
    }
  })
})

describe('applyTap', () => {
  test('ignores a tap for another ask id', () => {
    const state = newState(ask2)
    expect(applyTap(state, { id: 'zzzzzz', q: 0, kind: 'option', option: 0 })).toEqual(state)
  })

  test('ignores an out-of-range question or option', () => {
    const state = newState(ask2)
    expect(applyTap(state, { id: 'abcdef', q: 2, kind: 'option', option: 0 })).toEqual(state)
    expect(applyTap(state, { id: 'abcdef', q: 0, kind: 'option', option: 2 })).toEqual(state)
    expect(applyTap(state, { id: 'abcdef', q: 5, kind: 'other' })).toEqual(state)
  })

  test('a single-select option answers the question and clears Other', () => {
    const state = withState({ q: [{ picked: [], other: 'teks', done: true }, { picked: [], done: false }] })
    expect(applyTap(state, { id: 'abcdef', q: 0, kind: 'option', option: 1 }).q[0]).toEqual({ picked: [1], done: true })
  })

  test('never mutates the input state', () => {
    const state = newState(ask2)
    const before = structuredClone(state)
    applyTap(state, { id: 'abcdef', q: 1, kind: 'option', option: 2 })
    applyTap(state, { id: 'abcdef', q: 0, kind: 'other' })
    expect(state).toEqual(before)
  })

  test('a multi-select option toggles on and keeps picks sorted', () => {
    let state = newState(ask2)
    state = applyTap(state, { id: 'abcdef', q: 1, kind: 'option', option: 2 })
    state = applyTap(state, { id: 'abcdef', q: 1, kind: 'option', option: 0 })
    expect(state.q[1]).toEqual({ picked: [0, 2], done: false })
  })

  test('a multi-select option toggles off and reopens the question', () => {
    const state = withState({ q: [{ picked: [], done: false }, { picked: [0, 2], done: true }] })
    expect(applyTap(state, { id: 'abcdef', q: 1, kind: 'option', option: 0 }).q[1]).toEqual({ picked: [2], done: false })
  })

  test('Send answers a multi-select question that has picks', () => {
    const state = withState({ q: [{ picked: [], done: false }, { picked: [1], done: false }] })
    expect(applyTap(state, { id: 'abcdef', q: 1, kind: 'send' }).q[1]).toEqual({ picked: [1], done: true })
  })

  test('one Send answers every multi-select question that has picks, whatever its index', () => {
    const three: Ask = { ...ask2, questions: [ask2.questions[1], ask2.questions[0], { ...ask2.questions[1], question: 'Lagi?' }] }
    const state = withState({ q: [{ picked: [0], done: false }, { picked: [], done: false }, { picked: [], done: false }] }, three)
    const next = applyTap(state, { id: 'abcdef', q: 0, kind: 'send' })
    expect(next.q).toEqual([{ picked: [0], done: true }, { picked: [], done: false }, { picked: [], done: false }])
  })

  test('a header tap changes nothing', () => {
    const state = newState(ask2)
    expect(applyTap(state, { id: 'abcdef', q: 1, kind: 'header' })).toEqual(state)
  })

  test('Send with nothing picked changes nothing', () => {
    const state = newState(ask2)
    expect(applyTap(state, { id: 'abcdef', q: 1, kind: 'send' })).toEqual(state)
  })

  test('Send on a single-select question changes nothing', () => {
    const state = withState({ q: [{ picked: [0], done: false }, { picked: [], done: false }] })
    expect(applyTap(state, { id: 'abcdef', q: 0, kind: 'send' })).toEqual(state)
  })

  test('Other waits for typed text on that question', () => {
    expect(applyTap(newState(ask2), { id: 'abcdef', q: 1, kind: 'other' }).awaitingOther).toBe(1)
  })

  test('an option tap on the awaited question stops waiting for text', () => {
    const state = withState({ awaitingOther: 0 })
    expect(applyTap(state, { id: 'abcdef', q: 0, kind: 'option', option: 0 }).awaitingOther).toBeNull()
  })

  test('a tap on an answered question changes its answer', () => {
    const state = withState({ q: [{ picked: [0], done: true }, { picked: [], done: false }] })
    expect(applyTap(state, { id: 'abcdef', q: 0, kind: 'option', option: 1 }).q[0]).toEqual({ picked: [1], done: true })
  })
})

describe('applyText', () => {
  test('answers the awaited question with trimmed text', () => {
    const state = withState({ awaitingOther: 1, q: [{ picked: [], done: false }, { picked: [0], done: false }] })
    const next = applyText(state, '  Pakai *semua* 🚀 \n')
    expect(next.q[1]).toEqual({ picked: [], other: 'Pakai *semua* 🚀', done: true })
    expect(next.awaitingOther).toBeNull()
  })

  test('changes nothing when no question awaits text', () => {
    const state = newState(ask2)
    expect(applyText(state, 'halo')).toEqual(state)
  })

  test('changes nothing for blank text', () => {
    const state = withState({ awaitingOther: 0 })
    expect(applyText(state, '  \n ')).toEqual(state)
  })
})

describe('unanswered', () => {
  test('lists the 1-based numbers of questions not yet answered', () => {
    expect(unanswered(withState({ q: [{ picked: [0], done: true }, { picked: [], done: false }] }))).toEqual([2])
    expect(unanswered(withState({ q: [{ picked: [0], done: true }, { picked: [1], done: true }] }))).toEqual([])
  })
})

describe('answersIfComplete', () => {
  test('returns null while any question is unanswered', () => {
    expect(answersIfComplete(withState({ q: [{ picked: [0], done: true }, { picked: [1], done: false }] }))).toBeNull()
  })

  test('maps question text to labels joined by comma and space', () => {
    const state = withState({ q: [{ picked: [0], done: true }, { picked: [0, 2], done: true }] })
    expect(answersIfComplete(state)).toEqual({ 'Lanjut ke T2?': 'Ya', 'Cek apa saja?': 'Tes, Docs' })
  })

  test('uses Other text verbatim', () => {
    const state = withState({ q: [{ picked: [], other: 'Tunggu review dulu', done: true }, { picked: [1], done: true }] })
    expect(answersIfComplete(state)).toEqual({ 'Lanjut ke T2?': 'Tunggu review dulu', 'Cek apa saja?': 'Lint' })
  })
})

describe('renderAnswered', () => {
  const answers = { 'Lanjut ke T2?': 'Ya', 'Cek apa saja?': 'Tes, Docs' }

  test('lists answers and names Telegram', () => {
    expect(renderAnswered(ask2, answers, 'telegram')).toBe('🌾 vivera · telegram-ask\nGate: Ya\nCek: Tes, Docs\n✅ Dijawab lewat Telegram')
  })

  test('names the terminal', () => {
    expect(renderAnswered(ask2, answers, 'terminal')).toBe('🌾 vivera · telegram-ask\nGate: Ya\nCek: Tes, Docs\n✅ Dijawab di terminal')
  })

  test('shows a cancelled ask without answers', () => {
    expect(renderAnswered(ask2, {}, 'cancelled')).toBe('🌾 vivera · telegram-ask\n⛔ Dibatalkan')
  })
})
