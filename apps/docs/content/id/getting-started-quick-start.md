---
title: Mulai Cepat & Instalasi
description: Satu perintah install.sh memasang paket skill ke setiap tool agent yang terdeteksi, dan --check memverifikasi hasilnya melalui exit code.
category: getting-started
slug: quick-start
order: 3
source: README.md#Quick Start & Installation
source_hash: "b2d341f601e5"
---

<a id="quick-start--installation"></a>
# Mulai Cepat & Instalasi

Pasang paket skill ke setiap agent harness yang terdeteksi oleh installer di mesin Anda, dengan satu perintah:

```bash
git clone https://github.com/belajarcarabelajar/vivera.git
cd vivera
./install.sh
```

`./install.sh` tanpa argumen menjalankan tier `standard` (lihat Prasyarat) dan melakukan hal berikut:

| Langkah | Apa yang dilakukan |
|---|---|
| Menautkan skill | Paket skill (`SKILL.md`, tujuh phase skill `sucp-*`, `templates/`, `examples/`, dan dua konfigurasi Mermaid) ditautkan ke setiap target dengan path absolut yang menunjuk ke checkout ini, jadi biarkan checkout tetap di tempatnya. `--copy` menyalin file sebagai gantinya. |
| Memilih target | `~/.config/ai` dan `~/.agents/skills` selalu dipilih. Harness lain hanya dipilih bila terdeteksi (direktorinya ada di home Anda, atau CLI-nya ada di `PATH`, `~/.local/bin`, atau `~/.bun/bin`; tabel di bawah menyebut direktori dan CLI setiap target, dan CLI dicari di ketiga tempat itu untuk setiap baris) atau disebut dengan `--only ID,ID`. Home yang masih kosong hanya mendapat dua target itu. |
| Merender sprite agent | Tujuh file subagent Harvest Sprite (peri pembantu) dibuat, bukan ditautkan, untuk setiap harness yang terdeteksi di antara Claude Code, OpenCode, Codex, Cursor, Copilot, dan Antigravity. Langkah ini butuh `bun`, sehingga tier `minimal` melewatinya. |
| Mengaktifkan git hook | Menyetel `core.hooksPath=.githooks` di checkout ini bila checkout memiliki `.git` sendiri, baik `graphify` terpasang maupun tidak, karena hook ini membawa gate ukuran file. Batalkan dengan `git -C <checkout> config --unset core.hooksPath`. |
| Melindungi file Anda | File atau direktori yang sudah ada di tujuan dan bukan milik installer dipindahkan dulu ke `<name>.vivera-bak-<UTC time>` (sebuah baris `[BACKUP]`), sehingga tidak ada yang ditimpa. |

Periksa dulu sebelum memasang, lalu cek lagi sesudahnya:

```bash
./install.sh --dry-run   # prints what it would do, writes nothing
./install.sh --check     # reports whether the install is current, changes nothing
./install.sh -h          # lists every flag
```

`--check` mencetak `check: CURRENT` dan keluar dengan 0 bila setiap target yang dipilih beres, keluar dengan 1 bila menemukan
masalah, dan keluar dengan 2 bila tidak ada target terpilih yang memiliki skill dan tidak ada direktori sprite yang bisa diperiksa (misalnya `--only codex` dengan `--tier minimal`, atau di mesin tanpa `bun`; bila `bun` ada, `--only codex` memeriksa direktori sprite dan keluar dengan 1 jika direktori itu tidak ada). Mesin yang belum terpasang apa pun keluar dengan 1. Flag yang salah, target id yang tidak dikenal, atau `HOME` yang tidak disetel
keluar dengan 2.

<a id="install-channels"></a>
## Kanal instalasi

Git clone adalah satu-satunya jalur yang sudah dijalankan dari awal sampai akhir. Jalur lainnya ada di repository, dan kolom Status
menyebut sejauh mana masing-masing diuji. "Terverifikasi" berarti dijalankan di Linux x86_64 (Arch Linux, Bun 1.4.2) pada
2026-10-11 di home sekali pakai, dengan exit code diperiksa.

| Kanal | Apa itu | Status |
|---|---|---|
| Git clone dan `./install.sh` | Tiga perintah di atas. | Terverifikasi di Linux. |
| Release tarball (offline) | `vivera-<tag>.tar.gz` beserta `.sha256`, dibangun oleh `scripts/release/build-archive.sh` dari `git archive`. Ekstrak, lalu jalankan `./install.sh`. Tree-nya tidak memiliki `.git`, sehingga langkah git hook dilewati (bila `graphify` tidak ada, langkah itu sudah lebih dulu dilewati karena alasan tersebut). | Instalasi dari tree `git archive HEAD` terverifikasi (exit 0). Installer tidak melakukan panggilan jaringan. Belum ada release yang diterbitkan (0 tag), jadi belum ada yang bisa diunduh. |
| `scripts/bootstrap.sh` | `curl -fsSL <url>/bootstrap.sh \| bash -s -- --ref v1.2.3 -- --tier standard`. Skrip ini hanya menerima release tag sepanjang paling banyak 100 karakter (tidak pernah branch atau SHA), mengunduh arsip beserta `.sha256`-nya, memeriksa SHA-256 sebelum mengekstrak apa pun, mengekstrak ke `${XDG_DATA_HOME:-$HOME/.local/share}/vivera/<tag>/` (`VIVERA_HOME` atau `--dest` mengubah lokasinya), lalu menjalankan `install.sh` hasil ekstraksi dengan argumen sesudah `--`. Jaringan hanya diakses lewat https: base plain-http, dan redirect apa pun ke skema lain (baik dengan curl maupun wget), ditolak; base `file://` untuk mirror lokal butuh curl; `--dest` tidak boleh kosong. | Belum terverifikasi terhadap release sungguhan: ada 0 tag, dan pengujiannya memakai fixture `file://` ditambah server http loopback dan server https self-signed (untuk membuktikan bahwa base plain-http dan redirect dari https ke http ditolak); tidak ada yang diambil dari github.com. `<url>` adalah placeholder, karena tempat `bootstrap.sh` akan disajikan belum diputuskan: jangan jalankan baris itu dari README ini. |
| Release workflow | `.github/workflows/release.yml` hanya berjalan bila seseorang men-dispatch-nya, dengan input `tag` dan `dry_run` (default true). Dry run menjalankan job `build` yang read-only dan tidak menerbitkan apa pun. `publish` hanya berjalan bila `dry_run` bernilai false, hanya di default branch, dan menolak tag atau release yang sudah ada. | Belum dijalankan. Publish sungguhan yang pertama adalah keputusan manusia. |
| Docker dan devcontainer | `Dockerfile` (base `oven/bun:1.4.2-debian`, memakai user non-root `bun` bawaan base image (uid 1000), menjalankan `./install.sh --tier standard --only agents`) dan `.devcontainer/devcontainer.json`, yang membangun stage `base`. | Belum terverifikasi: `docker` dan `podman` tidak ada di sini, tidak ada yang dibangun, dan pengujiannya hanya membaca file. |
| `install.ps1` (Windows native) | Installer PowerShell: `install.ps1` di root repository ditambah `scripts/install/windows-core.ps1` dan `scripts/install/windows-ops.ps1`, yang dimuatnya dari checkout. Installer ini menyalin dan tidak pernah membuat symlink, hanya memasang skill (tanpa sprite agent: gunakan `./install.sh` dari WSL atau Git Bash), dan menerima `-Only -Skip -DryRun -Check -Update -Uninstall -Help` (`-Tier` diterima tetapi diabaikan: hanya skill di setiap tier). Jalankan sebagai `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DryRun`. | Di-parse dan dijalankan di PowerShell 7.6.6 pada Linux, oleh behaviour test yang berjalan bila `pwsh` ada di `PATH` (atau disebut di `PWSH`) dan dilewati bila tidak ada. **Belum terverifikasi di Windows, di Windows PowerShell 5.1, maupun pada NTFS junction.** Mulailah dengan `-DryRun`, lalu `-Check`. |
| Claude Code marketplace | Repository sebagai marketplace berisi satu plugin. | **Ditunda (parked)**, lihat di bawah. |
| Antigravity plugin (`agy plugin`) | `agy plugin install` dari URL GitHub atau path lokal. | Diadopsi nanti: belum ada yang dipasang. Lihat di bawah. |

Apa yang dibuktikan oleh checksum bootstrap: checksum disajikan dari origin release yang sama dengan arsipnya, sehingga ia mendeteksi
unduhan yang rusak atau arsip yang ditukar. Checksum tidak mendeteksi release yang dikompromikan, karena siapa pun yang bisa
mengganti arsip juga bisa mengganti checksum-nya.

**Mengapa marketplace ditunda.** Sebuah spike pada 2026-10-11 menjalankan `claude plugin validate`, `marketplace add`,
`install`, dan `details` di home yang terisolasi. Packaging-nya berfungsi: validasi lolos dan 8 skill
terdaftar. Marketplace ditunda karena tiga alasan:

- Master skill memuat phase skill-nya dengan nama polos (`sucp-rules`, `sucp-plan`) dan berhenti bila salah satunya tidak bisa
  dimuat. Dokumentasi menampilkan skill plugin dengan nama plugin sebagai prefiks (`/vivera:sucp-rules`). Apakah tool Skill
  milik model menerima nama polos tidak didokumentasikan, dan tidak ada sesi live yang dijalankan, jadi hal ini
  belum terverifikasi.
- Path fallback `~/vivera/skills/<name>/SKILL.md` tidak ada di mesin yang hanya memiliki plugin.
- Plugin yang berakar di repository memasang sekitar 498 MB dependensi ke cache, dibandingkan 720 KB untuk
  salinan yang hanya berisi skill.

Keputusannya berubah menjadi build bila satu sesi live di home terisolasi menunjukkan nama polos berhasil dimuat, atau bila pemilik
mengajarkan kedua nama itu kepada master skill.

**Mengapa Antigravity plugin menunggu.** `agy plugin validate` menerima salinan skill (8 diproses), tetapi
tidak ada yang dipasang. Ke mana instalasi lewat CLI mendarat, apakah staging mempertahankan symlink paket skill,
dan bagaimana update bekerja belum diukur. Sebuah plugin akan menambah satu kanal dan tidak akan menggantikan tautan
ke direktori skill Antigravity.

<a id="prerequisites"></a>
## Prasyarat

Pilih tier dengan `--tier minimal|standard|full` (default `standard`). Daftar tool-nya adalah
`scripts/install/tiers.tsv`, yang dibaca oleh `install.sh` maupun `scripts/validate-skill.mjs`, sehingga installer
dan validator tidak mungkin berbeda pendapat soal tier.

| Tier | Yang dibutuhkan di mesin Anda | Yang dipasang |
|---|---|---|
| `minimal` | Tidak ada selain bash serta `basename`, `dirname`, `head`, `ln`, `mkdir`, `readlink`, dan `uname` untuk instalasi pertama, `--dry-run`, `--check`, dan `--update` yang tidak menyisihkan apa pun. Menyisihkan file juga butuh `date` dan `mv`, `--uninstall` butuh `rm` (dan `mv` untuk mengembalikan backup), dan `--copy` butuh `cmp`, `diff`, `cp`, `mv`, dan `find`. | Hanya skill: tanpa sprite agent (butuh `bun`) dan tanpa git hook (butuh `git`). Terverifikasi dengan `git` dan `bun` tidak ada di `PATH`: instalasi keluar dengan 0 dan `--check` mencetak `check: CURRENT` (dengan tambahan ` (sprite agents not verified: ...)` bila harness sprite dipilih). |
| `standard` (default) | `git`, `bun` | Skill dan sprite agent, ditambah git hook bila `graphify` terpasang dan ini adalah git checkout. `gh` atau `tgrep` yang tidak ada masing-masing mencetak satu peringatan, dan proses tetap berjalan. Tool opsional lain di tabel di bawah (`rtk`, `context-mode`, `opencode`, `snipset`, `graphify`) memberi peringatan dengan cara yang sama, sehingga mesin yang hanya punya `git` dan `bun` melihat tujuh peringatan (`gh`, `tgrep`, `graphify`, `rtk`, `context-mode`, `opencode`, `snipset`); mesin tanpa `git` atau `bun` berhenti dengan exit 1 pada tool pertama yang tidak ada, sebelum peringatan apa pun. |
| `full` | `git`, `bun`, `gh`, `tgrep` | File yang sama dengan `standard`. Tier ini hanya menjadikan `gh` dan `tgrep` wajib. |

Tool-tool tersebut, dari `scripts/install/tiers.tsv`:

| Tool | Wajib sejak | Yang hilang bila tool tidak ada |
|---|---|---|
| `git` | `standard` | Self-check repo dan penyiapan `core.hooksPath`. |
| `bun` | `standard` | Semua skrip, rendering sprite, dan test. |
| `gh` | `full` | Sinkronisasi issue plan dan pembuatan PR. |
| `tgrep` | `full` | Pencarian kode berindeks trigram dan validate gate. |
| `graphify` | tidak pernah | Query knowledge graph dan refresh graph saat pre-commit. |
| `rtk` | tidak pernah | Proxy yang memampatkan output. |
| `context-mode` | tidak pernah | Routing output yang hemat token. |
| `opencode` | tidak pernah | Harness OpenCode. |
| `snipset` | tidak pernah | Database Snipset dan tool MCP. |

- **Tool wajib yang tidak ada membuat exit 1.** Yaitu `git` dan `bun` di `standard`, ditambah `gh` dan `tgrep` di `full`.
- **Tool opsional yang tidak ada memberi peringatan.** Di `standard` dan `full`, tool yang tidak diwajibkan oleh tier pilihan mencetak satu peringatan
  yang menyebut apa yang hilang, dan proses tetap berjalan. Installer mencari tool di `PATH`, lalu di
  `~/.local/bin`, lalu di `~/.bun/bin`.
- **`--check` dan `--uninstall` tidak meminta tool apa pun, di tier mana pun.** Direktori sprite agent diperiksa dan
  dihapus hanya bila `bun` ada: tanpanya, `--check` melewati direktori itu dan `--uninstall` mempertahankan file-nya serta
  meminta Anda menghapus file yang bertanda secara manual.
- **Bun >= 1.1.0** ([bun.sh](https://bun.sh)) adalah runtime untuk skrip dan test repository ini, dan
  `package.json` mematok `bun@1.4.2`. Semua instalasi dependensi memakai `bun install` / `bun add`, dan semua eksekusi JS/TS
  memakai `bun test` / `bun run`. `npm install`, `npm test`, `yarn`, dan `pnpm` dilarang
  keras. Pasang Bun dengan `curl -fsSL https://bun.sh/install | bash`. `./install.sh` sendiri tidak butuh `bun install`
  lebih dulu: tree tanpa `node_modules` berhasil memasang dan merender sprite.
- **Node.js tidak diperlukan untuk instalasi, maupun untuk menjalankan skrip Bun.** Node.js diperlukan untuk merender diagram Mermaid
  (`scripts/render-diagrams.sh` dan bagian Mermaid dari `scripts/validate-skill.mjs`): `mmdc` dari
  `@mermaid-js/mermaid-cli` diawali dengan `#!/usr/bin/env node`, dan `package.json` meminta Node >= 22.13.0.
  Satu-satunya lockfile adalah `bun.lock`.
- **`ripgrep` (`rg`) & `tgrep`**: Pencarian kode utama memakai `rg` (binary langsung v15.2+ dengan smart-case). `tgrep` ([microsoft/tgrep](https://github.com/microsoft/tgrep)) dipakai untuk pencarian berindeks trigram di repository yang terindeks dan untuk penyaringan shell pipe. GNU `grep` mentah dilarang keras. `tgrep` hanya wajib di tier `full`: di `standard`, install.sh mencetak satu peringatan bila tool ini tidak ada (tidak ada peringatan di `minimal`) dan aturan pencarian skill (`skills/sucp-rules/SKILL.md`) menerima `rg` atau `tgrep`, sehingga `rg` saja sudah memenuhinya.

<a id="platform-matrix"></a>
## Matriks platform

"Terverifikasi" memakai definisi yang sama seperti di Kanal instalasi: dijalankan di Linux x86_64 (Arch Linux, Bun 1.4.2) di
home sekali pakai, dengan exit code diperiksa. Selain itu berarti "belum terverifikasi".

| Kanal dan tier | Linux x86_64 (mesin ini) | macOS | WSL | Windows native | Docker |
|---|---|---|---|---|---|
| `./install.sh`, `minimal` | Terverifikasi (tanpa `git`, tanpa `bun` di `PATH`: exit 0, dan `check: CURRENT` dengan catatan sprite agent ditambahkan di belakangnya bila harness sprite dipilih) | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi |
| `./install.sh`, `standard` | Terverifikasi (install, `--check`, `--update`, `--uninstall`, `--copy` dan backup, semuanya exit 0) | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi |
| `./install.sh`, `full` | Terverifikasi (`git`, `gh`, `bun`, dan `tgrep` sungguhan di `PATH`: install, `--check`, `--update`, dan `--uninstall` semuanya exit 0; bila `gh` atau `tgrep` tidak ada, install keluar dengan 1) | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi |
| `./install.sh` di Git Bash, MSYS, atau Cygwin | n/a | n/a | n/a | Default ke `--copy` dan mencetak `[NOTE]`. Hanya diamati dengan `uname` tiruan (stub), bukan di Windows: belum terverifikasi | n/a |
| Release tarball, tier apa pun | Terverifikasi untuk instalasi dari tree `git archive` (exit 0); belum ada release yang bisa diunduh | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi |
| `scripts/bootstrap.sh` | Belum terverifikasi terhadap release sungguhan (hanya `file://` dan server test loopback) | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi | Belum terverifikasi |
| `install.ps1` | Dijalankan di PowerShell 7.6.6 oleh behaviour test (dilewati tanpa `pwsh`) | n/a | n/a | Belum terverifikasi di Windows, Windows PowerShell 5.1, maupun NTFS junction | n/a |
| Dockerfile dan devcontainer, hanya `standard` | n/a | n/a | n/a | n/a | Belum terverifikasi: tidak pernah dibangun |

- macOS: skrip bootstrap menyatakan berjalan di bash 3.2, tetapi installer tidak pernah dijalankan di bash 3.2 atau dengan
  tool BSD.
- "Belum terverifikasi" berarti belum diuji, bukan diketahui gagal.
- `HOME` yang read-only membuat instalasi keluar dengan 1 dan tidak menulis apa pun (terverifikasi di Linux).

<a id="supported-harnesses--target-paths"></a>
## Harness yang Didukung & Path Target

Installer memiliki 10 target, dicantumkan di sini sesuai urutan instalasi. Dua yang pertama selalu dipasang. Target
lainnya hanya dipasang bila harness-nya terdeteksi, atau bila Anda menyebutnya dengan `--only`.

| Target id | Harness | Terdeteksi bila | Skill dipasang ke | Sprite agent dipasang ke | Apakah sprite dimuat? |
|---|---|---|---|---|---|
| `ai-config` | Mirror konfigurasi pribadi | selalu | `~/.config/ai/Super Ultra Code Plan Implementation.md` (satu tautan) | tidak ada | n/a |
| `agents` | Universal Agents | selalu | `~/.agents/skills/` | tidak ada | n/a |
| `antigravity` | Antigravity 2.0 dan IDE-nya | `~/.gemini` ada, atau `agy` ada di `PATH` | `~/.gemini/config/skills/` | `~/.gemini/config/agents/<sprite>/agent.md` | belum terverifikasi (Antigravity 1.3.3) |
| `antigravity-cli` | Antigravity CLI (`agy`) | `~/.gemini/antigravity-cli` ada, atau `agy` ada di `PATH` | `~/.gemini/antigravity-cli/skills/` | tidak ada | n/a |
| `antigravity-builtin` | Direktori skill bawaan Antigravity CLI | `~/.gemini/antigravity-cli/builtin/skills` ada | `~/.gemini/antigravity-cli/builtin/skills/` | tidak ada | n/a |
| `opencode` | OpenCode | `~/.config/opencode` ada, atau `opencode` ada di `PATH` | `~/.config/opencode/skills/` | `~/.config/opencode/agents/<sprite>.md` | tercantum di `opencode debug agents` (OpenCode v2.0.24), belum dijalankan dengan prompt |
| `claude` | Claude Code | `~/.claude` ada (tanpa probe CLI) | `~/.claude/skills/` | `~/.claude/agents/<sprite>.md` | belum terverifikasi (Claude Code 2.1.296) |
| `codex` | Codex | `~/.codex` ada, atau `codex` ada di `PATH` | tidak ada | `~/.codex/agents/<sprite>.toml` | belum terverifikasi (CLI tidak terpasang di sini) |
| `cursor` | Cursor | `~/.cursor` ada, atau `cursor-agent` ada di `PATH` | tidak ada | `~/.cursor/agents/<sprite>.md` | belum terverifikasi (CLI tidak terpasang di sini) |
| `copilot` | Copilot CLI | `~/.copilot` ada, atau `copilot` ada di `PATH` | tidak ada | `~/.copilot/agents/<sprite>.agent.md` | belum terverifikasi (CLI tidak terpasang di sini) |

Setiap direktori skill di atas kecuali `~/.config/ai` berisi `super-ultra-code-plan/` (`SKILL.md`, `templates/`, `examples/`, dan dua
konfigurasi Mermaid) di samping tujuh phase skill, `sucp-<name>/SKILL.md`. Pengujian di Linux pada home sekali pakai
memeriksa deteksi berbasis direktori dan berbasis CLI serta path skill dan sprite untuk ke-10 target,
dengan CLI tiruan (stub) untuk deteksi.

Gemini CLI (`gemini`) bukan target. Google berhenti menyediakannya untuk akun gratis, AI Pro, dan Ultra pada
2026-06-18 dan menggantinya dengan Antigravity CLI (`agy`), yang dicakup oleh target `antigravity-cli`
(<https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>).
Gemini CLI masih tersedia dengan lisensi Code Assist Standard atau Enterprise, atau dengan API key berbayar; pengguna
tersebut dapat menautkan paket skill ke `~/.gemini/skills/` sendiri. Revisi installer yang lebih lama
memiliki target `gemini-cli`; `--only gemini-cli` kini keluar dengan 2 sebagai target yang tidak dikenal.

- **Hanya yang terdeteksi yang dipasang.** Target yang tidak ada setelah `./install.sh` berhasil berarti harness-nya
  tidak terdeteksi, bukan berarti instalasinya gagal. Installer tidak membuat tree konfigurasi kosong untuk
  harness yang tidak Anda miliki. `./install.sh --dry-run` mencantumkan target yang memenuhi syarat di mesin Anda. Home yang masih
  kosong hanya mendapat `~/.config/ai` dan `~/.agents/skills`.
- **Menyebut target.** `--only ID,ID` memasang tepat id-id tersebut, terdeteksi atau tidak, dan tidak menambahkan dua
  target yang selalu dipasang (`--only claude` memasang `claude` dan tidak ada yang lain). `--skip ID,ID` mengeluarkan
  id dan menang atas `--only`. Kedua flag bisa diulang dan nilainya terakumulasi, dan id yang tidak dikenal keluar dengan 2. Versi
  installer yang lebih lama membuat target OpenCode dan Antigravity bahkan saat harness-nya tidak ada;
  `--only opencode,antigravity,antigravity-cli,antigravity-builtin` mengembalikan perilaku itu.
- **Dua direktori skill Antigravity.** Target `antigravity` (`~/.gemini/config/skills`) adalah tempat
  Antigravity 2.0 dan IDE membaca skill, sedangkan CLI membaca `~/.gemini/antigravity-cli/skills` (target
  `antigravity-cli`), menurut dokumentasi Antigravity yang dibaca untuk riset `agy plugin`. Tidak satu pun
  path itu dikonfirmasi dengan memuat skill.
- **Codex, Cursor, dan Copilot tidak punya target skill.** Installer menganggap skill mereka berasal dari
  `~/.agents/skills`, yang belum diperiksa terhadap ketiga harness itu. Mereka hanya mendapat sprite agent.
- **Sprite agent dirender, dan hanya OpenCode yang dikonfirmasi mencantumkannya (tidak ada harness yang dijalankan dengan prompt model).** Enam harness mendapatkannya
  (Claude Code, OpenCode, Codex, Cursor, Copilot, dan target `antigravity`). `antigravity-cli`
  dan `antigravity-builtin` tidak mendapat satu pun, dan tier `minimal` tidak merender satu pun. OpenCode v2.0.24
  mencantumkan ketujuh sprite di `opencode debug agents`. Antigravity 1.3.3 belum terkonfirmasi: `agy agents`
  hanya mencantumkan agent yang ditulis dengan `mainAgent: true`, sedangkan sprite ditulis dengan `mainAgent: false`.
  Claude Code 2.1.296 tidak memiliki lister non-interaktif untuk definisi subagent (`claude agents --json` mencantumkan sesi background dan mencetak `[]` saat sprite terpasang), dan Codex, Cursor, serta Copilot tidak pernah dijalankan.

<a id="flags"></a>
## Flag

`./install.sh -h` mencetak daftar ini. Sumber kebenaran untuk target adalah tabel di atas, dan untuk tier adalah
`scripts/install/tiers.tsv`.

| Flag | Default | Efek | Aturan dan kasus exit 2 |
|---|---|---|---|
| `--tier minimal\|standard\|full` | `standard` | Tool mana yang wajib (lihat Prasyarat). | Nilai lain, atau nilai yang tidak diberikan, keluar dengan 2. |
| `--only ID,ID` | off: setiap target yang terdeteksi ditambah dua target yang selalu dipasang | Bertindak tepat pada target-target ini, terdeteksi atau tidak. Tidak menambahkan `ai-config` atau `agents`. | Pengulangan terakumulasi, dan `--only=a,b` juga berfungsi. Id yang tidak dikenal keluar dengan 2 dan mencantumkan id yang valid; nilai kosong keluar dengan 2. |
| `--skip ID,ID` | tidak ada | Mengecualikan target-target ini. Bisa mengeluarkan `ai-config` atau `agents`. | Menang atas `--only`. Pengulangan terakumulasi. Kasus exit 2 sama dengan `--only`. |
| `--copy` | off (tautan) | Menyalin file alih-alih menautkannya, dan menandai setiap salinan (lihat bagian Copy mode). Butuh `cmp` dan `diff`, atau proses keluar dengan 1. | Di Git Bash, MSYS, dan Cygwin flag ini aktif secara default. |
| `--dry-run` | off | Mencetak apa yang akan dilakukan tanpa menulis apa pun, di setiap mode. Prasyarat tetap diperiksa lebih dulu. | Dry run instalasi atau `--update` diakhiri dengan `==> Dry run finished: nothing was written (run again without --dry-run to apply it)`. `--uninstall --dry-run` diakhiri dengan ringkasannya sendiri (`would be removed`), dan `--check` diakhiri dengan baris `check:`-nya. Bila ada entri yang dibiarkan atau tidak ada target yang dipilih, baris penutupnya menyebutkan hal itu sebagai gantinya. |
| `--check` | off | Melaporkan apakah instalasi sudah terkini dan tidak mengubah apa pun. Tidak butuh `bun` maupun `git`. | Paling banyak satu dari `--check`, `--update`, `--uninstall`; dua di antaranya keluar dengan 2. |
| `--update` | off | Menyelaraskan instalasi dengan checkout ini: menautkan yang belum ada, mengarahkan ulang tautan yang usang, menyegarkan salinan, merender ulang sprite agent, lalu memangkas (prune). | Meminta tool dari tier yang dipilih, seperti instalasi. |
| `--uninstall` | off | Menghapus apa yang dibuat installer dan mengembalikan backup terbaru. Tidak butuh `bun` maupun `git`. | Tidak meminta tool apa pun, apa pun isi `--tier`. |
| `-h`, `--help` | off | Mencetak teks penggunaan dan keluar dengan 0. | |

| Exit | Arti |
|---|---|
| 0 | Proses selesai, atau `--check` mendapati semuanya terkini, atau `-h`. |
| 1 | Tool wajib tidak ada; `--check` menemukan masalah; tautan atau salinan tidak bisa ditempatkan (file Anda dikembalikan); renderer sprite gagal (target lain tetap diselesaikan lebih dulu); atau `HOME` tidak bisa ditulis (`[FAIL] cannot create <dir>: <reason> (is HOME writable?)`, tidak ada yang ditulis). |
| 2 | Kesalahan penggunaan: argumen yang tidak dikenal, `--tier` yang salah, daftar target yang tidak dikenal atau kosong, nilai yang tidak diberikan, lebih dari satu flag mode, `HOME` yang tidak disetel, atau path `HOME` atau checkout yang mengandung tab atau newline. Juga `--check` bila tidak ada target terpilih yang punya sesuatu untuk diperiksa. |

Instalasi biasa menyebutkan harness mana yang dilewatinya, dengan `[INFO] not detected, skipped: <ids> (name one with --only to install anyway)`.
Untuk `codex`, `cursor`, dan `copilot`, installer mencetak `[INFO] <id>: no skills target of its own (its skills come from ~/.agents/skills); installing its sprite agents only`.
Tier `minimal`, `--check`, dan `--uninstall` tidak mencetak peringatan tentang tool opsional.

<a id="backup-restore-update-check-and-uninstall"></a>
## Backup, restore, update, pemeriksaan, dan uninstall

Sebelum menempatkan apa pun, installer menilai setiap tujuan dari apa yang ada di disk. Tidak ada file state,
sehingga instalasi yang dibuat oleh versi lama, atau secara manual, dinilai dengan aturan yang sama.

| Status | Artinya | Yang dilakukan install dan `--update` |
|---|---|---|
| `absent` | Tidak ada apa-apa di sana. | Membuat link (atau salinan). |
| `ok` | Sudah berupa link yang diinginkan (dalam mode copy, salinan yang identik). | Tidak ada. |
| `ours-stale` | Milik installer sendiri tetapi salah: link ke dalam checkout ini yang menunjuk ke tempat lain atau menggantung (dangling), atau link ke item repositori lama `ai-skills`, baik yang masih hidup maupun yang menggantung. | Menggantinya tanpa backup, karena tidak ada tulisan Anda di dalamnya. |
| `foreign` | Apa pun yang tidak dapat dibuktikan installer sebagai miliknya: file atau direktori asli tanpa marker, atau link yang menunjuk ke tempat lain mana pun (bahkan yang menggantung). | Memindahkannya ke backup, lalu menempatkan. |
| `inrepo` | Tujuannya adalah file dari checkout ini sendiri (misalnya `~/.claude/skills/sucp-rules` yang di-link ke `<checkout>/skills/sucp-rules`). | Dilewati. |
| `viadir` | File asli yang sudah ada di balik direktori yang berupa symlink (misalnya `~/.claude/skills -> ~/dotfiles/skills`), atau link di sana yang bukan milik installer; dalam mode `--copy` juga link milik installer sendiri dan setiap entri yang belum ada. | Dilewati. |

| Operasi | Yang dilakukan | Tag yang akan Anda lihat |
|---|---|---|
| Backup | File yang bertabrakan dipindahkan dengan `mv` ke `<dest>.vivera-bak-<UTC YYYYmmddTHHMMSSZ>`, misalnya `SKILL.md.vivera-bak-20261011T080000Z`. Jika nama itu sudah dipakai, ditambahkan `-1`, `-2`, dan seterusnya. Jika penempatan link atau salinan kemudian gagal, file Anda dipindahkan kembali dan run keluar dengan exit 1. | `[BACKUP]` |
| `--check` | Hanya baca: tidak membuat, memindahkan, atau menghapus apa pun milik installer, juga dengan `--dry-run`, dengan `--copy`, dan pada `HOME` yang read-only (saat menjalankan `bun` untuk pemeriksaan sprite, `bun` sendiri mungkin membuat cache transpiler di bawah `~/.bun`; `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` mencegahnya). Satu baris per path, lalu satu verdict. | `[ok]`, `[missing]`, `[stale]`, `[dangling]`, `[foreign]`, `[skip]` |
| `--update` | Menjalankan setiap langkah instalasi biasa, lalu melakukan prune. Link menggantung ke path lama `ai-skills` diarahkan ulang tanpa backup. Direktori `sucp-*` yang tidak lagi dimiliki checkout ini di-prune, tetapi hanya jika itu direktori asli milik installer (berisi marker, atau `SKILL.md`-nya adalah link yang dinilai installer `ok` atau `ours-stale`). Direktori milik Anda sendiri dan link hidup ke tempat lain tidak pernah di-prune. Di direktori yang juga berisi file lain, hanya link milik installer (atau `SKILL.md` dan marker-nya) yang dihapus dan direktorinya tetap ada; direktori itu sendiri baru dihapus jika menjadi kosong karenanya. `SKILL.md` yang sudah diedit, atau `SKILL.md` yang berupa symlink, dipertahankan dengan baris `[KEEP]`. `--check` menampilkan himpunan yang sama sebagai `[stale]`. | `[PRUNED]` |
| `--uninstall` | Menghapus setiap link `ok` atau `ours-stale`, lalu mengembalikan backup terbaru: cap waktu UTC yang lebih akhir menang, lalu `-N` yang lebih besar sebagai angka (`-10` mengalahkan `-2`); nama yang hanya mirip backup diabaikan dan backup yang lebih lama tetap ada. Direktori dihapus dengan `rmdir` hanya jika kosong, dengan satu pengecualian: direktori salinan terkelola (`templates/`, `examples/`) yang identik dengan sumbernya, atau masih cocok dengan digest yang tercatat, dihapus seluruhnya. Salinan yang sudah diubah dipertahankan, sehingga file Anda selamat. Perintah ini tidak pernah menghapus root harness seperti `~/.claude` atau `~/.gemini`, `~/.config/ai` itu sendiri, direktori skill `antigravity-builtin`, atau pengaturan `core.hooksPath` (batalkan dengan `git -C <checkout> config --unset core.hooksPath`). File sprite hasil generate juga dihapus, jika `bun` tersedia. | `[REMOVED]`, `[RESTORED]`, `[KEEP]` |
| `--dry-run` | Mencetak rencana dan tidak menulis apa pun, baik pada install, `--update`, maupun `--uninstall`. | Baris `[DRY-RUN]` |

Verdict `--check`:

| Tag atau baris terakhir | Arti |
|---|---|
| `[ok]` | Link yang diinginkan dapat di-resolve (dalam mode copy, salinannya cocok). |
| `[missing]` | Tidak ada apa-apa di sana. `[missing] <dir> (sprite agents)` berarti direktori sprite kosong atau tidak lengkap. |
| `[stale]` | Milik installer tetapi salah: link yang menunjuk ke tempat lain di checkout atau ke `ai-skills`, salinan di tempat yang seharusnya berisi link, salinan yang berbeda atau sudah diedit, direktori `sucp-*` yang tidak lagi dimiliki checkout ini, atau file sprite yang usang atau diedit manual. `--update` memperbaikinya. |
| `[dangling]` | Link milik installer yang targetnya tidak ada (link ke checkout ini atau ke repositori lama `ai-skills`, atau link yang diinginkan tetapi file sumbernya sudah hilang). Link menggantung yang menunjuk ke tempat lain mana pun adalah `[foreign]`. |
| `[foreign]` | Bukan milik installer: file asli atau link lain (`--update` akan memindahkannya ke samping), file `viadir`, atau file `inrepo` yang bukan yang diharapkan. Ini dihitung sebagai masalah, sehingga file `viadir` membuat `--check` tetap exit 1 sampai Anda menyelesaikannya. |
| `[skip]` | Target tanpa skill untuk diperiksa, atau direktori sprite yang tidak diperiksa: tidak ada `bun`, tier `minimal`, atau direktori di dalam checkout ini atau di balik symlink. Baris terakhir kemudian berbunyi `sprite agents not verified: <why>`. |
| `[FAIL] <id> sprites: <generator line>` | Generator sprite gagal karena alasan selain drift, dan baris keluarannya sendiri ditampilkan alih-alih menyebut file-file itu stale. |
| `[hint] those are copies made by --copy: run ./install.sh --check --copy` | Anda memeriksa instalasi copy tanpa `--copy`. |
| `check: CURRENT` | Exit 0: semua yang dipilih dalam keadaan beres. |
| `check: CURRENT (sprite agents not verified: <why>)` | Exit 0, tetapi direktori sprite tidak diperiksa (misalnya `bun` tidak ada). |
| `check: N problem(s)` | Exit 1. |
| `check: nothing to check ...` | Exit 2: tidak ada target terpilih yang memiliki skill dan tidak ada direktori sprite yang dapat diperiksa. |

Uninstall, per tujuan:

| Yang ada di tujuan | Yang dilakukan `--uninstall` |
|---|---|
| Link yang `ok` atau `ours-stale` | Menghapusnya (`[REMOVED]`), lalu memindahkan kembali backup terbaru (`[RESTORED]`) jika ada. |
| Salinan terkelola yang identik, atau tidak tersentuh sejak instalasi | Menghapusnya dan memulihkan backup terbaru dengan cara yang sama. |
| Salinan terkelola yang Anda ubah | `[KEEP] <dest> (modified copy: it stays as it is; ./install.sh --update --copy replaces it after backing yours up)` |
| File asli atau link lain (`foreign`), file di dalam checkout ini, file asli di balik direktori symlink | Mempertahankannya dengan `[KEEP]`. |

Baris penutupnya adalah `==> Vivera uninstalled: N link(s) removed, R restored, K kept`, dan berbunyi
`link(s) or copy/copies` jika ada salinan yang dihapus. Link yang dipulihkan akan menggantung jika checkout yang
ditunjuknya sudah dihapus sementara itu.

<a id="copy-mode"></a>
## Mode copy

`--copy` menyalin file alih-alih me-link-nya, sehingga instalasi tetap berfungsi saat checkout dipindahkan atau
hilang. Konsekuensinya, salinan tidak mengikuti checkout: jalankan `./install.sh --update --copy` setelah Anda melakukan pull.

| Apa | Cara kerjanya |
|---|---|
| Marker | Setiap direktori paket (`super-ultra-code-plan/` dan setiap `sucp-<name>/`) mendapat file `.vivera-managed`. Baris pertamanya adalah `source=<checkout>`, lalu satu baris `entry <name> <algo>:<digest>` per entri yang ditempatkan installer. Digest-nya memakai `sha256sum`, jika tidak ada `shasum -a 256`, jika tidak ada juga `cksum`; digest sebuah direktori dibangun dari daftar terurut direktori di dalamnya (termasuk yang kosong), symlink-nya (berdasarkan nama target, tidak diikuti), dan file-nya (berdasarkan isi, ditambah bit exec pemilik), dengan file biasa bernama `.DS_Store` dikecualikan. Digest yang tidak dapat dihitung (tidak ada alat hash yang berfungsi, entri yang tidak dapat dibaca, FIFO) bernilai kosong dan tidak cocok dengan apa pun, sehingga salinan seperti itu dihitung sebagai diubah. File `ai-config` mendapat sidecar `Super Ultra Code Plan Implementation.md.vivera-managed`. |
| Tanpa link | Direktori disalin dengan `cp -RL`, sehingga tidak ada salinan yang memuat link ke checkout, dan pemeriksaan link internal checkout itu sendiri dilewati. |
| Kebutuhan | `cmp` dan `diff`. Tanpa keduanya `--copy` keluar dengan exit 1 sambil menyebut alat yang hilang. `find` juga diperlukan tetapi tidak diperiksa: tanpanya setiap salinan direktori (`templates/`, `examples/`) dinilai diubah, sehingga setiap `--update --copy` memindahkannya ke backup. `--uninstall` tanpa `--copy` tetap berjalan dan menilai setiap salinan hanya dari digest yang tercatat: salinan yang masih cocok dengan catatannya dihapus, salinan lain dipertahankan. |

Setiap salinan terkelola dinilai terhadap sumbernya dan terhadap digest yang tercatat:

| Penilaian | Artinya | `--update --copy` | `--uninstall` dan prune |
|---|---|---|---|
| identical (identik) | Isinya sama dengan sumber. | Tidak ada yang perlu dilakukan. | Dihapus. |
| pristine (belum disentuh) | Berbeda dari sumber, tetapi masih cocok dengan digest yang dicatat saat instalasi: salinan ini usang dan tidak pernah Anda edit. | Diperbarui, tanpa backup. | Dihapus. |
| modified (diubah) | Tidak cocok dengan keduanya, atau tidak punya catatan: Anda mengeditnya. | Dipindahkan ke backup (`[BACKUP]`) terlebih dahulu, lalu diganti. | Dipertahankan (`[KEEP]`). |

Aturan lain:

- **Git Bash, MSYS, dan Cygwin memakai `--copy` secara default.** Di sana `ln -s` menyalin file atau gagal kecuali
  symlink diaktifkan, sehingga instalasi biasa akan melaporkan link yang tidak dibuatnya. Installer mencetak `[NOTE]`
  lalu menyalin. Ini hanya teramati dengan `uname` tiruan (stub), tidak di Windows (belum diverifikasi).
- **`.gitattributes` memaksa LF** untuk `*.sh` dan `scripts/install/tiers.tsv`, karena clone Windows dengan
  `core.autocrlf` akan mengubah setiap skrip installer menjadi CRLF, dan carriage return setelah
  `set -euo pipefail` bukan perintah bash yang valid.
- **Instalasi copy harus diperiksa dengan `--check --copy`.** Tanpa `--copy`, `--check` mengharapkan link, menyebut
  salinan-salinan itu `[stale]`, dan mencetak `[hint] those are copies made by --copy: run ./install.sh --check --copy`.
- `install.ps1` selalu menyalin dan mengikuti aturan identical, pristine, dan modified yang sama, dengan digest-nya sendiri
  (entri `ps-sha256` di marker): digest yang dicatat oleh `install.sh` (`sha256:`) tidak pernah dipercaya, sehingga salinan seperti itu
  dihitung sebagai modified. Satu perbedaan: di balik direktori yang di-link, skrip ini membiarkan link APA PUN, termasuk milik installer
  sendiri, sedangkan `install.sh` dalam mode link tetap mengarahkan ulang link miliknya (`install.sh --copy`, mode yang setara dengan `install.ps1`, juga membiarkannya). Skrip ini hanya dijalankan di PowerShell 7.6.6 di Linux, tidak di Windows.

<a id="offline-mode-and-the-minimal-tier"></a>
## Mode offline dan tier minimal

| Pertanyaan | Jawaban |
|---|---|
| Apakah installer memakai jaringan? | Tidak. `install.sh` dan skrip yang dimuatnya tidak melakukan panggilan jaringan (`scripts/bootstrap.sh` adalah satu-satunya skrip yang mengunduh): pencarian `curl`, `wget`, dan URL hanya menemukan teks petunjuk yang memberi tahu cara memasang `bun`. Instalasi dengan hanya antarmuka loopback yang aktif juga lulus. |
| Bisakah saya memasang dari tree tanpa `.git`? | Bisa. Tree hasil `git archive` terpasang dengan exit 0 (diverifikasi di Linux), termasuk agent sprite jika `bun` tersedia. Langkah git hook dilewati, karena hook hanya dipasang di checkout yang memiliki `.git` sendiri. |
| Bisakah saya memasang tanpa `git` dan tanpa `bun`? | Bisa, dengan `--tier minimal`: hanya skill, tanpa agent sprite, tanpa git hook. `--check` dan `--uninstall` tidak memerlukan kedua alat itu di tier mana pun (diverifikasi di Linux dengan keduanya tidak ada di `PATH`: install exit 0, dan `check: CURRENT` dengan catatan agent sprite ditambahkan jika harness sprite dipilih). |
| Apa yang masih memerlukan jaringan? | Mengambil file (clone, tarball, `scripts/bootstrap.sh`), memasang `bun`, dan `bun install` untuk test dan validator milik repositori itu sendiri. |

<a id="known-limits"></a>
## Batasan yang diketahui

| Batasan | Akibat | Yang perlu dilakukan |
|---|---|---|
| Memasang dari checkout kedua mengambil alih link checkout pertama. | Link checkout pertama dinilai `foreign` dan dipindahkan ke backup (13 baris `[BACKUP]` untuk instalasi default). Dari checkout pertama, `--check` kemudian melaporkan `[foreign]` dan `--uninstall` mempertahankan link checkout kedua. `--uninstall` dari checkout kedua memulihkan link checkout pertama, dan link itu menggantung jika checkout tersebut sudah dihapus. | Gunakan satu checkout. Untuk berpindah, jalankan `./install.sh --uninstall` dari checkout lama, lalu pasang dari checkout baru. |
| Direktori skill yang berupa symlink ke tree lain dibiarkan (`viadir`), begitu pula direktori sprite di balik symlink. | Di balik direktori skill yang berupa symlink, installer tidak pernah memindahkan, menghapus, atau mengubah target apa pun yang menjadi milik tree lain: file asli yang sudah ada, link yang bukan miliknya (link dari checkout lain), dan, dalam mode `--copy`, link apa pun serta setiap entri yang belum ada (salinan akan menjadi file asli di tree lain, yang kemudian tidak dapat dikelola oleh check, update, dan uninstall). `--check` melaporkannya sebagai `[foreign]`, sehingga terus keluar dengan exit 1. Dalam mode link, installer tetap membuat link miliknya di sana (beserta direktori paket yang menampungnya); `--uninstall` menghapus link tersebut dan meninggalkan direktori kosong itu. Direktori sprite di balik symlink juga dibiarkan: `--check` mencetak `[skip]` dan diakhiri `check: CURRENT (sprite agents not verified: ...)` dengan exit 0. | Selesaikan secara manual (hapus symlink, atau gabungkan tree-nya), atau keluarkan target itu dengan `--skip`. Pasang dari checkout yang ditunjuk symlink, jangan pernah dari worktree atau checkout kedua, atau link-nya akan dilaporkan sebagai milik pihak lain. |
| `--check` menilai berdasarkan flag yang Anda berikan. | Tidak ada yang mencatat tier atau daftar target yang Anda gunakan saat instalasi. Setelah `--tier minimal` atau `--only a,b`, `--check` biasa (tier `standard`, setiap target yang terdeteksi) melaporkan agent sprite atau target yang Anda tinggalkan sebagai masalah `[missing]` dan keluar dengan exit 1. | Jalankan `--check` dengan `--tier`, `--only`, dan `--skip` yang sama seperti saat instalasi. |
| Backup memindahkan entri yang bertabrakan itu sendiri: file seperti `SKILL.md`, atau seluruh direktori milik Anda yang berada di path `templates/` atau `examples/`. | Direktori paket dan file Anda yang lain di samping link installer tetap di tempatnya. Uninstall mengembalikan setiap entri yang dipindahkan. | Salin sendiri direktori itu terlebih dahulu jika Anda menginginkan snapshot lengkap. |
| Mode copy dengan Claude Code tetap membuat path hook agent menunjuk ke dalam checkout. | File sprite memuat `bun "<checkout>"/.claude/hooks/block-git-writes.mjs`. Jika Anda menghapus checkout, hook penjaga git hilang dan penjaga berhenti bekerja. | Pertahankan checkout selama sprite terpasang, atau render ulang setelah memindahkannya. |
| `--uninstall` menghapus direktori sprite hanya jika akhirnya kosong. | Ini bisa menghapus `~/.cursor/agents` atau `~/.codex/agents` kosong yang Anda buat sendiri. Tidak ada file yang hilang. | Buat ulang dengan `mkdir` jika Anda menginginkannya kembali. |
| File bernama `.DS_Store` di dalam direktori salinan diperlakukan sebagai sampah Finder. | File ini dikecualikan dari digest dan dari perbandingan, sehingga menambahkan isi ke file dengan nama itu tidak dihitung sebagai edit. `--uninstall` menghapusnya bersama direktorinya, tanpa backup; `--update --copy` menghapusnya tanpa backup hanya ketika memperbarui direktori itu (salinan yang selebihnya identik dibiarkan apa adanya, termasuk `.DS_Store`). | Jangan simpan isi milik Anda sendiri di file dengan nama itu. |
| Marker adalah batas kepercayaan. | Siapa pun yang dapat mengedit `.vivera-managed` dapat membuat installer memperlakukan file yang sudah diedit sebagai tidak tersentuh, lalu `--update` menggantinya tanpa backup. | Pastikan direktori harness Anda hanya dapat ditulis oleh Anda. Marker adalah pencatatan, bukan kontrol keamanan. |
| Run yang terputus meninggalkan salinan sementara. | Salinan dibuat dengan nama `<dest>.vivera-tmp-<pid>` dan baru di-rename ke tempatnya setelah lengkap, sehingga run yang dihentikan paksa tidak pernah meninggalkan salinan parsial di tujuan. Run berikutnya yang menyalin tujuan itu, dan setiap `--uninstall`, menghapus sisa nama sementara dengan bentuk persis seperti itu. | Tidak ada, kecuali Anda menyimpan file sendiri bernama `<dest>.vivera-tmp-<digits>` di samping tujuan installer: `--uninstall` menghapusnya, begitu pula install atau update yang menyalin tujuan itu lagi. |
| Perubahan yang tidak mengubah byte (`chmod`, waktu modifikasi baru). | Ini bukan edit: `cmp` dan `diff` menyebut salinan itu identik, sehingga `--update` tanpa `--copy`, instalasi mode link, dan `--uninstall` mengganti atau menghapusnya dan perubahan itu hilang; `--update --copy` mendapati salinan sudah terkini dan membiarkannya apa adanya. Byte-nya tetap ada di checkout. | Simpan perubahan izin di checkout, bukan di salinan yang terpasang. |
| File sprite hasil generate yang Anda edit manual (baris marker `# Generated by`-nya masih ada). | Installer memperlakukannya sebagai miliknya: `--check` melaporkan `[stale]`, dan instalasi atau `--update` berikutnya menulis ulang file itu tanpa backup. | Edit `agents/roles/<role>.md` atau `agents/crew.json` sebagai gantinya, atau hapus baris marker agar file menjadi milik Anda (generator lalu menolak menyentuhnya dan run keluar dengan exit 1). |
| Clone atau salinan direktori skill yang terpasang ikut membawa marker. | Clone yang belum diedit di path yang dikelola installer (misalnya direktori skill harness lain) diperlakukan sebagai milik installer: `--update` memperbaruinya saat sumbernya berubah dan `--uninstall` menghapusnya, tanpa backup. Clone di bawah `sucp-<name>` baru di-prune oleh `--update` jika belum diedit (dipertahankan dengan `[KEEP]` jika sudah diedit atau jika `SKILL.md`-nya berupa symlink) dan `--uninstall` tidak pernah menyentuhnya. | Hapus file `.vivera-managed` di dalam clone. |
| Tanpa `sha256sum` dan `shasum`, dipakai `cksum` 32-bit. | Digest-nya lebih lemah, sehingga salinan yang berubah lebih mungkin dinilai tidak tersentuh. Tanpa alat hash yang berfungsi sama sekali, setiap digest kosong: marker hanya berisi `source=`, dan setiap salinan usang dihitung sebagai modified dan di-backup pada `--update --copy`, tidak pernah dihapus. | Pasang `sha256sum` atau `shasum` (coreutils). |
| File yang ditulis manual dengan nama sebuah sprite. | Generator menolak menimpanya dan membiarkannya utuh, tetap menulis enam sprite lain untuk harness itu, target lain tetap selesai, dan run keluar dengan exit 1. | Ganti nama atau pindahkan file Anda. |
| `HOME` yang read-only. | Run keluar dengan exit 1 dan tidak menulis apa pun. | Buat `HOME` dapat ditulis. |
| macOS, WSL, Windows native, dan Docker belum diverifikasi. | Semua hal di platform tersebut belum diuji, bukan diketahui gagal. `install.ps1` hanya dijalankan di PowerShell 7.6.6 di Linux, dan Dockerfile tidak pernah di-build. | Mulailah dengan `--dry-run`, lalu `--check`. |
| bash 3.2 dan BusyBox tidak pernah dijalankan. | Kode menghindari fitur bash 4, dipastikan lewat pembacaan dan grep, bukan lewat eksekusi. `shellcheck -S warning` juga dijalankan manual (bukan bagian dari `bun run ci`), tetapi tidak memeriksa versi bash. | Laporkan kegagalan beserta keluaran `--dry-run`. |

<h3 align="center" id="the-harvest-sprites">Harvest Sprites</h3>

<p align="center">
  <img alt="Karya seni resmi Back to Nature tentang Harvest Sprites: peri-peri kecil bertopi rajut yang menyiram tunas dengan kaleng penyiram hijau, membawa telur, serta menunggangi sapi dan ayam." src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/btn-harvest-sprites.jpg" width="100%">
  <br>
  <em>Tujuh Harvest Sprites sedang bekerja. Karya seni resmi Back to Nature © pemiliknya.</em>
</p>

Bagian ini mengikuti game PlayStation *Harvest Moon: Back to Nature* (Victor Interactive Software,
Jepang 16 Desember 1999, rilis bahasa Inggris oleh Natsume pada 22 November 2000), bukan *Friends of Mineral Town*,
yang sprite-nya bekerja dengan cara berbeda (lihat [glosarium](/id/docs/reference/glossary-full/)). Di dalam game itu, tujuh Harvest
Sprites (コロボックル, *Korobokkuru*) tinggal di sebuah pondok kecil di belakang Gereja. Ajak bicara salah satunya dua kali untuk meminta
bantuan setelah ia memiliki setidaknya 2 hati kasih sayang, lalu sewa ia selama 1 hari, 3 hari, atau seminggu, mulai
keesokan harinya, untuk menyiram tanaman, memanen tanaman, atau merawat hewan. Pada Musim Semi mereka hanya membicarakan Pesta Teh (Tea Party) mereka, dan Anda harus mengajak bicara sprite yang sama lima kali
agar ia mau bekerja. Mereka tampak identik kecuali warna topi dan bajunya, dan ketujuh
warna itu bersama-sama membentuk pelangi. Di Vivera setiap sprite adalah subagent bernama: nama dan
warnanya tetap, tetapi sprite mendapat peran tetap di `agents/crew.json`, bukan bebas memilih pekerjaan.

| Sprite | Di dalam game (PlayStation) | Peran di Vivera | Afinitas default | Yang dilakukannya |
|---|---|---|---|---|
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/chef.png" alt="Chef, Harvest Sprite merah" width="96"><br>**Chef** | Merah. Ulang tahun Musim Gugur 14. Suka memasak. Pada tahun keempat ia ditemukan dalam keadaan takut gelap, membawa lentera. | `implementer` | panen (harvesting) | Mengimplementasikan satu chunk dari plan yang sudah disetujui, test terlebih dahulu, di dalam file yang diizinkan. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/nappy.png" alt="Nappy, Harvest Sprite oranye" width="96"><br>**Nappy** | Oranye. Ulang tahun Musim Dingin 22. Para saudara itu tinggal bersama di rumahnya. | `implementer` | merawat hewan (animal care) | Peran yang sama dengan Chef, pada chunk yang berbeda. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/hoggy.png" alt="Hoggy, Harvest Sprite kuning" width="96"><br>**Hoggy** | Kuning. Ulang tahun Musim Gugur 10. Suka tidur dan malas bekerja. | `implementer` | panen (harvesting) | Peran yang sama dengan Chef, pada chunk yang berbeda. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/timid.png" alt="Timid, Harvest Sprite hijau" width="96"><br>**Timid** | Hijau. Ulang tahun Musim Panas 16. Mudah takut. | `researcher` | merawat hewan (animal care) | Menyelidiki satu pertanyaan sempit tentang kode, riwayat, atau web, dan tidak mengedit file apa pun. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/aqua.png" alt="Aqua, Harvest Sprite biru muda" width="96"><br>**Aqua** | Biru muda. Ulang tahun Musim Semi 26. Suka berpakaian rapi. | `researcher` | menyiram (watering) | Peran yang sama dengan Timid, pada pertanyaan yang berbeda. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/staid.png" alt="Staid, Harvest Sprite biru tua" width="96"><br>**Staid** | Biru tua (sumber lain juga menyebut biru atau indigo). Ulang tahun Musim Semi 15. | `reviewer` | merawat hewan (animal care) | Mengaudit diff, laporan subagent, atau klaim penyelesaian terhadap bukti baru, dan tidak mengedit file apa pun. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/bold.png" alt="Bold, Harvest Sprite ungu" width="96"><br>**Bold** | Ungu. Ulang tahun Musim Semi 4. Pemberani, dan mengusir yang lain dengan teriakan perang. | `debugger` | menyiram (watering) | Mengisolasi akar penyebab satu test yang gagal atau bug yang dapat direproduksi lewat hipotesis dan probe, lalu memperbaikinya pada penyebab bersamanya. |

Empat hal yang perlu diketahui:

- **Game mencatat dua angka per sprite.** Kasih sayang naik satu hati setiap 25 poin dan turun 2
  untuk setiap hari sprite bekerja untuk Anda. Level keterampilan tersembunyi per pekerjaan dimulai dari 0, naik 1 setiap
  kali ia melakukan pekerjaan itu, dan maksimal 255.
- **Kebutuhan berpengaruh, cuaca tidak.** Anda tidak dapat menyewa sprite untuk pekerjaan yang tidak ada yang perlu dikerjakan
  hari itu, tetapi sprite yang disewa tetap datang saat badai topan atau badai salju, sehingga berguna untuk memberi makan
  hewan saat badai.
- **Pekerjaan adalah default, bukan aturan.** Di dalam game, sprite mana pun dapat melakukan salah satu dari tiga pekerjaan, satu per
  permintaan. Di Vivera peran ditetapkan oleh roster, sedangkan kolom afinitas hanya default
  untuk fan-out (menyiram atau watering adalah pekerjaan keep-alive, merawat hewan atau animal care adalah aset berumur panjang, panen atau harvesting adalah
  pengiriman atau shipping). Parent boleh mengirim sprite mana pun ke chunk mana pun. Lihat
  [Glosarium Vivera](/id/docs/reference/glossary-full/).
- **Warna agent berbeda untuk dua sprite.** `agents/crew.json` memberi Aqua `blue` dan Staid `cyan`, sedangkan
  di dalam game Aqua berwarna biru muda dan Staid biru tua.

*Potret sprite di tabel adalah karya seni Harvest Moon dari Harvest Moon Wiki, © pemiliknya masing-masing. Fakta game dan sumbernya tercantum di [glosarium](/id/docs/reference/glossary-full/). Vivera adalah proyek independen dan tidak berafiliasi dengan franchise Harvest Moon.*

<a id="claude-code-agents"></a>
## Agent Claude Code

Subagent-nya adalah tujuh Harvest Sprites. Claude Code memberi label pada subagent yang sedang berjalan dengan nama
agent-nya, sehingga gelombang chunk paralel yang dikirim ke satu agent peran bersama akan menampilkan satu nama berulang-ulang. Setiap
sprite adalah salinan bernama dan berwarna dari salah satu dari empat template peran di `agents/roles/`, dan
`agents/crew.json` menetapkan sprite ke peran. Setiap peran memuat lebih dulu (preload) skill fase tempat ia bekerja,
sehingga chunk yang didelegasikan dimulai dengan aturan fasenya, bukan harus menemukannya sendiri.

| Template peran | Sprite | Tool | Skill yang di-preload | Dipakai untuk |
|---|---|---|---|---|
| `researcher` | `timid` (hijau), `aqua` (biru) | Read, Grep, Glob, Bash, TinyFish MCP | `sucp-brainstorm` | Satu pertanyaan sempit tentang kode, riwayat, atau web |
| `implementer` | `chef` (merah), `nappy` (oranye), `hoggy` (kuning) | diwarisi | `sucp-tdd-debug` | Satu chunk dari plan yang disetujui, test terlebih dahulu, di dalam file yang diizinkan |
| `debugger` | `bold` (ungu) | diwarisi | `sucp-tdd-debug` | Satu test yang gagal atau bug yang dapat direproduksi, diisolasi lewat hipotesis dan probe |
| `reviewer` | `staid` (cyan) | Read, Grep, Glob, Bash | `sucp-verify-deliver` | Audit independen atas diff atau klaim penyelesaian |

`bun run agents:gen` me-render sprite ke `.claude/agents/`; edit template atau roster, jangan pernah
file hasil generate, yang memuat baris `# Generated by` di frontmatter-nya. `bun run agents:check`
gagal ketika file hasil generate menyimpang (drift) dari sumbernya. `./install.sh` me-render crew yang sama ke `~/.claude/agents/` jika Claude Code
terdeteksi (`~/.claude` ada) atau disebut dengan `--only claude`, dan ke lima harness lain dalam format masing-masing
(lihat Agent sprite di enam harness di bawah). Sprite kemudian tersedia di setiap proyek, dengan path hook
dipatok ke repositori ini karena `$CLAUDE_PROJECT_DIR` di proyek lain tidak memiliki skrip penjaga. Installer
hanya menulis dan menghapus file yang memuat marker. Warna Staid
berbeda-beda antarsumber (lihat `docs/vivera-glossary.md`), dan Claude Code tidak memiliki indigo, sehingga cyan
menjadi penggantinya. Claude Code menggambar nama agent di atas warnanya tanpa padding, sehingga setiap `name:` adalah nama
sprite yang diapit no-break space (U+00A0), tanpa tanda kutip, yang dipertahankan YAML sementara spasi biasa akan hilang.
Label kemudian terbaca ` chef `, bukan `chef`, dan panggilan dengan `chef` biasa tetap ter-resolve.

Setiap peran membawa hook frontmatter `PreToolUse`, `.claude/hooks/block-git-writes.mjs`, yang keluar dengan exit 2 pada
subcommand git yang menulis state (`commit`, `add`, `push`, `checkout`, `switch`, `merge`, `rebase`,
`reset`, dan lainnya), pada bentuk penulisan dari perintah campuran seperti `stash`, `branch`, `tag`, `remote`, dan
`config`, serta pada setiap panggilan `gh`, termasuk di dalam rantai `a && b`. Bentuk baca seperti `git stash list` dan
`git branch --show-current` lolos. Hook ini menegakkan aturan git khusus parent dari kontrak subagent.
Hook memeriksa kata perintah di setiap segmen, mencocokkan `git` dan `gh` berdasarkan basename, dan membaca satu tingkat
ke dalam string `sh -c`, sehingga `/usr/bin/git commit` dan `sh -c "git commit"` diblokir. Alias, command
substitution yang bukan nilai dari sebuah assignment (`x=$(git commit)` diblokir), `-c` bersarang, `eval`, atau teks skrip yang di-pipe ke shell masih bisa lolos: hook ini adalah lapisan
kedua di belakang teks kontrak, bukan satu-satunya. Hook ini juga tidak mencegah panggilan `Bash` menulis file biasa, sehingga aturan "tidak mengedit file"
untuk researcher dan reviewer adalah kontrak, bukan batasan yang ditegakkan.

Hal-hal yang mudah keliru:

- **Sengaja tidak ada `CLAUDE.md`.** Claude Code membaca `AGENTS.md` sendiri hanya jika tidak ada `CLAUDE.md`
  di direktori kerja atau di direktori mana pun di atasnya. Menambahkan file itu di sini akan menghentikan pemuatan `AGENTS.md`
  kecuali file baru tersebut mengimpornya.
- **Nama di `skills:` di-resolve dari skill yang sudah terpasang di Claude Code**, bukan dari folder
  `skills/` di repositori ini. Jalankan `./install.sh` terlebih dahulu, atau preload dilewati dengan hanya peringatan di debug log.
- **Hook frontmatter dari agent proyek baru berjalan setelah dialog kepercayaan workspace diterima** untuk
  folder ini. Sebelum itu agent tetap berjalan, tanpa penjaga.
- **Claude Code mengabaikan field frontmatter yang tidak dikenal tanpa pesan apa pun**, sehingga `maxTurn:` alih-alih
  `maxTurns:` tidak berpengaruh apa-apa. `bun run agents:check` (juga bagian dari `bun run ci`) menolaknya, dan menolak
  hook yang path skripnya di bawah `$CLAUDE_PROJECT_DIR` tidak ada, karena salah ketik di sana mematikan penjaga
  tanpa pesan apa pun. Daftar field yang diizinkan dipatok ke dokumentasi Claude Code tanggal 2026-10-10.

<a id="opencode-agents"></a>
## Agent OpenCode

Jika OpenCode terdeteksi atau disebut dengan `--only opencode`, `./install.sh` me-render crew ke
`~/.config/opencode/agents/` dengan `gen-sprite-agents.mjs --target opencode`, sehingga OpenCode menjalankan tujuh
nama yang sama, bukan `general` bawaannya. Formatnya berbeda, dan perbedaannya diukur di OpenCode v2.0.24:

- **OpenCode melewati file agent Claude Code tanpa pesan apa pun.** Nama warna (`color: red`) atau
  field lama `tools:` membuat seluruh agent dibuang, sehingga file Claude Code tidak bisa sekadar di-link ke sana. File
  OpenCode memakai warna hex, `mode: subagent`, dan `steps` sebagai pengganti `maxTurns`.
- **OpenCode mengabaikan `skills:` dan `hooks:`.** Body dimulai dengan baris yang menyuruh agent memuat
  skill fasenya, dan penjaga git menjadi `permissions` shell: setiap perintah `git` dan `gh`
  ditolak, lalu bentuk baca yang umum (`git status`, `git diff`, `git log`, `git show`, dan lainnya) diizinkan
  kembali. Aturan terakhir yang cocok yang menang, dan setiap perintah dalam rantai `a && b` dicocokkan
  sendiri-sendiri. `git -C` diblokir, sehingga agent menjalankan `cd <dir> && git ...` sebagai gantinya.
- **Plugin rtk menulis ulang `git x` menjadi `rtk git x` sebelum pencocokan**, sehingga setiap aturan memiliki bentuk `rtk`.
  Tanpa bentuk itu, aturan `git commit*` tidak memblokir apa pun di mesin ini.
- Seperti hook, aturan ini tidak menangkap string `sh -c` dan alias. Researcher dan reviewer mendapat
  `edit: deny`, sehingga di OpenCode mereka tidak dapat memakai tool edit, tetapi shell tetap dapat menulis file.

Tidak ada file OpenCode yang di-commit: file-file itu di-render dari template yang sama saat instalasi. Hal yang sama
berlaku untuk setiap harness di bawah, kecuali `.claude/agents/` milik Claude Code sendiri di repositori ini.

<a id="sprite-agents-on-six-harnesses"></a>
## Agent sprite di enam harness

`scripts/gen-sprite-agents.mjs` me-render tujuh Harvest Sprites untuk enam harness, dari empat template
peran di `agents/roles/` dan roster di `agents/crew.json`. Setiap harness adalah satu file di
`scripts/sprite-agents/targets/`. `./install.sh` me-render-nya untuk setiap harness yang terdeteksi atau disebut dengan
`--only`, dan tier `minimal` tidak me-render apa pun karena generator memerlukan `bun`. `antigravity-cli`
dan `antigravity-builtin` tidak mendapat apa pun.

| Harness | File dan path | Cara peran read-only dibatasi | Penjaga git | Verifikasi |
|---|---|---|---|---|
| Claude Code | `~/.claude/agents/<sprite>.md`, Markdown dengan frontmatter YAML | `tools: Read, Grep, Glob, Bash` (timid dan aqua juga mendapat `mcp__tinyfish`), jadi tanpa tool edit; `Bash` tetap dapat menulis file | Hook frontmatter `PreToolUse` (`block-git-writes.mjs`, exit 2) pada penulisan git dan setiap panggilan `gh`; alias, `eval`, atau `sh -c` yang lebih dalam bisa lolos | Belum diverifikasi: `claude agents --json` (Claude Code 2.1.296) menampilkan sesi latar belakang, bukan definisi agent, dan panel interaktif `/agents` tidak dijalankan (perlu login). Hook ini memiliki test suite sendiri. |
| OpenCode | `~/.config/opencode/agents/<sprite>.md`, Markdown dengan daftar `permissions` | `edit: deny`; shell tidak dibatasi selain git | `permissions` shell: setiap perintah `git` dan `gh` ditolak, bentuk baca yang umum diizinkan kembali, setiap aturan `git` dan aturan `gh *` juga dalam bentuk `rtk` (aturan `gh` polos serta bentuk path `*/git *` dan `*/gh *` tidak memilikinya) | **Terverifikasi (hanya daftar):** OpenCode v2.0.24 menampilkan ketujuh sprite dan satu agent kontrol yang ditulis manual di `opencode debug agents`. Panggilan pertama mengembalikan `[]` dan yang kedua daftar parsial; panggilan 5 sampai 8 stabil. |
| Codex | `~/.codex/agents/<sprite>.toml`, TOML dengan instruksi di `developer_instructions` | `sandbox_mode = "read-only"` | Hanya penjaga prosa | Tidak dijalankan (CLI tidak terpasang). Codex mungkin tidak menegakkan `sandbox_mode` untuk agent kustom (dibaca di source Codex pada rust-v0.162.1, issue #45482 dan #40130 dilaporkan, tidak direproduksi), dan penyebutan skill dengan `$` di instruksi tidak dipindai, sehingga file meminta pemuatan sebisanya (best-effort). |
| Cursor | `~/.cursor/agents/<sprite>.md`, Markdown dengan frontmatter YAML | `readonly: true`; Cursor tidak memiliki daftar tool per agent | Hanya penjaga prosa | Tidak dijalankan (CLI tidak terpasang). Komentar YAML di frontmatter dan `description` yang diberi tanda kutip belum diverifikasi. |
| Copilot | `~/.copilot/agents/<sprite>.agent.md`, Markdown dengan frontmatter YAML, prompt dibatasi 30.000 karakter | `tools: ["read","search","execute"]`; `execute` berarti seluruh shell | Hanya penjaga prosa: dengan `execute`, shell bersifat semua atau tidak sama sekali, sehingga "tanpa git" adalah permintaan, bukan batasan | Tidak dijalankan (CLI tidak terpasang). Daftar `tools` mungkin tidak ditegakkan (issue #2638 masih terbuka), dan `~/.copilot/agents` tingkat pengguna mengungguli agent proyek dengan id yang sama. |
| Antigravity | `~/.gemini/config/agents/<sprite>/agent.md`, Markdown dengan frontmatter YAML | `tools: ["view_file","grep_search","run_command"]`, dan `commandExecutionPolicy: sandbox` di setiap file | Hanya penjaga prosa | **Belum diverifikasi:** di Antigravity 1.3.3, `agy agents` menampilkan agent kontrol yang ditulis manual dan tidak satu pun sprite, karena perintah itu hanya menampilkan agent yang `mainAgent`-nya true (default), sedangkan sprite ditulis dengan `mainAgent: false`. `invoke_subagent` tidak diuji. |

- **Peran read-only adalah `timid`, `aqua`, dan `staid`.** `chef`, `nappy`, `hoggy`, dan `bold` tidak memiliki key `tools`
  di template-nya. Di Claude Code mereka mewarisi tool parent, dan mereka tidak mendapat aturan `edit` di OpenCode,
  tidak ada `sandbox_mode` di Codex, tidak ada `readonly` di Cursor, dan tidak ada baris `tools` di Copilot dan Antigravity.
- **Read-only adalah daftar tool atau flag, bukan jaminan.** Claude Code, OpenCode, Copilot, dan Antigravity tetap menyediakan
  shell, sehingga perintah shell tetap dapat menulis file. Flag Cursor dan Codex tidak diuji.
- **Tanpa hook berarti penjaga prosa.** Di Codex, Cursor, Copilot, dan Antigravity, file memuat komentar
  `# guard: instruction only, not enforced by this harness` (di frontmatter untuk Cursor, Copilot, dan
  Antigravity, di bagian atas file TOML untuk Codex), dan body-nya menyuruh sprite menyerahkan git
  kepada sesi parent. Tidak ada yang mencegah sprite melanggar aturan itu.
- **Arti key `tools` yang dihilangkan belum diverifikasi.** Halaman Antigravity mendokumentasikan daftar kosong sebagai
  default, sehingga empat sprite penulis mungkin mulai tanpa tool di sana, dan Copilot diasumsikan membaca key
  `tools` yang tidak ada sebagai semua tool. Keduanya tidak dijalankan.
- **Komentar YAML di dalam frontmatter** memuat marker `# Generated by` dan label penjaga. Parser
  YAML Bun menerimanya di setiap file Markdown hasil render, dan `agy` menerima komentar `#` di frontmatter
  agent kontrolnya. Cursor dan Copilot tidak dijalankan, sehingga hal ini belum diverifikasi di sana.
- **Batas giliran dan skill fase.** `maxTurns` menjadi `steps` di OpenCode dan dihapus di empat harness lainnya,
  yang halamannya tidak mencantumkan key seperti itu. Claude Code melakukan preload skill fase dari `skills:`; di tempat lain baris pertama
  body menyuruh sprite memuatnya.
- Nama key dan direktori Codex, Cursor, Copilot, dan Antigravity berasal dari halaman dokumentasi vendor
  yang dibaca pada 2026-10-11, dan setiap file target tersebut menyebut halaman dan tanggalnya dalam komentar di bagian atas.
  Milik Claude Code berasal dari dokumentasinya tanggal 2026-10-10, dan milik OpenCode dari pengukuran di v2.0.24.

Untuk me-render, memeriksa, atau menghapus satu harness secara manual:

```bash
bun scripts/gen-sprite-agents.mjs --target <id> --out <dir>           # render
bun scripts/gen-sprite-agents.mjs --target <id> --out <dir> --check   # exit 1 when the files differ
bun scripts/gen-sprite-agents.mjs --target <id> --out <dir> --clean   # remove the marked files
```

`<id>` adalah `claude`, `opencode`, `codex`, `cursor`, `copilot`, atau `antigravity`. Hanya `claude` yang memiliki direktori
default (`.claude/agents` di repositori ini); yang lain memerlukan `--out`, dan `--clean` selalu memerlukan `--out`.
`--hook-root` hanya untuk `claude`. Generator hanya menulis dan menghapus file yang memuat baris
`# Generated by scripts/gen-sprite-agents.mjs`, dan menolak file yang ditulis manual dengan nama sebuah
sprite.
