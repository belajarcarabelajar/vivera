---
title: Pengantar
description: Vivera adalah pipeline skill yang memandu agent coding AI dari ide dan desain, melalui persetujuan plan, TDD, debugging, dan verifikasi, sampai debt sweep (penyisiran utang).
category: getting-started
slug: introduction
order: 1
source: README.md
source_hash: "1f3ea3bfb47e"
---

<p align="center">
  <img alt="Vivera, maskot proyek ini: seorang gadis berambut pendek yang tersenyum, mengenakan kostum maid cyberpunk biru dengan celemek holografik, memegang tablet clipboard yang menyala di jalan kota neon yang diguyur hujan." src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/vivera.jpg" width="100%">
  <br>
  <em>Vivera, nama fiktif yang terinspirasi dari Elli dalam Harvest Moon: Back to Nature.</em>
</p>

Pipeline skill yang memandu agent coding AI melalui seluruh siklus hidup rekayasa perangkat lunak: **Ide -> Desain -> Plan -> Gerbang Persetujuan Manusia -> TDD -> Debugging Sistematis -> Orkestrasi Subagent -> Verifikasi -> Penyelesaian -> Debt Sweep Penutupan Sesi (penyisiran utang)**.

- **Empat komponen bergerbang.** Brainstorming → Penulisan Plan → TDD → Verifikasi, dengan gerbang persetujuan manusia di antara setiap komponen, ditambah jalur **Deep Research** yang hanya berjalan ketika sebuah keputusan bergantung pada informasi yang tidak ada di codebase. Pipeline sub-agent yang menjalankan pekerjaan ini wajib, bukan sekadar rekomendasi.
- **Satu sumber kebenaran.** `Super Ultra Code Plan Implementation.md` menjaga invarian kontekstual, batasan keamanan, dan gerbang persetujuan manusia tetap terlihat sepanjang run.
- **Verifikasi adalah gerbang terakhir, bukan langkah terakhir.** Setelah plan berstatus `Done 100%` dan buktinya hijau, agent memanen setiap item dari sesi itu yang sempat diperhatikan tetapi belum ditutup, memeringkat 3-5 tindak lanjut yang bisa diselesaikan saat itu juga, lalu menanyakannya sebagai kotak centang multi-select di widget prompt milik harness sendiri. Sesi berakhir tanpa utang coding yang belum diperiksa.

## Instalasi

```bash
git clone https://github.com/belajarcarabelajar/vivera.git
cd vivera
./install.sh           # installs into every agent harness it detects
./install.sh --check   # prints check: CURRENT and exits 0 when the install is in order
```

Jalankan `./install.sh --dry-run` lebih dulu untuk melihat apa yang akan dilakukannya tanpa menulis apa pun. Tier, flag, dan jalur instalasi lainnya ada di [Mulai Cepat & Instalasi](/id/docs/getting-started/quick-start/).

## Harvest Sprites

**Vivera** adalah nama fiktif yang terinspirasi dari Elli, salah satu karakter dalam *Harvest Moon: Back to Nature*. Kosakata di sekitar pipeline ini meminjam dari game yang sama: skill adalah tanaman, pull request adalah lamaran Blue Feather (bulu biru), subagent adalah tujuh Harvest Sprites (peri panen; menyiram berarti keep-alive, merawat hewan berarti aset berumur panjang, memanen berarti shipping), dan registry PR adalah shipping bin (kotak pengiriman). Nuansa ini hanya kosmetik; setiap perintah, path, dan perilaku dalam dokumen ini bermakna harfiah. Lihat [Glosarium Vivera](/id/docs/reference/glossary-full/).

<p align="center">
  <a href="/id/docs/reference/harvest-sprites/"><img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/chef.png" alt="Chef, Harvest Sprite merah" width="72"></a>
  <a href="/id/docs/reference/harvest-sprites/"><img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/nappy.png" alt="Nappy, Harvest Sprite oranye" width="72"></a>
  <a href="/id/docs/reference/harvest-sprites/"><img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/hoggy.png" alt="Hoggy, Harvest Sprite kuning" width="72"></a>
  <a href="/id/docs/reference/harvest-sprites/"><img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/timid.png" alt="Timid, Harvest Sprite hijau" width="72"></a>
  <a href="/id/docs/reference/harvest-sprites/"><img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/aqua.png" alt="Aqua, Harvest Sprite biru muda" width="72"></a>
  <a href="/id/docs/reference/harvest-sprites/"><img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/staid.png" alt="Staid, Harvest Sprite biru tua" width="72"></a>
  <a href="/id/docs/reference/harvest-sprites/"><img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/bold.png" alt="Bold, Harvest Sprite ungu" width="72"></a>
</p>

Setiap sprite adalah subagent bernama dengan satu peran tetap: Chef, Nappy, dan Hoggy mengimplementasikan, Timid dan Aqua meriset, Staid me-review, dan Bold men-debug. Potret, sifat di dalam game, dan peran mereka ada di [Harvest Sprites](/id/docs/reference/harvest-sprites/).

Dokumentasi ini juga dipublikasikan di [vivera.belajarcarabelajar.com/docs](https://vivera.belajarcarabelajar.com/docs/), dan workshop tim memiliki halamannya sendiri di [vivera.belajarcarabelajar.com/workshop](https://vivera.belajarcarabelajar.com/workshop/).

## Panduan

Sisa dokumentasi berada di [`docs/guide/`](https://github.com/belajarcarabelajar/vivera/tree/main/docs/guide) dan di `docs/`, satu file untuk setiap halaman situs dokumentasi, sesuai urutan situs. Halaman yang terlalu panjang untuk satu file dipecah per subbagian menjadi beberapa bagian bernomor.

- [Struktur Repositori](/docs/getting-started/repository-structure/), lanjut di bagian [2](/docs/getting-started/repository-structure/)
- [Mulai Cepat & Instalasi](/docs/getting-started/quick-start/), lanjut di bagian [2](/docs/getting-started/quick-start/), [3](/docs/getting-started/quick-start/), [4](/docs/getting-started/quick-start/)
- [Siklus Hidup Eksekusi](/docs/pipeline/execution-lifecycle/)
- [Model Eksekusi: Subagent Lebih Dulu, Fan-Out Proporsional](/docs/pipeline/execution-model/)
- [Konfirmasi Tanpa Mengetik](/docs/pipeline/confirmations/)
- [Alur Kerja Riset Mendalam](/docs/pipeline/deep-research/)
- [Menjalankan Plan ultra-plan/v1](/docs/pipeline/executing-a-plan/)
- [Mirroring Plan: Obsidian dan GitHub Issues](/docs/pipeline/plan-mirroring/)
- [Checklist Plan (daftar to-do)](/docs/pipeline/plan-checklist/)
- [Pengiriman Pull Request & Batch Merge](/docs/pipeline/pr-delivery/)
- [Rendering Mermaid](/docs/tooling/mermaid-rendering/)
- [Snippet Pemicu](/docs/tooling/trigger-snippets/), lanjut di bagian [2](/docs/tooling/trigger-snippets/), [3](/docs/tooling/trigger-snippets/)
- [Pengindeksan Vault dan Verifikasi Knowledge Graph](/docs/tooling/vault-indexing/)
- [Audit Siklus Hidup Plan dan Penyelesaian Task](/docs/tooling/lifecycle-audit/)
- [Validasi & Pemeriksaan Kualitas](/docs/tooling/validation/)
- [Template Pendamping](/docs/reference/companion-templates/)
- [Contoh](/docs/reference/examples/)
- [Pemberitahuan Pihak Ketiga dan Penafian](/docs/reference/third-party-notices/)
- [Lisensi](/docs/reference/license/)
- [Glosarium Vivera](/docs/reference/glossary/)
- [Glosarium Vivera Lengkap](/docs/reference/glossary-full/)
- [Harvest Sprites](/docs/reference/harvest-sprites/)
- [Integritas Integrasi graphify](/docs/integrations/graphify-integrity/)
- [Runbook Integrasi graphify](/docs/integrations/graphify-runbook/)
