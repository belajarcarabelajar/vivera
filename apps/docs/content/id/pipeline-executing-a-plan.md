---
title: Menjalankan Plan ultra-plan/v1
description: scripts/ultra-plan-runner.mjs mengurai frontmatter plan, memvalidasi DAG task, melewati task yang idempoten, menjalankan setiap langkah, dan mencatat kegagalan dalam sebuah ledger.
category: pipeline
slug: executing-a-plan
order: 5
source: README.md#Executing an `ultra-plan/v1` Plan
source_hash: "880f63920ce3"
---

<a id="executing-an-ultra-planv1-plan"></a>
# Menjalankan Plan `ultra-plan/v1`

`scripts/ultra-plan-runner.mjs` adalah separuh mesin dari kontrak plan. Script ini mengurai
frontmatter `ultra-plan/v1`, memvalidasi DAG task, menegakkan skip idempoten, mengeksekusi
langkah `run[]` setiap task, dan menghimpun kegagalan ke dalam sebuah error ledger. Tanpa
dependensi, hanya Bun.

```bash
bun run plan:check docs/code-plan/plans/<plan>.md   # validate the DAG and the visual map
bun run plan:run   docs/code-plan/plans/<plan>.md   # same, then execute the tasks
bun run contract:check                              # fast structural check for all 23 runner keys (~1s)
bun run audit:skipif                                # tally & audit skip_if predicates across registry
```

<a id="regex-performance-two-scans-that-were-quadratic"></a>
## Performa regex: dua pemindaian yang kuadratik

Dua scanner berbasis regex berperilaku kuadratik pada input milik repository ini sendiri, dan
keduanya sudah ditulis ulang menjadi satu kali lintasan. Kedua perbaikan menyimpan versi
kuadratik aslinya di file test sebagai **kontrol**, sehingga klaimnya tetap dapat difalsifikasi:
klaim performa tanpa pembanding hanyalah komentar, bukan test.

| Lokasi | Bentuk lama | Hasil ukur lama | Baru |
|---|---|---|---|
| `check-anchors.mjs` `parseAnchors` | berjalan maju dari setiap `[` | 250 KB → **3,0 s** | 1,4 ms |
| `vault-index-structural.mjs` `stripFrontmatter` | `/^([\s\S]*?)^---[ \t]*(?:\r?\n\|$)/m` | 781 KB → **3,8 s**; 3 MB → 30 s | ~2 ms |

Keduanya punya akar masalah yang sama: **prefix lazy tanpa batas yang tidak memiliki literal
sebagai titik lompat bagi engine**. `[\s\S]*?` cocok dengan string kosong di setiap posisi,
sehingga engine mencoba ulang dari tiap posisi, kira-kira 4x setiap kali ukuran input berlipat
dua. Korpus `--all` berisi catatan sesi OpenCode yang sering mencapai ratusan KB, jadi masalah
ini berarti beberapa menit wall clock per audit, bukan sekadar kekhawatiran teoretis.

Sifat yang memprediksi masalah ini **bukan** "mengandung lazy quantifier". Dua regex sejenis
dengan bentuk yang sama sudah diukur dan sengaja dibiarkan: pola PEM di `redact.mjs` dan
pencocok mermaid-fence di `ultra-plan-runner.mjs` sama-sama diawali sebuah **literal**
(`-----BEGIN `, ` ```mermaid `), sehingga pencarian prefix oleh engine langsung melompat ke
kandidat (0,1 ms pada input 800 KB). Ukur ulang sebelum mengubah salah satunya.

Penggantinya, keduanya linear dan keduanya diverifikasi terhadap versi asli pada korpus yang
mencakup kasus-kasus rumit (`----` bukan fence, `k: ---` bukan fence, fence di EOF tanpa
newline, BOM, CRLF, dan blok yang tidak ditutup):

- `parseAnchors` → sebuah bracket stack. Setara secara konstruksi: `]` yang membawa kedalaman
  kembali ke 0 dari posisi `i` tepat merupakan bracket pasangan `i` menurut pencocokan standar,
  karena semua yang ada di antara keduanya seimbang.
- `stripFrontmatter` → regex **sticky** (`y`) yang dijalankan pada setiap awal baris yang
  ditemukan dengan `indexOf('\n')`. Flag sticky inilah yang membuat "harus cocok tepat di sini"
  dapat dinyatakan, dan itulah yang memungkinkan pemanggil menelusuri awal baris secara manual.

Satu pelajaran soal pengukuran waktu dicatat di kedua file test, karena pelajaran ini sempat
menelan dua assertion yang salah: rasio wall clock antara dua run yang diukur terpisah mengukur
scheduler sama banyaknya dengan mengukur algoritma. Satu assertion membaca 3,28x per penggandaan
pada fungsi yang terbukti linear, dan retry best-of-N tetap flaky begitu suite menjalankan 55
file secara bersamaan. Assertion yang bertahan adalah yang **komparatif dan diselang-seling**:
kedua implementasi diukur berurutan pada input yang sama dengan urutan bergantian, sehingga jeda
GC mengenai keduanya dan saling meniadakan dalam hasil bagi.

`bun run contract:check` (`scripts/check-runner-contract.mjs`) memverifikasi bahwa `templates/implementation-plan-template.md` dan header plan pada master skill mendeklarasikan ke-23 key yang dibaca runner (`tasks[].run[].cmd`, `tasks[].run[].loop_until`, `tasks[].skip_if`, `tasks[].impacts`, dan seterusnya) memakai perbandingan AST/frontmatter murni dalam ~1 detik, tanpa perlu menjalankan rendering Mermaid lewat headless browser yang mahal.

Pemeriksaan visual map adalah bagian yang menangkap plan yang berbohong. Setiap heading task
harus punya node yang cocok di blok Mermaid, dan setiap edge `depends_on` harus cocok dengan
edge Mermaid **di kedua arah**: task di diagram tanpa `depends_on`, atau `depends_on` tanpa
panah, adalah kontradiksi antara dua representasi dari plan yang sama, dan runner memilih gagal
daripada menebak mana yang benar.

<a id="run-is-what-makes-a-plan-executable"></a>
## `run[]` yang membuat plan dapat dieksekusi

Sebuah plan hanya bisa dijalankan mesin sejauh langkah-langkahnya berada di `tasks[].run[]`.
Setiap entri adalah satu perintah dengan `cmd`, `expect_exit`, dan `retry`; runner
menjalankannya secara berurutan, membandingkan exit code, mengulang ketidakcocokan yang bersifat
sementara (transient), lalu melaporkan `PASSED`, `FAILED-BLOCKING`, `FAILED-ISOLATED`,
`HALTED-UPSTREAM`, atau `SKIPPED-IDEMPOTENT`. Langkah RED memang diharapkan gagal, sehingga
langkah itu lolos dengan `expect_exit: 1`.

| Task mendeklarasikan | Runner melakukan |
|---|---|
| `run[]` | Mengeksekusi langkah-langkahnya. `PASSED` atau kegagalan yang terklasifikasi. |
| hanya `skip_if` | `NEEDS-AGENT` plus sebuah peringatan. Tepat untuk prosa, layout, dan keputusan desain. |
| Tidak satu pun | **Error validasi.** Tidak terlihat oleh runner dan lolos dari setiap gate. |

<a id="how-a-failure-is-reported"></a>
## Cara kegagalan dilaporkan

Tiga hal membuat sebuah kegagalan dapat ditindaklanjuti, bukan sekadar tercatat, dan ketiganya
masih berupa cacat sebelum 2026-10-04.

**1. Baris membawa buktinya sendiri.** `run()` selalu menangkap stderr dan stdout; tidak ada
pemanggil yang membaca keduanya, sehingga baris `FAILED-ISOLATED` hanya berbunyi `exit 1` lalu
berhenti. Mendiagnosisnya berarti menjalankan ulang perintah secara manual, dan untuk langkah
yang stateful, run ulang bukanlah perintah yang sama untuk kedua kalinya. Kini ledger mencatat
ekor stderr (stdout jika stderr kosong), dibatasi beberapa baris terakhir, ditambah ekspektasi
yang benar-benar dibawa langkah tersebut (`exited 1, expected 0` adalah fakta; `exited 1` baru
separuhnya). `_no output captured_` itu sendiri adalah temuannya: perintah yang gagal tidak
menghasilkan apa pun untuk didiagnosis.

**2. Klasifikasi berasal dari exit code, dan hanya dari exit code.**

| Exit | Kelas | Transient | Alasan |
|---|---|---|---|
| 124 / ETIMEDOUT | `timeout` | `true` | langkah berjalan melebihi `step_timeout_s` |
| 127 | `environment` | `false` | perintah tidak ada di mesin ini; run ulang tidak bisa mengubahnya |
| 126 | `environment` | `false` | ditemukan, tetapi tidak executable |
| 130 | `interrupted` | `false` | SIGINT sampai ke langkah tersebut |
| 143 | `terminated` | `false` | SIGTERM sampai ke langkah tersebut |
| selain itu | `code` | `unknown` | perintah berjalan dan hasilnya tidak sesuai `expect_exit` |

`transient` adalah sumbu kedua, bukan sinonim dari kelas: field ini menjawab "apakah menjalankan
ulang ada gunanya". Test yang flaky dan kegagalan deterministik sama-sama exit 1, sehingga yang
dilaporkan adalah `unknown`, bukan tebakan (aturan yang sama yang sudah diikuti
`classifySkipIf`). Baris dengan `transient: false` **melewati retry-nya dan menyatakannya di run
log**, itulah sebabnya perintah yang salah ketik kini gagal sekali saja, bukan `retry: 3` kali.

**3. Langkah yang timeout mati bersama child process-nya.** Hasil pengukuran: `spawnSync(..., { shell: true,
timeout })` hanya mengirim sinyal ke shell, sehingga pada `sh -c "sleep N & wait"` proses yang
berjalan di background masih hidup setelah runner melaporkan ETIMEDOUT. Kini setiap langkah
berjalan di process group-nya sendiri (`detached: true`) dan sinyal dikirim ke seluruh group
saat timeout, sehingga langkah yang melewati batas waktu tidak meninggalkan worker build atau
test yang masih memegang lock. Inilah bentuk mesin dari Stalled Subagent & Stale-Writer
Guardrail yang diikuti agent secara manual.

Urutan kolom ledger adalah kontrak, bukan preferensi: `plan-mark-done.mjs` membaca kembali
sebuah baris berdasarkan **bentuknya** (sel pertama berbentuk id, status ber-backtick di akhir),
dan itulah yang membuat pelebaran tabel aman; selain itu trace meng-escape `|` sehingga output
compiler tidak akan pernah bisa memunculkan baris hantu. Sebuah test memastikan ledger yang
sudah dilebarkan tetap bisa di-parse oleh parser milik `plan-mark-done` sendiri.

<a id="state-files-are-written-atomically"></a>
## File state ditulis secara atomik

`pr.registry.json`, `plan.issues.json`, dan file `.md` plan yang ditulis ulang oleh
`plan-mark-done.mjs` semuanya ditulis melalui `scripts/lib/atomic-write.mjs`: file sementara di
direktori target itu sendiri (filesystem yang sama, sehingga `rename(2)` atomik), `fsync`
sebelum rename, lalu rename, dengan satu generasi `.bak`.

Alasannya adalah biaya pemulihan, bukan teori. Ketiganya di-gitignore *karena* bersifat lokal
di mesin, sehingga `git checkout` tidak punya apa pun untuk dipulihkan dan penulisan yang
terpotong tidak punya jalur pemulihan di luar mesin itu. `writeFileSync` biasa membuka file
dengan `O_TRUNC` terlebih dahulu, sehingga crash di tengah penulisan sudah menghancurkan byte
lama pada saat kegagalan itu terjadi.

Atomisitas bukan lock, dan modul ini tidak berpura-pura sebaliknya: dua penulis yang berjalan
bersamaan tetap bisa saling menyela, karena mencegahnya memerlukan lock file dan kebijakan
stale-lock dengan mode kegagalannya sendiri. `pr-registry.mjs` menjaga kasus itu secara terpisah
dengan `assertNoCollisions`, yang menolak branch atau worktree duplikat baik saat load maupun
save.

`skip_if` yang hanya membuktikan keberadaan sebuah string (`grep -q 'Marker' src/x.md`) adalah
saluran false-pass: ia tetap lolos walaupun perilakunya sudah di-revert, dan
`plan-mark-done.mjs` mencentang task hanya berdasarkan klaim itu. Runner **menolaknya sebagai
error validasi**. Gunakan perintah yang gagal berdasarkan perilaku: pemanggilan test, build,
query `git diff`, atau pemeriksaan state. `grep` yang menyaring output sebuah tool
(`bun test x 2>&1 | grep -q '...'`) tidak masalah, karena tool tersebut harus berhasil lebih
dulu.

Classifier di balik pemeriksaan itu mengembalikan salah satu dari lima kelas: `empty` (tidak
mengklaim apa pun), `sentinel` (literal `skip_if: "false"`, penanda terdokumentasi untuk "task
ini tidak punya perintah"), `behavioural` (menjalankan tool yang harus berhasil lebih dulu),
`loose` (membaca file dan menegaskan ada string di dalamnya, dan ditolak), serta `unknown`
(tidak cocok dengan kedua aturan). `unknown` **memberi peringatan**, bukan error, dengan
menyebut task dan perintahnya, karena 14 task semacam itu berada di plan milik repository yang
tidak dimiliki repository ini, dan error di sini berarti satu commit mengubah repository orang
lain. Jalankan `bun scripts/skipif-registry-audit.mjs` untuk rekap per plan saat ini, atau
`--compare-to-frozen` untuk melihat apa yang diubah aturan yang berlaku sejak freeze 2026-09-30.

<a id="impacts-what-the-task-can-break-which-files-never-asked"></a>
## `impacts`: apa yang bisa dirusak task, hal yang tidak pernah ditanyakan `files`

`files: { create, modify, test }` menyebut path yang **disentuh** sebuah task. Tidak ada bagian
kontrak yang menanyakan apa yang **dirusaknya**, sehingga sebuah task bisa mengubah interface
bersama, bentuk export publik, flag CLI, atau aturan yang terdokumentasi, hanya mendeklarasikan
file miliknya sendiri, dan lolos dari setiap gate sementara konsumennya tetap rusak.
`depends_on` tidak bisa menutup celah itu: ia mengurutkan task *di dalam satu plan*, sehingga
konsumen di modul lain, plan lain, atau repository lain bukanlah node dan tidak bisa menjadi
edge.

`tasks[].impacts` menutupnya. Setiap entri berisi sebuah surface ditambah perintah atau graph
query yang menunjukkan dampaknya, sehingga klaim tersebut membawa buktinya sendiri:

```yaml
- id: T1
  impacts: ["scripts/check-runner-contract.mjs - structural key compare: bun scripts/check-runner-contract.mjs",
            "README.md §Runner contract - bun scripts/check-runner-contract.mjs"]
```

| Plan mendeklarasikan | Runner melakukan |
|---|---|
| `require_impacts: true` + task tanpa `impacts` | **Error validasi**, dengan menyebut task-nya. |
| `impacts: []` | **Error validasi.** Daftar kosong tidak mengklaim apa pun dan tidak membuktikan apa pun. |
| `impacts: ["none: <command>"]` | Lolos. "Sudah diperiksa, tidak ada dampak downstream" adalah jawaban yang sah, dan jawaban itu menyebut pemeriksaannya (disiplin yang sama dengan `skip_if: "false"`). |
| `require_impacts` tidak ada | Satu **peringatan** gabungan yang menyebut setiap task yang belum mendeklarasikan, tidak pernah error. |
| `allow_no_impacts: [T3]` | Membebaskan satu task. Menyebut task yang *justru* mendeklarasikan impacts adalah error tersendiri, sehingga daftar ini tidak bisa menjadi selimut permanen. |
| `loop_until: "<command>"` pada langkah iteratif | Runner mengeksekusinya setelah `cmd` milik langkah itu sendiri berhasil. Exit 0 berarti konvergen dan langkah lolos; non-zero menjalankan ulang langkah di dalam anggaran `retry` yang sudah dideklarasikannya, dan menghabiskan anggaran itu adalah kegagalan yang menyebut `loop_until`. Ini selalu sebuah perintah, tidak pernah pencocokan string: `grep -q 'Done' src/x.ts` tetap lolos walaupun perilakunya di-revert, sehingga ia melaporkan konvergensi untuk pekerjaan yang belum konvergen. |
| `loop_until` tidak ada | Sah, dan merupakan default. Langkah yang tidak beriterasi tidak pernah menjalankan pemeriksaan konvergensi, sehingga setiap plan yang lebih tua dari key ini berperilaku persis seperti sebelumnya. |
| `loop_until` ada tetapi kosong atau bukan string | **Error validasi**, dengan menyebut task dan langkahnya. Kondisi yang tidak bisa dieksekusi runner lebih buruk daripada tanpa kondisi, karena terbaca sebagai klaim padahal tidak menegakkan apa pun. |

Hanya flow-style (`impacts: ["a", "b"]`). Bentuk blok `- "text"` di-parse sebagai object, bukan
scalar, sehingga list bergaya blok sampai ke validator sebagai object di tempat yang ditulis
sebagai string, dan validator melaporkan hal itu sambil menyebut bentuk yang benar, alih-alih
menghitungnya sebagai klaim.

Cermin prosanya ada di §2b template plan, yaitu tabel **Affected Surfaces** dengan kolom bukti,
dan audit dijalankan ulang sebelum Langkah 1 dan sekali lagi pada Langkah 4 setiap task. Ketika
kontrak subagent melarang child mengedit di luar chunk-nya, baris
`IMPACT: <surface> - <what breaks> - <evidence>` di laporan menjadi serah terimanya, dan gather
checkpoint milik parent mewajibkan setiap baris seperti itu punya pemilik: sebuah task atau
baris backlog `defer:`, tidak pernah nama yang tidak sampai ke antrean mana pun.

`validate-skill.mjs` menegaskan bahwa template plan dan header plan pada master skill sama-sama
mendeklarasikan setiap key yang dibaca runner, dengan membandingkan **struktur frontmatter hasil
parse**, bukan mencari teks. Daftar key diimpor dari runner, sehingga menambahkan input tanpa
mendokumentasikannya membuat CI gagal. Pemeriksaan ini ada karena kedua bagian itu pernah
benar-benar bergeser sementara CI tetap hijau: `files`, `idempotency_key`, `verify_exit`, dan
`on_precondition_fail` semuanya terdokumentasi tetapi tidak satu pun dibaca, sementara `run[]`
tidak dibaca oleh apa pun dan tidak didokumentasikan di mana pun.

Plan milik repository ini sendiri ada di `docs/code-plan/plans/`, dengan manifest batch
pra-dispatch di sebelahnya, di `docs/code-plan/`. Manifest itu disimpan karena mencatat
penyimpangan yang disetujui selama eksekusi, yaitu bagian yang tidak bisa lagi dijelaskan oleh
plan yang sudah selesai.
