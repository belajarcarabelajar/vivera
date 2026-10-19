<a id="all-five-share-the-subagent-and-evidence-rules"></a>
## Kelimanya berbagi aturan subagent dan bukti

Kelima snippet membawa aturan subagent dan bukti yang sama, karena kegagalan yang paling
umum adalah agent yang membaca prompt pemicu, tidak pernah melihat persyaratan subagent
di dalamnya, lalu diam-diam mengimplementasikan semuanya secara inline. Masing-masing
menyatakan pipeline delapan langkah secara eksplisit: task-chunking, batch manifest,
proportional fan-out, scope yang tidak tumpang tindih, nested fan-out, gather and synthesize,
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
