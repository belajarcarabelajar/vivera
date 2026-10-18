---
title: Snippet Pemicu
description: Prompt siap salin-tempel di snippets/ untuk enam titik masuk workflow, seperti brainstorm, plan, dan debugging, masing-masing dengan keyword singkat.
category: tooling
slug: trigger-snippets
order: 2
source: README.md#Trigger Snippets
source_hash: "c788ff0e04fd"
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

<a id="file-size-the-split-it-rule-as-a-gate"></a>
## Ukuran file: aturan pecah-file sebagai gate

File yang tidak bisa dibaca agent sekaligus akan dibaca per bagian lalu diedit tanpa melihat
keseluruhannya. `bun run size:check` memblokir file teks yang lebih dari 5.000 token (byte / 4,
batas 20.000 byte). Ada tiga mode:

```bash
bun run size:check                                   # --staged (default, the hook): staged files, size from the index
bun scripts/check-file-size.mjs --all                # every tracked file plus stale ceilings (end of bun run ci)
bun scripts/check-file-size.mjs --write-baseline     # seed the ceilings once, then only lower or drop them
```

Exit 0 berarti lulus, 1 berarti pelanggaran atau plafon basi, dan 2 berarti kesalahan pemakaian,
bukan repositori git, baseline tidak valid, atau panggilan git yang gagal.
File yang sudah melewati batas saat gate ini masuk mempertahankan ukurannya sebagai plafon di
`scripts/file-size-baseline.json`, sebuah ratchet: menyusut itu bebas, membesar diblokir. Plafon
dibaca dari salinan file itu yang sudah di-stage. Bila pemecahan file berada di luar cakupan,
naikkan plafonnya secara manual dan stage di commit yang sama, lalu
sebutkan tindak lanjutnya di body PR. File yang di-rename dihitung sebagai file baru, jadi
pindahkan plafonnya. Setelah memecah file, jalankan `git grep` pada path lama dan perbarui
rujukannya (`validate-skill` mengunci path skill).

<a id="strict-retries-retry_if"></a>
## Retry ketat: `retry_if`

```yaml
defaults:
  retry_if: any        # any (default) | transient
```

| Nilai | Retry dipakai untuk |
|---|---|
| `any` | Apa saja kecuali kegagalan yang menurut exit code-nya pasti tidak bisa berubah: 127, 126, 130, 143 |
| `transient` | Hanya `transient: true`, yang dalam praktiknya berarti timeout |

**Kebijakan ketat bersifat opt-in karena `transient: 'unknown'` adalah exit 1
biasa**, di mana kegagalan assertion yang deterministik dan test yang flaky tidak bisa
dibedakan dari exit code. Menjadikan kebijakan ketat sebagai default akan menghentikan
retry untuk test flaky di setiap plan yang sudah ada, termasuk plan di repositori lain
yang tidak dimiliki repositori ini. Nilai yang tidak dikenali akan melempar error alih-alih
jatuh ke default, sama seperti `on_precondition_fail`.

<a id="mutual-exclusion-for-the-pr-registry"></a>
## Mutual exclusion untuk PR registry

`pr.registry.json` menentukan sesi mana yang memiliki branch dan worktree mana, dan
file ini di-gitignore, jadi penulisan yang hilang tidak bisa dipulihkan. Atomic write
membuat setiap penulisan tidak terbagi, tetapi tidak mencegah dua penulis saling
menyela, di mana rename kedua diam-diam membuang hasil yang pertama.

Karena itu `saveRegistry` menerima `expectedRaw`: byte persis yang dibaca pemanggil. Jika
file sudah berubah sejak saat itu, ia menolak. **Tidak ada lock file**, dan ini disengaja:
lock membutuhkan kebijakan stale-lock, dan stale lock membutuhkan keputusan tentang apa
akibat pemegang lock yang crash terhadap pemegang berikutnya. Compare and swap tidak
membutuhkan keduanya, karena state yang dibacanya *adalah* state itu sendiri.

```js
mutateRegistry((registry) => claimSlot(registry, { ... }).registry, { registryPath })
```

`mutate` harus pure, karena fungsi ini diterapkan ulang pada hasil baca yang baru saat
terjadi konflik. Setelah empat konflik, ia gagal secara terang-terangan alih-alih berputar terus.

Jendela sisanya dinyatakan, tidak disembunyikan: di antara pembacaan ulang dan rename,
proses lain masih bisa menulis. Jendela itu hanya selebar satu pemanggilan, bukan selebar
satu sesi penuh, dan `mutateRegistry` menutupnya dengan membaca ulang dan menerapkan ulang.

<a id="backfilling-impacts-into-plans-that-predate-it"></a>
## Backfill `impacts` ke plan yang dibuat sebelum key tersebut ada

```bash
bun scripts/backfill-plan-impacts.mjs --dry-run   # report only
bun scripts/backfill-plan-impacts.mjs             # rewrite in place
```

Dua belas plan memuat 108 task yang ditulis sebelum key itu ada, masing-masing
memunculkan peringatan validasi. Menulis 108 klaim dampak secara manual berarti menulis
108 analisis, dan analisis yang tidak pernah dilakukan siapa pun adalah fabrikasi yang
menyamar sebagai catatan. Sebaliknya, setiap entri **diturunkan** dari apa yang sudah
dideklarasikan setiap task di `files` miliknya sendiri, ditambah konsumen file-file
tersebut di tree saat ini, ditambah perintah yang menunjukkannya.

Versi pertama script ini melaporkan sebuah file tidak punya konsumen karena regex-nya
membuang `.mjs` dari stem lalu langsung mensyaratkan tanda kutip penutup, sehingga
`from './plan-publish-frontmatter.mjs'` tidak pernah cocok. **83 dari 127 task kembali
sebagai sentinel "sudah diperiksa, tidak ada temuan"**, dan setiap plan tetap lolos
validasi, karena sentinel adalah entri yang sah. Itulah kegagalan yang seharusnya
dicegah oleh key tersebut, tereproduksi di dalam tool yang mengisinya. Setelah
perbaikan: 88 entri turunan, 39 sentinel, dan sebuah test yang memindai ulang setiap
jumlah konsumen yang diklaim.

<a id="all-five-share-the-subagent-and-evidence-rules"></a>
## Kelimanya berbagi aturan subagent dan bukti

Kelima snippet membawa aturan subagent dan bukti yang sama, karena kegagalan yang paling
umum adalah agent yang membaca prompt pemicu, tidak pernah melihat persyaratan subagent
di dalamnya, lalu diam-diam mengimplementasikan semuanya secara inline. Masing-masing
menyatakan pipeline delapan langkah secara eksplisit: task-chunking, batch manifest,
high fan-out floor, scope yang tidak tumpang tindih, nested fan-out, gather and synthesize,
parent diff audit, dan batched dispatch. Pekerjaan inline hanya diizinkan sebagai
pengecualian tertulis.

Varian brainstorming mengunci intent pengguna melalui ronde wawancara terstruktur sebelum
plan atau kode apa pun ada. Varian debugging memecah chunk berdasarkan **hipotesis**, bukan
berdasarkan file, sehingga penjelasan yang saling bersaing diuji secara paralel dan penyebab
yang terbantahkan dibuang tanpa mencemari yang lain. Varian pengiriman PR menambahkan isolasi
turunan (derived isolation), kepemilikan git yang hanya ada di parent, kontrak body PR
(`--body-file`), dan batch merge topologis. Varian review PR menegakkan kontrak review yang
ditambatkan ke baris dan menahan merge sampai pemeriksaan lokal hijau dan verdict-nya `correct`.

Ke-16 snippet (enam titik masuk dan sepuluh snippet perintah) membawa satu paragraf `CONFIRMATIONS:` yang identik tepat setelah paragraf `PROGRESS METER:`, karena sesi yang dimulai dari snippet tidak pernah memuat `sucp-rules`, dan sebuah test di [`scripts/sync-snippets.test.mjs`](https://github.com/belajarcarabelajar/vivera/blob/main/scripts/sync-snippets.test.mjs) gagal jika paragraf itu hilang, terduplikasi, atau bergeser (drift). Salinan di database Snipset baru menyusul ketika pengguna menjalankan `bun run snippets:push`.

<a id="keeping-the-database-in-sync"></a>
## Menjaga database tetap sinkron

File markdown adalah sumber kebenaran. Database Snipset menyimpan salinannya, karena
salinan itulah yang benar-benar diterima agent saat snippet dipicu.
[`snippets.manifest.json`](https://github.com/belajarcarabelajar/vivera/blob/main/snippets.manifest.json) memetakan setiap file ke slot database-nya
(uuid, keyword, name, description).

```bash
bun run snippets:status   # table of local vs database hashes
bun run snippets:check    # exit 1 on drift (also runs in CI)
bun run snippets:push     # write local content to the database
```

<a id="adding-a-new-snippet-is-a-create-not-an-update"></a>
## Menambah snippet baru berarti create, bukan update

`sync-snippets.mjs` hanya pernah memanggil `snippet update`, yang memerlukan uuid yang
**sudah ada**. Jadi trigger prompt baru perlu slot database-nya disiapkan sekali,
secara manual, sebelum `snippets:push` bisa berbuat apa pun dengannya:

```bash
# 1. the CLI must agree with the database schema, or every write is refused
snipset doctor            # schema_match must be true

# 2. create the slot, taking the body from the file (never retyping it)
snipset snippet add \
  --name "<name>" --keyword "<keyword>" --group "Agentic Coding AI" \
  --description "<description>" \
  --content "$(bun -e "import {readFileSync} from 'fs'; import {extractPromptBody} from './scripts/sync-snippets.mjs'; process.stdout.write(extractPromptBody(readFileSync('snippets/<file>.md','utf8')))")"

# 3. paste the uuid the database returns into snippets.manifest.json, then
bun run snippets:push
```

uuid **dipilih oleh database**, sehingga tidak bisa dibuat lebih dulu lalu ditulis ke
manifest sebelumnya. Entri manifest yang uuid-nya belum ada akan melaporkan
`snippet not found` dari `snippets:check`, dan itu vonis yang benar: database
memang tidak punya salinannya, dan agent tidak akan menerima apa pun saat snippet dipicu.

Kedua sisi dinormalisasi sebelum dibandingkan (em dash, tanda kutip melengkung, panah ke kanan,
CRLF, spasi di akhir baris), sehingga karakter tipografis di sumber Markdown tidak
dilaporkan sebagai drift. Instalasi Snipset yang tidak ada dilaporkan sebagai perbandingan
yang dilewati, bukan kegagalan, karena runner CI tidak punya database lokal dan itu adalah
batas lingkungan, bukan bukti adanya masalah. Drift yang nyata tetap gagal.

`validate-skill.mjs` menegakkan invarian yang berlaku di mana saja, termasuk CI: manifest
berupa JSON yang valid, setiap entri punya semua field wajib, tidak ada uuid atau keyword
ganda, setiap file yang dirujuk ada, setiap file yang dilacak membawa kontrak subagent,
dan setiap trigger snippet yang wajib ikut dilacak sehingga tidak pernah bisa tertinggal
diam-diam dari database.

<a id="mirroring-plans-into-the-obsidian-vault"></a>
## Mencerminkan plan ke vault Obsidian

Plan di bawah `docs/code-plan/plans/` adalah file markdown di repositori proyek, sehingga
vault tidak bisa mencarinya, merender Mermaid-nya, atau menampilkannya di graph. `scripts/plan-publish.mjs`
menyalin setiap plan ke `01 - Projects/<Project>/plans/` dengan frontmatter PARA milik vault
digabungkan ke dalamnya. Salinan itu adalah **mirror satu arah yang hanya-baca**: repositori
proyek adalah sumber kebenaran, salinan di vault adalah state turunan, dan salinan vault tidak
pernah diedit manual. Publisher tidak pernah membaca mirror kembali sebagai input, sehingga
mirror yang basi bisa membusuk secara kasatmata (`--check` ada untuk menangkapnya) tetapi
tidak pernah bisa merusak plan.

```bash
bun run mirror:publish <plan.md>...   # mirror the named plans (or pass the flags below directly)
bun run mirror:check                  # exit 1 on drift or a missing mirror
bun run mirror:status                 # table of every plan and its mirror state, always exit 0
bun run issue:sync <plan.md>...       # the same plan, mirrored to a GitHub issue
bun run issue:check <plan.md>...      # issue drift report, never writes
bun run issue:status                  # table of recorded plan-issue links, always exit 0
```

Sebuah plan punya **dua** salinan turunan, keduanya satu arah: catatan Obsidian ini, dan
issue GitHub yang membawa teks yang sama. Jalankan issue sync segera setelah setiap
`mirror:publish` untuk pemicu yang sama, agar keduanya tidak pernah berselisih. Lihat
[Plan Mirroring](/id/docs/pipeline/plan-mirroring/) untuk pemetaan state
dan tiga jebakan yang membentuk implementasinya.

- **`mirror:publish`** menulis satu file per plan dan men-stage-nya di vault dengan `git add` saat
  `stageInVault` aktif, sehingga obsidian-git (dikonfigurasi dengan `autoCommitOnlyStaged: true`)
  meng-commit-nya. Ia hanya men-stage satu file itu dan tidak pernah melakukan commit atau push.
  Publikasi ulang plan yang tidak berubah mencetak `SKIPPED-IDEMPOTENT`, keluar dengan kode 0,
  dan tidak menulis apa pun.
- **`mirror:check`** adalah gate bergaya CI: ia tidak pernah menulis, dan keluar dengan kode 1
  saat `source_hash` yang tercatat pada sebuah mirror tidak lagi cocok dengan plan sumbernya
  atau mirror-nya tidak ada. Exit 0 berarti setiap plan yang dienumerasi sudah di-mirror dan
  terkini.
- **`mirror:status`** adalah laporan, bukan vonis. Ia selalu keluar dengan kode 0, termasuk saat
  sebuah mirror tidak ada, sehingga aman di dalam rantai `&&` dan di pipeline shell.

Flag yang dipahami CLI itu sendiri, untuk saat Anda memanggil `bun scripts/plan-publish.mjs` secara langsung:

| Flag | Alasan keberadaannya |
|---|---|
| `--check [--all]` | Hanya verifikasi. `--all` mengenumerasi setiap plan di bawah setiap proyek `mirror: true` alih-alih mewajibkan path eksplisit. |
| `--status` | Melaporkan state mirror untuk setiap plan; tidak pernah gagal. |
| `--dry-run` | Mencetak tujuan dan apakah akan menulis, lalu tidak menulis dan tidak men-stage apa pun. |
| `--today YYYY-MM-DD` | Menimpa nilai frontmatter `updated`. Flag ini ada agar properti tersebut deterministik dalam test; tanpanya nilainya adalah tanggal lokal hari ini. |
| `PLAN_PUBLISH_CONFIG` | Variabel lingkungan yang menyimpan path ke `plans.publish.json`. Ini satu-satunya cara mengarahkan tool ke vault lain atau ke kumpulan root proyek yang lain. |

Dua variabel lingkungan lagi adalah seam host, sehingga skrip yang memerlukan path khusus
mesin tetap bisa berjalan di mesin selain mesin ini:

| Variabel | Dibaca oleh | Default |
|---|---|---|
| `GRAPHIFY_SITE_PACKAGES` | `vault-index.mjs` | tidak di-set: key `graphifySitePackages` di `local.config.json` yang di-gitignore (lihat `local.config.example.json`), bila itu pun tidak ada, error yang menyebutkan langkah perbaikannya |
| `GRAPHIFY_PYTHON` | `vault-index.mjs` | tidak di-set: key `graphifyPython` di `local.config.json`, bila itu pun tidak ada, error yang menyebutkan langkah perbaikannya |

`bun test scripts/` **melewati (skip), alih-alih menggagalkan,** test yang premisnya tidak
bisa dipenuhi host saat ini: checkout di lokasi lain, mesin tanpa detektor graphify
terpasang, atau mesin tanpa vault. Skip itu membawa alasannya, sehingga prasyarat yang tidak
ada tidak pernah dilaporkan sebagai cacat, dan, sama pentingnya, tidak pernah dihitung sebagai
lulus. Set variabel yang relevan untuk menjalankan test tersebut di sini.

Kode exit: `0` sukses atau skip idempoten, `1` drift / mirror tidak ada / tujuan ditolak /
kegagalan transformasi, `2` kesalahan penggunaan.

<a id="a-worktree-is-not-a-project"></a>
## Worktree bukan proyek

`projects` adalah tabel routing yang dikunci pada **prefiks path**, dan file plan tidak membawa
nama proyek, sehingga plan dirutekan murni berdasarkan letaknya di disk. Akibatnya, git
worktree dari proyek yang sudah terdaftar tidak bisa dipublikasikan: path-nya tidak dimiliki
siapa pun, dan `mirror:publish` menolak alih-alih menebak.

Perbaikan yang menggoda, yaitu mendaftarkan worktree sebagai proyek tersendiri, adalah salah,
dan kerusakannya sebanding dengan panjang riwayat repositori. `mirror: true` melakukan dua
hal: mengizinkan publikasi eksplisit *dan* memasukkan root ke enumerasi `--check --all`,
yang menelusuri **setiap** `.md` di bawah `<root>/docs/code-plan/plans/`. Checkout worktree
berisi seluruh riwayat yang dilacak, sehingga mengenumerasinya akan memublikasikan ulang setiap
plan yang pernah dimiliki repositori. Mendaftarkan worktree SEO Snipset sebagai proyek membuat
seluruh 274 plan Snipset yang ada di-mirror untuk kedua kalinya, di bawah folder proyek kedua,
286 file dalam satu commit.

Jadi sebuah proyek boleh mendeklarasikan **`worktrees`**: direktori tambahan yang menyimpan
plan proyek yang sama di branch lain.

```json
{ "name": "Snipset", "root": "/home/.../Proyek/Snipset", "mirror": true,
  "worktrees": ["/home/.../Proyek/Snipset-seo"] }
```

| Aspek | Cara penanganannya |
| --- | --- |
| Routing | `resolveProject()` memperlakukan worktree sebagai lokasi kandidat untuk proyeknya, sehingga plan yang ditulis di worktree di-mirror ke `01 - Projects/<Project>/plans/` di samping plan saudaranya. Tidak ada proyek kedua dan tidak ada indeks kedua yang dibuat. |
| Enumerasi | `enumeratePlans()` hanya membaca **root**, tidak pernah worktree. Asimetri inilah inti dari field tersebut: routing harus menerima worktree, enumerasi tidak boleh, karena plan di worktree adalah plan milik root. Hal ini di-assert langsung pada `enumeratePlans`. |
| Session worktree | Plan di bawah `<root>-wt/<slot>/`, tata letak yang dibuat oleh `scripts/pr-registry.mjs claim`, dirutekan ke proyek yang `root`-nya `<root>` tanpa entri konfigurasi, baik di `plan-publish.mjs` maupun `plan-issue-sync.mjs`; entri `worktrees` yang eksplisit tetap menang atas aturan turunan itu. |
| Remote origin | Hanya di `plan-issue-sync.mjs`: checkout yang nama direktorinya bukan key proyek, misalnya gate worktree `/tmp` yang detached, di-resolve melalui remote `origin`-nya, yang dibaca dari konfigurasi git di disk (mengikuti `gitdir` dan `commondir`), bila `owner/repo` tersebut sudah menjadi sebuah nilai di `projects`. Bila key direktori dan origin sama-sama ter-resolve ke repositori yang dikonfigurasi dan keduanya berbeda, sync ditolak dengan menyebut keduanya; origin yang tidak dipetakan ke proyek mana pun diabaikan bila key direktori ter-resolve, dan `--project` tetap menang. |
| Prioritas | Root dan worktree bersaing pada skala prefiks terpanjang yang sama, sehingga proyek nyata yang bersarang di dalam worktree tetap menang atas worktree yang memuatnya. |
| Penolakan | Nilai `worktrees` yang bukan array, entri yang kosong atau bukan string, entri yang sudah terdaftar sebagai root, dan entri yang diklaim dua proyek, semuanya adalah error saat load. Satu direktori tidak pernah bisa dirutekan sebagai dua proyek. |
| Deteksi | Tidak ada pemeriksaan identitas git, jadi tidak ada yang menyimpulkan bahwa dua root adalah satu repositori. Worktree harus dideklarasikan. `loadRegistry` menolak tabrakan itu alih-alih membiarkan aturan prefiks terpanjang memilih pemenang secara kebetulan. |

Worktree yang sudah dihapus dari disk sebaiknya dikeluarkan dari `worktrees`. Field itu tidak
menimbulkan biaya selama basi, karena enumerasi tidak pernah membacanya, tetapi entri yang basi
diam-diam tetap merutekan path yang sudah tidak ada ke proyek yang tidak akan pernah
me-mirror-nya.

`mirror:check` sengaja **tidak** menjadi bagian dari `bun run ci`. Ia membaca `plans.publish.json`, yang
menyebut satu vault dengan path absolut di satu mesin, dan kumpulan plan yang dienumerasinya saat ini
belum punya mirror satu pun, sehingga pemeriksaan ini adalah gate lokal untuk dijalankan di mesin
pemilik vault, bukan sesuatu yang bisa lolos di runner CI portabel.

<a id="indexing-generated-markdown-into-the-graph"></a>
## Mengindeks Markdown hasil generate ke dalam graph

`graphify update .` tidak bisa melakukan ini. Teks bantuannya berbunyi "re-extract code files and update the
graph (no LLM needed)" dan ia mem-parse kode, sehingga setiap plan, batch manifest, laporan spike,
handoff, log progres, dan learning ledger yang ditulis sebuah sesi tetap tak terlihat oleh `graphify
query`, `path`, dan `explain`. `scripts/graphify-sync.mjs` menutup celah itu dengan separuh yang
deterministik dari pipeline vault-index: satu node `document` per file Markdown yang memenuhi
syarat, node `heading` ATX-nya, dan `[[wikilinks]]`-nya yang bisa di-resolve sebagai edge `references`,
digabungkan (union) ke dalam `graphify-out/graph.json`.

```bash
bun run graphify:sync     # structural extraction + merge, writes graph.json
bun run graphify:check    # exit 1 when the graph is stale; never writes
bun <vivera>/scripts/graphify-sync.mjs --root "$(pwd)"           # from any repository's root, vivera included
bun <vivera>/scripts/graphify-sync.mjs --check --root "$(pwd)"
bun scripts/graphify-sync.mjs --dry-run
bun scripts/graphify-sync.mjs docs/code-plan/plans/<plan>.md   # narrow to files
```

| Aspek | Cara penanganannya |
|---|---|
| Batas cloud | Ini adalah pemindaian baris lokal: tanpa `extract`, tanpa API key, tanpa packet. Kumpulan file yang memenuhi syarat ditentukan oleh detektor milik graphify sendiri melalui `scan()`, sehingga batas `.gitignore`/`.graphifyignore` sama dengan yang akan dihormati ekstraksi di masa depan, bukan matcher kedua. |
| Urutan | Jalankan **setelah** `graphify update .`. `update` menulis ulang graph kode dan tidak diketahui mempertahankan node asing, sehingga menjalankannya setelah sync bisa membuang node document yang baru saja ditambahkan sync. Hook pre-commit di bawah menegakkan urutan ini secara otomatis. |
| Id ganda | Graph sudah membawa id `document` dari era graphify. Sebelum union, id `document` sebelumnya dipetakan ulang ke id milik lapisan ini untuk `source_file` yang sama, sehingga file yang sudah dikenal tidak diindeks dua kali dan edge-nya mengikuti pemetaan ulang tersebut. Node `node_kind: heading` tidak pernah dipetakan ulang: node itu adalah anak dari sebuah file, bukan identitasnya. |
| Kehilangan | `merge()` memulai union dari graph sebelumnya, sehingga node code, concept, dan rationale dipertahankan dan hanya bisa bertambah. Sebuah gate menolak menulis bila jumlah node akan turun. |
| Idempotensi | `structural()` deterministik dan merge-nya adalah union yang dikunci pada id node, sehingga run kedua atas file yang tidak berubah menulis output yang identik byte demi byte. `graphify:check` adalah gate-nya. |
| Graph tidak ada | Ia menolak dan menyatakannya. Ia melakukan merge ke graph yang sudah ada; ia tidak pernah mengarang graph baru. |

Baris `bun run` dan `bun scripts/...` berjalan di dalam vivera dan secara default memakai root-nya. Langkah 6.6
skill menjalankan sync di akhir sesi dalam bentuk `--root "$(pwd)"` dari repositori sesi tersebut,
yang benar di vivera maupun di setiap repositori lain. Di dalam vivera, sync ini juga berjalan
otomatis melalui git hook yang di-commit.

<a id="the-pre-commit-hook"></a>
## Hook pre-commit

`.githooks/pre-commit` terdiri atas dua bagian. Gate ukuran file berjalan lebih dulu dan menjadi
satu-satunya bagian yang bisa memblokir commit. Refresh graph lalu menjaga graph tetap konsisten
dengan isi commit yang sebenarnya, tanpa agent harus mengingatnya: saat kode berubah, ia menjalankan `graphify update .` (AST
lokal), lalu `bun run graphify:sync` menambahkan node struktural Markdown paling akhir. `install.sh`
mengaktifkannya dengan `git config core.hooksPath .githooks`.

| Aspek | Cara penanganannya |
|---|---|
| Gate ukuran (memblokir) | `bun scripts/check-file-size.mjs` memblokir file teks yang di-stage bila lebih dari 5.000 token (byte / 4, jadi 20.000 byte), diukur dari index, bukan working tree. Hanya file yang di-stage yang dinilai. Symlink, submodule, file biner, dan path bertanda `-size-gate` di `.gitattributes` (lockfile, diagram hasil render, file vendor) dilewati. Pesan galatnya mencetak saran pemecahan per jenis file. `bun run size:check` menjalankannya secara manual. |
| Ratchet | File yang sudah melewati batas memiliki plafon di `scripts/file-size-baseline.json`: boleh menyusut, tidak boleh membesar. `--write-baseline` hanya menurunkan atau menghapus plafon; menaikkannya adalah edit manual di commit yang sama, terlihat saat review, dengan tindak lanjut disebut di body PR. |
| Refresh graph tidak memblokir | Setiap langkah graphify keluar dengan kode 0, dan bun atau checker yang tidak ada, atau checker yang keluar dengan kode 2, membuat gate ukuran dilewati dengan `[size-gate] skipped: <reason>`; checker yang crash (kode keluar lain, atau kode 1 tanpa laporan) memblokir commit. Graph bersifat turunan, lokal, dan bisa dibuat ulang, sehingga langkah yang gagal mencetak peringatan yang panjangnya dibatasi dan commit tetap berlanjut. Graph yang merah tidak boleh memblokir riwayat. |
| Urutan | `graphify update` berjalan **sebelum** sync, tidak pernah sesudahnya. `update` membangun ulang `graph.json` dan penulisnya tidak dijamin mempertahankan node asing, sehingga lapisan struktural harus menjadi penulis terakhir atau node document bisa hilang. Diukur 2026-10-03: `update` memakan 5,3 detik, menumbuhkan graph 2342 → 2832 node, mempertahankan lapisan semantik (concept 284 → 274, rationale 156 → 158), dan sync berikutnya memulihkan lapisan document menjadi 2984 node dengan `graphify:check` CURRENT. |
| Gating / biaya | Tidak ada yang berjalan saat diff yang di-stage kosong atau tidak ada graph untuk diperbarui. Commit yang **hanya berisi Markdown** menjalankan sync saja dan melewati rebuild kode 5,3 detik; commit dengan **file non-Markdown apa pun** menjalankan `update` lalu sync. Kedua langkah bersifat lokal: tanpa LLM, tanpa jaringan. |
| Mengapa git hook dan bukan plugin hook OpenCode | Satu-satunya event siklus hidup sesi di OpenCode v2 adalah `session.idle`, yang terpicu setelah **setiap** giliran asisten, bukan di akhir sesi, sehingga plugin hook di sana akan memindai ulang terus-menerus. Git hook tidak bergantung pada harness (OpenCode, Claude Code, dan terminal semuanya berakhir di `git commit`) dan merupakan file yang di-commit, bukan state plugin yang lokal di mesin. |
| Mengaktifkan / menonaktifkan | `git config core.hooksPath .githooks` mengaktifkannya; `GRAPHIFY_SYNC_SKIP=1 git commit ...` hanya melewati refresh graph untuk satu commit; `git commit --no-verify` melewati seluruh hook, dan `bun run ci` tetap menangkap file yang terlalu besar; `git config --unset core.hooksPath` mengembalikannya ke `.git/hooks` default. Tidak satu pun menyentuh `graphify-out/`. |

Refresh graph sengaja **tidak** menjadi bagian dari `bun run ci`: ia menulis artefak lokal mesin
yang di-gitignore, yang kebenarannya bergantung pada vault dan graphify yang terpasang, dan
keduanya tidak bisa dilihat oleh runner CI portabel. Pemeriksaan ukuran justru menjadi bagiannya:
`bun run ci` diakhiri dengan `bun scripts/check-file-size.mjs --all`.

<a id="getting-sessions-to-query-the-graph"></a>
## Membuat sesi melakukan query ke graph

Graph yang tidak pernah di-query hanyalah biaya build. Claude Code tidak memuat `AGENTS.md`
sebuah repositori saat ada `CLAUDE.md` di direktori induk, sehingga aturan graphify di file itu
tidak pernah sampai ke sebagian besar sesi, dan tidak ada hal lain yang mendorong query: 14 dari
161 sesi Claude Code tingkat atas dari 2026-10-08 sampai 2026-10-14 melakukan query. Tiga hook
tingkat pengguna kini memberi tahu setiap sesi dan subagent tentang graph saat mulai, dan dua
perintah mendaftarkan repositori serta menampilkan daftar repositori yang masih belum punya graph.

```text
bun run graphify:hooks (--install | --uninstall | --check) [--settings <path>] [--hooks-dir <dir>] [--dry-run]
bun run graphify:register <dir> [--never] [--global]
bun run graphify:audit <root>... [--json] [--max-depth N]
```

| Perintah | Fungsinya | Kode exit |
|---|---|---|
| `graphify:hooks` | Menggabungkan tiga entri di bawah ke dalam `--settings` (default `~/.claude/settings.json`), masing-masing menjalankan skrip di `--hooks-dir` (default `scripts/hooks` di checkout ini). Sebuah entri dianggap miliknya bila sebuah command memuat `/scripts/hooks/graphify-`: `--install` mengganti entri-entri itu, sehingga run kedua tidak mengubah apa pun, dan `--uninstall` hanya menghapus entri-entri itu. Setiap key dan hook lain dipertahankan, dan file sebelumnya disimpan di `<settings>.bak`. `--install` membuat file settings yang belum ada. `--dry-run` mencetak JSON hasilnya dan tidak menulis apa pun. Bila dijalankan dari linked worktree tanpa `--hooks-dir`, `--install` menolak dan menyebut checkout utama sebagai tempat menjalankannya, karena session worktree dihapus setelah PR-nya di-merge. | `--check`: 0 bila ketiga entri dan skripnya ada, selain itu 1 dengan menyebut apa yang hilang. File settings yang bukan JSON valid, atau yang `hooks`-nya bukan object: 1, tidak ada yang ditulis. `--install` dari linked worktree tanpa `--hooks-dir`: 1, tidak ada yang ditulis. |
| `graphify:register` | Me-resolve checkout utama (bila dijalankan dari worktree, ia mendaftarkan checkout utama), menjalankan `graphify update <mainRoot>`, lalu menambahkan `graphify-out/` ke `<git-common-dir>/info/exclude` bila belum di-ignore. Hanya dengan `--global` ia kemudian menjalankan `graphify global add <graphPath> --as <basename of mainRoot>`; tanpanya, ia mencetak cara menambahkan graph nanti. Global graph tetap opt-in karena setiap server MCP graphify memuat seluruhnya saat startup (terukur 176 MB dengan 24.617 node dan setidaknya 625 MB dengan 126.291), sehingga isinya hanya apa yang perlu menjawab query yang tidak menyebut repositori. Aman dijalankan dua kali. Repositori yang opt-out dilaporkan dan tidak di-build. `--never` menetapkan `git config graphify.register never` dan tidak mem-build apa pun. | 0 selesai; 1 bila `graphify` tidak ada atau sebuah langkah graphify keluar dengan kode bukan nol (output menyebut langkah dan kodenya); 2 untuk kesalahan penggunaan atau direktori di luar repositori git. |
| `graphify:audit` | Menelusuri setiap root sampai `--max-depth` (default 4), melewati `node_modules`, `.cache`, dan worktree (dicantumkan terpisah, tidak pernah dihitung sebagai unregistered), lalu mencetak path, jenis, jumlah node dan edge, serta status basi setiap repositori beserta baris total, atau JSON dengan `--json`. | 1 selama ada repositori yang `unregistered` (yang opt-out tidak dihitung), selain itu 0; 2 tanpa root atau dengan root yang tidak ada. |

Registrasi bersifat offline: `graphify update` mem-parse kode secara lokal (AST), tanpa LLM dan
tanpa jaringan. Repositori berisi 2.076 file selesai di-build dalam sekitar 13 detik dengan
jaringan dinonaktifkan.

Tiga entri hook, masing-masing `"<path to bun>" "<hooks-dir>/<script>"` dengan timeout 10 detik:

- `SessionStart`, tanpa matcher, sehingga `compact` menyuntikkannya kembali: `graphify-session-start.mjs`
- `SubagentStart`: `graphify-session-start.mjs`
- `PreToolUse`, matcher `^(Grep|Glob|Read|Bash|mcp__graphify__.*)$`: `graphify-search-nudge.mjs`

| Status repositori | Yang dilihat sesi atau subagent saat mulai |
|---|---|
| Terdaftar | Satu paragraf: path graph (dari worktree, graph milik checkout utama, dan teksnya menyebutkan hal itu); bila graph lebih tua dari commit terakhir, keterangan bahwa `graphify update <mainRoot>` menyegarkannya secara offline; dan perintah query, `graphify query "<question>" --graph <graphPath>` (juga `path`, `explain`) atau tool MCP `query_graph` dengan `project_path` diatur ke checkout utama. |
| Belum terdaftar | Hanya saat sesi mulai, bukan subagent: bahwa repositori tidak punya graph, perintah registrasinya, dan permintaan tetap pengguna untuk ditawari registrasi melalui question tool dengan pilihan Register now, Not now, dan Never for this repository. Register now menjalankan `graphify-register.mjs`, Never menjalankannya dengan `--never`, dan Not now tidak mencatat apa pun, sehingga sesi berikutnya menawarkan lagi. |
| Opt-out, atau bukan repositori git | Tidak ada. |

Di repositori yang terdaftar, pencarian pertama oleh sesi atau subagent sebelum query graph
pertamanya mendapat satu pengingat di samping hasilnya, yang menyebut path graph dan perintah
query. Pencarian adalah `Grep`, `Glob`, `Read` atas file yang bukan Markdown dan tidak berada di
bawah `graphify-out/`, atau perintah Bash yang kata pertamanya `rg`, `grep`, `fd`, `find`, atau
`ag`. Query adalah tool `mcp__graphify__` apa pun, atau `graphify query`, `path`, atau `explain`
di Bash. Setiap sesi dan agent dilacak secara terpisah. Kedua hook keluar dengan kode 0 di setiap
jalur dan tidak pernah mengizinkan atau memblokir pemanggilan tool. `install.sh` hanya mencetak
perintah instalasi; ia tidak mengedit settings global.

| Perubahan | Revert |
|---|---|
| Entri hook di `~/.claude/settings.json` | `bun run graphify:hooks --uninstall` |
| Never untuk sebuah repositori | `git config --unset graphify.register`, dijalankan di repositori itu |
| Sebuah registrasi | Hanya bila dijalankan dengan `--global`: `graphify global remove <tag>`, dengan tag berupa nama direktori checkout utama. Graph lokal tetap ada di `graphify-out/`; hapus graph itu, dan baris `graphify-out/` di `.git/info/exclude`, untuk membatalkan build-nya juga. |

Bagian runbook dengan detail pengukurannya adalah §3.4.1 dari
[`docs/graphify-integration.md`](/id/docs/integrations/graphify-runbook/).

<a id="the-drift-watchdog"></a>
## Watchdog drift

`scripts/plan-mirror-check.sh` membungkus `mirror:check` untuk run harian tanpa pengawasan. Skrip itu
hanya pernah meneruskan `--check`, sehingga sengaja tidak ada jalur publish di file tersebut.

| Aspek | Cara penanganannya |
|---|---|
| Penjadwalan | Timer `systemd --user`, bukan workflow GitHub Actions. Workflow di runner tidak bisa melihat vault maupun repositori saudara, sehingga ia akan gagal selamanya karena path yang hilang atau lolos secara hampa karena mengenumerasi nol plan. |
| Lolos hampa | Dilaporkan sebagai vonis tersendiri alih-alih disembunyikan. Gate yang lolos karena tidak menemukan apa pun lebih buruk daripada tidak ada gate sama sekali, karena ia menciptakan keyakinan tanpa dasar. |
| Status exit | Sengaja diteruskan, sehingga run yang gagal muncul di `systemctl --user --failed`. Menelannya akan membuat skrip ini sekadar pembuang log, bukan watchdog. |
| Runtime tidak ada | `exit 127` bila `bun` tidak ada baik di `PATH` maupun di `$HOME/.bun/bin/bun`, karena systemd memulai service dengan environment minimal. |
| Log | `~/.local/state/plan-mirror/mirror-check.log`, append-only, dibatasi 500 record dan 20 baris detail per run. Pemangkasan dilakukan melalui file sementara, sehingga run yang terputus tidak bisa meninggalkan log yang terpotong. |

Nonaktifkan dengan:

```bash
systemctl --user disable --now plan-mirror-check.timer
systemctl --user reset-failed plan-mirror-check.service
```
