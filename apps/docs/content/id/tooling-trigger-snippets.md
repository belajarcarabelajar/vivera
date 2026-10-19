---
title: Snippet Pemicu
description: Prompt siap salin-tempel di snippets/ untuk enam titik masuk workflow, seperti brainstorm, plan, dan debugging, masing-masing dengan keyword singkat.
category: tooling
slug: trigger-snippets
order: 2
source: docs/guide/tooling-trigger-snippets-1.md
source_hash: "83acc775150d"
---

<a id="trigger-snippets"></a>
# Snippet Pemicu

Prompt siap salin-tempel untuk enam titik masuk workflow. Semuanya ada di
[`snippets/`](https://github.com/belajarcarabelajar/vivera/tree/main/snippets) dan merupakan cara tercepat untuk mengaktifkan skill dengan benar.

- **[`orkestrasi-brainstorm.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/orkestrasi-brainstorm.md)** (keyword: `brn`): wawancara brainstorm yang terus menggali sampai semuanya terkunci, SEBELUM plan apa pun dibuat: berpijak pada repositori, memunculkan trade-off lewat question tool milik harness, dan mengunci task A/B/C/D ke dalam artefak intent yang disetujui.
- **[`orkestrasi-ngoding-plan.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/orkestrasi-ngoding-plan.md)** (keyword: `;`): pembuatan plan, eksekusi TDD, dan pipeline subagent wajib.
- **[`orkestrasi-debugging.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/orkestrasi-debugging.md)** (keyword: `;,`): analisis akar masalah (root cause analysis) dengan investigasi hipotesis secara paralel, dan pipeline subagent wajib.
- **[`orkestrasi-pr.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/orkestrasi-pr.md)** (keyword: `;;,`): pengiriman PR dari sesi yang sudah selesai, review PR, dan batch merge yang berurutan.
- **[`orkestrasi-overnight.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/orkestrasi-overnight.md)** (keyword: `ovn`): membawa plan yang sudah disetujui sampai menjadi PR terverifikasi selagi Anda pergi. Targetnya diambil dari `#{clipboard}`: salin path plan yang disetujui. Ada entry gate, retry budget, larangan merge (never-merge), dan file serah terima pagi (morning handoff).
- **[`orkestrasi-pr-review.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/orkestrasi-pr-review.md)** (keyword: `prr`): review PR remote yang berdiri sendiri, temuan yang ditambatkan ke baris, tabel cakupan, dan verdict biner; merge ke main hanya jika sudah diotorisasi sebelumnya dan semua gate lolos. Targetnya diambil dari `#{clipboard}`: salin satu URL PR untuk satu review, atau beberapa URL (satu per baris) untuk batch berukuran berapa pun.

<a id="command-snippets"></a>
## Snippet perintah

Prompt pendek untuk momen di antara keenam titik masuk: mengotorisasi merge,
melanjutkan setelah kegagalan, menjawab check-in, melanjutkan sesi (resume), dan
bersih-bersih. Masing-masing berupa satu paragraf, tidak membawa kontrak subagent
(karena dijalankan di dalam sesi yang sudah memilikinya), dan dicatat di manifest
seperti snippet yang besar.

| Keyword | File | Gunakan untuk |
|---|---|---|
| `mrg` | [`cmd-merge.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-merge.md) | mengotorisasi merge PR sesi ini ke main; gate diukur ulang, tidak pernah `--admin` atau `--force` |
| `err` | [`cmd-error-continue.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-error-continue.md) | terus berjalan setelah kegagalan: 2 percobaan per chunk, lalu diparkir sebagai `blocked` |
| `apv` | [`cmd-approved.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-approved.md) | menjawab check-in "boleh saya lanjutkan?" di dalam cakupan yang sudah disetujui |
| `dnn` | [`cmd-done-verify.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-done-verify.md) | melaporkan bahwa langkah manual sudah selesai; agent mengukur sendiri alih-alih percaya begitu saja |
| `sts` | [`cmd-status.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-status.md) | tabel status read-only: plan, PR, job yang sedang berjalan |
| `rsm` | [`cmd-resume.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-resume.md) | melanjutkan dari file plan setelah compaction, `/clear`, atau giliran yang terputus |
| `cln` | [`cmd-cleanup.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-cleanup.md) | menghapus worktree yang sudah di-merge dan branch lokal milik sesi ini, berdasarkan PID, tidak pernah `rm -rf` |
| `aud` | [`cmd-audit.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-audit.md) | audit read-only dengan usulan berperingkat dan jalur revert |
| `prm` | [`cmd-review-merge.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-review-merge.md) | diketik setelah `prr`: pra-otorisasi yang memungkinkannya me-merge PR yang aman |
| `fbk` | [`cmd-fallback.md`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets/cmd-fallback.md) | tangga fallback saat sebuah tool gagal; jangan pernah menukar run remote dengan run lokal |

`mrg` mengotorisasi merge dan tidak lebih: tidak ada deploy, tidak ada cleanup. Cleanup
adalah `cln`, tindakan yang terpisah. Batalkan slot mana pun dengan `snipset snippet delete <uuid>`
(uuid-nya ada di `snippets.manifest.json`), lalu hapus entri manifest dan file sumbernya.

<a id="clipboard-driven-review-targets"></a>
## Target review dari clipboard

`orkestrasi-pr-review.md` mengambil targetnya dari `#{clipboard}`, yang disubstitusi oleh
Snipset saat ekspansi. Satu URL me-review satu PR; beberapa URL (satu per baris) me-review satu batch:

```bash
snipset snippet expand --by-keyword prr \
  --clipboard "https://github.com/owner/repo/pull/42"

# a batch
snipset snippet expand --by-keyword prr --clipboard "$(gh pr list --json url --jq '.[].url' | tr '\n' ' ')"
```

Bentuk yang diterima: URL PR lengkap, `#123`, atau `owner/repo#123`. Nilai tanpa
target yang bisa dikenali berarti **berhenti**, tidak pernah menebak nomor yang
berdekatan dan tidak pernah fallback ke apa pun yang pertama kali ditampilkan `gh pr list`.

Perilaku batch ditetapkan secara eksplisit, bukan dibiarkan ditafsirkan sendiri oleh
agent yang membaca jumlah target lebih besar. Satu verdict per PR, tidak pernah satu
verdict untuk seluruh batch. Fan-out memecah chunk per `(PR, coverage category)`
sehingga tidak ada dua subagent yang berbagi sel. Merge tetap berurutan secara ketat
meskipun review berjalan paralel, dengan fetch dan pemeriksaan lokal setelah setiap
merge. Pra-otorisasi berlaku untuk setiap PR dalam daftar secara terpisah, jadi
me-merge PR pertama tidak mengotorisasi PR kedua. Satu PR yang tidak bisa dijangkau
dicatat sebagai `not reviewed` dan batch tetap berlanjut.

<a id="copy-rules-no-em-dash-no-attribution-footer"></a>
## Aturan teks: tanpa em dash, tanpa footer atribusi

Dua aturan tentang teks yang dirilis repositori ini, ditegakkan oleh
`bun run copy:check` dan diverifikasi pada setiap `bun run ci`:

```bash
bun run copy:check <file>...        # check an artifact (a PR body, a doc)
bun run copy:check --commits [N]    # check the last N commit messages
```

Checker membaca repositori tempat perintah dijalankan: `--diff` dan `--commits`
memakai git toplevel dari direktori saat ini dan keluar dengan kode 2 di luar
repositori, sedangkan path file di-resolve terhadap direktori saat ini. `bun run copy:check`
selalu berjalan dari root repositori ini, jadi untuk memeriksa repositori lain, panggil
script-nya di sana: `cd <repo> && bun <vivera>/scripts/check-copy-rules.mjs --diff origin/main`.

| Aturan | Pola |
|---|---|
| Tanpa em dash | U+2014 dalam prosa yang terlihat oleh pengguna |
| Tanpa footer atribusi | `Generated with <tool>`, badge kredit `🤖`, `Co-Authored-By:`, `Signed-off-by:` |
| Tanpa prefix tool pada nama branch (aturan atribusi yang sama, untuk teks yang dihasilkan) | `pr-registry.mjs claim` menurunkan `<plan-id>/<session-slug>` |

Aturan kedua ada karena PR #15 pada 2026-10-04, ketika footer
`Generated with [Claude Code]` ditambahkan ke body PR padahal tidak ada template,
instruksi, maupun satu pun dari tujuh PR lain di repositori ini yang mendukungnya,
dalam sesi yang bukan Claude Code. Footer itu menerbitkan klaim palsu tentang
kepengarangan dalam artefak publik yang permanen. Kedua aturan sebenarnya sudah ada
sebagai prosa; aturan em dash ada di master skill dan di checklist template PR, tetapi
69 em dash tetap lolos dalam satu diff. Aturan yang hanya ada sebagai prosa tidak
bisa menghentikan apa pun.

Dua keputusan cakupan, keduanya dipaksa oleh hasil menjalankan checker, bukan
sekadar membacanya:

**Pola mencocokkan BENTUK atribusi, bukan nama tool.** Versi pertama juga
mencocokkan nama vendor polos dan langsung menandai tabel harness di README, yang
memang sah mencantumkan Claude Code dan Copilot, ditambah node mermaid yang berbunyi
`🤖 Subagents execute`. Itu bukan atribusi. Gate yang menyala untuk hal semacam itu
lama-lama dianggap noise, dan gate yang berisik melaporkan sukses sambil tidak
memeriksa apa-apa. `Generated with X` adalah atribusi apa pun X-nya; nama tool polos
bukan atribusi.

**Riwayat git tidak dipindai oleh CI.** Versi sebelumnya memeriksa 20 pesan commit
terakhir dan gagal pada dua commit dari sesi sebelumnya, yang bukan tugas CI untuk
diperbaiki dan akan membuat gate merah selamanya karena riwayat yang tidak akan ditulis
ulang oleh siapa pun. Jalankan `bun run copy:check --commits` pada commit Anda sendiri
sebelum push, sehingga setiap temuan memang temuan pada pekerjaan yang baru Anda hasilkan.

**Aturan nama branch butuh gate yang berbeda, karena namanya dihasilkan.**
Daftar pola di atas hanya bisa menangkap teks yang diketik seseorang, sedangkan nama
branch dicetak oleh `pr-registry.mjs claim`, bukan ditulis tangan. Jadi gate-nya adalah
`bun run validate`: ia memanggil `branchFor` dan membandingkan hasilnya dengan bentuk
yang didokumentasikan master skill, sehingga langsung gagal begitu sebuah prefix
dikembalikan. `pr-registry.mjs` dulu menurunkan `ai/<plan-id>/<session-slug>`. Nama
branch adalah riwayat repositori yang permanen dan bisa dibaca publik, jadi prefix itu
merupakan klaim kepengarangan di satu-satunya artefak yang tidak bisa disunting siapa
pun setelahnya, dan prefix itu dihapus atas dasar tersebut. Slot yang diklaim sebelum
perubahan ini tetap memakai branch yang sudah mereka klaim, jadi tidak ada migrasi dan
tidak ada rename yang perlu dibatalkan.

Baris yang menyatakan sebuah aturan dikecualikan dari aturan itu, dengan lookback dua
baris agar item checklist markdown yang terpotong ke baris berikutnya bisa mengutip
frasa pemicu yang dilarangnya. Jendelanya terbatas: pelanggaran empat baris di bawah
pernyataan aturan tetap tertangkap.

<a id="design-tells-no-decorative-left-stripe"></a>
## Design tell: tanpa garis kiri dekoratif

Master skill menyebut tujuh tell frontend (badge eyebrow, titik status dekoratif,
garis kiri berwarna, dan empat lainnya). Tell yang bentuknya bisa dideteksi secara
mekanis punya gate, `bun run design:check`:

```bash
bun run design:check <file-or-dir>...   # whole files; a directory is walked
cd <repo> && bun <vivera>/scripts/check-design-tells.mjs --diff origin/main
                                        # only stylesheet lines added since the base
```

Gate ini ada karena pada 2026-10-16 situs Snipset masih membawa 31 garis kiri
dekoratif, padahal tell tersebut sudah sejak awal tertulis sebagai prosa di `sucp-rules`:
`border-left` aksen 4px pada kartu CTA penutup di setiap halaman solutions (23 atribut
`style=""` inline, EN dan ID), pada kartu TCO di halaman compare, pada setiap kartu
testimoni (`::before` bergradien 4px), pada dua kotak demo terminal, dan pada halaman
404. Tidak satu pun menandai sebuah state. Pemiliknya menemukan yang pertama di sebuah screenshot.

| Bentuk | Pola |
|---|---|
| Garis border | `border-left`, `border-left-width`, `border-inline-start(-width)` selebar 2px atau lebih dengan warna yang terlihat |
| Garis bayangan | `box-shadow: inset <N>px 0 0 ...` dengan N bernilai 2 atau lebih |
| Garis pseudo-element | `::before`/`::after` yang `position: absolute`, `left: 0`, lebarnya 2 sampai 8px, dan setinggi penuh |
| Garis utility | Tailwind `border-l-2`, `border-l-4`, `border-l-8` dalam daftar class |

Sebuah garis adalah sinyal jika selector-nya menyebut state yang ditandainya, jadi
selector (atau selector pembungkus mana pun, atau tag elemen itu sendiri untuk inline
style) yang mengandung `active`, `current`, `selected`, `warning`, `error`, `success`, `alert`,
`callout`, `blockquote`, `status`, `pass`, `fail`, atau kata lain di `STATE_WORDS`
lolos dengan sendirinya. Selain itu wajib diberi `/* design-tells: allow <reason> */` di
baris yang sama atau di baris atasnya, dan waiver tanpa alasan adalah pelanggaran
tersendiri. Border 1px hanyalah border, dan border atas, kanan, dan bawah tetap di luar
cakupan sampai salah satunya terukur sebagai tell. Seperti `copy:check`, `--diff` hanya
menilai baris yang ditambahkan branch, sehingga garis lama tidak pernah memblokir PR
yang tidak berkaitan.

<a id="duplicate-definitions-the-reuse-rung-of-the-simplicity-ladder"></a>
## Definisi duplikat: anak tangga reuse pada Simplicity Ladder

Anak tangga 2 pada Simplicity Ladder meminta Anda memakai ulang helper yang sudah ada
di repositori sebelum menulis yang baru. Anak tangga itu dulu hanya berupa prosa, jadi
helper duplikat ditemukan secara manual atau tidak ditemukan sama sekali.
`bun run dups:check` adalah bentuk mekanisnya:

```bash
bun run dups:check --diff origin/main   # only definitions on lines the branch adds
```

Perintah ini melaporkan definisi top-level pada baris yang ditambahkan branch ini jika
namanya, setelah diubah ke huruf kecil dan dibersihkan dari `_` dan `-`, sudah
didefinisikan di file lain (`formatPrice` dan `format_price` dihitung sebagai satu nama).
Ia membaca JS dan TS, Python, func biasa Go, dan `fn` Rust. Ia melewati nama generik
(termasuk `parseArgs` dan `usage`), file test, `node_modules`, `vendor`, `dist`, `build`,
`target`, `graphify-out`, serta pasangan lintas keluarga bahasa. Exit 0 berarti bersih,
1 berarti kemungkinan duplikat, dan 2 berarti kesalahan pemakaian. Baris terakhirnya
selalu `scanned N added definitions in M files`, sehingga nol terlihat sebagai nol, bukan
sebagai run yang tidak membaca apa pun. Waiver-nya adalah `dup-defs: allow <reason>` di
baris yang sama atau di baris atasnya, dan waiver tanpa alasan adalah pelanggaran
tersendiri.

Sebuah temuan adalah kemungkinan duplikat: reviewer membaca kedua definisinya sebelum
mencatatnya. Pada riwayat repositori ini tanggal 2026-10-17, perintah ini melaporkan 31
temuan berbeda dalam dua jendela (20 commit terakhir dan 60 commit terakhir). Setelah kedua
definisi pada setiap temuan dibaca, 5 adalah duplikat sungguhan, 14 parsial (tugasnya sama,
dengan perbedaan nyata), dan 12 bukan duplikat. Dua pengecualian yang lahir dari pembacaan
itu, yaitu `parseArgs` dan `usage` sebagai nama generik serta pasangan lintas keluarga
bahasa, menghapus 7 dari 12 tersebut, sehingga tersisa 24 temuan yang 19 di antaranya layak
dibaca. Dua aturan dicoba di atas kertas lalu ditolak karena menyembunyikan duplikat
sungguhan: hanya memeriksa definisi yang diekspor, dan melewati `checkDiff`. Batasnya,
perintah ini hanya mencocokkan nama, jadi helper yang ditulis ulang dengan nama lain tidak
ditemukan, dan 5 pasangan bernama sama dengan tugas berbeda masih tersisa.
