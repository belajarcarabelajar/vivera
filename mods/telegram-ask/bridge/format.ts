export type Option = { label: string; description?: string; preview?: string }
export type Question = { question: string; header: string; options: Option[]; multiSelect: boolean }
export type Ask = { id: string; project: string; session: string; context: string; questions: Question[] }
export type QState = { picked: number[]; other?: string; done: boolean }
export type AskState = { ask: Ask; q: QState[]; awaitingOther: number | null }
export type Tap =
  | { id: string; q: number; kind: 'option'; option: number }
  | { id: string; q: number; kind: 'send' }
  | { id: string; q: number; kind: 'other' }
export type Button = { text: string; callback_data: string }

// Telegram limits: message text and button text in characters (JS length is
// UTF-16 units, never fewer than Telegram's count), callback data in bytes.
const MAX_TEXT = 4096
const MAX_CONTEXT = 1500
const MAX_BUTTON = 64

const ID_RE = /^[a-z]{6}$/
const INDEX_RE = /^(0|[1-9]\d{0,2})$/

function cut(s: string, max: number): string {
  if (s.length <= max) return s
  let end = Math.max(0, max - 1)
  // Do not split a surrogate pair, which would leave an invalid character.
  const code = s.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--
  return s.slice(0, end) + '…'
}

export function newAskId(rand: () => number = Math.random): string {
  let id = ''
  for (let i = 0; i < 6; i++) id += String.fromCharCode(97 + Math.min(25, Math.floor(rand() * 26)))
  return id
}

export function newState(ask: Ask): AskState {
  return { ask, q: ask.questions.map(() => ({ picked: [], done: false })), awaitingOther: null }
}

function headerLine(ask: Ask): string {
  return `🌾 ${ask.project} · ${ask.session}`
}

function buildText(state: AskState, contextMax: number, descMax: number | null): string {
  const { ask } = state
  const lines = [headerLine(ask)]
  const context = ask.context.trim()
  if (context) lines.push('Claude:', cut(context, contextMax))
  const total = ask.questions.length
  ask.questions.forEach((q, n) => {
    lines.push('', `[${n + 1}/${total}] ${q.header}: ${q.question}${q.multiSelect ? ' (pilih beberapa)' : ''}`)
    q.options.forEach((o, i) => {
      const desc = o.description && descMax !== null ? ` - ${cut(o.description, descMax)}` : ''
      lines.push(` ${i + 1}. ${o.label}${desc}`)
    })
  })
  if (state.awaitingOther !== null) {
    lines.push('', `✏️ Ketik jawaban untuk pertanyaan ${state.awaitingOther + 1} sebagai pesan biasa.`)
  }
  return lines.join('\n')
}

function fitText(state: AskState): string {
  const longestDesc = Math.max(0, ...state.ask.questions.flatMap((q) => q.options.map((o) => o.description?.length ?? 0)))
  let contextMax = MAX_CONTEXT
  let text = buildText(state, contextMax, longestDesc)
  while (text.length > MAX_TEXT && contextMax > 1) {
    const shown = Math.min(contextMax, state.ask.context.trim().length)
    contextMax = Math.max(1, Math.min(contextMax - 1, shown - (text.length - MAX_TEXT)))
    text = buildText(state, contextMax, longestDesc)
  }
  if (text.length <= MAX_TEXT) return text
  // Largest uniform description length that still fits; null drops them all.
  let lo = 1
  let hi = longestDesc
  let best: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (buildText(state, contextMax, mid).length <= MAX_TEXT) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return cut(buildText(state, contextMax, best), MAX_TEXT)
}

export function renderAsk(state: AskState): { text: string; keyboard: Button[][] } {
  const { ask } = state
  const keyboard: Button[][] = []
  ask.questions.forEach((q, n) => {
    const qs = state.q[n]
    q.options.forEach((o, i) => {
      const mark = qs?.picked.includes(i) ? '✅ ' : ''
      keyboard.push([{ text: cut(`${mark}${n + 1}.${i + 1} ${o.label}`, MAX_BUTTON), callback_data: `${ask.id}:${n}:${i}` }])
    })
    const row: Button[] = [{ text: qs?.other !== undefined ? '✅ ✏️ Lainnya' : '✏️ Lainnya', callback_data: `${ask.id}:${n}:o` }]
    if (q.multiSelect) row.push({ text: 'Kirim', callback_data: `${ask.id}:${n}:s` })
    keyboard.push(row)
  })
  return { text: fitText(state), keyboard }
}

export function parseCallback(data: string): Tap | null {
  const parts = data.split(':')
  if (parts.length !== 3) return null
  const [id, qs, os] = parts
  if (!ID_RE.test(id) || !INDEX_RE.test(qs)) return null
  const q = Number(qs)
  if (os === 's') return { id, q, kind: 'send' }
  if (os === 'o') return { id, q, kind: 'other' }
  if (!INDEX_RE.test(os)) return null
  return { id, q, kind: 'option', option: Number(os) }
}

function withQuestion(state: AskState, n: number, qs: QState, awaitingOther: number | null): AskState {
  return { ...state, q: state.q.map((old, i) => (i === n ? qs : old)), awaitingOther }
}

export function applyTap(state: AskState, tap: Tap): AskState {
  const question = state.ask.questions[tap.q]
  const current = state.q[tap.q]
  if (tap.id !== state.ask.id || !question || !current) return state
  const awaiting = state.awaitingOther === tap.q ? null : state.awaitingOther
  if (tap.kind === 'other') return { ...state, awaitingOther: tap.q }
  if (tap.kind === 'send') {
    if (!question.multiSelect || current.picked.length === 0) return state
    return withQuestion(state, tap.q, { picked: [...current.picked], done: true }, awaiting)
  }
  if (tap.option < 0 || tap.option >= question.options.length) return state
  if (!question.multiSelect) return withQuestion(state, tap.q, { picked: [tap.option], done: true }, awaiting)
  const picked = current.picked.includes(tap.option)
    ? current.picked.filter((i) => i !== tap.option)
    : [...current.picked, tap.option].sort((a, b) => a - b)
  return withQuestion(state, tap.q, { picked, done: false }, awaiting)
}

export function applyText(state: AskState, text: string): AskState {
  const other = text.trim()
  if (state.awaitingOther === null || !other || !state.q[state.awaitingOther]) return state
  return withQuestion(state, state.awaitingOther, { picked: [], other, done: true }, null)
}

export function answersIfComplete(state: AskState): Record<string, string> | null {
  if (!state.q.every((qs) => qs.done)) return null
  const answers: Record<string, string> = {}
  state.ask.questions.forEach((q, n) => {
    const qs = state.q[n]
    // The engine's own dialog joins multi-select labels with ", ".
    answers[q.question] = qs.other ?? qs.picked.map((i) => q.options[i].label).join(', ')
  })
  return answers
}

export function renderAnswered(ask: Ask, answers: Record<string, string>, by: 'telegram' | 'terminal' | 'cancelled'): string {
  const footer = by === 'telegram' ? '✅ Dijawab lewat Telegram' : by === 'terminal' ? '✅ Dijawab di terminal' : '⛔ Dibatalkan'
  const lines = ask.questions.filter((q) => Object.hasOwn(answers, q.question)).map((q) => `${q.header}: ${answers[q.question]}`)
  const head = headerLine(ask) + '\n'
  if (lines.length === 0) return head + footer
  return head + cut(lines.join('\n'), MAX_TEXT - head.length - footer.length - 1) + '\n' + footer
}
