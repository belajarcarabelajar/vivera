---
title: Mengekspor Riwayat OpenCode ke Obsidian
description: scripts/export-opencode-history.mjs menyalin database sesi SQLite OpenCode lokal secara satu arah menjadi catatan Obsidian di bawah 05 - Conversations.
category: tooling
slug: opencode-export
order: 3
source: README.md#Exporting OpenCode History to Obsidian
source_hash: "25d2cc5709fb"
---

<a id="exporting-opencode-history-to-obsidian"></a>
# Mengekspor Riwayat OpenCode ke Obsidian

`scripts/export-opencode-history.mjs` menyediakan mirror satu arah yang deterministik dari database sesi SQLite OpenCode lokal (`~/.local/share/opencode/opencode.db`) ke catatan markdown Obsidian di bawah `05 - Conversations/<Project>/`.

```bash
bun run export:history [options]
bun scripts/export-opencode-history.mjs --dry-run --limit 5
bun scripts/export-opencode-history.mjs --project-dir ~/vivera
```

<a id="safety-and-content-guarantees"></a>
## Jaminan Keamanan dan Konten

| Aspek | Cara penanganannya |
|---|---|
| Akses SQLite Hanya-Baca | Database dibuka dengan `readonly: true` (`openReadonly()`). Tidak ada query yang menyentuh tabel `credential`; tidak ada jalur kode yang mampu menulis ke database. |
| Lampiran Inline | Gambar sesi inline dan lampiran biner di-hash dengan sha256 lalu dibongkar ke `.attachments/`. Timestamp dipertahankan antar-run (`restoreUnchangedAttachmentTimes`) sehingga `obsidian-git` tidak membuat commit positif palsu untuk gambar yang tidak berubah. |
| Pembatasan Spill | Output eksekusi tool berukuran besar yang dialihkan ke disk dibaca dengan aman di dalam root yang diizinkan. Path traversal (`..` dan symlink yang menunjuk ke luar root) ditolak secara tegas, dan output yang melebihi `maxBytes` dipotong dengan penanda yang terlihat jelas. |
| Penyamaran Rahasia | 8 pola rahasia yang berbeda disamarkan dari pesan sebelum ditulis: AWS access key, GitHub PAT classic & fine-grained, PEM private key, JWT, Bearer token, kode TOTP, dan penetapan API key generik. |
| Deteksi Perubahan | `sync-writer.mjs` memeriksa isi catatan sebelum menulis. Run ulang terhadap database yang tidak berubah melakukan nol penulisan ke disk. |
| Pembatasan Kegagalan | Penulisan di-buffer: sesi yang rusak dicatat ke log dan dilewati satu per satu, tetapi jika lebih dari separuh batch gagal, run keluar dengan kode non-zero tanpa menulis apa pun. |

<a id="cli-options"></a>
## Opsi CLI

| Flag | Kegunaan |
|---|---|
| `--dry-run` | Merender dan me-resolve sesi tanpa menulis catatan atau lampiran ke disk. |
| `--limit N` | Memproses paling banyak N sesi, dimulai dari yang terlama (0 berarti tidak ada yang diproses). |
| `--vault PATH` | Root vault Obsidian tujuan (default ke `$OPENCODE_EXPORT_VAULT`, jika tidak ada maka key `vaultRoot` di `local.config.json`; lihat `local.config.example.json`). |
| `--db PATH` | Path ke database SQLite OpenCode (default ke `~/.local/share/opencode/opencode.db`). |
| `--project-dir PATH` | Menyaring agar hanya sesi yang terkait dengan PATH atau subdirektorinya yang diekspor. |
