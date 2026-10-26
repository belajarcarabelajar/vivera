---
title: Glosarium Vivera Lengkap
description: Glosarium lengkap, berisi tiga pekerjaan sprite, afinitas penugasan, tingkat hati, dan sumber bertanggal yang menjadi acuan pemeriksaan setiap fakta game.
category: reference
slug: glossary-full
order: 6
source: docs/vivera-glossary.md
source_hash: "686644c2b1a9"
---

<a id="the-vivera-glossary"></a>
# Glosarium Vivera

Vivera adalah nama fiktif yang terinspirasi dari Elli, salah satu karakter dalam
*Harvest Moon: Back to Nature*. Pipeline di baliknya tidak berubah; kosakata di sekitarnya meminjam dari *Harvest Moon: Back to
Nature* (Sony PlayStation, Victor Interactive Software, 1999; diterbitkan dalam bahasa Inggris oleh Natsume pada 22 November 2000), game bertani
tentang kerja yang lambat dan sabar, tetapi membuahkan hasil. Istilah di bawah ini hanyalah label kosmetik
untuk konsep pipeline yang nyata. Ketika sebuah dokumen menulis "ship it", "dispatch the
sprites", atau "offer the Blue Feather" (mengajukan Blue Feather, yaitu pull request), inilah maksudnya.

Glosarium ini hanya mengikuti game PlayStation. *Friends of Mineral Town* (remake untuk Game Boy Advance) dan game Nintendo DS memakai ulang nama dan tampilan Harvest Sprites (tujuh peri pembantu, padanan subagent), tetapi tidak semua aturannya, sehingga keduanya tidak dijadikan sumber di sini. Para sprite setidaknya berbeda dalam minigame pelatihan (tiga di Friends of Mineral Town, tidak ada yang terdokumentasi untuk Back to Nature). Ambang hati juga berbeda: 2 hati di Back to Nature dan 3 di Friends of Mineral Town, menurut halaman wiki masing-masing.

| Istilah farm | Di Back to Nature | Di Vivera |
|---|---|---|
| The farm | Lahan milik pemain di Mineral Village | Repositori ini |
| Crops and seeds | Yang Anda tanam, rawat, dan kirim | Skill beserta file sumbernya; `install.sh` menanamnya ke setiap harness yang dideteksinya (dan selalu ke `~/.config/ai` dan `~/.agents/skills`) |
| Power Berry | Buah beri tersembunyi yang menaikkan stamina maksimum sebesar 10 secara permanen; jumlahnya ada sepuluh | Peningkatan kemampuan permanen: setiap perubahan skill atau tooling yang di-merge menaikkan apa yang bisa dikerjakan pipeline dalam sehari |
| Mystic Berry (Kappa's Berry) | Memangkas laju kelelahan menjadi separuh; didapat dari Kappa setelah meninggalkan tiga mentimun di Mother Lake, satu per hari di musim Spring | Pekerjaan yang memangkas kelelahan konteks menjadi separuh: hemat token, query graphify alih-alih dump mentah, filter pipe alih-alih output penuh |
| The seven Harvest Sprites | Chef, Nappy, Hoggy, Aqua, Bold, Timid, dan Staid, masing-masing dengan warna berbeda; mereka tinggal di pondok di belakang gereja dan bisa disewa untuk 1 hari, 3 hari, atau seminggu, mulai keesokan harinya, setelah memiliki minimal 2 hati | Subagent. Fan-out mengirim sprite ke ladang yang terpisah, dan setiap sprite memegang satu chunk kecil. Di Claude Code, OpenCode, Codex, Cursor, Copilot, dan Antigravity, setiap sprite adalah agent bernama (dirender oleh `./install.sh` untuk setiap harness yang terdeteksi) dengan peran yang ditetapkan di `agents/crew.json` |
| Watering | Salah satu dari tiga pekerjaan ladang: minta sprite menyiram tanaman, di setiap petak yang ditanami; keahlian dicatat per pekerjaan dan naik 1 per tugas | Pekerjaan keep-alive: merge base ke branch sesi, jalankan ulang pemeriksaan, jaga tanaman yang sedang dikerjakan tetap hidup sampai panen |
| Animal Care | Salah satu dari tiga pekerjaan ladang: minta sprite memberi makan, memerah susu, dan mencukur bulu hewan, lalu mengirim hasilnya; aturan permintaannya sama | Aset jangka panjang: template, graph, indeks vault, dan dokumen yang bertahan lintas musim, bukan hanya untuk satu panen |
| Harvesting | Salah satu dari tiga pekerjaan ladang: minta sprite memanen tanaman yang sudah matang dan langsung mengirimnya; aturan permintaannya sama | Shipping (pengiriman): kumpulkan laporan, verifikasi dengan bukti baru, masukkan ke shipping bin (kotak pengiriman: `scripts/pr-registry.mjs`), lalu ajukan Blue Feather |
| Sprite dispatch affinity | Konvensi, bukan fakta game: di BTN sprite mana pun bisa mengerjakan ketiga pekerjaan. Hanya afinitas bawaan: Aqua dan Bold ke penyiraman, Hoggy dan Chef ke panen, Nappy, Timid, dan Staid ke perawatan hewan; keahlian tetap dicatat per pekerjaan seperti di game | Bawaan penugasan untuk fan-out: sprite berafinitas siram mengambil chunk keep-alive, sprite berafinitas panen mengambil chunk kumpulkan-dan-kirim, sprite berafinitas rawat mengambil chunk aset jangka panjang. Agent induk boleh menugaskan ulang sprite mana pun ke chunk mana pun |
| The Tea Party | Acara kumpul di musim Spring: pada hari cerah yang bukan hari festival, antara pukul 15.00 dan 16.00, Anda memberi masing-masing dari tujuh sprite hadiah kesukaannya (Flour paling mudah) di dalam pondok mereka, lalu mereka mengundang Anda; hadiahnya adalah Relaxation Tea Leaves | Checkpoint kumpulkan-dan-sintesis: laporan baru dikumpulkan ketika setiap sprite yang dikirim sudah melapor |
| Affection (heart levels) | Tujuh warna: hitam, ungu, biru, hijau, kuning, oranye, merah (hitam 0 sampai 4.999; biru 20.000 sampai 29.999; hijau 30.000 sampai 39.999; maksimum 65.535, merah terang pada 60.000); secara terpisah, sprite butuh minimal 2 hati sebelum mau bekerja, hati sprite naik setiap 25 poin afeksi, dan setiap hari kerja mengurangi 2 afeksi sprite (panduan resmi Prima menyebut 1; lihat Sumber) | Kepercayaan yang terukur: hitam sampai biru adalah klaim yang belum terverifikasi, hijau sampai kuning adalah kerja yang berbukti, oranye membuka pengajuan Blue Feather, merah adalah pernikahan yang sudah di-merge; tidak ada laporan sprite yang dihitung sebelum melewati gerbang audit agent induk, yaitu aturan 2 hati untuk subagent |
| Blue Feather | Dijual di Supermarket seharga 1.000G begitu seorang gadis lajang mencapai hati oranye; item untuk melamar, yang juga membutuhkan hati merah dan perluasan rumah kedua | Sebuah pull request. Membukanya adalah lamaran, persetujuan pemilik adalah jawaban "ya", dan merge adalah pernikahannya |
| Ores and Saibara's Forge | Mythril, Orichalcum, dan Adamantite yang digali dari tambang; Saibara menempa Orichalcum menjadi aksesori seharga 1.000G dengan waktu tunggu tiga hari | Kontribusi mentah adalah bijih. Tahap REFACTOR dan review menempanya menjadi alat, dan penempaan sengaja diberi masa jeda |
| The Shipping Bin and Zack | Hasil panen dimasukkan ke kotak, lalu diambil dan dibayar setiap petang | PR registry (`scripts/pr-registry.mjs`). Sesi memasukkan kerja yang sudah terverifikasi, `order` menghitung rute pengambilan, dan `merged` berarti sudah dikirim dan dibayar |
| Won | Pedagang keliling yang datang membawa barang langka | Bazar tool opsional: tgrep, rtk, context-mode, snipset, graphify. Ampuh, harganya aneh, dan sepenuhnya opt-in |
| House extensions and the Greenhouse | Rumah pertanian bertambah besar lewat perluasan, dan rumah kaca menumbuhkan tanaman di musim apa pun | Kematangan repo: setiap kemampuan (template, riset mendalam, pengindeksan vault, graph) adalah sayap baru. `graphify-out/` adalah rumah kacanya: tumbuh di codebase apa pun, di musim apa pun |
| Seasons | Spring (musim semi), Summer (musim panas), Fall (musim gugur), dan Winter (musim dingin), masing-masing tiga puluh hari | Siklus hidup delivery: Spring menanam ide (brainstorm), Summer merawat plan (desain dan persetujuan), Fall membawa panen (TDD, verifikasi, PR), dan Winter adalah waktu di depan perapian (debt sweep atau penyisiran utang, ledger, memori) |
| Stamina and fatigue | Stamina terkuras saat Anda bekerja; di titik nol Anda pingsan dan kehilangan pagi hari | Anggaran konteks agent. Power Berries menaikkan batas atas, Mystic Berry memangkas laju pemakaian menjadi separuh, dan compaction adalah pingsan |
| Festivals | Kalender kota: Goddess Festival, Harvest Festival, Fireworks Display, Starry Night | Tonggak rilis; versi baru boleh memakai nama festival |

<a id="naming"></a>
## Penamaan

Vivera adalah nama fiktif yang terinspirasi dari Elli, salah satu karakter dalam
Harvest Moon: Back to Nature. Nama ini bukan nama ladang atau tempat di dalam
game, dan repositori ini hanya disebut the farm (ladang) dalam kosakata yang
terinspirasi game.
