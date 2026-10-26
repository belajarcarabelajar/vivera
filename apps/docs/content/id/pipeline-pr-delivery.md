---
title: Pengiriman Pull Request & Batch Merge
description: Setiap sesi berakhir dengan pull request di branch-nya sendiri, operasi tulis git tetap di tangan parent, dan PR registry melakukan merge sesi sesuai urutan dependensi.
category: pipeline
slug: pr-delivery
order: 8
source: README.md#Pull Request Delivery & Batch Merge
source_hash: "29378c3e9c67"
---

<a id="pull-request-delivery--batch-merge"></a>
# Pengiriman Pull Request & Batch Merge

Sebuah sesi berakhir dengan pull request di branch-nya sendiri, tidak pernah dengan commit
di branch kerja. Itulah yang membuat dua puluh sesi atau lebih bisa berjalan bersamaan
tanpa berantakan, dan alasannya mekanis: ketika lebih dari satu sesi menyentuh satu
repositori, muncul tiga kegagalan, dan **tidak satu pun memicu error di level git**,
karena setiap perintah valid jika berdiri sendiri.

| Kegagalan | Apa yang sebenarnya terjadi | Dicegah oleh |
|---|---|---|
| Dua sesi di satu branch | Push kedua melakukan fast-forward atau ditolak, agent lalu memakai `--force`, dan PR sesi pertama kini membawa commit sesi kedua | Nama branch **diturunkan** oleh `pr-registry claim`, duplikat ditolak saat claim, load, dan save |
| Dua sesi di satu worktree | `git worktree add` gagal, atau sesi kedua bekerja di dalam checkout sesi pertama dan kedua diff menjadi kacau | Path worktree diturunkan dengan cara yang sama, dan worktree berada *di samping* repositori, tidak pernah di dalamnya |
| Merge sesuai urutan selesai | Sesi yang bergantung pada sesi lain masuk lebih dulu, lalu konflik dengan sisa batch | Urutan topologis dihitung dari graf `depends_on` yang tercatat, nilai seri diputus berdasarkan nama agar urutannya bisa direproduksi |

<a id="two-ownership-rules-that-make-concurrency-safe"></a>
## Dua aturan kepemilikan yang membuat konkurensi aman

**Operasi tulis git hanya milik parent.** Subagent mengedit file dan menjalankan test.
Subagent tidak pernah menjalankan `git commit`, `git add`, `git checkout`, `git switch`,
`git merge`, `git rebase`, `git stash`, `git reset`, `git push`, atau `gh`. Index git
adalah state bersama yang bisa berubah dan tidak punya lock per penulis, sehingga dua
subagent yang melakukan staging bersamaan menghasilkan commit yang memuat perubahan
setengah jadi dari subagent lain, dan commit itu tidak pernah dites dalam bentuk tersebut.
Parent mengintegrasikan per chunk dengan membaca `git diff -- <permitted paths>` dan
melakukan staging dengan path eksplisit, tidak pernah `git add .`.

**Satu sesi, satu PR.** Dua puluh subagent di dalam satu sesi adalah satu PR. Dua puluh
sesi adalah dua puluh PR. Satu PR per subagent mengubah run dua puluh sesi menjadi antrean
merge berisi dua ratus PR.

<a id="the-session-state-machine"></a>
## State machine sesi

`pr-registry.mjs` menyimpan state, dan state-state itu ada untuk membuat dua kesalahan
tertentu mustahil terjadi:

```
isolated → active → verified → open → merged
                                    ↘ closed
```

| Batasan | Mengapa ini error keras |
|---|---|
| Nomor PR tidak bisa dicatat sebelum `verified` | Mencatat nomor PR menyiratkan pekerjaan sudah selesai dan diperiksa, jadi `isolated → open` akan melewati gate yang membuat merge aman |
| Hanya sesi `open` yang punya PR yang bisa di-merge | Run lokal yang hijau saja belum menjadikan sebuah sesi siap di-merge |
| `merged` dan `closed` bersifat terminal | Me-revert atau mengulang sebuah sesi berarti sesi baru dengan branch baru. File yang bisa "membatalkan merge" menyembunyikan revert dari urutan merge |
| Sesi yang ditutup tidak menggeser base | `merged` adalah alasan untuk memperbarui branch karena ia memajukan `origin/main`; `closed` tidak, sehingga `surface` tidak pernah mencantumkannya sebagai sudah masuk, sementara `order` tetap memperlakukannya sebagai dependensi yang terpenuhi |
| Branch atau worktree duplikat ditolak | Registry yang melaporkan sukses untuk tata letak yang akan menghilangkan pekerjaan lebih buruk daripada tidak punya registry sama sekali |

```bash
bun scripts/pr-registry.mjs claim --plan <plan-id> --session <slug> --worktree [--depends-on <slug>,<slug>]
bun scripts/pr-registry.mjs state <session> <isolated|active|verified|open|merged|closed>
bun scripts/pr-registry.mjs state <session> merged [--repo <path>]
bun scripts/pr-registry.mjs open <session> --title "<t>" --body-file <f> [--draft]
bun scripts/pr-registry.mjs pr <session> --number 42   # a PR opened by hand
bun scripts/pr-registry.mjs reconcile [--dry-run] [--stale-days N] [--close-stale]
bun scripts/pr-registry.mjs order       # topological merge order
bun scripts/pr-registry.mjs surface w3  # what must land in the branch first, what blocks it
bun scripts/pr-registry.mjs status
```

`claim --worktree` menjalankan sendiri `git worktree prune`, `fetch`, dan `worktree add`,
dan bersifat idempoten: claim yang diulang setelah sesi crash mengembalikan slot yang sama.
`open` menolak sesi yang belum `verified`, mendorong branch-nya, menjalankan `gh pr create`, lalu mencatat
nomornya. `state <s> merged` tidak pernah menolak karena plan: celah close-out dicetak
sebagai peringatan dan merge tetap dicatat. `reconcile` mencatat `merged` atau `closed`
dari `gh pr view`, melewati dengan menyebut nama sesi yang tidak bisa dibaca atau
dicocokkan, dan menutup sesi tanpa PR yang usang hanya dengan `--close-stale`.

Branch turunannya adalah `<plan-id>/<session-slug>`, tanpa prefiks tool atau workflow.
Dulu ada prefiks `ai/`, dan prefiks itu dihapus dengan alasan yang sama seperti aturan
attribution-footer di bawah: nama branch adalah riwayat permanen yang bisa dibaca publik,
sehingga sebuah prefiks menegaskan kepengarangan di satu-satunya artefak yang tidak bisa
disensor siapa pun setelahnya. Plan id sudah memuat tanggal dan deskripsi pekerjaannya.
Slot yang di-claim sebelum perubahan ini tetap memakai branch yang sudah di-claim-nya,
jadi tidak ada migrasi dan tidak ada rename yang perlu dibatalkan.
`pr.registry.json` sengaja **di-gitignore**. File ini adalah state live per mesin yang
mencatat branch mana yang sedang dipegang setiap sesi yang berjalan saat ini; meng-commit-nya
berarti menggabungkan sesi yang sedang berjalan dari dua puluh mesin ke dalam satu file dan
menjamin konflik pada claim berikutnya.

<a id="merging-twenty-prs"></a>
## Melakukan merge dua puluh PR

Satu per satu, sesuai urutan yang dicetak `order`, dan setiap merge membawa buktinya sendiri:

1. Merge `origin/main` ke branch sesi tersebut **tepat sebelum merge-nya sendiri**.
   Caranya merge, bukan rebase: branch itu sudah punya PR, dan rebase butuh force push yang
   dilarang di tahap ini. Base bergeser di setiap merge, jadi branch yang diperbarui pada posisi 3 sudah tertinggal
   saat tiba di posisi 7. `surface <s>` melaporkan sesi mana saja yang sudah masuk sejak
   branch itu dibuat.
2. Selesaikan konflik apa pun **di branch sesi tersebut**, tidak pernah di base branch, lalu
   jalankan ulang verifikasi sesi itu. Mengedit base untuk "memperbaiki" konflik menghasilkan
   perubahan yang tidak bisa diatribusikan atau di-review oleh sesi mana pun.
3. Merge PR yang satu ini.
4. Jalankan ulang pemeriksaan lokal di base yang baru. Run itulah bukti untuk merge *tersebut*.

Mengumpulkan dua puluh merge sekaligus lalu mengetesnya di akhir membuat sembilan belas di
antaranya tidak terverifikasi. Sesi yang tidak bisa dibuat siap merge dilaporkan dan
dilewati sementara batch tetap berjalan; itu adalah status, bukan alasan untuk membekukan
sembilan belas sesi lainnya. Sesi yang sudah di-merge keluar dari urutan dan berhenti
memblokir sesi yang bergantung padanya, dan siklus dependensi ditolak dengan menyebutkan
siklusnya, karena tidak ada urutan yang valid untuk sebuah siklus.

<a id="two-boundaries-this-stage-does-not-cross"></a>
## Dua batas yang tidak dilewati tahap ini

**CI remote dilaporkan, tidak pernah diadopsi.** Pemeriksaan repositori ini berjalan secara
lokal sesuai kebijakan, jadi run GitHub Actions yang hijau adalah bukti dari penulisnya
tentang sebuah commit, bukan bukti dari sesi ini tentang working tree. Membacanya sebagai
verifikasi adalah kesalahan yang sama dengan melakukan push untuk memicu runner milik orang lain.

**Membuat review dan memposting review adalah dua tindakan berbeda.** Komentar yang
diposting adalah artefak yang lebih pendek daripada laporan internal: verdict, temuan yang
memblokir, tidak lebih. Manusia membaca teks persisnya terlebih dahulu. Lihat [`templates/pr-review-template.md`](https://github.com/belajarcarabelajar/vivera/blob/main/templates/pr-review-template.md)
untuk tabel cakupan, aturan line-anchoring, dan verdict biner.
