---
title: Validasi & Pemeriksaan Kualitas
description: Suite validasi lokal memeriksa frontmatter, integritas master file, anggaran token, symlink, template, script, dan sintaks Mermaid.
category: tooling
slug: validation
order: 8
source: README.md#Validation & Quality Checks
source_hash: "83ec951775d8"
---

<a id="validation--quality-checks"></a>
# Validasi & Pemeriksaan Kualitas

Jalankan suite validasi otomatis secara lokal:

```bash
# Install the pinned toolchain (once)
bun install

# Fast runner frontmatter contract check (~1s, pure AST comparison)
bun run contract:check
```

`bun run ci` menjalankan langkah-langkah ini secara berurutan, sebagaimana didefinisikan `scripts/ci-targeted.mjs`:

<!-- include: scripts/ci-targeted.mjs#full-ci -->
```js
const TEST_CMD = ['bun', 'test', '--timeout', '30000'];

// Mirrors the `ci` script; a test keeps them in sync.
export const FULL_CI = [
  { name: 'render-diagrams', cmd: ['bash', 'scripts/render-diagrams.sh'] },
  { name: 'validate-skill', cmd: ['bun', 'scripts/validate-skill.mjs'] },
  { name: 'validate-agents', cmd: ['bun', 'scripts/validate-agents.mjs'] },
  { name: 'gen-sprite-agents', cmd: ['bun', 'scripts/gen-sprite-agents.mjs', '--check'] },
  { name: 'file-size', cmd: ['bun', 'scripts/check-file-size.mjs', '--all'] },
  { name: 'tests', cmd: [...TEST_CMD, 'scripts/'] },
  { name: 'sync-snippets', cmd: ['bun', 'scripts/sync-snippets.mjs', '--check'] },
];
```
<!-- /include -->

Untuk commit atau PR, jalankan `bun run ci:targeted` sebagai gantinya dan kutip plan `--rencana`-nya; perintah itu sendiri yang memilih CI penuh bila perubahan memerlukannya.

Yang diverifikasi:
- Sintaks frontmatter YAML (`name`, `description`, `triggers`).
- Integritas master file, kontrak debt sweep (penyisiran utang), dan estimasi anggaran token (~34k token, diukur dengan ~4 karakter/token).
- Validitas symlink di `skills/super-ultra-code-plan/SKILL.md`.
- Keberadaan semua template wajib dan script yang dapat dieksekusi.
- Validitas sintaks Mermaid untuk setiap blok ` ```mermaid` di repo (keluar dengan kode 1 pada error apa pun).
- `accTitle` dan `accDescr` ada di setiap diagram.
- Kedua file config mermaid dapat di-parse dan mem-pin `theme` + `fontFamily`.
- Hero README yang di-commit tersedia dalam versi terang dan gelap.
- `ultra-plan-runner` menegakkan peta visual: heading task, node task, dan `depends_on` harus cocok dengan edge Mermaid ke dua arah.
- Trigger snippet membawa kontrak subagent yang wajib dan memakai Bun, bukan runtime yang dilarang.
- Confirmation Protocol di-pin (blok 3l dari `scripts/validate-skill.mjs`): `sucp-rules` memuat bagian tersebut beserta aturan kuncinya, orkestrator dan setiap phase skill merujuknya dengan nama, debt sweep dan template follow-up-nya menyatakan batas 4 opsi, dan frasa persetujuan ketik yang lama (`wait for explicit yes`, `nod sufficient`, `wait for explicit approval before plan`) sudah dihapus. Paragraf `CONFIRMATIONS:` di setiap trigger snippet di-pin oleh `bun test scripts/`.
- `snippets.manifest.json` konsisten: valid, lengkap, tanpa uuid atau keyword duplikat, dan setiap trigger snippet terlacak.
- Kontrak plan-publishing terdokumentasi: referensi CLI publisher, penanda idempotensi, dan `plans.publish.json` yang valid.

Sengaja tidak dicakup oleh `bun run ci`: `mirror:check`, yang memerlukan vault yang tidak dapat
dilihat runner ini. Jalankan secara lokal bila Anda memiliki vault tersebut.

<a id="code-blocks-copied-from-source"></a>
## Blok Kode yang Disalin dari Sumber

Sebuah blok kode di halaman docs bisa merupakan salinan file sumber. Salinannya tetap ada di halaman, jadi GitHub menampilkannya, dan sebuah pemeriksaan gagal ketika salinan itu tidak lagi sama dengan sumbernya:

````markdown
<!-- include: scripts/ci-targeted.mjs#full-ci -->
```js
...the lines between the region markers...
```
<!-- /include -->
````

- Tanpa `#<region>`, isi blok adalah seluruh file. Region adalah baris-baris di antara `docs-include:start <region>` dan `docs-include:end <region>`, ditulis dengan sintaks komentar file sumber itu sendiri; baris penanda dan indentasi bersama tidak ikut.
- `bun run docs:include` dan `bun scripts/docs-gen.mjs --check` melaporkan blok yang berbeda dari sumbernya, file atau region yang tidak ada, dan blok yang salah bentuk, masing-masing sebagai `file:line`. `bun scripts/docs-include.mjs --write` memperbarui blok yang usang.
- `bun run ci:targeted` menjadwalkan pemeriksaan docs ketika file yang disebut sebuah include berubah, jadi perubahan pada sumbernya saja juga tertangkap.
- Contoh di dalam blok berpagar, seperti contoh di atas, tidak diperiksa. Twin bahasa Indonesia menyalin setiap blok include byte demi byte dan hanya menerjemahkan teks di sekitarnya.

<a id="platform-matrix"></a>
## Matriks Platform

`.github/workflows/platforms.yml` menjalankan suite installer di platform yang tidak dimiliki mesin ini. Seperti workflow lain, workflow ini tidak punya pemicu otomatis; jalankan secara manual dengan `gh workflow run platforms.yml` dan pantau dengan `gh run watch`. GitHub baru menawarkannya setelah file itu ada di branch default.

| Job | Runner | Yang dibuktikan |
|---|---|---|
| `windows` | `windows-latest`, sekali dengan `pwsh` dan sekali dengan Windows PowerShell 5.1 | install.ps1 yang dijalankan dari prompt pwsh, langsung dan lewat relay Bun (child 5.1 hanya mewarisi `PSModulePath` PowerShell 7 lewat proses perantara), dengan `PSModulePath` dihapus sebagai kontrol; lalu suite `install-ps1*` di Windows sungguhan tanpa ada yang dilewati: link berjalan sebagai junction NTFS dan path yang tak terbaca sebagai ACE deny untuk Everyone. Job gagal bila shell tidak ada atau edisinya salah, jadi suite tidak bisa melewati semua test lalu lulus. Reparse point OneDrive tetap belum terbukti |
| `macos` | `macos-latest` dengan `/bin/bash` 3.2 paling depan di `PATH` | suite `install-*` dan `prereq`, serta `install.sh --dry-run`, di bawah bash bawaan macOS |
| `docker` | `ubuntu-latest` | `Dockerfile` berhasil di-build dan `install.sh --check` lulus di dalam image |

`bun test scripts/workflows.test.mjs` memastikan setiap workflow tetap hanya bisa dijalankan manual (dispatch-only).
