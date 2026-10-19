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
