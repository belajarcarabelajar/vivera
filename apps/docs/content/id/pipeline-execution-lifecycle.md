---
title: Siklus Hidup Eksekusi
description: Permintaan diklasifikasikan sebagai Spike, Bounded, atau Architectural, lalu melewati brainstorming, persetujuan plan, dan gerbang verifikasi sebelum debt sweep (penyisiran utang).
category: pipeline
slug: execution-lifecycle
order: 1
source: docs/guide/pipeline-execution-lifecycle.md
source_hash: "f718216ee351"
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

<a id="step-by-step"></a>
## Langkah demi Langkah

Diagram ini dibagi menjadi delapan tahap, berurutan; di situs docs setiap langkah menyorot bagiannya pada diagram di atas.

<ol data-stepper="lifecycle">
<li data-nodes="Start Classify PathSpike PathBounded PathArch"><strong>Klasifikasi.</strong> Sebuah permintaan diklasifikasikan sebagai Spike, perbaikan Bounded (kurang dari 2 file), atau pekerjaan Architectural, dan setiap kelas menempuh jalurnya sendiri.</li>
<li data-nodes="DesignReport Brainstorm Gate1"><strong>Desain.</strong> Spike berakhir dengan laporan berisi rekomendasi, dan pekerjaan architectural melakukan brainstorming alternatif dan trade-off sampai spec dikunci. Di Gate 1 manusia menyetujui desain atau mengembalikannya untuk direvisi.</li>
<li data-nodes="ResearchDecision GraphPreflight DeepResearch"><strong>Riset.</strong> Deep research hanya berjalan bila informasi eksternal dibutuhkan: preflight graphify opsional atas codebase, lalu search, fetch, dan sintesis. Bila codebase sudah cukup, tahap ini dilewati.</li>
<li data-nodes="WritePlan HardGate"><strong>Plan.</strong> Visual implementation plan memuat diagram Mermaid, checklist to-do, dan kondisi <code>skip_if</code>; perbaikan Bounded langsung masuk ke sini. Gate 2 adalah gerbang persetujuan manusia yang keras: tidak ada yang dieksekusi sebelum plan disetujui.</li>
<li data-nodes="ExecRoute TDD Debug ChunkPlan FanOut SubWork Gather AuditChunk ReChunk"><strong>Eksekusi.</strong> Fitur atau refactor masuk ke test-driven development, bug ke systematic debugging, dan pekerjaan paralel dipotong menjadi chunk terkecil yang bisa diverifikasi secara mandiri. Chunk dibagikan ke 2 sampai 4 subagent (paling banyak 15) di workspace terisolasi, laporan mereka dikumpulkan dan diverifikasi ulang, dan chunk yang merah dipotong ulang lalu dikirim ulang sendirian.</li>
<li data-nodes="VerifyGate Gate3"><strong>Verifikasi.</strong> Penyelesaian butuh bukti segar: log baru, exit 0, test yang lulus, dan diff VCS. Bila bukti belum cukup, Gate 3 mengembalikan pekerjaan ke TDD.</li>
<li data-nodes="GitHygiene DebtSweep AskGate SweepFix Done"><strong>Kirim dan sapu.</strong> Pekerjaan di-commit dan dikirim sebagai pull request tanpa trailer co-author. Debt sweep (penyisiran utang) di akhir sesi memanen 3 sampai 5 follow-up berperingkat dan menanyakan mana yang dikerjakan; item yang dipilih dijalankan sebagai pekerjaan nyata, dan sesi berakhir dengan nol utang atau penundaan yang terdokumentasi.</li>
<li data-nodes="Compact"><strong>Kontinuitas.</strong> Compaction atau reset konteks bisa terjadi kapan saja: state, keputusan, dan bukti disimpan, dan pekerjaan dilanjutkan dari checkpoint terverifikasi terakhir.</li>
</ol>

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
