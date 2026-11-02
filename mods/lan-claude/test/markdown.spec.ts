import { describe, expect, test } from "bun:test";
import { htmlToPlain, markdownToHtml } from "../src/markdown";

describe("markdown to Telegram HTML", () => {
  test("narrow table stays an aligned monospace block", () => {
    const html = markdownToHtml("| a | b |\n|---|---|\n| 1 | 22 |");
    expect(html).toBe("<pre>a │ b\n──┼───\n1 │ 22</pre>");
  });

  test("wide table becomes a per-row list with headers", () => {
    const html = markdownToHtml("| Cek | Hasil |\n|---|---|\n| Unit test dan typecheck | 27/27 lulus, tsc bersih |\n| Paste dua baris | **masuk** |");
    expect(html).toBe("▸ <b>Unit test dan typecheck</b>\n   Hasil: 27/27 lulus, tsc bersih\n▸ <b>Paste dua baris</b>\n   Hasil: masuk");
  });

  test("code fences, inline code, and HTML-looking text are escaped, not interpreted", () => {
    const html = markdownToHtml("Jalankan `bun test <file>`:\n```ts\nif (a < b && c) x()\n```");
    expect(html).toBe('Jalankan <code>bun test &lt;file&gt;</code>:\n<pre><code class="language-ts">if (a &lt; b &amp;&amp; c) x()</code></pre>');
    expect(htmlToPlain(html)).toContain("if (a < b && c) x()");
  });

  test("headings, bullets, bold, links", () => {
    expect(markdownToHtml("## Hasil\n- **oke** lihat [docs](https://x.dev/a_b)")).toBe('<b>Hasil</b>\n• <b>oke</b> lihat <a href="https://x.dev/a_b">docs</a>');
  });
});

import { countTableBlocks, countTables } from "../src/markdown";

describe("table counters", () => {
  test("countTables ignores code fences and counts each table once", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n```\n| x | y |\n|---|---|\n```\n\n| c |d|\n|:--|--:|\n| 3 | 4 |";
    expect(countTables(md)).toBe(2);
    expect(countTables("tidak ada | tabel di sini")).toBe(0);
  });

  test("countTableBlocks finds tables at any depth", () => {
    const rm = { blocks: [{ type: "paragraph" }, { type: "table", cells: [] }, { type: "list", items: [[{ type: "table" }]] }] };
    expect(countTableBlocks(rm)).toBe(2);
    expect(countTableBlocks(undefined)).toBe(0);
  });
});
