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
