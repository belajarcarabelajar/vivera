---
title: Rendering Mermaid
description: Diagram dirender ke SVG secara lokal dengan mermaid-cli v12 yang di-pin sebelum setiap commit, karena workflow CI hanya berjalan lewat dispatch manual.
category: tooling
slug: mermaid-rendering
order: 1
source: README.md#Mermaid Rendering
source_hash: "079215061c52"
---

<a id="mermaid-rendering"></a>
# Rendering Mermaid

Diagram dirender ke SVG dengan [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) v12 yang di-pin (yang membundel mermaid 12, Node >= 22.13).

| Aspek | Cara penanganannya |
|---|---|
| Tema | `mermaid.config.json` (terang) dan `mermaid.dark.config.json` (gelap) adalah satu-satunya sumber kebenaran. Script render tidak pernah meneruskan `-t`. |
| Font | `Recursive Variable` di-pin agar mermaid menyematkannya di setiap SVG. Dengan begitu geometri label identik di GitHub, situs dokumentasi, dan ekspor PDF, alih-alih bergantung pada font mana dari Verdana/Arial/Trebuchet yang kebetulan dimiliki penampil. |
| Aksesibilitas | Setiap diagram membawa `accTitle` dan `accDescr`, yang dikeluarkan mermaid sebagai `<title>`/`<desc>` yang terhubung ke `aria-labelledby`. Validator menggagalkan build jika salah satunya tidak ada. |
| Duplikat | File symlink (`skills/*/SKILL.md`) dilewati, sehingga diagram di master file tidak dirender dua kali. |
| File yatim | SVG dari diagram yang sudah dihapus dipangkas di setiap run. Artefak basi lebih buruk daripada tidak ada artefak. |
| Run kosong | Tidak menemukan satu pun blok mermaid adalah kegagalan keras, bukan keberhasilan diam-diam. |
| Toolchain hilang | `mmdc` yang tidak ada menggagalkan validasi alih-alih melewati gate. Gate yang dilewati tetapi melaporkan sukses lebih buruk daripada tidak ada gate. |
| Mode gelap | Hero README dikirim dalam versi terang dan gelap, disajikan lewat `<picture>` dan `prefers-color-scheme`. |
| Drift | CI merender ulang dan gagal jika hero yang di-commit tidak lagi cocok dengan sumber Mermaid-nya. |
| Versi | Di-pin di `bun.lock` dan di-upgrade dengan sengaja. mermaid-cli 12 membundel mermaid 12 dan memerlukan Node >= 22.13. |

```bash
bun install                              # pinned toolchain
bun run render-diagrams                  # all blocks -> diagrams/
bun run validate                         # syntax + a11y + config + hero presence
bun test scripts/                        # unit tests for every script under scripts/
bun run ci                               # render, validate, agents check, size check, tests, snippet drift check
```

Perintah-perintah ini dijalankan **secara lokal, oleh Anda, sebelum commit**, bukan di hosted
runner. Ada dua alasan, dan alasan kedua yang paling penting:

1. Menit GitHub Actions di tier gratis adalah sumber daya yang langka di sini, sehingga workflow
   di `.github/workflows/ci.yml` hanya memakai `workflow_dispatch` atas kebijakan eksplisit
   pengguna. Workflow itu tidak punya trigger `push` atau `pull_request`, dan tidak boleh
   ditambahi. Header file tersebut memuat alasannya beserta langkah revert yang persis.
2. Hosted runner tidak dapat melihat vault Anda, database Snipset Anda, atau working tree Anda.
   Runner itu hanya dapat memeriksa subset yang portabel, sehingga hasil hijau dari remote adalah
   bukti yang lebih lemah daripada perintah yang sama yang dijalankan secara lokal, bukan lebih kuat.

> Hanya `diagrams/lifecycle.svg` dan `diagrams/lifecycle-dark.svg` yang di-commit. Setiap
> SVG lain di bawah `diagrams/` adalah artefak build yang diregenerasi oleh langkah render dan
> dipangkas oleh gate: GitHub merender blok kode Mermaid secara native, sehingga meng-commit-nya
> hanya menambah output duplikat berukuran megabyte tanpa ada yang membacanya. Jumlah pastinya
> berubah seiring bertambahnya template, itulah sebabnya angka itu tidak ditulis di sini.

<a id="why-the-font-is-embedded"></a>
## Mengapa font disematkan

mermaid-cli 12 menyisipkan font diagram secara inline sebagai blok `@font-face` base64, itulah
sebabnya setiap SVG hasil render berukuran sekitar 200 KB, bukan 12 KB. Itu kompromi yang
disengaja. Tanpa penyematan, mermaid mengukur lebar label berdasarkan font apa pun yang kebetulan
dimiliki renderer, dan penampil dengan metrik font yang lebih lebar daripada mesin build akan
diam-diam mengalirkan ulang (re-flow) atau memotong label. Penyematan membuat geometri identik di
GitHub, di situs dokumentasi, dan di ekspor PDF.

`Recursive Variable` lebih dipilih daripada `Open Sans` dengan alasan yang sama yang membuat
mermaid sendiri merekomendasikannya: font ini adalah variable font, sehingga 4 face mencakup semua
ketebalan, sedangkan Open Sans menyematkan 20 face dan menggandakan ukuran file. Teruskan
`--no-font-embed` hanya jika Anda menerima pergeseran label yang berbeda per penampil.
