---
title: Pengindeksan Vault dan Verifikasi Knowledge Graph
description: Kontrak, script, dan gate yang membangun knowledge graph atas vault Obsidian lokal dan arsip percakapan dari lapisan struktural dan semantik.
category: tooling
slug: vault-indexing
order: 4
source: README.md#Vault Indexing & Knowledge Graph Verification
source_hash: "90f2803fd1d4"
---

<a id="vault-indexing--knowledge-graph-verification"></a>
# Pengindeksan Vault dan Verifikasi Knowledge Graph

Repositori ini memelihara kontrak ekstraksi, script, dan gerbang verifikasi untuk membangun knowledge graph yang menyeluruh atas vault Obsidian lokal dan arsip percakapan, tanpa biaya ekstraksi di cloud:

- **Lapisan Struktural (`vault-index-structural.mjs`)**: Ekstraksi lokal yang deterministik atas node dokumen, heading ATX (edge `contains`), dan `[[wikilinks]]` (edge `references`).
- **Lapisan Semantik (`vault-index/semantic/`)**: Subagent mengekstrak node `concept` yang bersinyal tinggi beserta atribut keputusan ke file chunk yang terisolasi menggunakan [`templates/vault-index-subagent-contract.md`](https://github.com/belajarcarabelajar/vivera/blob/main/templates/vault-index-subagent-contract.md), dengan kepatuhan ketat pada `scripts/lib/chunk-schema.mjs`.
- **Manifest (`vault-index/manifest.json`)**: Mencatat root yang dilacak, hash konten sha256, ukuran dalam byte, dan jumlah node di lebih dari 9.600 baris.
- **Pengelompokan Komunitas (`vault-index-cluster.mjs` / `.py`)**: Menjalankan algoritma deteksi komunitas Leiden bawaan graphify secara lokal pada graph yang sudah dirakit.

<a id="verification-gate-scriptsvault-index-verifymjs"></a>
## Gerbang Verifikasi (`scripts/vault-index-verify.mjs`)

Verifikasi task T12 membuktikan bahwa graph yang disusun secara manual memenuhi semua kontrak struktural, privasi, dan kueri:

```bash
bun scripts/vault-index-verify.mjs                 # full gate: coverage + privacy + live graphify read paths
bun scripts/vault-index-verify.mjs --no-graphify   # fast gate: coverage and privacy rules only (~2s, CI-safe)
```

| Asersi | Kontrak |
|---|---|
| Cakupan | Setiap path dalam worklist terverifikasi sebagai `source_file` di graph atau tercatat dalam skip list manifest. |
| Batas Privasi | Memverifikasi bahwa tidak ada `source_file` milik node yang berada di bawah direktori sensitif yang dikecualikan (misalnya `Satset/`). Pelanggaran batas langsung gagal secara terang-terangan. |
| Integritas Jalur Baca | Memverifikasi bahwa `graphify query`, `graphify explain`, dan `graphify path` berjalan dengan exit 0 dan keluaran yang tidak kosong terhadap graph yang sudah dirakit. |
