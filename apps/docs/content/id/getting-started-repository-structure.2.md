<a id="session-metrics"></a>
## Metrik sesi

`bun run metrics` (`scripts/session-metrics.mjs`) melaporkan berapa biaya pipeline dan bagaimana perilakunya, dibaca hanya dari transkrip Claude Code di `~/.claude/projects/<slug>` dan dari `pr.registry.json`. Script ini menghitung sesi utama, run subagent per tipe, panggilan API, token, padanan harga daftar API dalam USD, konteks panggilan pertama, panggilan `AskUserQuestion`, pemuatan Skill, PR yang di-merge, dan escape (commit di `origin/main` dengan trailer `Fixes:`).

```bash
bun run metrics -- --since 2026-10-09 --until 2026-10-19 --json
```

Sebuah sesi dimasukkan ke jendela `--since`/`--until` (hari UTC penuh) berdasarkan timestamp pertamanya, dan id pesan yang muncul di dua file transkrip dihitung sekali. Script ini hanya mencetak hitungan, tidak pernah teks transkrip, input tool, atau hasil tool. Direktori proyek yang tidak ada keluar dengan exit 1, karena sumber yang tidak terbaca bukan hasil kosong.

Angka dolar dihitung per panggilan API dengan harga model panggilan itu sendiri dan TTL cache-nya (penulisan cache 5 menit 1,25x harga input, penulisan 1 jam 2x), memakai tabel harga bertanggal yang tanggalnya dicetak sebagai `pricesAsOf`, lalu dirinci per model dan per PR yang di-merge. Angka ini adalah padanan harga daftar API untuk token yang sama, bukan jumlah yang ditagihkan: langganan ditagih dengan cara lain. Panggilan dari model yang belum punya harga tidak ikut dihitung dan disebutkan di catatan (notes), jadi angka itu bukan nol bagi model tersebut, hanya belum lengkap.

<a id="scripts-without-a-section-of-their-own"></a>
## Script yang tidak punya bagian sendiri

Pohon di atas hanya mencantumkan sebagian isi `scripts/`, dan bagian-bagian berikutnya
mendokumentasikan sebagian besar sisanya. Script berikut tidak punya bagian sendiri, jadi
tabel inilah tempat penjelasannya. Setiap baris diambil dari komentar header script itu
sendiri. File test (`*.test.mjs`) berada di samping script yang diujinya dan tidak dicantumkan.

| Script | Fungsinya |
|---|---|
| `install-skill-links.mjs` | Menautkan setiap skill di `skills/` ke `~/.config/opencode/skills/`, satu-satunya tempat yang dibaca tool skill OpenCode. Tidak pernah menimpa file asli atau symlink asing. `install.sh` juga menautkan phase skill; script ini adalah cara mandiri untuk menjalankan ulang atau memverifikasi bagian itu saja. `bun run skills:link` menerapkan tautan, `bun run skills:check` keluar dengan kode 1 jika ada tautan yang hilang atau usang, `--dry-run` mencetak aksinya. |
| `ci-targeted.mjs` | `bun run ci:targeted`, gate default untuk commit dan PR. Memilih pemeriksaan berdasarkan file yang berubah terhadap `origin/main`: graf import di `scripts/`, `validate` untuk skill dan template, pemeriksaan agents dan snippets hanya saat bagian itu berubah, `render-diagrams` hanya untuk sumber diagram, serta aturan copy dan pemeriksaan ukuran file selalu. File konfigurasi root dan toolchain (`package.json` kecuali yang berubah hanya `scripts`-nya, `bun.lock`, installer) atau path yang tidak dikenali memilih `bun run ci` penuh. `--rencana` (`--plan`) mencetak pemeriksaan yang dipilih beserta alasannya; `--penuh` (`--full`) menjalankan `bun run ci` penuh. |
| `frontmatter-strict.mjs` | Menjalankan frontmatter plan melalui pemeriksaan YAML yang ketat. Parser milik runner sendiri hanyalah subset yang longgar, jadi sebuah plan bisa lolos dari parser itu tetapi tetap bukan YAML yang valid. |
| `validate-lib.mjs` | Bagian murni yang bisa di-import dari `validate-skill.mjs`, ditambah `renderMermaidBatch`, agar unit test bisa mengunci pemeriksaannya. |
| `mermaid-batch.mjs` | Merender daftar file `.mmd` dari stdin dengan fallback batch-and-bisect, dipakai bersama oleh `render-diagrams.sh` dan `validate-skill.mjs`. |
| `puppeteer-browser.mjs` | Mengarahkan `mmdc` ke Chromium atau Chrome sistem di PATH saat `~/.cache/puppeteer` tidak ada dan `PUPPETEER_EXECUTABLE_PATH` tidak diset, dipakai bersama oleh `render-diagrams.sh` dan `validate-skill.mjs`. |
| `skill-corpus.mjs` | Menyimpan daftar phase skill dan `readSkillCorpus`, yang membaca master skill dan phase skill sekaligus untuk para validator. |
| `vault-index-merge.mjs` | Menggabungkan chunk-chunk menjadi satu `graph.json`. |

<a id="frozen-surfaces"></a>
## Permukaan yang dibekukan

Permukaan berikut tetap menyimpan kode dan tesnya, tetapi tidak mendapat fitur baru dan tidak di-deploy sampai rilis bertag pertama (pembekuan dicabut begitu ada tag `v*`):

- Situs dokumentasi di `apps/docs`.
- Installer Windows: `install.ps1` dan `scripts/install/windows-*.ps1`.
- Setup container: `Dockerfile` dan `.devcontainer`.
- Tooling rilis: `scripts/bootstrap.sh` dan `scripts/release`.
