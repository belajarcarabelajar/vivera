// Fallback renderer (sendRichMessage is tried first, see telegram.ts sendRich). Copied from vivera
// mods/telegram-ask/bridge/markdown.ts (2026-11-02, same author); vivera stays untouched.
// Change: a table wider than a phone screen (TABLE_MAX_WIDTH) becomes a per-row list instead of a
// monospace block, which wraps badly on a phone.
// Markdown to Telegram HTML (parse_mode "HTML"). Telegram renders only a few
// tags (b, i, s, code, pre, a, blockquote), so headings become bold, lists
// become bullets, and tables, which Telegram cannot draw, become an aligned
// monospace block. Anything that does not parse as Markdown stays literal text.

const SLOT = '\u0000'

// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

// Code spans and links are set aside first, so markers inside them (a_b_c in a
// URL, * in code) are never read as emphasis.
// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
function withSlots(src: string, render: (slots: string[], text: string) => string, code: (c: string) => string, link: (t: string, u: string) => string): string {
  const slots: string[] = []
  const keep = (html: string) => `${SLOT}${slots.push(html) - 1}${SLOT}`
  const text = src
    .replace(/`([^`\n]+)`/g, (_, c: string) => keep(code(c)))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => keep(link(t, u)))
  return render(slots, text).replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, 'g'), (_, i: string) => slots[Number(i)])
}

// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
function emphasis(s: string, b: (x: string) => string, i: (x: string) => string, st: (x: string) => string): string {
  return s
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, (_, x: string) => b(x))
    .replace(/__(?=\S)([^_\n]*?\S)__/g, (_, x: string) => b(x))
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, (_, p: string, x: string) => p + i(x))
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, (_, p: string, x: string) => p + i(x))
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, (_, x: string) => st(x))
}

// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
export function inlineMarkdown(src: string): string {
  return withSlots(
    src,
    (_, text) => emphasis(escapeHtml(text), (x) => `<b>${x}</b>`, (x) => `<i>${x}</i>`, (x) => `<s>${x}</s>`),
    (c) => `<code>${escapeHtml(c)}</code>`,
    (t, u) => (/^https?:\/\//.test(u) ? `<a href="${escapeHtml(u).replace(/"/g, '&quot;')}">${inlineMarkdown(t)}</a>` : escapeHtml(`[${t}](${u})`)),
  )
}

// Plain text with the inline markers dropped, for button labels and table cells.
// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
export function stripMarkdown(src: string): string {
  return withSlots(src, (_, text) => emphasis(text, (x) => x, (x) => x, (x) => x), (c) => c, (t) => stripMarkdown(t))
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => stripMarkdown(c.trim()))
}

// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
function width(s: string): number {
  return Array.from(s).length
}

/** Widest table (characters per line) still drawn as a monospace block; wider ones become a list. */
export const TABLE_MAX_WIDTH = 38

function renderTableAsList(rows: string[][]): string {
  const [head, ...body] = rows
  return body
    .map((r) => {
      const title = `▸ <b>${escapeHtml(r[0] ?? '')}</b>`
      const rest = r.slice(1).map((cell, k) => `   ${escapeHtml(head[k + 1] ?? '')}: ${escapeHtml(cell)}`)
      return [title, ...rest].join('\n')
    })
    .join('\n')
}

// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length))
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => width(r[c] ?? ''))))
  const total = widths.reduce((a, w) => a + w, 0) + 3 * (cols - 1)
  if (total > TABLE_MAX_WIDTH && rows.length > 1 && cols > 1) return renderTableAsList(rows)
  const line = (r: string[]) =>
    widths
      .map((w, c) => {
        const cell = r[c] ?? ''
        return c === cols - 1 ? cell : cell + ' '.repeat(w - width(cell))
      })
      .join(' │ ')
      .trimEnd()
  const sep = widths.map((w) => '─'.repeat(w)).join('─┼─')
  const [head, ...body] = rows
  return `<pre>${escapeHtml([line(head), sep, ...body.map(line)].join('\n'))}</pre>`
}

// dup-defs: allow forked from mods/telegram-ask/bridge/markdown.ts, wide tables become row lists
export function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i].trim() === fence[1])) body.push(lines[i++])
      i++
      const code = escapeHtml(body.join('\n'))
      out.push(fence[2] ? `<pre><code class="language-${fence[2]}">${code}</code></pre>` : `<pre>${code}</pre>`)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const rows = [cells(line)]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      out.push(renderTable(rows))
      continue
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(inlineMarkdown(QUOTE.exec(lines[i++])![1]))
      out.push(`<blockquote>${quoted.join('\n')}</blockquote>`)
      continue
    }
    const heading = HEADING.exec(line)
    const bullet = BULLET.exec(line)
    if (heading) out.push(`<b>${inlineMarkdown(heading[1])}</b>`)
    else if (RULE.test(line)) out.push('──────────')
    else if (bullet) out.push(`${bullet[1]}• ${inlineMarkdown(bullet[2])}`)
    else out.push(inlineMarkdown(line))
    i++
  }
  return out.join('\n')
}

/** Number of Markdown tables in `md` (header line + separator line), ignoring fenced code. */
export function countTables(md: string): number {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i])
    if (fence) {
      i++
      while (i < lines.length && lines[i].trim() !== fence[1]) i++
      continue
    }
    if (lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      n++
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) i++
      i--
    }
  }
  return n
}

/** Number of blocks of type "table" anywhere in the rich_message Telegram returned (nested ones too). */
export function countTableBlocks(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((a: number, x) => a + countTableBlocks(x), 0)
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    return (o.type === 'table' ? 1 : 0) + Object.values(o).reduce((a: number, x) => a + countTableBlocks(x), 0)
  }
  return 0
}
