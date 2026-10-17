---
title: Alur Kerja Riset Mendalam
description: Saat sebuah pilihan tidak bisa diputuskan dari codebase, sebuah laporan riset bersitasi ditulis di antara spike dan plan implementasi.
category: pipeline
slug: deep-research
order: 4
source: README.md#Deep Research Workflow
source_hash: "804f15959e2d"
---

<a id="deep-research-workflow"></a>
# Alur Kerja Riset Mendalam

Sebagian pilihan implementasi tidak bisa diputuskan dari codebase: keputusannya bergantung pada
permukaan library yang belum pernah diamati agen, pada perbandingan lebih dari dua alternatif di
beberapa sumbu, atau pada kebutuhan agar keputusan itu bisa dipertanggungjawabkan kepada reviewer
yang tidak pernah melihat penalarannya. `🔬 Deep Research Workflow` di master skill ada tepat untuk
kasus itu, dan alur ini berjalan di antara spike dan plan implementasi, bukan menggantikan salah satunya.

| Aspek | Aturan |
|---|---|
| Pemanggilan | Hanya ketika keputusan bergantung pada informasi yang tidak ada di codebase, overlay proyek, maupun konfigurasi agen yang sudah diverifikasi. Pertanyaan yang muat dalam laporan spike atau ADR tidak memerlukannya. |
| Keluaran | Laporan panjang berbasis sitasi yang disusun dari [`templates/deep-research-report-template.md`](https://github.com/belajarcarabelajar/vivera/blob/main/templates/deep-research-report-template.md). Panjangnya mengikuti cakupan pertanyaan, tidak pernah digembungkan demi batas minimum. |
| Bentuk | Ringkasan eksekutif, 3-7 tema `##` dengan subbagian `###`, lalu sintesis penutup. Sitasi inline `[n]`, delimiter LaTeX untuk notasi, prosa lebih diutamakan daripada daftar, dan tabel untuk perbandingan multi-sumbu. |
| Asal-usul | Laporan disimpan sebagai artefak bertanggal di bawah `research/` dalam proyek aktif. Plan merujuk anchor bagian laporan alih-alih mengulang temuannya; ADR merujuk laporan itu alih-alih menduplikasi sitasinya. |
| Anti-pattern | Mengutip sumber yang tidak dibaca, mengklaim laporan ditulis oleh sistem eksternal tertentu, menggembungkan panjang secara artifisial, atau menyembunyikan direktif di dalam markup, semuanya termasuk kegagalan. Ini adalah aturan skill yang menjadi tolok ukur agen saat review, bukan gerbang mesin: `validate-skill.mjs` saat ini hanya memastikan bahwa template dan contoh kerjanya ada. |

[`examples/deep-research-worked-example.md`](https://github.com/belajarcarabelajar/vivera/blob/main/examples/deep-research-worked-example.md) adalah
referensi kalibrasi: baca file ini sebelum menulis laporan pertama agar panjang, kepadatan sitasi,
dan ritme prosa laporan Anda sepadan dengannya.
