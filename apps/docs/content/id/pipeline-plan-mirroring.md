---
title: "Mirroring Plan: Obsidian dan GitHub Issues"
description: Plan disalin satu arah ke Obsidian dan GitHub issue, dan body issue adalah teks plan byte demi byte ditambah trailer berisi id, status, dan hash.
category: pipeline
slug: plan-mirroring
order: 6
source: "README.md#Plan Mirroring: Obsidian and GitHub Issues"
source_hash: "e8db92333a54"
---

<a id="plan-mirroring-obsidian-and-github-issues"></a>
# Mirroring Plan: Obsidian dan GitHub Issues

Sebuah plan punya dua salinan turunan, dan keduanya satu arah. Repositori proyek
adalah sumber kebenaran; setiap salinan lain adalah state turunan yang dibuat ulang,
tidak pernah diedit.

| Salinan | Apa yang didapat | Kunci idempotensi |
|---|---|---|
| Catatan Obsidian | Bisa dicari, enak dibaca, Mermaid dirender, terhubung ke graph | `source_hash` yang dicatat di frontmatter catatan itu sendiri |
| GitHub issue | **Riwayat**: siapa yang membukanya, kapan disetujui, apa yang ditutup dan kapan, setiap komentar dalam satu timeline yang sudah diindeks GitHub dan ditautkan dari commit | Nomor issue yang dicatat di `plan.issues.json` |

Body issue **adalah** teks plan, byte demi byte, ditambah trailer yang bisa dibaca
mesin berisi id plan, key, path sumber, status, dan hash. Body berupa ringkasan
dilarang: ringkasan adalah sumber kebenaran kedua yang diam-diam menjadi usang begitu
plan berubah, dan saat itu issue menjadi salah tanpa ada yang melaporkannya.
Trailer itulah yang membuat pertanyaan "apakah issue ini masih terkini?" bisa dijawab dari issue itu saja.
Plan yang lebih panjang dari batas body GitHub sebesar 65.536 karakter dijadikan prefiks
verbatim terpanjangnya, dipotong di batas baris, lalu diikuti satu baris `**Truncated:**`
eksplisit yang menyebut N dari M karakter dan path plan di repositori, kemudian trailer
yang tidak berubah, yang hash-nya tetap mencakup plan secara utuh: prefiks dengan penanda,
tidak pernah ringkasan.

<a id="three-things-that-will-bite-you-and-why-they-are-built-this-way"></a>
## Tiga hal yang akan menjebak Anda, dan mengapa dibuat seperti ini

**Nomor issue tidak pernah ditulis ke frontmatter plan.** Mirror vault menghitung hash
seluruh teks plan, jadi menyisipkan nomor akan mengubah `source_hash` dan seketika
membuat setiap mirror vault usang, yang memblokir `--execute` dengan exit 3. Nomor itu
disimpan di file pendamping (sidecar), `plan.issues.json`, itulah sebabnya file plan tetap
stabil byte demi byte.

**Body dikirim lewat stdin, tidak pernah lewat argv.** Body plan sebesar 10 KB di command
line akan mentok di `ARG_MAX` dan melewati aturan quoting shell, sehingga byte-nya tidak
lagi identik dengan plan, padahal itulah premis utama mirror ini. Setiap penulisan memakai
`--body-file -`.

**State issue diturunkan dari `status` plan, tidak pernah dipilih.**

| `status` plan | State issue | Alasan |
|---|---|---|
| `Draft`, `Approved`, `InProgress`, `Verification` | open | |
| `Blocked` | open | Pekerjaan yang terblokir belum selesai. Menutupnya berarti melaporkan pekerjaan yang sudah rampung. |
| `Complete` | closed | |

Issue yang ditutup manual tidak menang, karena issue adalah state turunan. Plan yang
sedang berjalan, yang issue-nya ditutup manual oleh seseorang, akan membuka kembali issue
itu pada sync berikutnya, jadi merapikan board tidak pernah melepaskan plan dari mirror-nya
secara permanen.

<a id="the-decision-is-pure-which-is-why-it-is-tested-without-a-network"></a>
## Keputusannya murni, itulah sebabnya diuji tanpa jaringan

`syncOne` menghasilkan tepat satu dari lima aksi, dari `(recorded entry, plan
text, plan status)`:

| Aksi | Pemicu | Efek |
|---|---|---|
| `create` | belum ada yang tercatat | satu `gh issue create`, body lewat stdin |
| `update-body` | hash berbeda | satu `gh issue edit` dengan judul dan body |
| `update-state` | open/closed berbeda | satu `gh issue edit --state` |
| `update-and-state` | keduanya berbeda | **satu** panggilan edit, bukan tiga |
| `current` | tidak ada yang berbeda | **nol** panggilan `gh` |

`current` adalah no-op yang sebenarnya dan dilaporkan sebagai jenisnya sendiri, sehingga
`--check` dan `--status` bisa membedakan "sudah terkini" dari "dry run tidak menulis apa
pun". Menjalankan sync dua kali tidak melakukan penulisan kedua, dan itulah yang mencegah
issue duplikat muncul di repositori sungguhan.

```bash
bun run issue:sync <plan.md>...     # create or sync
bun run issue:check <plan.md>...     # drift report, never writes, exit 1 on drift
bun run issue:status                 # table of every recorded link, always exit 0
```

Proyek yang tidak punya entri di `plan.issues.json` **ditolak, bukan ditebak**: plan yang
tercatat di repositori yang salah lebih buruk daripada plan yang tidak tercatat sama sekali.
Plan tanpa `status:` di frontmatter-nya juga ditolak, karena tidak ada state yang bisa
diturunkan. Kegagalan sync tidak membatalkan plan; laporkan exit code-nya, dan jangan
membuat issue secara manual sebagai jalan pintas, karena issue buatan tangan tidak membawa
trailer sehingga terbaca sebagai drift permanen.

> `plan.issues.json` menyimpan pemetaan `project -> owner/repo` dan **memang** di-commit,
> karena itu adalah konfigurasi. Tautan issue tercatat yang terkumpul di dalamnya adalah
> state koordinasi yang hidup; arahkan `PLAN_ISSUES_CONFIG` ke salinan yang di-gitignore
> (`plan.issues.local.json`) di mesin yang melakukan sync plan, agar dua puluh sesi yang
> menulis ke satu file tidak bertabrakan di version control.

Catatan issue dari setiap repositori berbagi satu store, `ISSUES_STORE` di
`scripts/plan-issue-sync.mjs`: `plan.issues.json` di root checkout tempat script
dijalankan, atau path di `PLAN_ISSUES_CONFIG`. Karena itu, run dari worktree vivera
memakai file milik worktree itu kecuali variabel tersebut di-set. Catatan diberi kunci
berupa path plan relatif terhadap repositorinya, tanpa repositori di dalam kunci, sehingga
dua repositori dengan plan bernama sama akan mendarat di satu catatan. `syncOne` menolak
catatan yang repositorinya bukan repositori yang sedang di-sync, sebelum ada panggilan `gh`
atau penulisan apa pun; ganti nama file plan untuk memperbaikinya. Gerbang merged (`pr-registry state <s>
merged`, melalui `checkCloseout`) membaca store yang sama, menentukan "repositori ini"
dengan `resolveProjectRepo` yang sama, dan melaporkan catatan seperti itu sebagai `ISSUE_OTHER_REPO`.
