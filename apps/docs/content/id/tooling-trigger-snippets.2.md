<a id="file-size-the-split-it-rule-as-a-gate"></a>
## Ukuran file: aturan pecah-file sebagai gate

File yang tidak bisa dibaca agent sekaligus akan dibaca per bagian lalu diedit tanpa melihat
keseluruhannya. `bun run size:check` memblokir file teks yang lebih dari 5.000 token (byte / 4,
batas 20.000 byte). Ada tiga mode:

```bash
bun run size:check                                   # --staged (default, the hook): staged files, size from the index, their stale ceilings
bun scripts/check-file-size.mjs --all                # every tracked file plus stale ceilings (end of bun run ci)
bun scripts/check-file-size.mjs --write-baseline     # seed the ceilings once, then only lower or drop them
```

Exit 0 berarti lulus, 1 berarti pelanggaran atau plafon basi, dan 2 berarti kesalahan pemakaian,
bukan repositori git, baseline tidak valid, atau panggilan git yang gagal.
File yang sudah melewati batas saat gate ini masuk mempertahankan ukurannya sebagai plafon di
`scripts/file-size-baseline.json`, sebuah ratchet: membesar diblokir, dan file yang menyusut menurunkan plafonnya di commit yang sama (`--write-baseline`, lalu stage baseline-nya), karena hook menolak file staged yang tertinggal di bawah plafonnya. Plafon
dibaca dari salinan file itu yang sudah di-stage. Bila pemecahan file berada di luar cakupan,
naikkan plafonnya di commit yang sama dengan baris pesan
`size-raise: <plan-id> <reason>` (`.githooks/commit-msg`, `--all --base <ref>`). File yang di-rename dihitung sebagai file baru, jadi
pindahkan plafonnya. Setelah memecah file, jalankan `git grep` pada path lama dan perbarui
rujukannya (`validate-skill` mengunci path skill).

<a id="strict-retries-retry_if"></a>
## Retry ketat: `retry_if`

```yaml
defaults:
  retry_if: any        # any (default) | transient
```

| Nilai | Retry dipakai untuk |
|---|---|
| `any` | Apa saja kecuali kegagalan yang menurut exit code-nya pasti tidak bisa berubah: 127, 126, 130, 143 |
| `transient` | Hanya `transient: true`, yang dalam praktiknya berarti timeout |

**Kebijakan ketat bersifat opt-in karena `transient: 'unknown'` adalah exit 1
biasa**, di mana kegagalan assertion yang deterministik dan test yang flaky tidak bisa
dibedakan dari exit code. Menjadikan kebijakan ketat sebagai default akan menghentikan
retry untuk test flaky di setiap plan yang sudah ada, termasuk plan di repositori lain
yang tidak dimiliki repositori ini. Nilai yang tidak dikenali akan melempar error alih-alih
jatuh ke default, sama seperti `on_precondition_fail`.

<a id="mutual-exclusion-for-the-pr-registry"></a>
## Mutual exclusion untuk PR registry

`pr.registry.json` menentukan sesi mana yang memiliki branch dan worktree mana, dan
file ini di-gitignore, jadi penulisan yang hilang tidak bisa dipulihkan. Atomic write
membuat setiap penulisan tidak terbagi, tetapi tidak mencegah dua penulis saling
menyela, di mana rename kedua diam-diam membuang hasil yang pertama.

Karena itu `saveRegistry` menerima `expectedRaw`: byte persis yang dibaca pemanggil. Jika
file sudah berubah sejak saat itu, ia menolak. **Tidak ada lock file**, dan ini disengaja:
lock membutuhkan kebijakan stale-lock, dan stale lock membutuhkan keputusan tentang apa
akibat pemegang lock yang crash terhadap pemegang berikutnya. Compare and swap tidak
membutuhkan keduanya, karena state yang dibacanya *adalah* state itu sendiri.

```js
mutateRegistry((registry) => claimSlot(registry, { ... }).registry, { registryPath })
```

`mutate` harus pure, karena fungsi ini diterapkan ulang pada hasil baca yang baru saat
terjadi konflik. Setelah empat konflik, ia gagal secara terang-terangan alih-alih berputar terus.

Jendela sisanya dinyatakan, tidak disembunyikan: di antara pembacaan ulang dan rename,
proses lain masih bisa menulis. Jendela itu hanya selebar satu pemanggilan, bukan selebar
satu sesi penuh, dan `mutateRegistry` menutupnya dengan membaca ulang dan menerapkan ulang.

<a id="backfilling-impacts-into-plans-that-predate-it"></a>
## Backfill `impacts` ke plan yang dibuat sebelum key tersebut ada

```bash
bun scripts/backfill-plan-impacts.mjs --dry-run   # report only
bun scripts/backfill-plan-impacts.mjs             # rewrite in place
```

Dua belas plan memuat 108 task yang ditulis sebelum key itu ada, masing-masing
memunculkan peringatan validasi. Menulis 108 klaim dampak secara manual berarti menulis
108 analisis, dan analisis yang tidak pernah dilakukan siapa pun adalah fabrikasi yang
menyamar sebagai catatan. Sebaliknya, setiap entri **diturunkan** dari apa yang sudah
dideklarasikan setiap task di `files` miliknya sendiri, ditambah konsumen file-file
tersebut di tree saat ini, ditambah perintah yang menunjukkannya.

Versi pertama script ini melaporkan sebuah file tidak punya konsumen karena regex-nya
membuang `.mjs` dari stem lalu langsung mensyaratkan tanda kutip penutup, sehingga
`from './plan-publish-frontmatter.mjs'` tidak pernah cocok. **83 dari 127 task kembali
sebagai sentinel "sudah diperiksa, tidak ada temuan"**, dan setiap plan tetap lolos
validasi, karena sentinel adalah entri yang sah. Itulah kegagalan yang seharusnya
dicegah oleh key tersebut, tereproduksi di dalam tool yang mengisinya. Setelah
perbaikan: 88 entri turunan, 39 sentinel, dan sebuah test yang memindai ulang setiap
jumlah konsumen yang diklaim.
