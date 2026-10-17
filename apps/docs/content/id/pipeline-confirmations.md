---
title: Konfirmasi Tanpa Mengetik
description: Setiap gerbang keputusan manusia ditanyakan lewat question tool bawaan alat agen dengan opsi siap pakai, sehingga jawabannya cukup satu ketukan atau Enter.
category: pipeline
slug: confirmations
order: 3
source: README.md#Confirmations Without Typing
source_hash: "4e34d17b388c"
---

<a id="confirmations-without-typing"></a>
# Konfirmasi Tanpa Mengetik

Setiap titik saat pipeline berhenti untuk menunggu keputusan manusia, dari intent lock di Langkah 1 hingga debt sweep (penyisiran utang) di Langkah 6, merupakan pemanggilan question tool bawaan harness dengan opsi siap pakai, sehingga jawabannya cukup satu ketukan atau Enter. Tidak ada gate yang bertanya "lanjut?" sebagai teks chat biasa, dan mengetik tetap bisa dilakukan di mana pun tool menyediakan input bebas (Claude Code dan OpenCode menyediakannya). Ini mengubah cara sebuah gate ditanyakan, bukan apakah gate itu ada.

| Harness | Tool | Batasan | Jawaban bebas |
|---|---|---|---|
| Claude Code | `AskUserQuestion` | 1 sampai 4 pertanyaan, masing-masing 2 sampai 4 opsi, header maksimal 12 karakter, `multiSelect` | tool menambahkan "Other" |
| OpenCode v2 | `question` | header, prompt, pilihan, `multiple`; menutup pertanyaan berarti membatalkan | selalu tersedia |

Diverifikasi 2026-10-11: Claude Code terhadap skema tool-nya, OpenCode v2 terhadap <https://opencode.ai/v2/docs/tools/>. Harness lain (termasuk Antigravity) belum diverifikasi: agen mencari question tool berdasarkan nama, membaca skemanya, lalu memakai padanan terdekat. Jika tidak ada tool, tool mengalami error, atau tidak ada klien interaktif, agen menampilkan daftar bernomor di pesan terakhir, menyebutkan bahwa widget prompt tidak tersedia, dan membiarkan gate tetap tertutup.

Bentuk sebuah pertanyaan:

- Artefaknya (draf intent, desain, ringkasan plan, diff stat, teks komentar persisnya) ditampilkan di chat terlebih dahulu, baru kemudian ditanyakan.
- 2 sampai 4 opsi. Opsi yang direkomendasikan muncul pertama dengan label `(Recommended)`, sehingga Enter langsung menerimanya. Label terdiri dari lima kata atau kurang, masing-masing dengan deskripsi satu baris.
- Paling banyak 4 pertanyaan per pemanggilan dan paling banyak 4 opsi per pertanyaan. Debt sweep mengelompokkan follow-up-nya ke dalam pertanyaan multi-select dengan paling banyak 4 opsi.
- Debt sweep diakhiri dengan gate `Close plan`. Gate ini terlebih dahulu mencentang kotak langkah task berdasarkan bukti, lewat dua perintah berurutan: `bun scripts/ultra-plan-runner.mjs <plan.md> --execute > runner.log`, lalu `bun scripts/plan-mark-done.mjs <plan.md> --from runner.log`. Kemudian `bun scripts/plan-closeout.mjs --readiness <plan.md>` menjalankan `skip_if` milik setiap task dan melaporkan `READY`, `NOT-READY` atau `NEEDS-HUMAN` (`NOT-READY` selama masih ada kotak langkah task yang terbuka, dihitung sebagai `open step boxes: N`; kotak di luar bagian task dicantumkan sebagai `other open boxes: M` dan dicentang manual dengan bukti), dan `Mark Complete` menjadi opsi yang direkomendasikan hanya saat `READY`. Plan yang tetap dibiarkan terbuka mendapat bagian `## Closeout status` berisi apa yang masih tersisa. `bun scripts/plan-closeout.mjs --audit` mendaftar plan yang semua sesinya sudah di-merge padahal plan-nya masih terbuka.
- Tindakan yang destruktif, sulit dibatalkan, terlihat secara eksternal, atau menyentuh sistem bersama (force push, delete, merge, publish, deploy) menempatkan opsi aman di urutan pertama, `Cancel, do nothing`, dan opsi persetujuan di urutan kedua dengan menyebut tindakan persisnya. Enter tidak pernah menjalankan tindakan itu, sehingga tidak ada opsi yang membawa `(Recommended)`, dan pertanyaan seperti ini selalu diajukan sendiri, tidak pernah dibundel.
- Setiap opsi yang direkomendasikan menyebutkan alasannya: deskripsinya diawali `Why:` dan satu baris dasar (fakta repositori, hasil terukur, atau aturan pipeline di balik gate tersebut), lalu satu baris biasa tentang apa yang terjadi berikutnya, atau `Why: my judgment` jika hanya itu dasarnya. Sebuah penilaian tidak pernah disajikan sebagai best practice yang belum diperiksa.
- Pertanyaan berisiko tidak membawa tag, tetapi teks pertanyaannya memuat satu baris `Facts:`, misalnya nomor PR, head commit, status mergeable, dan checks. Baris ini adalah bukti untuk ditimbang, bukan dorongan ke salah satu opsi.
- Menjawab "tidak yakin" tidak pernah menyetujui gate, berisiko atau tidak: agen menyatakan ulang alasan atau faktanya beserta akibat dari setiap opsi, membiarkan gate tetap tertutup, dan bertanya sekali lagi. Hanya pertanyaan klarifikasi yang bukan gate yang mengambil default yang direkomendasikan.
- Pertanyaan yang ditutup tanpa dijawab bukanlah persetujuan. Gate tetap tertutup, satu baris menyebutkan apa yang masih tertunda, dan pertanyaan yang sama tidak diajukan lagi dalam sesi itu kecuali pengguna memintanya. Pertanyaan klarifikasi yang bukan gate mengambil default yang direkomendasikan dan mencatatnya sebagai asumsi.
- Run tanpa pengawasan tidak menanyakan apa pun di tengah jalan. Entry gate overnight dikumpulkan selagi pengguna hadir, dan keputusan di tengah run mengikuti Unattended Continuation Rule: keputusan yang dapat dibalik dilanjutkan dengan tafsiran yang paling masuk akal, sedangkan keputusan yang tidak dapat dibalik dan bisa condong ke dua arah diparkir di handoff. Pertanyaan debt sweep adalah satu-satunya pengecualian, sebagai tindakan terakhir dari run, dan hanya jika harness memiliki klien interaktif.
- Teks pertanyaan mengikuti preferensi bahasa pengguna, tidak pernah bahasa yang di-hardcode. Subagent tidak pernah bertanya: pertanyaan dimasukkan ke laporannya, lalu parent yang mengajukannya.

Aturan lengkapnya ada di bagian `### ⏸️ Confirmation Protocol` dalam [`skills/sucp-rules/SKILL.md`](https://github.com/belajarcarabelajar/vivera/blob/main/skills/sucp-rules/SKILL.md). Tabel terakhirnya adalah katalog gate: header dan urutan opsi untuk setiap gate, dari intent lock hingga merge dan debt sweep.
Katalog itu juga memiliki kolom `Basis` yang memuat alasan standar untuk setiap gate, yang diwajibkan oleh validator.
