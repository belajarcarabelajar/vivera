---
title: Audit Siklus Hidup Plan dan Penyelesaian Task
description: Satu script melaporkan jumlah status plan, dan script lain mencentang langkah plan hanya untuk task yang tercatat PASSED atau SKIPPED-IDEMPOTENT di log runner.
category: tooling
slug: lifecycle-audit
order: 6
source: README.md#Plan Lifecycle Audit & Task Completion
source_hash: "9e2156224825"
---

<a id="plan-lifecycle-audit--task-completion"></a>
# Audit Siklus Hidup Plan dan Penyelesaian Task

Dua script mengelola status siklus hidup plan `ultra-plan/v1` setelah eksekusi.

<a id="plan-lifecycle-audit-scriptsplan-lifecycle-auditmjs"></a>
## Audit Siklus Hidup Plan (`scripts/plan-lifecycle-audit.mjs`)

Mengaudit field `status:` di semua plan yang dilacak dan membagi hitungannya ke dalam tiga kelompok yang jujur:

| Kelompok | Arti |
|---|---|
| `untracked` | Sama sekali tidak memiliki frontmatter YAML. `Draft` pada mirror hanyalah fallback dari publisher, bukan klaim yang sebenarnya. |
| `tracked` | Memiliki frontmatter dengan `status: Draft`, klaim siklus hidup yang nyata tetapi mungkin sudah usang. Hanya plan seperti inilah kandidat untuk backfill. |
| `frontmatter-no-status` | Memiliki pagar `---` tetapi tanpa key `status:`. Plan yang formatnya rusak. |

```bash
bun scripts/plan-lifecycle-audit.mjs         # human-readable tally
bun scripts/plan-lifecycle-audit.mjs --json  # same data as JSON
```

Selalu keluar dengan exit 0: ini laporan, bukan gate. Ambang batas akan langsung gagal begitu ada plan baru yang ditambahkan.

<a id="task-completion-scriptsplan-mark-donemjs"></a>
## Penyelesaian Task (`scripts/plan-mark-done.mjs`)

Membaca log eksekusi runner dan memberi centang `[x]` pada baris langkah plan `[ ]` untuk setiap task yang mencapai keberhasilan terminal (`PASSED` atau `SKIPPED-IDEMPOTENT`). Tiga status non-sukses (`NEEDS-AGENT`, `READY (dry-run)`, `HALTED-UPSTREAM`) ditolak secara eksplisit: sebuah task ditandai selesai hanya ketika bukti menyatakan demikian.

```bash
bun scripts/plan-mark-done.mjs --from runner.log docs/code-plan/plans/<plan>.md
bun scripts/plan-mark-done.mjs --task T3 docs/code-plan/plans/<plan>.md  # assert, no evidence
```
