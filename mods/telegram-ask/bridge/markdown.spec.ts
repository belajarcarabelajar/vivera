import { describe, expect, test } from 'bun:test'
import { escapeHtml, htmlToPlain, inlineMarkdown, markdownToHtml, stripMarkdown } from './markdown'

describe('escapeHtml', () => {
  test('escapes the three characters Telegram HTML reserves', () => {
    expect(escapeHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d')
  })
})

describe('inlineMarkdown', () => {
  test('renders bold, italic, strikethrough, code and links', () => {
    expect(inlineMarkdown('**tebal** dan *miring* dan _juga_ ~~coret~~ `kode` [situs](https://x.dev/a_b_c)')).toBe(
      '<b>tebal</b> dan <i>miring</i> dan <i>juga</i> <s>coret</s> <code>kode</code> <a href="https://x.dev/a_b_c">situs</a>',
    )
  })

  test('leaves snake_case and lone asterisks alone', () => {
    expect(inlineMarkdown('pakai snake_case_name dan 2 * 3 * 4')).toBe('pakai snake_case_name dan 2 * 3 * 4')
  })

  test('escapes HTML inside text and code', () => {
    expect(inlineMarkdown('a <b> `x < y`')).toBe('a &lt;b&gt; <code>x &lt; y</code>')
  })

  test('keeps unbalanced markers literal', () => {
    expect(inlineMarkdown('**belum ditutup')).toBe('**belum ditutup')
  })
})

describe('stripMarkdown', () => {
  test('drops inline markers for plain contexts such as buttons and table cells', () => {
    expect(stripMarkdown('🚀 **Rilis** _now_ `v2` [x](https://y.dev)')).toBe('🚀 Rilis now v2 x')
  })
})

describe('markdownToHtml', () => {
  test('turns a table into an aligned monospace block', () => {
    const md = ['| Nama | Status |', '|---|:---:|', '| **bridge** | aktif |', '| hook | `ok` |'].join('\n')
    expect(markdownToHtml(md)).toBe(
      ['<pre>Nama   │ Status', '───────┼───────', 'bridge │ aktif', 'hook   │ ok</pre>'].join('\n'),
    )
  })

  test('accepts a table without outer pipes', () => {
    expect(markdownToHtml('a | b\n--|--\n1 | 2')).toBe('<pre>a │ b\n──┼──\n1 │ 2</pre>')
  })

  test('renders fenced code with its language and escapes it', () => {
    expect(markdownToHtml('```ts\nconst a = 1 < 2\n```')).toBe('<pre><code class="language-ts">const a = 1 &lt; 2</code></pre>')
  })

  test('closes a fence cut off before its end', () => {
    expect(markdownToHtml('teks\n```\nkode yang terpotong')).toBe('teks\n<pre>kode yang terpotong</pre>')
  })

  test('renders headings bold, lists as bullets, quotes and rules', () => {
    const md = ['## Ringkasan', '- satu', '  * dua', '1. tetap', '> dikutip', '> lagi', '---', 'akhir'].join('\n')
    expect(markdownToHtml(md)).toBe(
      ['<b>Ringkasan</b>', '• satu', '  • dua', '1. tetap', '<blockquote>dikutip\nlagi</blockquote>', '──────────', 'akhir'].join('\n'),
    )
  })
})

describe('htmlToPlain', () => {
  test('drops tags and unescapes entities', () => {
    expect(htmlToPlain('<b>a</b> &lt;b&gt; &amp; <a href="https://x">y</a>')).toBe('a <b> & y')
  })
})
