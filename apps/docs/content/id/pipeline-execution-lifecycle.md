---
title: Siklus Hidup Eksekusi
description: Permintaan diklasifikasikan sebagai Spike, Bounded, atau Architectural, lalu melewati brainstorming, persetujuan plan, dan gerbang verifikasi sebelum debt sweep (penyisiran utang).
category: pipeline
slug: execution-lifecycle
order: 1
source: docs/guide/pipeline-execution-lifecycle.md
source_hash: "adcb79c259ba"
---

<a id="execution-lifecycle"></a>
# Siklus Hidup Eksekusi

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/docs/generated/lifecycle-dark.svg">
  <img alt="Siklus hidup eksekusi: sebuah permintaan diklasifikasikan sebagai Spike, Bounded, atau Architectural; semua jalur bertemu di Brainstorming (Gate 1), lalu Visual Implementation Plan (Gate 2, persetujuan manusia yang wajib); Deep Research opsional dengan preflight Graphify dapat menyisipkan bukti; eksekusi diarahkan ke TDD, Systematic Debugging (RCA 4 fase), atau Subagent Orchestration (chunk → fan-out proporsional → gather → loop audit); gerbang Verification (Gate 3) mendahului Finishing dan Git Hygiene; sesi ditutup dengan Debt Sweep (penyisiran utang) dan pertanyaan tindak lanjut multi-select; Compaction menjaga state tetap utuh saat konteks di-reset." src="/docs/generated/lifecycle.svg" width="820">
</picture>

<p align="center">
  <em>Siklus hidup eksekusi, dari sebuah permintaan sampai pengiriman yang terverifikasi dan debt sweep.</em>
</p>

<a id="test-later-mode"></a>
## Mode Test-Later

Langkah TDD biasanya menulis test yang gagal sebelum ada kode produksi. Mode test-later mengubah urutan langkah itu untuk pekerjaan fitur ketika pemilik ingin melihat hasilnya dulu (render, preview, build, atau hasil CLI) dan menilainya sendiri sebelum ada test. Test dipindah ke akhir perubahan, tidak pernah dihapus.

- **Pemicu.** Hanya ucapan pemilik sendiri, misalnya "kilat", "test belakangan", atau "test later". Agen tidak pernah memilih mode ini sendiri. Design (atau plan) memuat baris `Mode: test-later`, dan menyetujui gerbang itu berarti menyetujui modenya.
- **Cakupan.** Pekerjaan fitur di jalur Bounded atau Architectural. Bukan perbaikan bug, dan bukan run overnight.
- **Urutan.**
  1. Kode: implementasikan checklist yang disetujui tanpa siklus RED/GREEN.
  2. Build dan tampilkan: jalankan build, render, atau preview, lalu tampilkan artefaknya di chat, bukan hanya perintahnya.
  3. Manual check: pemilik menilai hasilnya di gerbang `Manual check`, dan setiap hal yang ia laporkan menjadi kriteria bernomor (`MC1`, `MC2`, ...) dengan kata-katanya sendiri. Hasil yang salah kembali ke langkah 1.
  4. Test dari catatan: satu test per item `MC`, dengan nilai yang diharapkan diambil dari pengamatan pemilik. Item yang tidak bisa dijangkau test tetap menjadi bukti manual dan disebut di body PR.
  5. RED terhadap base: test baru dijalankan di worktree scratch detached di bawah `/tmp` pada commit base dan harus gagal di sana, lalu lulus di worktree sesi.
- **Pengiriman.** Verifikasi tidak berubah: pull request tetap menunggu test hijau, dan body-nya mencantumkan setiap item `MC`, test-nya, serta run RED terhadap base.
