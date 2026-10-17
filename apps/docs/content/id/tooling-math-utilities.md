---
title: Utilitas Matematika
description: "Tiga modul murni tanpa dependensi: fusi bukti Bayesian dengan ambang merge, predikat struktur plan, dan model antrean M/M/c untuk dispatch."
category: tooling
slug: math-utilities
order: 5
source: README.md#Mathematical Utilities
source_hash: "17b2d89f15ef"
---

<a id="mathematical-utilities"></a>
# Utilitas Matematika

Tiga modul pure function menyediakan fondasi matematis untuk keputusan dalam workflow. Ketiganya deterministik, tanpa dependensi, dan teruji penuh dengan fixture yang dihitung secara manual.

<a id="bayesian-confidence-aggregation-scriptsbayesian-confidencemjs"></a>
## Agregasi Keyakinan Bayesian (`scripts/bayesian-confidence.mjs`)

Menggabungkan temuan independen dari beberapa subagent menjadi satu probabilitas posterior dengan bentuk odds dari teorema Bayes:

```
posterior_odds = prior_odds × ∏(p_i / (1 - p_i))
```

| Export | Kegunaan |
|---|---|
| `combineConfidence(findings, prior)` | Menggabungkan temuan independen menjadi satu posterior |
| `classifyVerdict(posterior)` | Memetakan posterior ke `auto-merge`, `human-review`, atau `reject` |
| `weightOfEvidence(confidence)` | Rasio log-likelihood (nats) untuk satu temuan |
| `aggregateFindings(findings, prior)` | Objek verdict lengkap beserta jumlah temuannya |

**Ambang batas:** `>= 0.95` auto-merge, `>= 0.70` review oleh manusia, `< 0.70` ditolak.

```bash
bun run math:bayes
```

<a id="formal-logic-invariants-scriptsformal-invariantsmjs"></a>
## Invarian Logika Formal (`scripts/formal-invariants.mjs`)

Predikat struktural yang harus terpenuhi agar sebuah plan tersusun dengan benar (well-formed). Masing-masing mengembalikan `true` atau string pelanggaran.

| Export | Invarian |
|---|---|
| `isAcyclic(graph)` | Graf dependensi berupa DAG (tanpa siklus) |
| `hasReferentialIntegrity(graph, taskIds)` | Semua dependensi merujuk ke task yang ada |
| `hasMutuallyExclusiveScopes(scopes)` | Tidak ada dua task yang mengklaim file yang sama |
| `hasValidGateOrdering(tasks)` | Verifikasi datang setelah implementasi |
| `hasUniqueIdempotencyKeys(tasks)` | Tidak ada idempotency key yang duplikat |
| `validateInvariants(plan)` | Menjalankan semua pemeriksaan dan mengembalikan daftar pelanggaran |

```bash
bun run math:invariants
```

<a id="queueing-theory-batch-sizing-scriptsqueueing-batchmjs"></a>
## Penentuan Ukuran Batch dengan Teori Antrean (`scripts/queueing-batch.mjs`)

Model antrean M/M/c untuk dispatch subagent yang optimal. Modul ini menghitung probabilitas menunggu, panjang antrean, dan ukuran batch yang meminimalkan biaya.

| Export | Rumus |
|---|---|
| `erlangC(λ, μ, c)` | Probabilitas sebuah task yang datang harus menunggu |
| `averageQueueLength(λ, μ, c)` | Rata-rata panjang antrean `L_q` |
| `averageWaitTime(λ, μ, c)` | Rata-rata waktu tunggu `W_q = L_q / λ` |
| `optimalBatchSize(λ, μ, costs)` | Ukuran batch yang meminimalkan biaya |
| `completionProbability(λ, μ, c, t)` | `P(T <= t)` |

```bash
bun run math:batch
```
