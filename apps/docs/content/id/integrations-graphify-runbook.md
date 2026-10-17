---
title: Runbook Integrasi graphify
description: Runbook untuk graphify v0.9.73 dengan angka yang diukur pada satu mesin Linux pada 2026-10-01, termasuk batasan bahwa backend LLM yang bisa dipakai hanya tersedia di cloud.
category: integrations
slug: graphify-runbook
order: 2
source: docs/graphify-integration.md
source_hash: "8ffb837da654"
---

<a id="graphify-integration-runbook"></a>
# Runbook Integrasi graphify

Ditulis 2026-10-01. Menargetkan `graphify` v0.9.73. Metodologi di bawah ini
diukur pada mesin Linux pribadi yang sederhana (satu contoh terukur: 8 thread,
**tanpa CUDA**, RAM 7,6 GB dengan ~2 GB yang biasanya kosong, swap zram); angka
perangkat keras tersebut hanya contoh, bukan persyaratan.

Berkas ini ditulis untuk sesi mendatang yang tidak punya akses ke percakapan
yang menghasilkannya. Setiap angka di bawah ini diukur pada mesin ini pada
2026-10-01, kecuali teks secara eksplisit menandainya UNMEASURED atau
melabelinya sebagai aritmetika yang diturunkan dari input terukur. Tidak ada
yang disimpulkan dari dokumentasi atau dari mesin lain.

Aturan internal yang dipatuhi berkas ini (`~/AGENTS.md`): jangan pernah
menyatakan klaim yang belum diverifikasi sebagai fakta, pisahkan temuan dari
dugaan, dan nyatakan di dalam berkas cara me-revert setiap perubahan.

**Direvisi 2026-10-01 (hari yang sama, beberapa waktu kemudian).** Empat
koreksi terukur dimasukkan setelah draf pertama ditulis, dan satu klaim yang
terukur tetapi keliru ditarik kembali:

1. Proyeksi waktu wall-clock multi-worker di §5.1 **keliru** dan sudah
   diganti. Backend cloud ollama tidak berjalan paralel; lihat §5.1 dan §6.7.
2. Perbaikan pola usang di `.gitignore` milik vault **sudah diterapkan** (lihat §4.4).
3. `03 - Resources/Attachments/` kini dikecualikan dari `.graphifyignore` milik
   vault (lihat §4.3.1).
4. Angka "1227 catatan yang dikecualikan" adalah kesalahan kategori (lihat §1 dan §4.3).

Angka yang ditarik kembali disebutkan di tempat penghapusannya, agar sesi
mendatang tidak menghidupkannya lagi dari ingatan.

---

<a id="1-what-this-is-and-the-constraint-you-must-read-first"></a>
## 1. Apa ini, dan batasan yang wajib Anda baca lebih dulu

`graphify` membangun graf pengetahuan (knowledge graph) persisten dari sebuah
codebase atau vault catatan: simbol kode dari parsing AST lokal, ditambah relasi
semantik dari LLM.

**Satu-satunya backend LLM yang layak di mesin ini adalah model CLOUD, sehingga
menjalankan graphify mengirim konten keluar dari mesin ini.**

Itulah fakta keamanan utama, dan fakta ini didahulukan sebelum perintah apa pun
di berkas ini. Secara konkret, saat ekstraksi semantik berjalan:

- Isi berkas sumber dan teks catatan dipotong menjadi chunk lalu dikirim lewat
  jaringan ke model cloud yang di-host oleh Ollama.
- Yang keluar adalah apa pun yang diterima backend **setelah** `.graphifyignore` dan
  `.gitignore` diterapkan. Karena itu, berkas ignore adalah *satu-satunya*
  batas antara konten Anda dan jaringan (lihat §4).
- Tidak ada mode khusus lokal untuk markdown di mesin ini. Model lokal yang
  diukur tidak layak (§5), dan ekstraksi markdown tidak bisa berjalan tanpa
  backend LLM (§6.4).

Konsekuensi untuk perencanaan:

1. Baca `.graphifyignore` sebelum run pertama, bukan sesudahnya. Tidak ada flag
   CLI yang mematikannya (§6.5), jadi isinya adalah batas keamanan.
2. Untuk vault Obsidian, `.graphifyignore` yang ketat itulah yang berdiri di
   antara konten Anda dan jaringan. Cakupan terukur: vault berisi total **3087
   berkas markdown / 42,0 MB**, dan dari jumlah itu **1312 berkas / 11,4 MB /
   ~2,86 juta token tersisa** di bawah berkas ignore yang ketat. Jangan
   memperluasnya sembarangan; §4 menjelaskan cara melakukannya dengan sengaja.
   (Draf awal berkas ini menyebut himpunan yang dikecualikan sebagai "1227
   catatan". Itu keliru: **1227 adalah jumlah berkas di dalam
   `03 - Resources/LLM Wiki/sources/` secara khusus**, bukan total yang
   dikecualikan di semua himpunan pengecualian. Lihat §4.3.)
3. Repositori ini (`vivera`) **tidak** mendeklarasikan batas ekstraksi cloud di
   `.graphifyignore`-nya. Berkas itu sendiri menyatakan hal ini. Menambahkan
   batas tersebut adalah tugas terpisah yang perlu direview.

UNMEASURED: apakah penyedia cloud tertentu menyimpan isi permintaan (request
body), dan berapa lama, belum dipastikan di mesin ini. Jangan berasumsi ke arah
mana pun.

---

<a id="2-preconditions-and-install"></a>
## 2. Prasyarat dan instalasi

<a id="21-the-ollama-extra-is-mandatory"></a>
### 2.1 Extra `[ollama]` wajib dipasang

`graphify` dipasang dengan `uv`. **Extra `[ollama]` wajib ada.** Tanpanya,
ekstraksi gagal dengan pesan:

```
the 'openai' package is required for this backend
```

```bash
uv tool install "graphifyy[ollama]"
```

- Pasang ulang/perbaikan: `uv tool install --force "graphifyy[ollama]"`
- Binary terpasang: `~/.local/bin/graphify`
- Versi yang terverifikasi saat penulisan: **0.9.73**

Revert: `uv tool uninstall graphifyy`. Perintah ini hanya menghapus tool
tersebut; tidak ada berkas proyek yang tersentuh.

<a id="22-ollama-must-be-running"></a>
### 2.2 Ollama harus berjalan

Ollama **0.35.0** di `/usr/bin/ollama`, melayani hanya dengan CPU.

```bash
ollama serve          # foreground; needs to be up before extraction
```

Jika unit desktop/service sudah menjalankannya, jangan jalankan salinan kedua.
Konflik port adalah gejala yang perlu diwaspadai.

Revert: hentikan proses yang Anda jalankan (`Ctrl-C` jika di foreground, atau
`systemctl --user stop ollama` jika Anda menjalankan user unit). Sesuai aturan
tetap mesin ini, **jangan** uninstall Ollama tanpa instruksi eksplisit; periksa
`pacman -Qo /usr/bin/ollama` terlebih dahulu.

<a id="23-environment-variables"></a>
### 2.3 Variabel lingkungan

Variabel berikut wajib untuk backend `ollama` dan **tidak disimpan ke berkas
apa pun** oleh runbook ini. Berikan secara inline pada setiap perintah.

| Variabel | Nilai | Alasan |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | mengarahkan klien ke Ollama lokal |
| `OLLAMA_API_KEY` | nilai apa pun yang tidak kosong | **hanya meredam sebuah peringatan**; ini bukan autentikasi ke Ollama |
| `OLLAMA_MODEL` | `gpt-oss:120b-cloud` | model yang dipakai untuk penamaan komunitas; inilah variabel yang benar-benar berfungsi (§6.3) |

`OLLAMA_API_KEY=ollama` sudah cukup. Jangan pernah memperlakukannya sebagai
rahasia dan jangan pernah menempelkan kunci asli di sini.

---

<a id="3-the-working-command-set"></a>
## 3. Kumpulan perintah yang berfungsi

Atur `G` dan blok env sekali per shell, lalu gunakan perintah di bawah apa
adanya.

```bash
export G=~/.local/bin/graphify
export OLLAMA_HOST=http://localhost:11434
export OLLAMA_API_KEY=ollama
export OLLAMA_MODEL=gpt-oss:120b-cloud
```

Revert untuk langkah di atas: `unset G OLLAMA_HOST OLLAMA_API_KEY OLLAMA_MODEL`.
Tidak ada yang ditulis ke disk, jadi tidak ada hal lain yang perlu di-revert.

<a id="31-extract"></a>
### 3.1 Ekstraksi

```bash
"$G" extract <path> \
  --backend ollama \
  --model gpt-oss:120b-cloud \
  --max-concurrency 4 \
  --out <path>
```

- Secara default menulis `<path>/graphify-out/`. `--out DIR` mengalihkannya.
- `--token-budget N` batas per chunk, default **60000** (dari `graphify extract
  --help` di mesin ini).
- `--api-timeout S` timeout per permintaan, default **600**.
- `--max-workers N` jumlah subprocess AST, default = jumlah CPU (8 di sini).
- `--no-cluster` hanya menulis hasil ekstraksi mentah.
- `--code-only` melewati berkas dokumen/paper/gambar (lihat peringatan di §6.4).
- `--max-concurrency N` **tidak menghasilkan percepatan paralel di sini.
  TERUKUR 2026-10-01: backend ini menjalankan permintaan secara serial.** Flag
  ini ada pada `extract` dengan default **4**, tetapi 4 permintaan generate
  `gpt-oss:120b-cloud` yang identik dan dikirim secara paralel memakan **41
  detik** wall clock, padahal 4 x 8 detik = 32 detik dan satu permintaan dengan
  payload yang sama memakan **~8 detik**, artinya semuanya praktis berjalan
  serial. Throughput nyata yang teramati adalah **~6 chunk/menit (~8-10 detik
  per chunk) berapa pun nilai flag concurrency**. Jangan merencanakan dengan
  asumsi percepatan 4x; lihat §6.7.

<a id="32-cluster-only-rerun-clustering--regenerate-report"></a>
### 3.2 Cluster-only (jalankan ulang clustering + buat ulang laporan)

```bash
"$G" cluster-only <path> --no-viz
```

- **Tidak menghormati `--model`** (§6.3). Variabel env `OLLAMA_MODEL`-lah yang
  membuat perintah ini berfungsi.
- `--no-viz` melewati `graph.html`; teks help merekomendasikannya di atas 5000
  node.
- `--no-label` mempertahankan placeholder `Community N` dan sama sekali
  melewati penamaan oleh LLM.

Revert: berikan `--no-cluster` pada extract berikutnya, atau hapus
`<path>/graphify-out/` (lihat §7).

<a id="33-label-name-communities"></a>
### 3.3 Label (menamai komunitas)

```bash
"$G" label <path> --missing-only
```

- Catatan soal `--model` sama seperti §3.2. Gunakan `OLLAMA_MODEL`.
- `--missing-only` mempertahankan label yang sudah ada dan hanya menamai
  komunitas yang labelnya hilang atau masih placeholder. Ini varian yang aman
  saat menjalankan ulang.

<a id="34-query--path--explain-read-only-no-backend-needed"></a>
### 3.4 Query / path / explain (hanya baca, tanpa backend)

```bash
"$G" query "<question>" --budget 2000
"$G" path "<node A>" "<node B>"
"$G" explain "<node>"
```

Ketiganya secara default memakai `--graph graphify-out/graph.json`. `query`
adalah BFS atas graf yang sudah ada; perintah ini tidak memanggil LLM.
**Terukur:** `query` mengembalikan jawaban berupa subgraf yang terlingkup dan
membuat node referensi untuk target wikilink bahkan ketika berkas target itu
sendiri tidak diekstraksi. Perilaku itu berguna untuk pekerjaan vault dan bukan
bug.

Revert: tidak ada. Perintah-perintah ini tidak menulis apa pun ke korpus.

<a id="341-getting-claude-code-sessions-to-query-hooks-registration-audit"></a>
#### 3.4.1 Membuat sesi Claude Code melakukan query: hook, registrasi, audit

Ditambahkan 2026-10-14. §3.4 hanya membantu ketika sebuah agen menjalankannya,
dan sebelum perubahan ini tidak ada yang membuat agen melakukannya. Claude Code
tidak memuat `AGENTS.md` milik repositori ketika ada `CLAUDE.md` di direktori
induk (mesin ini punya `~/CLAUDE.md`), sehingga aturan graphify di `AGENTS.md`
tidak pernah sampai ke sebagian besar sesi. **Terukur:** 14 dari 161 sesi Claude
Code tingkat atas dari 2026-10-08 sampai 2026-10-14 melakukan query graf
(dihitung dari event tool-use di `~/.claude/projects/**/*.jsonl`).

Jalankan perintah berikut dari checkout vivera. Dari direktori lain, gunakan
`bun <vivera>/scripts/graphify-hooks-install.mjs`, `graphify-register.mjs` atau
`graphify-audit.mjs` dengan argumen yang sama. Masing-masing menerima `--help`
(exit 0) dan mengabaikan `--` di awal argumen.

```text
bun run graphify:hooks (--install | --uninstall | --check) [--settings <path>] [--hooks-dir <dir>] [--dry-run]
bun run graphify:register <dir> [--never]
bun run graphify:audit <root>... [--json] [--max-depth N]
```

**Hook (`graphify:hooks`).** Menulis tiga entri ke `--settings` (default
`~/.claude/settings.json`). Masing-masing menjalankan `"<path to bun>" "<hooks-dir>/<script>"`
dengan `timeout: 10`; `--hooks-dir` secara default bernilai `scripts/hooks` di
checkout ini. Dari linked worktree, `--install` tanpa `--hooks-dir` menolak
(exit 1, tidak ada yang ditulis) dan menyebutkan checkout utama tempat perintah
itu harus dijalankan, karena worktree sesi dihapus setelah PR-nya di-merge dan
hook yang menunjuk ke dalamnya akan gagal.

- `SessionStart`, tanpa matcher, sehingga `compact` menyuntikkannya ulang:
  `graphify-session-start.mjs`
- `SubagentStart`: `graphify-session-start.mjs`
- `PreToolUse`, matcher `^(Grep|Glob|Read|Bash|mcp__graphify__.*)$`:
  `graphify-search-nudge.mjs`

Sebuah entri dianggap milik kita bila salah satu perintahnya mengandung
`/scripts/hooks/graphify-`. `--install` menghapus entri milik kita lalu
menambahkan yang baru, sehingga idempoten; `--uninstall` hanya menghapus entri
milik kita. Setiap key dan hook lain dipertahankan, dan setiap penulisan
bersifat atomik serta menyalin berkas sebelumnya ke `<settings>.bak`.
`--dry-run` mencetak JSON hasilnya dan tidak menulis apa pun. Kode exit:
`--check` bernilai 0 bila ketiga entri dan berkas skripnya ada, selain itu 1
dengan menyebutkan apa yang hilang. Berkas settings yang belum ada akan dibuat
oleh `--install` dan membuat `--check` exit 1. Berkas settings yang bukan JSON
valid, atau yang `hooks`-nya bukan objek, ditolak: exit 1, tidak ada yang
ditulis. `install.sh` hanya mencetak perintah instalasinya.

**Apa yang dilihat sebuah sesi.** Hook mengklasifikasikan direktori kerja dengan
`git` dan sebuah `stat` pada graf; hook tidak pernah mem-parse `graph.json`.
`<mainRoot>` adalah induk dari `git rev-parse --path-format=absolute --git-common-dir`,
sehingga sebuah worktree memakai graf yang dimiliki checkout utamanya.

| Status | Kondisi | SessionStart | SubagentStart |
|---|---|---|---|
| registered | `<mainRoot>/graphify-out/graph.json` ada | path graf; dari worktree, keterangan bahwa graf itu menggambarkan checkout utama; bila mtime graf lebih lama daripada commit HEAD checkout utama, keterangan bahwa `graphify update <mainRoot>` menyegarkannya secara offline; lalu `graphify query "<question>" --graph <graphPath>` (serta `path`, `explain`), atau MCP tool `query_graph` dengan `project_path` diisi `<mainRoot>` | sama |
| unregistered | tidak ada graf di checkout utama | keterangan bahwa tidak ada graf, sehingga query graf tidak tersedia; bahwa `bun <vivera>/scripts/graphify-register.mjs <mainRoot>` membangunnya secara offline dalam sekitar 13 detik per 2.000 berkas, dan `--never` menghentikan tawaran itu; bahwa pengguna meminta ditawari registrasi melalui question tool: Register now, Not now, Never for this repository | tidak ada |
| opted-out | `git -C <mainRoot> config --get graphify.register` mencetak `never` | tidak ada | tidak ada |
| not-git | tidak berada di dalam git work tree, atau git gagal | tidak ada | tidak ada |

Not now tidak mencatat apa pun, sehingga sesi berikutnya di repositori itu
menawarkannya lagi.

**Pengingat pencarian.** Hanya di repositori yang registered: satu pengingat per
sesi dan per agen, di samping hasil pencarian pertama yang dilakukan sebelum
query graf apa pun. Yang dihitung sebagai query adalah tool `mcp__graphify__`
apa pun, atau Bash dengan kata perintah `graphify` yang diikuti `query`, `path`
atau `explain`. Yang dihitung sebagai pencarian adalah `Grep`, `Glob`, `Read`
atas path yang tidak berakhiran `.md` dan tidak berada di bawah `graphify-out/`,
atau Bash yang kata perintah pertamanya `rg`, `grep`, `fd`, `find` atau `ag`.
State disimpan di `<stateDir>/<session_id>.<agent_id or main>.json`, dengan
`stateDir` berupa `GRAPHIFY_HOOK_STATE_DIR` atau `<os.tmpdir()>/graphify-hooks`.
Kedua hook exit 0 di setiap jalur, tidak mencetak apa pun saat terjadi error,
dan tidak pernah mencetak `permissionDecision`, sehingga keduanya tidak dapat
memblokir pemanggilan tool.

**Registrasi (`graphify:register <dir> [--never] [--global]`).** Me-resolve
`<mainRoot>`, menjalankan `graphify update <mainRoot>`, dan menambahkan
`graphify-out/` ke `<git-common-dir>/info/exclude` bila
`git check-ignore -q graphify-out/` gagal, sambil mencetak satu baris per
langkah. Hanya dengan `--global` perintah ini kemudian menjalankan
`graphify global add <graphPath> --as <basename of mainRoot>`; tanpanya,
perintah ini mencetak cara menambahkan graf tersebut nanti. Graf global bersifat
opt-in karena setiap server MCP graphify memuat seluruh isinya saat startup,
terukur 176 MB dengan 24.617 node dan setidaknya 625 MB dengan 126.291 node,
sehingga graf global hanya berisi hal yang memang perlu menjawab query yang
tidak menyebut repositori. Bila dijalankan dari worktree, perintah ini
mendaftarkan checkout utama; menjalankannya dua kali aman. Repositori yang
opted-out dilaporkan dan tidak dibangun. `--never` menjalankan
`git -C <mainRoot> config graphify.register never` dan tidak membangun apa pun.
Exit 0 bila selesai; 1 bila `graphify` tidak ada atau pemanggilan graphify exit
non-zero (baris tersebut menyebutkan langkah dan kode exit-nya); 2 untuk
kesalahan pemakaian atau `<dir>` yang bukan git.

Registrasi berjalan offline: `update` adalah parsing AST lokal, tanpa LLM dan
tanpa jaringan (§3.5), sehingga batas cloud di §1 tidak dilintasi. **Terukur
2026-10-14** pada salinan sekali pakai dengan jaringan dinonaktifkan
(`unshare -rn`): `graphify update .` membangun `fasttrack` (2.076 berkas) dari
nol menjadi 8.787 node dalam 12,8 detik, exit 0.

**Audit (`graphify:audit <root>... [--json] [--max-depth N]`).** Menelusuri
setiap root hingga kedalaman 4 secara default, melewati `node_modules`, `.cache`
dan direktori apa pun yang `.git`-nya berupa berkas (dihitung sebagai worktree,
tidak pernah sebagai unregistered). Mencetak path, kind, nodes, edges dan stale
per repositori ditambah satu baris total, atau JSON dengan `--json`.
`graph.json` yang tidak dapat dibaca atau tidak valid dilaporkan sebagai
registered dengan hitungan null dan sebuah catatan. Exit 1 selama masih ada
repositori yang `unregistered`, selain itu 0; 2 bila tidak ada root yang
diberikan atau root yang diberikan tidak ada.

UNMEASURED saat penulisan: teks konteks di sesi Claude Code yang benar-benar
berjalan (tes hook mengirim JSON ke skrip lewat pipe), dan apakah penggunaan
query meningkat setelah rollout. Satu pengingat per sesi dan agen adalah batas
bawah yang disengaja; batas ini baru berubah menjadi satu pengingat per N
pencarian jika penggunaan query yang terukur tetap di bawah 25% sesi setelah
rollout.

Revert:

- Hook: `bun run graphify:hooks --uninstall` hanya menghapus ketiga entri ini.
- Never: `git config --unset graphify.register`, dijalankan di repositori itu
  (worktree mana pun miliknya bisa dipakai; setelan ini lokal untuk repositori).
- Registrasi: hanya bila dijalankan dengan `--global`, `graphify global remove <tag>`,
  dengan tag berupa nama direktori checkout utama. Graf itu sendiri adalah
  output `graphify-out/` (lihat §7); baris `graphify-out/` di
  `<git-common-dir>/info/exclude` dihapus secara manual.

<a id="35-update"></a>
### 3.5 Pembaruan

```bash
"$G" update <path>
```

- Teks help: "re-extract code files and update the graph (**no LLM needed**)".
  Hanya AST, tanpa biaya API.
- `--force` menimpa `graph.json` bahkan ketika hasil rebuild punya lebih sedikit
  node; juga tersedia sebagai `GRAPHIFY_FORCE=1`. Gunakan setelah refactor yang
  menghapus simbol, karena tanpanya jumlah node diam-diam menurun.

<a id="36-obsidian-export-flag-names-verified-separately"></a>
### 3.6 Ekspor Obsidian: nama flag, diverifikasi terpisah

Ada dua hal yang berbeda, dan hanya satu yang terlihat di help CLI versi ini:

- **Perintah yang DIKONFIRMASI BERFUNGSI, diverifikasi dengan benar-benar
  menjalankannya di mesin ini (v0.9.73):**
  ```bash
  "$G" export obsidian --dir <vault-dir>
  ```
  Flag-nya adalah `--dir PATH` pada subperintah `export obsidian`. Opsi yang
  tampil di `graphify --help`: `--graph PATH`, `--labels PATH`, `--dir PATH`.
  Menghasilkan catatan vault Obsidian + canvas. Gunakan yang ini.
- **Jangan gunakan `--obsidian --obsidian-dir`.** Pasangan itu dilaporkan ada di
  jalur ekstraksi/skill tetapi **tidak** ada di output `extract --help` v0.9.73
  yang direkam di mesin ini, dan ekspor yang benar-benar dijalankan adalah
  bentuk `--dir` di atas. Jika Anda melihat `--obsidian --obsidian-dir` di
  sebuah skill atau README, itu keliru untuk versi ini.
- **Perilaku terverifikasi, dari run yang teramati:** ekspor ini **menolak
  menimpa berkas pengguna yang sudah ada sebelumnya**. Ekspor melewatinya dan
  mengeluarkan peringatan yang menyebutkan apa saja yang dilewati. Pesan yang
  teramati:
  ```
  skipped 1 pre-existing file(s) graphify did not create, to avoid overwriting your notes
  ```
  Ekspor ini juga tidak pernah menyentuh konfigurasi `.obsidian`. Hanya berkas
  yang dibuat graphify yang ditulis.
- UNMEASURED: perilaku tabrakan saat catatan dengan nama yang sama sudah ada
  baru diukur ke arah *skip* di atas; apakah graphify pernah menambahkan sufiks
  alih-alih melewati masih belum teramati. Pada run yang teramati, graphify
  melewatinya; jangan menggeneralisasi aturan skip ke sufiks.

Revert: hapus catatan yang dibuat oleh ekspor. Tidak ada `export obsidian
--revert`. Karena ekspor menolak menimpa, revert cukup menangani berkas yang
ditambahkan saja. Lihat §7 untuk prosedur penghapusan dan pengamannya.

---

<a id="4-graphifyignore-is-a-safety-boundary-not-an-optimisation"></a>
## 4. `.graphifyignore` adalah batas keamanan, bukan optimasi

<a id="41-mechanics-verified"></a>
### 4.1 Mekanisme (terverifikasi)

- graphify **tidak punya flag `--no-graphifyignore`.** `.graphifyignore` selalu
  diberlakukan.
- Pola-polanya digabung dengan `.gitignore` dan dievaluasi paling akhir, jadi saat
  keduanya bertentangan, `.graphifyignore` yang menang.
- `extract --no-gitignore` memang ada dan mengabaikan `.gitignore` + `.git/info/exclude`
  *sambil tetap memprioritaskan `.graphifyignore`*. Ini bukan jalan keluar untuk
  melewati `.graphifyignore`.

<a id="42-why-it-is-the-boundary"></a>
### 4.2 Mengapa file ini menjadi batasnya

Karena fakta di §1 bahwa konten keluar dari mesin itu benar, dan karena satu-satunya
kendali atas konten *mana* yang keluar adalah file ini, pola yang terlalu luas adalah bug
eksfiltrasi data, bukan sekadar build yang lambat. Tidak ada apa pun di CLI yang akan
memperingatkan Anda.

<a id="43-the-vault-trade-off-measured-updated-2026-10-03"></a>
### 4.3 Trade-off vault, terukur (**diperbarui 2026-10-03**)

Korpus vault Obsidian: total **3087 file markdown / 42,0 MB** (2026-10-01).

| Cakupan | File | Ukuran | ~Token |
|---|---|---|---|
| Seluruh vault | 3087 | 42,0 MB | UNMEASURED pada cakupan penuh |
| **Di bawah `.graphifyignore` ketat milik vault (2026-10-01)** | **1312** | **11,4 MB** | **~2,86 M** |
| **Di bawah `.graphifyignore` ketat milik vault (2026-10-03, setelah T9)** | **1585** | **tidak dicatat** | **tidak dicatat** |
| Sama, tetapi tanpa pengecualian `sources/` | 2539 | tidak dicatat | ~6,90 M |

File ketat itu mengecualikan empat path berikut (tidak berubah sejak 2026-10-01):

- `Satset/`
- `90 - System/Legacy/`
- `03 - Resources/LLM Wiki/sources/`
- `03 - Resources/Attachments/` (ditambahkan setelah pengukuran; lihat §4.3.1)

**Koreksi: baca ini sebelum mengutip total "catatan yang dikecualikan" mana pun.** Revisi
sebelumnya dari file ini menyebut cakupan ketat "membuang **1227 catatan**" dan memuat
satu paragraf yang mencoba merekonsiliasi 1227 dengan selisih mentah 3087 − 1312 = 1765.
Keduanya salah. Posisi yang terverifikasi adalah:

- **1227 adalah jumlah file di dalam `03 - Resources/LLM Wiki/sources/`
  secara khusus**, yaitu satu set pengecualian, bukan totalnya.
- Total vault adalah **3087 file md / 42,0 MB**; di bawah `.graphifyignore` ketat
  (2026-10-01), **tersisa 1312 file / 11,4 MB / ~2,86 M token.**
- Di bawah `.graphifyignore` ketat (2026-10-03, setelah penghapusan raw-capture N8n
  di commit `3a968b2` dan penambahan GROUP 7 pada `.graphifyignore` di
  `c20b3be`), **1585 file tetap memenuhi syarat.**

Jadi total yang dikecualikan adalah komplemen dari sisa yang terukur, dan file ini tidak
mengutip angka terukur tersendiri untuknya. Jika sesi mendatang membutuhkannya, turunkan
sekali dari dua hitungan terukur itu dan beri label sebagai aritmetika. Jangan
menghidupkan kembali "1227" sebagai total.

**Catatan tentang angka 2360 dari plan 2026-10-02:** plan itu mengukur
`graphify.detect.detect()` pada root vault, yang menghitung *semua* file yang dilihat
detector (termasuk `.txt`, `.yaml`, dan seterusnya). Manifest T9 memakai filter ekstensi
yang lebih sempit (`.md`, `.mdx`, `.pdf`), sehingga 1585 file yang memenuhi syarat di
sana merupakan subset dari 2360 file yang dilaporkan plan. Keduanya terukur; selisihnya
berasal dari filter ekstensi, bukan dari perubahan korpus.

<a id="431-03---resourcesattachments-added-measured-reason"></a>
#### 4.3.1 `03 - Resources/Attachments/`: ditambahkan, dengan alasan terukur

**DITERAPKAN** pada `.graphifyignore` milik vault. Alasan terukur untuk penambahan ini:

- direktori itu berisi **252 gambar**;
- **chunk vision mendominasi wall-clock**, sehingga proyeksi run **947 chunk** membengkak
  hingga **~4 jam**;
- setelah gambar-gambar itu dikecualikan, run menjadi **791 chunk dari 1282 file**.

Perhatikan bahwa dua hitungan file itu berbeda: **1282** adalah hitungan untuk run
tersebut setelah pengecualian Attachments, sedangkan **1312** adalah hitungan korpus
strict-ignore pada tabel di atas. File ini tidak merekonsiliasi selisih 30 file itu
(UNMEASURED path mana yang menjadi penyebabnya). Kedua angka terukur; tidak satu pun
disesuaikan agar cocok dengan yang lain.

**Memperluas cakupan adalah edit yang ditinjau dan disengaja pada file ignore.** Tidak
ada flag untuk itu. Prosedurnya:

1. Salin file saat ini: `cp .graphifyignore .graphifyignore.bak-$(date +%Y%m%d)`
2. Keluarkan tepat satu path yang dikecualikan, tambahkan komentar bertanggal yang
   menyebutkan alasannya, lalu jalankan ulang hitungan korpus sebelum mengekstrak.
3. Nyatakan secara eksplisit bahwa langkah ini memperluas apa yang dikirim ke model cloud.
4. Untuk membatalkan: pulihkan salinan `.bak`.

<a id="44-the-vault-gitignore-stale-pattern-fix-applied"></a>
### 4.4 Perbaikan pola usang di `.gitignore` vault: DITERAPKAN

**Perbaikan ini sekarang sudah diterapkan pada `.gitignore` milik vault.** Revisi
sebelumnya dari file ini membiarkan pola-pola usang itu tetap ada; kondisi itu sudah
tidak berlaku. Yang diubah, terukur:

- **88** pola `wiki/sources/...` **di-anchor ulang** menjadi
  `/03 - Resources/LLM Wiki/sources/...`. Dalam bentuk aslinya, pola-pola itu tidak
  mencocokkan apa pun yang berguna.
- **20 nama file sensitif tambahan yang belum pernah dienumerasi** ditambahkan. Ini
  adalah nama-nama yang belum pernah dicantumkan oleh pass mana pun sebelumnya, dan
  ditemukan lewat enumerasi saat patch dibuat.
- Cadangan file sebelum patch: **`/tmp/opencode/vault.gitignore.bak`**.

**Diterapkan bukan berarti selesai. Ini bagian yang penting.** Aturan ignore hanya
berlaku untuk file yang belum dilacak git. Aturan itu **TIDAK** menghentikan pelacakan
file yang sudah dilacak. **29 catatan sensitif yang sudah dilacak masih tetap dilacak**
dan masing-masing masih memerlukan `git rm --cached <path>`. **`git rm
--cached` itu BELUM dijalankan.** Sampai langkah itu dilakukan, `.gitignore` yang sudah
di-patch tidak melindungi apa pun untuk 29 file tersebut: file-file itu tetap ada di
index dan di history.

Kembalikan patch `.gitignore` itu sendiri: `cp /tmp/opencode/vault.gitignore.bak <vault>/.gitignore`.

---

<a id="5-measured-performance"></a>
## 5. Performa terukur

Pengukuran single-chunk di mesin ini, satu chunk ~4k token per run, diambil pada
2026-10-01. **Ini adalah angka single-chunk, bukan rata-rata.** Perlakukan angka ini
sebagai orde besaran, dan ukur ulang sebelum mengandalkannya untuk penjadwalan.

| Backend / model | Wall clock | Laju generasi | Kebenaran output |
|---|---|---|---|
| Lokal `llama3.2:3b` | 240,1 s | 2,16 tok/s | **GAGAL**: mengembalikan prosa di dalam code fence, bukan JSON yang valid |
| Lokal `qwen3:1.7b` | UNMEASURED | 10,5 tok/s | **GAGAL**: menghasilkan respons kosong |
| Cloud `gpt-oss:120b-cloud` | **7,0 s** (chunk 4053 token) | **422,8 tok/s** | **VALID**: 20 node / 25 edge |

Diturunkan dari pengukuran tersebut (aritmetika, bukan pengukuran baru):

- Percepatan wall-clock dibanding `llama3.2:3b`: 240,1 / 7,0 = **~34x**.
- Rasio laju generasi dibanding `qwen3:1.7b`: 422,8 / 10,5 = ~40x; dibanding
  `llama3.2:3b`: ~196x.
- Proyeksi waktu generasi untuk satu chunk 4053 token pada laju 10,5 tok/s milik
  `qwen3:1.7b` adalah ~386 s. Ini hanya aritmetika: model itu tidak mengembalikan apa
  pun, sehingga wall clock lokal end-to-end untuknya tidak pernah teramati.

**Kesimpulan (terukur): model lokal tidak layak untuk beban kerja ini di mesin ini.**
Keduanya gagal pada kebenaran output, bukan hanya pada kecepatan. Itulah sebabnya
batasan cloud di §1 memang tidak bisa dihindari, bukan sekadar jalan pintas.

<a id="51-full-vault-wall-clock-withdrawn-no-parallel-speedup"></a>
### 5.1 Wall clock seluruh vault: DITARIK, tidak ada percepatan paralel

**Tabel multi-worker yang dulu ada di sini salah. Tabel itu ditarik, bukan diralat.**
Tabel itu ditampilkan ulang di bawah hanya agar sesi mendatang tidak mengira
ketiadaannya sebagai kelalaian; **setiap baris kecuali baris 1 worker adalah SALAH, dan
baris 1 worker adalah proyeksi yang belum divalidasi.** Jangan gunakan bagian mana pun
darinya.

| Worker | Proyeksi wall clock setara serial | Status |
|---|---|---|
| 1 (serial) | 1,67 jam | DITARIK: proyeksi, tidak pernah diukur |
| 4 | 0,42 jam | **SALAH**: tidak ada percepatan |
| 8 | 0,21 jam | **SALAH**: tidak ada percepatan |

Baris-baris itu menyiratkan percepatan paralel yang **tidak ada pada backend ini**.
Diukur langsung pada 2026-10-01:

- Saat sebuah ekstraksi sedang berjalan, **4 request generate `gpt-oss:120b-cloud`
  identik yang dikirim secara paralel memakan wall clock 41 s.**
- Satu request dengan payload yang sama memakan **~8 s**, jadi 4 x 8 s = 32 s.
- 41 s dibanding baseline serial 32 s berarti request-request itu berjalan **pada
  dasarnya secara serial**, bukan bersamaan.

**Karena itu `graphify extract --max-concurrency 4` TIDAK memberi percepatan di sini.**
Throughput nyata yang terukur adalah **~6 chunk/menit**, yaitu **~8-10 s per chunk, apa
pun nilai flag concurrency-nya**. Itulah angka yang menjadi acuan penjadwalan.

Jangan memasang kembali tabel worker dari ingatan. Jika Anda membutuhkan wall clock run
penuh, **ukurlah**. Jangan memproyeksikannya dari angka single-chunk 7,0 s di §5, yang
merupakan sampel satu chunk, bukan rata-rata.

<a id="the-two-distinct-concurrency-facts-do-not-conflate-them"></a>
#### Dua fakta concurrency yang berbeda: jangan dicampuradukkan

| Fakta | Status | Detail |
|---|---|---|
| `label` / `cluster-only` **memaksa concurrency menjadi 1** saat backend-nya `ollama` | Dinyatakan oleh teks `--help` milik subcommand tersebut di mesin ini ("forced to 1 for ollama/claude-cli") | Batas keras di sisi CLI, diterapkan sebelum request apa pun dibuat. §3.2, §3.3. |
| `extract` **menyediakan `--max-concurrency` dengan default 4** | Flag-nya ada; `extract --help` **tidak** mengulang catatan forced-to-1 itu | Flag itu diterima, tetapi tetap tidak menghasilkan percepatan paralel, karena backend cloud itu sendiri menyerialkan request. §3.1. |

Fakta kedua tidak bertentangan dengan fakta pertama: bahkan saat flag itu tidak dibatasi,
backend tetap mengantrekan request. Menaikkan nilainya bukan cara untuk menembus batas
~6 chunk/menit.

<a id="what-is-still-valid-from-the-old-projection"></a>
#### Yang masih valid dari proyeksi lama

- **Jumlah chunk, aritmetika dari input terukur:** **~2,86 M token** pada cakupan ketat,
  dengan 3306 token/chunk, diperkirakan menjadi **866 chunk**. Run yang benar-benar diukur
  setelah pengecualian Attachments (§4.3.1) adalah **791 chunk dari 1282 file**. Kedua
  angka dicatat; file ini tidak merekonsiliasi selisihnya (UNMEASURED).
- Cakupan yang lebih luas (**~6,90 M token, ~2087 chunk**) diproyeksikan menjadi **~4,06
  jam serial** dengan waktu chunk dari §5. Hanya aritmetika. Proyeksi serial adalah
  *satu-satunya* bentuk proyeksi yang didukung backend ini, mengingat pengukuran di atas.
- Tidak ada rate limiting yang teramati selama 12 panggilan berturut-turut, tetapi 12
  panggilan tidak membuktikan apa pun soal kuota.

---

<a id="6-known-traps-every-one-of-these-was-actually-hit"></a>
## 6. Jebakan yang diketahui: semuanya benar-benar pernah terjadi

<a id="61-missing-ollama-extra"></a>
### 6.1 Extra `[ollama]` tidak terpasang

Gejala: `the 'openai' package is required for this backend`. Perbaikan:
`uv tool install --force "graphifyy[ollama]"`. Paket `graphifyy` biasa bisa terpasang
dan tampak berfungsi sampai backend ollama dipanggil untuk pertama kali.

<a id="62-think-false-is-ignored-on-apigenerate"></a>
### 6.2 `think: false` diabaikan pada `/api/generate`

Gejala: meskipun `think:false` diminta, `gpt-oss` menghabiskan seluruh anggaran output
untuk reasoning dan mengembalikan **respons kosong**.

Penyebab: secara default parameter itu diabaikan pada path `/api/generate`.

Konfigurasi yang andal membutuhkan ketiga hal berikut sekaligus:

1. `think:false`, **dan**
2. batas token eksplisit yang dinyatakan **di dalam teks prompt**, **dan**
3. `num_predict` yang tinggi.

Menghilangkan salah satu dari ketiganya akan memunculkan kembali respons kosong itu.

<a id="63---model-is-ignored-by-cluster-only-and-label"></a>
### 6.3 `--model` diabaikan oleh `cluster-only` dan `label`

Gejala: kedua perintah kembali ke `qwen2.5-coder:7b` yang di-hardcode dan gagal dengan
**404** di mesin ini, bahkan ketika `--model gpt-oss:120b-cloud` sudah diberikan.

Perbaikan: gunakan environment variable `OLLAMA_MODEL`. Cara itu **memang** berhasil.
Inilah satu-satunya tempat `OLLAMA_MODEL` bersifat wajib, bukan opsional.

<a id="64-markdown-extraction-requires-an-llm-backend-updated-2026-10-03"></a>
### 6.4 Ekstraksi markdown membutuhkan backend LLM (**diperbarui 2026-10-03**)

**Tidak ada mode khusus lokal untuk `.md`**. `--code-only` melewati dokumen sepenuhnya,
jadi itu bukan pengganti. Digabung dengan §5 (model lokal tidak bisa dipakai), hasilnya
adalah knowledge graph "AST-only, gratis" dari vault markdown **tidak bisa dicapai** di
mesin ini **lewat jalur ekstraksi cloud-LLM**. Rencanakan biaya cloud dan egress cloud,
atau jangan mengindeks vault.

**Pembaruan 2026-10-03: jalur subagent mengubah gambaran ini.** T7 di
`docs/code-plan/plans/2026-10-02-subagent-driven-vault-index.md` menunjukkan bahwa lapisan
struktural (dokumen, heading, wikilink) **sama sekali tidak membutuhkan model**: lapisan
itu adalah parse deterministik atas frontmatter dan sintaks markdown. T8 menunjukkan bahwa
lapisan semantik (konsep, alasan, tautan lintas file) dapat dijalankan secara lokal oleh
subagent fan-out terhadap vault, menghasilkan 271 file chunk yang digabung ke format graph
yang sama. Jalur subagent ini gratis (tanpa panggilan API LLM), deterministik, dan diukur
pada 1585 file yang memenuhi syarat: 20214 node / 18812 link dengan degree-0 1358.
Pertahankan pengukuran asli di atas dan tambahkan jalur subagent di sampingnya, alih-alih
menghapusnya.

<a id="65-no---no-graphifyignore"></a>
### 6.5 Tidak ada `--no-graphifyignore`

Lihat §4.1. `.graphifyignore` tidak bisa dilewati dari CLI; file ini menang atas
`.gitignore` saat terjadi konflik.

<a id="66-not-a-trap-but-commonly-assumed-update-is-not-free-of-surprises"></a>
### 6.6 Bukan jebakan, tetapi sering diasumsikan: update tidak bebas kejutan

`graphify update` bersifat AST-only (tanpa LLM), yang berarti perintah ini **tidak** akan
menangkap semantik markdown yang baru. Setelah menambah atau mengedit prosa, Anda perlu
menjalankan `extract` penuh. Gunakan `update --force` setelah refactor yang menghapus
simbol, karena tanpa itu jumlah node menurun diam-diam.

<a id="67-the-cloud-backend-does-not-parallelise---max-concurrency-is-not-a-speedup"></a>
### 6.7 Backend cloud tidak memproses secara paralel: `--max-concurrency` bukan percepatan

**DIUKUR 2026-10-01. Inilah jebakan yang menghasilkan angka-angka salah yang disorot di
§5.1.**

Gejala: Anda memberikan `--max-concurrency 4`, run memakan waktu sama lamanya dengan
serial, padahal proyeksi jumlah worker di atas kertas mengatakan seharusnya 4x lebih cepat.

Penyebab: backend **cloud** ollama pada akun ini menyerialkan request. Diukur saat sebuah
ekstraksi sedang berjalan:

| Uji | Hasil |
|---|---|
| 4 request generate `gpt-oss:120b-cloud` identik yang dikirim secara paralel | wall clock **41 s** |
| Satu request, payload yang sama | **~8 s** |
| Baseline serial (4 x 8 s) | **32 s** |

41 s dibanding baseline 32 s pada dasarnya adalah eksekusi serial, bukan concurrency.

**Konsekuensi: `--max-concurrency` TIDAK memberi percepatan pada `extract` terhadap
backend ini.** Throughput nyata yang terukur adalah **~6 chunk/menit (~8-10 s per chunk),
apa pun nilai flag-nya.**

Ketelitian yang penting, dan kesalahan yang harus dihindari:

| | `label`, `cluster-only` | `extract` |
|---|---|---|
| `--max-concurrency` dipaksa menjadi 1 oleh CLI | **YA**, dinyatakan di `--help` keduanya ("forced to 1 for ollama/claude-cli") | **Tidak**: flag-nya ada dengan default 4 dan help-nya tidak memuat catatan itu |
| Percepatan paralel tersedia | Tidak (dibatasi sebelum request dibuat) | **Tetap tidak**: backend mengantrekan request |

Ini adalah dua mekanisme berbeda dengan hasil akhir yang sama. Mencampuradukkan keduanya
menghasilkan kesalahan yang sudah pernah dibuat file ini: menganggap "flag-nya tidak
dibatasi pada extract" sama dengan "flag-nya berfungsi pada extract". Kenyataannya tidak.

---

<a id="7-revert-for-every-step"></a>
## 7. Revert untuk setiap langkah

Tidak ada langkah dalam runbook ini yang dengan sendirinya menulis pengaturan
permanen. Daftar revert lengkapnya:

| Langkah | Revert |
|---|---|
| Variabel env shell | `unset G OLLAMA_HOST OLLAMA_API_KEY OLLAMA_MODEL` |
| `ollama serve` | Hentikan proses yang Anda jalankan. Jangan uninstall tanpa instruksi eksplisit. |
| `uv tool install "graphifyy[ollama]"` | `uv tool uninstall graphifyy` |
| Output `extract` | `rm -rf <path>/graphify-out/` (hanya file hasil generate). Atau `graphify uninstall --purge` (menghapus graphify-out/ beserta konfigurasi platform). |
| Sidecar hasil generate di samping `graph.json` (`.graphify_analysis.json`, `.graphify_labels.json`, `GRAPH_REPORT.md`, `graph.html`, `GRAPH_TREE.html`, `memory/`, `reflections/`) | Semuanya berada di dalam `graphify-out/` atau terdeteksi otomatis di samping `graph.json`; hapus setelah memastikan path persisnya dengan `ls` |
| Edit `.graphifyignore` | Pulihkan: `cp .graphifyignore .graphifyignore.bak-<YYYYMMDD>` |
| Perbaikan pola usang di `.gitignore` vault (SUDAH DITERAPKAN, §4.4) | `cp /tmp/opencode/vault.gitignore.bak <vault>/.gitignore` |
| Catatan Obsidian yang dibuat oleh `export obsidian` | Tidak ada revert bawaan. Perintah ini menolak menimpa catatan yang sudah ada dan memberi peringatan tentang apa saja yang dilewatinya, jadi hanya catatan baru yang perlu dihapus. **Daftarkan catatan itu secara eksplisit dan hapus berdasarkan nama. Jangan pernah `rm -rf` sebuah direktori vault.** |
| `graphify hook install` | `graphify hook uninstall` |
| `bun run graphify:hooks --install` (§3.4.1) | `bun run graphify:hooks --uninstall` |
| `bun run graphify:register <dir> --never` (§3.4.1) | `git config --unset graphify.register`, dijalankan di repositori tersebut |
| `bun run graphify:register <dir>` (§3.4.1) | `graphify global remove <tag>` (nama direktori main checkout), hanya jika perintah itu dijalankan dengan `--global`; hapus baris `graphify-out/` yang mungkin ditambahkannya ke `<git-common-dir>/info/exclude`; untuk graph-nya, sama seperti output `extract` di atas |
| `graphify install --platform <p>` / `opencode install` / `codex install` / dll. | Subcommand `uninstall` yang sesuai (mis. `graphify uninstall`, `graphify codex uninstall`) |
| `.graphifyignore` untuk repo **ini** | Tidak diubah oleh runbook ini. Saat ini file tersebut tidak mendeklarasikan batas cloud; lihat §1. |

Pengaman untuk setiap baris destruktif di atas: pastikan target dengan `ls` lebih
dulu, dan jangan pernah memakai penghapusan rekursif terhadap path yang belum
Anda tampilkan barusan. Aturan tetap di mesin ini adalah hanya file yang dibuat
dalam sesi saat ini yang boleh dihapus.

---

<a id="8-measured-vs-unmeasured-quick-index"></a>
## 8. Terukur vs belum terukur: indeks cepat

Terukur di mesin ini: path CLI dan versi 0.9.73; string kegagalan extra
`[ollama]`; waktu chunk lokal vs cloud, laju, dan kebenaran output; kegagalan
respons kosong `think:false`; fallback `--model` → 404 di
`cluster-only`/`label` serta perbaikan `OLLAMA_MODEL`; tidak adanya
`--no-graphifyignore` dan urutan prioritas merge; markdown yang memerlukan
backend LLM; `query` yang membuat node referensi wikilink; jumlah korpus vault
di bawah setiap cakupan ignore; tidak adanya batas cloud apa pun di
`.graphifyignore` repo ini; tidak ada 429 di 12 panggilan.

Juga terukur, ditambahkan pada revisi 2026-10-01:

- **Backend cloud tidak memproses secara paralel**: 4 request generate
  `gpt-oss:120b-cloud` paralel memakan 41 s dibanding baseline serial 32 s,
  sementara satu request tunggal butuh ~8 s. Throughput nyata **~6 chunk/menit
  (~8-10 s per chunk) berapa pun nilai `--max-concurrency`** (§5.1, §6.7).
- **`label`/`cluster-only` memaksa concurrency menjadi 1** untuk backend ollama,
  menurut teks `--help` mereka sendiri. Ini fakta yang terpisah dari serialisasi
  di atas (§6.7).
- **`export obsidian --dir PATH` adalah perintah export yang berfungsi**, bukan
  `--obsidian --obsidian-dir`; perintah ini **menolak menimpa file yang sudah ada
  sebelumnya**, dengan peringatan "skipped 1 pre-existing file(s) graphify did
  not create, to avoid overwriting your notes" (§3.6).
- **Perbaikan pola usang di `.gitignore` vault SUDAH DITERAPKAN**: 88 pola
  `wiki/sources/...` di-anchor ulang ke `/03 - Resources/LLM Wiki/sources/...`,
  20 nama file sensitif tambahan yang belum pernah didaftarkan ikut ditambahkan,
  dan cadangan sebelum patch ada di `/tmp/opencode/vault.gitignore.bak`. **29
  catatan sensitif yang sudah terlacak masih terlacak dan masih perlu
  `git rm --cached`, yang BELUM dilakukan** (§4.4).
- **`03 - Resources/Attachments/` ditambahkan ke `.graphifyignore` vault**: ada
  252 gambar di sana, chunk vision mendominasi wall clock, dan run 947 chunk
  diproyeksikan memakan ~4 jam; setelah dikecualikan, 791 chunk atas 1282 file
  (§4.3.1).
- **1227 adalah jumlah file di dalam `03 - Resources/LLM Wiki/sources/`,** bukan
  jumlah seluruh catatan yang dikecualikan. Angka vault yang terverifikasi: 3087
  file md / 42,0 MB total; 1312 file / 11,4 MB / ~2,86 M token di bawah ignore
  ketat (§1, §4.3).

BELUM TERUKUR dan ditandai inline di atas: retensi body request oleh penyedia
cloud; wall clock lokal end-to-end untuk `qwen3:1.7b`; apakah run penuh dengan
cakupan ketat cocok dengan estimasi aritmetika 866 chunk atau dengan run
terukur 791 chunk (§5.1); selisih 30 file antara hitungan cakupan ketat 1312
file dan hitungan run pasca-Attachments 1282 file (§4.3.1); keberadaan
`--obsidian --obsidian-dir` di `extract --help` v0.9.73 (§3.6); apakah
`export obsidian` pernah menambahkan sufiks alih-alih melewati file saat terjadi
tabrakan nama (§3.6).

**Ditarik karena terukur tetapi salah:** tabel proyeksi wall clock 1,67 h /
0,42 h / 8-worker (§5.1). Percepatan yang disiratkannya tidak ada di backend ini.
Jangan memulihkannya dari ingatan. Ukur ulang jika Anda memerlukan angka run penuh.
---

<a id="8-the-1299-unattributable-nodes-f7-decided-with-measurements"></a>
## 8. 1.299 node yang tidak dapat diatribusikan: F7, diputuskan dengan pengukuran

`graph.json` milik vault yang sudah ada memuat **6.155 node dan 5.527 link**.
Dari node tersebut, **1.299 memiliki `source_file` yang `null` (1.269) atau
kosong (30)** dan **1.185 di antaranya merupakan endpoint dari setidaknya satu
edge**. Berdasarkan `file_type`: `document` 769, `concept` 460, `code` 61,
`paper` 9.

Node-node ini gagal di `chunk-schema.mjs` (`source_file` harus berupa path
relatif terhadap repo), sehingga graph hasil merge yang memuatnya bukan chunk
yang valid, dan kegagalannya baru muncul belakangan sebagai 1.299 error validasi
tanpa petunjuk asal-usulnya. `vault-index-merge.mjs` sebelumnya menghitungnya
(`previousNodesUnusableSourceFile`) dan mempertahankannya. F7 adalah keputusan
tentang apa yang terjadi selanjutnya, dan kini menjadi opsi eksplisit,
`ghostPolicy`.

<a id="81-measured-not-assumed"></a>
### 8.1 Diukur, bukan diasumsikan

Dijalankan terhadap vault yang sebenarnya (lapisan struktural atas 3.390 file
markdown-nya dimasukkan sebagai satu chunk ke `merge()` dengan `graph.json` yang
sebenarnya sebagai `previous`):

| Kebijakan | node keluar | diatribusikan ulang | ambigu | tidak cocok | dihapus | link menjadi yatim |
|---|---|---|---|---|---|---|
| `reattribute` (default) | 27.849 | **453** | 297 | 549 | 0 | 0 |
| `drop` | 26.550 | 0 | 0 | 0 | **1.299** | **1.454** |

**Tiga angka yang diminta F7: 453 unik, 297 ambigu, 549 tanpa kecocokan.**

Dua kontrol independen, karena "kecocokan unik" tidak berarti apa-apa jika
keunikan mudah didapat:

- Semua **453** nilai `source_file` hasil atribusi ulang **ada di disk**
  (`statSync`, file). Nol path karangan.
- **0 dari 453** label yang dibuat secara acak cocok dengan judul mana pun.
  Kecocokannya informatif, bukan kebetulan dari kumpulan 6.155 node.
- **408 dari 453** path yang diselamatkan menguatkan label ghost (judul catatan,
  H1, atau nama file). 45 sisanya sebagian besar adalah ghost concept yang
  menunjuk ke catatan yang sekadar membahas istilah tersebut (lihat §8.4).

Kumpulan kandidat adalah **gabungan** (previous + chunk yang masuk), dengan
kunci `file_type` + `foldLabel()`. Dari 453 itu, **402** berasal dari lapisan
struktural baru dan **51** dari node previous yang sudah memiliki path nyata.
Kumpulan gabungan ini disengaja: ekstraksi graph itu sendiri sebelumnya adalah
bukti tentang catatan asal sebuah node, dan mengabaikannya berarti membuang 51
kecocokan tanpa keuntungan apa pun.

<a id="82-why-the-default-is-reattribute"></a>
### 8.2 Mengapa default-nya `reattribute`

Dari kedua opsi, hanya opsi ini yang **tidak dapat menghancurkan hasil kerja**.

- `drop` menghapus **1.299 node (21,1% dari graph) dan membuat 1.454 link
  menjadi yatim, 26,3% dari semua link**, karena 1.185 dari node tersebut
  membawa edge. Kebijakan yang menghilangkan seperempat graph akibat cacat pada
  satu field semestinya baru berlaku jika seseorang mengetikkannya sendiri.
- `reattribute` mengisi 453 path dan tidak menyentuh apa pun selain itu. Mode
  kegagalannya adalah path yang **salah**; mode kegagalan `drop` adalah path
  yang **hilang**. Path yang salah terlihat di `ghostNodesReattributed` dan dapat
  diperiksa ulang terhadap disk; path yang hilang tidak terlihat lagi setelah
  ditulis.

Fakta bahwa 694 dari 769 ghost `document` membawa label yang cocok dengan judul
*suatu* catatan nyata itulah yang menjadikan ini opsi yang dapat dipulihkan,
bukan sekadar opsi yang main aman: tumpang-tindih label sebesar sembilan puluh
persen bukanlah ciri data sampah. Ini adalah node judul catatan yang kehilangan
path-nya.

<a id="83-what-reattribute-refuses-to-do"></a>
### 8.3 Yang ditolak oleh `reattribute`

Kecocokan yang **ambigu** dihitung (`ambiguousReattribution`), tidak pernah
ditebak. Terukur: 297. Dua catatan memiliki judul yang sama dan graph tidak dapat
menentukan dari catatan mana sebuah node berasal; memilih yang pertama akan
menulis rekaman provenance yang tidak dapat dibedakan dari hasil ekstraksi, dan
itulah kegagalan yang dianggap paling buruk oleh codebase ini.

Sebuah kecocokan dianggap unik hanya jika **tepat satu** node gabungan memiliki
`file_type` yang sama sekaligus `foldLabel()` yang sama.

- **`file_type` adalah bagian dari kunci.** Lapisan struktural hanya
  menghasilkan node `document`, sehingga kunci tanpa tipe akan menawarkan judul
  suatu dokumen sebagai asal bagi masing-masing dari 460 ghost `concept`. 460
  adalah kelas tunggal terbesar yang tidak dapat diatribusikan ulang dengan aman
  lewat cara ini.
- **`foldLabel()`** melakukan case-folding, menghapus aksen (NFKD), dan
  meringkas setiap deretan karakter non-alfanumerik menjadi satu spasi, sehingga
  `AI Tools List` = `ai-tools-list` dan `Café Strategy` = `cafe strategy`. Fungsi
  ini sengaja **bukan** `norm_label` milik graph itu sendiri, yang ditetapkan
  oleh pass berikutnya dengan aturannya sendiri dan tidak ada pada 30 node.
- Label yang ter-fold menjadi `''` tidak cocok dengan apa pun. Ghost dengan label
  kosong dilaporkan, tidak pernah dilekatkan ke judul nyata pertama.

<a id="84-the-honest-limit-846-stay-unattributed"></a>
### 8.4 Batas yang jujur: 846 tetap tanpa atribusi

Dengan default, **846 dari 1.299 tetap tanpa path**: 297 ambigu, 549 tanpa
kecocokan. Ini hasil yang benar, bukan bug yang harus diakali:

| tipe | total | diatribusikan ulang | masih tanpa atribusi | yang membawa edge |
|---|---|---|---|---|
| `document` | 769 | 404 | 365 | 753 |
| `concept` | 460 | 48 | 412 | 387 |
| `code` | 61 | 1 | 60 | 36 |
| `paper` | 9 | 0 | 9 | 9 |

Dua alasan struktural:

1. **30 ghost `code` dengan `""`/`null` adalah artefak AST**, mis. id seperti
   `scripts_watch_inbox_py_path` berlabel `Path` atau `Any`. Ini nama simbol
   Python, bukan judul catatan; pencocokan judul adalah alat yang salah. 1.285
   dari 1.299 memiliki `_origin: null` dan 14 memiliki `_origin: ast`.
2. **Ghost concept menamai sebuah istilah, bukan catatan.** Konsep yang sama
   secara sah muncul di banyak catatan, dan 412 dari 460 cocok dengan beberapa
   catatan atau tidak cocok sama sekali.

**Id ghost tidak dapat didekode menjadi file.** Seluruh 1.299 sudah diuji untuk
itu: membalik setiap id terhadap 3.390 path di vault berhasil memetakan **0**.
Id seperti `scripts_watch_inbox_py_path` tampak seperti
`scripts/watch_inbox.py` + simbol `Path`, tetapi vault berisi catatan markdown,
bukan pohon Python `vivera` tempat id ghost tersebut dibuat. Id bukan jalur atribusi yang lebih
murah; hanya pencocokan label yang berhasil, dan itu pun hanya kadang-kadang.

**Jadi atribusi ulang tidak membuat graph hasil merge menjadi valid.** 846 node
masih gagal di validator peer. F7 menghapus 453 dari 1.299 cacat dan membuat 846
sisanya dapat dihitung secara eksplisit. Membuat graph sepenuhnya valid
memerlukan ekstraksi ulang node-node tersebut dengan path nyata, dan itu
pekerjaan yang berbeda.

### 8.5 API

```js
merge(chunks, { previous, ghostPolicy: 'reattribute' | 'drop' })
```

Default-nya `'reattribute'`; nilai yang tidak dikenali akan melempar error
alih-alih jatuh ke fallback. Field laporan: `ghostNodes`, `ghostNodesDropped`,
`linksOrphanedByGhosts`, `ghostNodesReattributed`, `ambiguousReattribution`,
`unmatchedReattribution`, dan `ghostPolicy` itu sendiri. Link yang menjadi yatim
akibat drop dihitung **di keduanya**, yaitu di `linksOrphanedByGhosts`
(penyebab) dan `danglingLinksDropped` (akibat): keduanya menggambarkan alasan
yang berbeda, dan tidak satu pun menyembunyikan total biayanya.

`previous` tidak pernah dimutasi oleh kebijakan mana pun, sehingga `drop` tidak
bersifat permanen lintas run: merge ulang `previous` yang sama dengan default
akan mengembalikan node-node tersebut.
