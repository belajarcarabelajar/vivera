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
| Ratchet | File yang sudah melewati batas memiliki plafon di `scripts/file-size-baseline.json`: tidak boleh membesar, dan file yang menyusut menurunkan plafonnya di commit yang sama. `--write-baseline` hanya menurunkan atau menghapus plafon; menaikkannya adalah edit manual di commit yang sama, yang pesannya memuat `size-raise: <plan-id> <reason>`. |
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
