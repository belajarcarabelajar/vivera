---
title: "Model Eksekusi: Subagent Lebih Dulu, Fan-Out Proporsional"
description: Agent induk memecah pekerjaan menjadi chunk kecil yang dapat diverifikasi, menyesuaikan jumlah subagent dengan chunk yang saling lepas (inline, 2 sampai 4, paling banyak 15), lalu mengumpulkan dan menyintesis laporan mereka.
category: pipeline
slug: execution-model
order: 2
source: docs/guide/pipeline-execution-model.md
source_hash: "490217189017"
---

<a id="execution-model-subagent-first-high-fan-out"></a>
# Model Eksekusi: Subagent Lebih Dulu, Fan-Out Proporsional

Secara default, eksekusi berjalan melalui subagent. Agent induk berperan sebagai orkestrator: ia memecah pekerjaan menjadi chunk, mengirim satu batch, lalu mengumpulkan dan menyintesis laporan-laporannya.

- **Pemecahan tugas sebelum dispatch:** pekerjaan dipecah menjadi unit terkecil yang dapat diverifikasi secara independen (satu perilaku, satu file, satu rangkaian perintah, satu hipotesis). Unit kecil digabung agar setiap subagent mendapat 15+ turn kerja nyata, karena setiap subagent baru menanggung biaya awal yang besar.
- **Fan-out proporsional:** tugas satu langkah dikerjakan inline, pekerjaan menengah mendapat 2 sampai 4 subagent, dan 10 sampai 15 hanya bila memang ada chunk saling lepas sebanyak itu (paling banyak 15 yang berjalan bersamaan). Tindak lanjut berurutan memakai ulang subagent yang masih hidup, karena setiap subagent baru membayar lagi prefix startup-nya.
- **Kumpulkan dan sintesis:** laporan subagent adalah masukan, bukan kesimpulan. Agent induk menghapus duplikat, menyelesaikan konflik berdasarkan bukti, memverifikasi ulang setiap klaim lewat diff/log/status exit, dan menggabungkan satu hasil sebelum melanjutkan.
- **Gerbang audit:** setiap chunk yang sudah diintegrasikan harus lolos audit diff oleh agent induk sebelum dihitung selesai. Chunk yang merah dipecah ulang dan dikirim ulang sendirian.
- **Konsultasi advisor:** bila tool agent menyediakan advisor (model yang lebih kuat yang membaca seluruh percakapan), hanya agent induk yang berkonsultasi dengannya, pada tiga momen: sebelum putaran pertanyaan yang berisi 2 pertanyaan atau lebih, sebelum memilih pendekatan yang menjadi dasar plan, dan setelah plan disetujui saat menemui hambatan (error yang sama untuk kedua kalinya, spiral stop, atau pergantian pendekatan). Advisor tidak dikonsultasikan sebelum langkah rutin atau klaim selesai. Subagent tidak pernah berkonsultasi dengannya: subagent menjalankan apa yang sudah diputuskan sebelum perencanaan dan melaporkan hambatan ke agent induk. Waktu konsultasi ini belum diukur.

Eksekusi inline hanya ada sebagai pengecualian yang terdokumentasi, bukan default.
