---
title: Validasi & Pemeriksaan Kualitas
description: Suite validasi lokal memeriksa frontmatter, integritas master file, anggaran token, symlink, template, script, dan sintaks Mermaid.
category: tooling
slug: validation
order: 8
source: README.md#Validation & Quality Checks
source_hash: "8f1c40a3cd4f"
---

<a id="validation--quality-checks"></a>
# Validasi & Pemeriksaan Kualitas

Jalankan suite validasi otomatis secara lokal:

```bash
# Install the pinned toolchain (once)
bun install

# Fast runner frontmatter contract check (~1s, pure AST comparison)
bun run contract:check

# Render all diagrams to diagrams/
bun run render-diagrams

# Validate frontmatter, symlinks, templates, scripts, mermaid syntax & a11y
bun run validate

# Unit tests for every script under scripts/
bun test scripts/

# Trigger prompts vs the Snipset database (skips cleanly where no database exists)
bun run snippets:check
```

Atau jalankan seluruh gate secara berurutan dengan `bun run ci`. Untuk commit atau PR, jalankan `bun run ci:targeted` sebagai gantinya dan kutip plan `--rencana`-nya; perintah itu sendiri yang memilih CI penuh bila perubahan memerlukannya.

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
