---
title: Integritas Integrasi graphify
description: Dua script yang mendeteksi blok graphify yang basi di AGENTS.md dan melapor ketika graphify install menimpa plugin graphify OpenCode.
category: integrations
slug: graphify-integrity
order: 1
source: README.md#graphify Integration Integrity
source_hash: "0ff26ca35e7d"
---

<a id="graphify-integration-integrity"></a>
# Integritas Integrasi graphify

<a id="agentsmd-section-drift-scriptsagents-md-currentmjs"></a>
## Drift Bagian AGENTS.md (`scripts/agents-md-current.mjs`)

Mendeteksi kapan blok `## graphify` sebuah repo di `AGENTS.md` sudah basi dibandingkan binary `graphify` yang terpasang. Blok yang **hilang** akan terkoreksi dengan sendirinya (agent kembali memakai grep). Blok yang **basi** lebih buruk: blok itu menyatakan graph tidak ada padahal ada, sehingga agent diam-diam melewatkan `graphify query` sepanjang sesi.

```bash
bun scripts/agents-md-current.mjs
```

<a id="plugin-drift-guard-scriptsgraphify-plugin-driftmjs"></a>
## Penjaga Drift Plugin (`scripts/graphify-plugin-drift.mjs`)

Menjaga `.opencode/plugins/graphify.js` dari penimpaan diam-diam oleh `graphify install --project`. Hasil pengukuran menunjukkan installer tersebut mengubah bentuk ekspor plugin menjadi signature yang belum terverifikasi dan menghapus catatan resolusi modul yang ditulis tangan. Script ini **hanya melapor**: script ini tidak punya jalur tulis, dan sebuah test memastikan byte file lokal tidak berubah setelah setiap pemanggilan.

```bash
bun scripts/graphify-plugin-drift.mjs
```

Runbook terukur lengkap: [`docs/graphify-integration.md`](/id/docs/integrations/graphify-runbook/).
