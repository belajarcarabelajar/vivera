---
title: Siklus Hidup Eksekusi
description: Permintaan diklasifikasikan sebagai Spike, Bounded, atau Architectural, lalu melewati brainstorming, persetujuan plan, dan gerbang verifikasi sebelum debt sweep (penyisiran utang).
category: pipeline
slug: execution-lifecycle
order: 1
source: README.md#Execution Lifecycle
source_hash: "ebd1e6713b7d"
---

<a id="execution-lifecycle"></a>
# Siklus Hidup Eksekusi

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/docs/generated/lifecycle-dark.svg">
  <img alt="Siklus hidup eksekusi: sebuah permintaan diklasifikasikan sebagai Spike, Bounded, atau Architectural; semua jalur bertemu di Brainstorming (Gate 1), lalu Visual Implementation Plan (Gate 2, persetujuan manusia yang wajib); Deep Research opsional dengan preflight Graphify dapat menyisipkan bukti; eksekusi diarahkan ke TDD, Systematic Debugging (RCA 4 fase), atau Subagent Orchestration (chunk → fan-out 10+ → gather → loop audit); gerbang Verification (Gate 3) mendahului Finishing dan Git Hygiene; sesi ditutup dengan Debt Sweep (penyisiran utang) dan pertanyaan tindak lanjut multi-select; Compaction menjaga state tetap utuh saat konteks di-reset." src="/docs/generated/lifecycle.svg" width="820">
</picture>

<p align="center">
  <em>Siklus hidup eksekusi, dari sebuah permintaan sampai pengiriman yang terverifikasi dan debt sweep.</em>
</p>
