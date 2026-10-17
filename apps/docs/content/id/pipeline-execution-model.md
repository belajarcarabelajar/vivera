---
title: "Model Eksekusi: Subagent Lebih Dulu, Fan-Out Tinggi"
description: Agent induk memecah pekerjaan menjadi chunk kecil yang dapat diverifikasi, mengirim 10 subagent atau lebih bila memungkinkan, lalu mengumpulkan dan menyintesis laporan mereka.
category: pipeline
slug: execution-model
order: 2
source: "README.md#Execution Model: Subagent-First, High Fan-Out"
source_hash: "fc35cb785b0c"
---

<a id="execution-model-subagent-first-high-fan-out"></a>
# Model Eksekusi: Subagent Lebih Dulu, Fan-Out Tinggi

Secara default, eksekusi berjalan melalui subagent. Agent induk berperan sebagai orkestrator: ia memecah pekerjaan menjadi chunk, mengirim satu batch, lalu mengumpulkan dan menyintesis laporan-laporannya.

- **Pemecahan tugas sebelum dispatch:** pekerjaan dipecah menjadi unit terkecil yang dapat diverifikasi secara independen (satu perilaku, satu file, satu rangkaian perintah, satu hipotesis), dan setiap unit mendapat subagent sendiri.
- **Batas bawah fan-out tinggi:** targetkan 10 subagent sempit atau lebih bila tugasnya memungkinkan. Sepuluh chunk kecil selesai lebih cepat dan mengisolasi kegagalan lebih baik daripada lima chunk yang terlalu besar. Turun di bawah batas bawah ini memerlukan alasan tertulis (tugas atomik, tidak ada tool subagent, atau state bersama yang tidak dapat dipisahkan).
- **Kumpulkan dan sintesis:** laporan subagent adalah masukan, bukan kesimpulan. Agent induk menghapus duplikat, menyelesaikan konflik berdasarkan bukti, memverifikasi ulang setiap klaim lewat diff/log/status exit, dan menggabungkan satu hasil sebelum melanjutkan.
- **Gerbang audit:** setiap chunk yang sudah diintegrasikan harus lolos audit diff oleh agent induk sebelum dihitung selesai. Chunk yang merah dipecah ulang dan dikirim ulang sendirian.

Eksekusi inline hanya ada sebagai pengecualian yang terdokumentasi, bukan default.
