---
title: Mulai Cepat & Instalasi
description: Satu perintah install.sh memasang paket skill ke setiap tool agent yang terdeteksi, dan --check memverifikasi hasilnya melalui exit code.
category: getting-started
slug: quick-start
order: 3
source: docs/guide/getting-started-quick-start-1.md
source_hash: "78368f631759"
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
