---
title: Context Hooks
description: Tiga hook Claude Code opsional yang membatasi Read penuh, mengganti output tool yang besar dengan awal, akhir, dan path simpanannya, serta memulihkan blok state setelah compaction.
category: tooling
slug: context-hooks
order: 9
source: docs/context-hooks.md
source_hash: "06508f28f56e"
---

<a id="context-hooks"></a>
# Context Hooks

Ditulis 2026-11-05. Tiga command hook Claude Code yang opsional (opt-in): hook
ini menjaga output tool yang besar agar tidak masuk ke context window dan
memulihkan blok state faktual yang singkat setelah compaction. Untuk sekarang
hanya untuk Claude Code; versi Codex dan OpenCode menyusul.

Merge kode tidak memasang apa pun. Apakah hook ini direkomendasikan untuk
dipakai sehari-hari bergantung pada hasil eval A/B (byte tool result, token,
biaya, dan pass rate dengan dan tanpa hook). Sampai hasil itu ada, anggap hook
ini sebagai eksperimen.

Istilah di sini (Output cap, Output replacement, Session journal, State block,
Kill switch) didefinisikan di `GLOSSARY.md`.

<a id="1-what-the-hooks-do"></a>
## 1. Apa yang dilakukan hook

| Hook | Event dan matcher | Perilaku |
|---|---|---|
| `scripts/hooks/output-cap.mjs` | PreToolUse `Read` | Menolak Read seluruh file untuk file di atas 16.384 B dan menyebut alternatif yang terbatas (Read dengan `offset` dan `limit`, `rg -n`, `sed -n`, `wc -c`). Read dengan `offset` atau `limit`, file yang tidak ada, atau direktori selalu lolos. |
| `scripts/hooks/output-replace.mjs` | PostToolUse `Bash` dan `mcp__.*` | Bila output di atas 4.096 B, menyimpan teks lengkapnya ke file dan mengganti output dengan 1.024 B pertama dan terakhir ditambah satu baris berisi ukuran yang dihilangkan dan path simpanannya. Output gambar tidak diubah. |
| `scripts/hooks/session-journal.mjs` | PostToolUse `Edit`, `Write`, `NotebookEdit` dan PostToolUseFailure `Bash` (`record`); SessionStart `compact` (`inject`) | Mencatat setiap path yang diedit dan setiap perintah yang gagal (200 karakter pertama dan exit code-nya). Setelah compaction, menyuntikkan blok state paling banyak 2.048 B: branch, HEAD, path yang baru diedit, kegagalan terakhir, dan file plan terakhir yang diedit. Bila ada perbedaan, file plan yang menang. |

Setiap hook keluar dengan 0 pada error internal apa pun dan membiarkan
pemanggilan tool berjalan (fail open, aturan L98); satu-satunya blokir yang
disengaja adalah penolakan output cap. Kode bersama ada di
`scripts/lib/hook-io.mjs`.

<a id="2-install-check-uninstall"></a>
## 2. Pasang, cek, lepas

Jalankan dari root repositori:

```bash
bun run context:hooks --install     # tambahkan entri ke ~/.claude/settings.json
bun run context:hooks --check       # laporkan apakah entri terpasang dan terkini
bun run context:hooks --uninstall   # hapus hanya entri milik installer ini
```

`--dry-run` mencetak perubahan tanpa menulisnya, dan `--settings <file>`
menunjuk file settings lain. Installer mempertahankan setiap entri hook milik
pihak lain (graphify dan milik Anda sendiri) dan menolak file settings yang
rusak tanpa mengubahnya. `./install.sh --check` juga mencetak baris
`context-hooks`. Mulai sesi Claude Code baru setelah memasang atau melepas,
supaya sesi membaca settings yang berubah.

<a id="3-kill-switch-error-log-directories"></a>
## 3. Kill switch, log error, direktori

| Apa | Path default | Pengganti |
|---|---|---|
| Direktori state | `~/.local/state/vivera/` | `VIVERA_HOOK_STATE_DIR` |
| Kill switch | `~/.local/state/vivera/context-hooks-off` | ada di direktori state |
| Log error | `~/.local/state/vivera/hook-errors.log` | ada di direktori state |
| Direktori scratch | `~/.cache/tmp/vivera-scratch/` | `VIVERA_HOOK_SCRATCH_DIR` |
| Output tersimpan | `<scratch>/tool-output/<session_id>/<tool_use_id>.txt` | mengikuti direktori scratch |
| Journal sesi | `<scratch>/journal/<session_id>.jsonl` | mengikuti direktori scratch |

- Kill switch: `touch ~/.local/state/vivera/context-hooks-off` langsung membuat
  setiap context hook tidak melakukan apa pun, tanpa restart. Hapus file itu
  untuk menyalakannya lagi.
- Log error: satu baris per error internal, `<waktu ISO> <nama hook> <pesan>`.
  Periksa log ini bila sebuah hook tampak tidak melakukan apa-apa.
- Output tersimpan dan journal ada di direktori scratch dan tidak dirotasi atau
  dibatasi; hapus folder sebuah sesi secara manual bila sudah tidak diperlukan.

<a id="4-revert"></a>
## 4. Revert

1. Saklar mati cepat: `touch ~/.local/state/vivera/context-hooks-off`.
2. Lepas hook: `bun run context:hooks --uninstall` (sama dengan
   `bun scripts/context-hooks-install.mjs --uninstall`), lalu mulai sesi Claude
   Code baru. Pastikan dengan `bun run context:hooks --check`.
3. Hapus data: hapus `~/.cache/tmp/vivera-scratch/tool-output/`,
   `~/.cache/tmp/vivera-scratch/journal/`, dan dua file di atas di
   `~/.local/state/vivera/`.
4. Hapus kode: revert commit yang menambahkan `scripts/hooks/output-cap.mjs`,
   `scripts/hooks/output-replace.mjs`, `scripts/hooks/session-journal.mjs`,
   `scripts/lib/hook-io.mjs`, dan `scripts/context-hooks-install.mjs`.
