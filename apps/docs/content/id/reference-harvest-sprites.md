---
title: Harvest Sprites
description: "Tujuh Harvest Sprites dari Harvest Moon: Back to Nature, masing-masing dengan potret, sifat di dalam game, dan peran subagent tetapnya di Vivera."
category: reference
slug: harvest-sprites
order: 7
source: docs/guide/reference-harvest-sprites.md
source_hash: "dc6eb2e3bdb5"
---

<a id="the-harvest-sprites"></a>
# Harvest Sprites

<p align="center">
  <img alt="Karya seni resmi Back to Nature tentang Harvest Sprites: peri-peri kecil bertopi rajut yang menyiram tunas dengan kaleng penyiram hijau, membawa telur, serta menunggangi sapi dan ayam." src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/btn-harvest-sprites.jpg" width="100%">
  <br>
  <em>Tujuh Harvest Sprites sedang bekerja. Karya seni resmi Back to Nature © pemiliknya.</em>
</p>

Halaman ini mengikuti game PlayStation *Harvest Moon: Back to Nature* (Victor Interactive Software,
Jepang 16 Desember 1999, rilis bahasa Inggris oleh Natsume pada 22 November 2000), bukan *Friends of Mineral Town*,
yang sprite-nya bekerja dengan cara berbeda (lihat [glosarium](/id/docs/reference/glossary-full/)). Di dalam game itu, tujuh Harvest
Sprites (コロボックル, *Korobokkuru*) tinggal di sebuah pondok kecil di belakang Gereja. Ajak bicara salah satunya dua kali untuk meminta
bantuan setelah ia memiliki setidaknya 2 hati kasih sayang, lalu sewa ia selama 1 hari, 3 hari, atau seminggu, mulai
keesokan harinya, untuk menyiram tanaman, memanen tanaman, atau merawat hewan. Pada Musim Semi mereka hanya membicarakan Pesta Teh (Tea Party) mereka, dan Anda harus mengajak bicara sprite yang sama lima kali
agar ia mau bekerja. Mereka tampak identik kecuali warna topi dan bajunya, dan ketujuh
warna itu bersama-sama membentuk pelangi. Di Vivera setiap sprite adalah subagent bernama: nama dan
warnanya tetap, tetapi sprite mendapat peran tetap di `agents/crew.json`, bukan bebas memilih pekerjaan.

| Sprite | Di dalam game (PlayStation) | Peran di Vivera | Afinitas default | Yang dilakukannya |
|---|---|---|---|---|
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/chef.png" alt="Chef, Harvest Sprite merah" width="96"><br>**Chef** | Merah. Ulang tahun Musim Gugur 14. Suka memasak. Pada tahun keempat ia ditemukan dalam keadaan takut gelap, membawa lentera. | `implementer` | panen (harvesting) | Mengimplementasikan satu chunk dari plan yang sudah disetujui, test terlebih dahulu, di dalam file yang diizinkan. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/nappy.png" alt="Nappy, Harvest Sprite oranye" width="96"><br>**Nappy** | Oranye. Ulang tahun Musim Dingin 22. Para saudara itu tinggal bersama di rumahnya. | `implementer` | merawat hewan (animal care) | Peran yang sama dengan Chef, pada chunk yang berbeda. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/hoggy.png" alt="Hoggy, Harvest Sprite kuning" width="96"><br>**Hoggy** | Kuning. Ulang tahun Musim Gugur 10. Suka tidur dan malas bekerja. | `implementer` | panen (harvesting) | Peran yang sama dengan Chef, pada chunk yang berbeda. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/timid.png" alt="Timid, Harvest Sprite hijau" width="96"><br>**Timid** | Hijau. Ulang tahun Musim Panas 16. Mudah takut. | `researcher` | merawat hewan (animal care) | Menyelidiki satu pertanyaan sempit tentang kode, riwayat, atau web, dan tidak mengedit file apa pun. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/aqua.png" alt="Aqua, Harvest Sprite biru muda" width="96"><br>**Aqua** | Biru muda. Ulang tahun Musim Semi 26. Suka berpakaian rapi. | `researcher` | menyiram (watering) | Peran yang sama dengan Timid, pada pertanyaan yang berbeda. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/staid.png" alt="Staid, Harvest Sprite biru tua" width="96"><br>**Staid** | Biru tua (sumber lain juga menyebut biru atau indigo). Ulang tahun Musim Semi 15. | `reviewer` | merawat hewan (animal care) | Mengaudit diff, laporan subagent, atau klaim penyelesaian terhadap bukti baru, dan tidak mengedit file apa pun. |
| <img src="https://raw.githubusercontent.com/belajarcarabelajar/vivera/main/docs/images/sprites/bold.png" alt="Bold, Harvest Sprite ungu" width="96"><br>**Bold** | Ungu. Ulang tahun Musim Semi 4. Pemberani, dan mengusir yang lain dengan teriakan perang. | `debugger` | menyiram (watering) | Mengisolasi akar penyebab satu test yang gagal atau bug yang dapat direproduksi lewat hipotesis dan probe, lalu memperbaikinya pada penyebab bersamanya. |

Empat hal yang perlu diketahui:

- **Game mencatat dua angka per sprite.** Kasih sayang naik satu hati setiap 25 poin dan turun 2
  untuk setiap hari sprite bekerja untuk Anda. Level keterampilan tersembunyi per pekerjaan dimulai dari 0, naik 1 setiap
  kali ia melakukan pekerjaan itu, dan maksimal 255.
- **Kebutuhan berpengaruh, cuaca tidak.** Anda tidak dapat menyewa sprite untuk pekerjaan yang tidak ada yang perlu dikerjakan
  hari itu, tetapi sprite yang disewa tetap datang saat badai topan atau badai salju, sehingga berguna untuk memberi makan
  hewan saat badai.
- **Pekerjaan adalah default, bukan aturan.** Di dalam game, sprite mana pun dapat melakukan salah satu dari tiga pekerjaan, satu per
  permintaan. Di Vivera peran ditetapkan oleh roster, sedangkan kolom afinitas hanya default
  untuk fan-out (menyiram atau watering adalah pekerjaan keep-alive, merawat hewan atau animal care adalah aset berumur panjang, panen atau harvesting adalah
  pengiriman atau shipping). Parent boleh mengirim sprite mana pun ke chunk mana pun. Lihat
  [Glosarium Vivera](/id/docs/reference/glossary-full/).
- **Warna agent berbeda untuk dua sprite.** `agents/crew.json` memberi Aqua `blue` dan Staid `cyan`, sedangkan
  di dalam game Aqua berwarna biru muda dan Staid biru tua.

*Potret sprite di tabel adalah karya seni Harvest Moon dari Harvest Moon Wiki, © pemiliknya masing-masing. Fakta game dan sumbernya tercantum di [glosarium](/id/docs/reference/glossary-full/). Vivera adalah proyek independen dan tidak berafiliasi dengan franchise Harvest Moon.*
