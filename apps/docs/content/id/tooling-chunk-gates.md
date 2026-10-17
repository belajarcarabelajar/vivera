---
title: Gerbang Kualitas Chunk Vault
description: Script yang memeriksa korpus chunk semantik, termasuk memastikan setiap anchor [path:LN] menunjuk ke baris nyata yang memuat kata-kata kutipan secara verbatim.
category: tooling
slug: chunk-gates
order: 7
source: README.md#Vault Chunk Quality Gates
source_hash: "d7195b907c72"
---

<a id="vault-chunk-quality-gates"></a>
# Gerbang Kualitas Chunk Vault

Script untuk menjaga kebenaran korpus chunk `vault-index/semantic/` yang dihasilkan oleh pipeline subagent vault-indexing.

<a id="anchor-audit-scriptscheck-anchorsmjs"></a>
## Audit Anchor (`scripts/check-anchors.mjs`)

Memverifikasi bahwa setiap anchor `[path:LN]` dalam chunk semantik menunjuk ke baris nyata yang memuat kata-kata kutipan secara verbatim. Ada empat mode kegagalan senyap yang dicegahnya: zero-count yang hampa (bracket yang tidak seimbang menelan pola), kutipan rekaan (kata kunci yang tumpang tindih ≠ verbatim), padding harness sintetis (kutipan yang diambil dari blok `session-event: synthetic`), dan sisi anchor yang salah (komentar diletakkan sebelum `[path:LN]`, bukan sesudahnya).

```bash
bun scripts/check-anchors.mjs rem-154          # one chunk, exit 1 on any failure
bun scripts/check-anchors.mjs --all            # full corpus, report only
bun scripts/check-anchors.mjs --all --quiet    # only chunks with failures
```

Pemindaian anchor melacak kedalaman `[` `]`, karena grup `[ses_…]` di ujung sebuah path harus tertutup lebih dulu sebelum anchor-nya tertutup. Dulu pelacakan itu berjalan maju dari setiap `[` untuk mencari penutupnya. Cara itu benar tetapi **kuadratik**: satu `[` yang tidak seimbang membuat penelusuran berjalan sampai ujung string, dan `[` berikutnya mengulang perjalanan yang sama. Pengukuran dilakukan pada `text [more words here and there\n` yang diulang-ulang (prosa biasa dengan satu bracket tanpa penutup, yang memang seperti itulah wujud catatan sesi penuh link markdown ketika bracket penutupnya berada di luar rentang kutipan):

| Input | Lama | Baru |
|---|---|---|
| 63 KB | 123 ms | 2,3 ms |
| 125 KB | 759 ms | 8,1 ms |
| 250 KB | **3032 ms** | 1,4 ms |
| 200 KB, sepenuhnya tidak seimbang | **96 s** | tidak dicatat |

Stack bracket menjawab pertanyaan yang sama dalam satu kali lintasan dan setara secara konstruksi: `]` yang membawa kedalaman ke 0 dari posisi `i` tepat merupakan bracket pasangan `i` menurut pencocokan standar. `scripts/check-anchors-perf.test.mjs` memverifikasi kesetaraan itu pada korpus berisi 22 kasus **dan** mengukur ulang kontrol kuadratiknya, sehingga klaim ini tetap bisa difalsifikasi alih-alih hanya menjadi komentar.

<a id="anchor-repair-scriptsrepair-anchorsmjs"></a>
## Perbaikan Anchor (`scripts/repair-anchors.mjs`)

Memperbaiki secara otomatis anchor pra-§4a yang gagal dalam uji verbatim, dengan strategi bertingkat:

| Tier | Strategi |
|---|---|
| T1 | Kutipan memang verbatim di suatu tempat dalam file: tulis ulang anchor ke nomor baris yang benar. |
| T2 | Kutipan membentang di dua baris berturut-turut: pecah menjadi dua anchor sesuai §4a. |
| T3 | Kutipan tidak ada, tetapi `source_location` menyebut baris pendukung: ganti dengan potongan verbatim. |
| T4 | Tidak ada yang bisa diverifikasi: **dibiarkan dan dilaporkan, tidak pernah ditebak.** |

```bash
bun scripts/repair-anchors.mjs --survey            # tier counts, no writes
bun scripts/repair-anchors.mjs --tier 1 --apply    # rewrite correct line numbers
bun scripts/repair-anchors.mjs --chunk 037 --apply # one chunk, any tier
```

<a id="chunk-validation--acceptance-scriptsverify-chunksh-scriptsaccept-chunkssh"></a>
## Validasi & Penerimaan Chunk (`scripts/verify-chunk.sh`, `scripts/accept-chunks.sh`)

Helper gather-and-synthesize di sisi parent:

```bash
./scripts/verify-chunk.sh rem-090              # validate one chunk with cross-chunk link resolution
./scripts/accept-chunks.sh rem-127 075         # dry run: gate + structural diff
./scripts/accept-chunks.sh --commit -m 'msg' rem-127
./scripts/accept-chunks.sh --commit            # all dirty chunks
```

`accept-chunks.sh` memastikan node id, urutan, dan array links sama dengan HEAD, kecuali chunk tersebut mendeklarasikan penghapusan case-3, satu-satunya perubahan yang boleh mengubah struktur.
