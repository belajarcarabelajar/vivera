---
title: Checklist Plan (daftar to-do)
description: Daftar to-do adalah checklist di file plan yang dimiliki oleh agent induk, dan setiap item yang dicentang mencantumkan perintah, exit code, dan hasilnya.
category: pipeline
slug: plan-checklist
order: 7
source: README.md#Plan Checklist (the to-do list)
source_hash: "0a2b3802e450"
---

<a id="plan-checklist-the-to-do-list"></a>
# Checklist Plan (daftar to-do)

Daftar to-do berada di file plan, dalam bentuk checklist `- [ ]`. Setiap item yang selesai
mencantumkan buktinya (perintah, exit code, hasil) dalam update yang sama dengan saat item itu
dicentang. Agent tidak memakai tool todo bawaan harness untuk keperluan ini.

Mengapa bukan tool harness: tool itu adalah salinan kedua dari daftar. Salinan itu hilang saat
compaction atau saat berganti harness, bisa menyimpang dari file plan, dan nama serta izinnya
berbeda di tiap harness (`todowrite`, `TodoWrite`, `update_plan`). Checklist di file plan
bertahan dari semua hal itu, dan sesi yang dilanjutkan langsung membacanya.

<a id="ownership"></a>
## Kepemilikan

- **Agent induk memiliki checklist.** Subagent menerima satu chunk dan mengembalikan laporan.
  Memintanya memelihara daftar justru menghasilkan daftar rekaan di laporannya.
- **Checklist berlaku per sesi, bukan per subagent.** Sepuluh subagent yang memperbarui sepuluh
  daftar berarti sepuluh daftar yang tidak pernah direkonsiliasi siapa pun. Ini sejalan dengan
  aturan satu PR per sesi.

<a id="rules-that-keep-the-checklist-honest"></a>
## Aturan yang menjaga checklist tetap jujur

- Satu item untuk setiap unit yang dapat diverifikasi secara mandiri, pada granularitas chunking.
  Item yang tidak bisa gagal sendiri juga tidak bisa dicentang sendiri.
- Setiap item menyebut **garis akhir**, bukan topik. "Tambahkan `session.test.ts` yang mencakup
  token refresh dan buat sampai lulus" adalah item. "Perbaiki modul auth" bukan item.
- **Tepat satu item yang sedang dikerjakan pada satu waktu.** Dua item yang sedang dikerjakan
  berarti dua alur kerja.
- Penyelesaian dicatat **bersama buktinya dalam update yang sama**: perintah, exit code, hasil.
  Menandai selesai lalu mencantumkan bukti belakangan adalah false pass (lulus palsu) yang hendak
  dicegah oleh aturan `skip_if` milik runner.
- Item yang baru ditemukan **ditambahkan**, tidak pernah menggantikan item yang sedang dikerjakan.

Jika file plan tidak dapat ditulis, itu adalah blocker yang harus dilaporkan. Itu bukan alasan
untuk memindahkan daftar ke tool harness.
