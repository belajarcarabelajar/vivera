---
title: Pengindeksan Vault dan Verifikasi Knowledge Graph
description: Kontrak, script, dan gate yang membangun knowledge graph atas vault Obsidian lokal dan arsip percakapan dari lapisan struktural dan semantik.
category: tooling
slug: vault-indexing
order: 4
source: README.md#Vault Indexing & Knowledge Graph Verification
source_hash: "5f4f9e27a922"
---

<a id="vault-indexing--knowledge-graph-verification"></a>
# Pengindeksan Vault dan Verifikasi Knowledge Graph

Repositori ini memelihara kontrak ekstraksi, script, dan gerbang verifikasi untuk membangun knowledge graph yang menyeluruh atas vault Obsidian lokal dan arsip percakapan, tanpa biaya ekstraksi di cloud:

- **Lapisan Struktural (`vault-index-structural.mjs`)**: Ekstraksi lokal yang deterministik atas node dokumen, heading ATX (edge `contains`), dan `[[wikilinks]]` (edge `references`).
- **Lapisan Semantik (`vault-index/semantic/`)**: Subagent mengekstrak node `concept` yang bersinyal tinggi beserta atribut keputusan ke file chunk yang terisolasi, dengan kepatuhan ketat pada `scripts/lib/chunk-schema.mjs`.
- **Manifest (`vault-index/manifest.json`)**: Mencatat root yang dilacak, hash konten sha256, ukuran dalam byte, dan jumlah node di lebih dari 9.600 baris.
