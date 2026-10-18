---
title: Struktur Repositori
description: Pohon file repositori beranotasi, ditambah lokasi aturan TinyFish dan cara skill terpasang lewat symlink ke dalam repo.
category: getting-started
slug: repository-structure
order: 2
source: README.md#Repository Structure
source_hash: "f2143528c3a4"
---

<a id="repository-structure"></a>
# Struktur Repositori

```
vivera/
├── README.md                                    # Documentation & architecture flow
├── LICENSE                                      # MIT License
├── package.json                                 # npm scripts & devDependencies (@mermaid-js/mermaid-cli)
├── Super Ultra Code Plan Implementation.md      # Orchestrator skill: gates, classification, phase router
├── MEMORY.md                                    # Distilled in-repo rules from Step 6 learning harvest
├── install.sh                                   # 1-command installer: skills for every detected harness, sprite agents for six
├── install.ps1                                  # Windows installer: copy mode, skills only (run under pwsh 7.6.6 on Linux; not verified on Windows)
├── Dockerfile                                   # Container image on oven/bun:1.4.2-debian, non-root user, standard tier (never built)
├── .dockerignore                                # Keeps private state out of the image
├── .gitattributes                               # Forces LF for *.sh, .githooks/* and scripts/install/tiers.tsv (a CRLF checkout breaks the installer)
├── .devcontainer/
│   └── devcontainer.json                        # Builds the Dockerfile base stage and links the mounted workspace
├── mermaid.config.json                          # Light theme: palette + embedded-font stack
├── mermaid.dark.config.json                     # Dark variant, same layout and font
├── puppeteer-config.json                        # Headless flags for mermaid-cli rendering
├── .claude/
│   ├── agents/                                  # Seven Harvest Sprite subagents, generated from agents/roles
│   └── hooks/
│       └── block-git-writes.mjs                 # PreToolUse guard: subagents never write git state
├── agents/
│   ├── roles/                                   # Four role templates: researcher, implementer, debugger, reviewer
│   └── crew.json                                # Assigns each Harvest Sprite a role and a color
├── .githooks/
│   └── pre-commit                               # Blocking file size gate first, then a non-blocking graphify refresh
├── .github/
│   └── workflows/
│       ├── ci.yml                               # CI: bun install, render, drift gate, validate, test
│       └── release.yml                          # Release: dispatch only, dry_run defaults to true, publishes only on request
├── diagrams/                                    # Generated SVGs (only the hero pair is committed)
│   ├── lifecycle.svg                            # README hero, light
│   └── lifecycle-dark.svg                       # README hero, dark
├── docs/
│   ├── diagrams-src/
│   │   └── lifecycle.mmd                        # Mermaid source of the README hero diagram
│   ├── images/
│   │   ├── vivera.jpg                           # README mascot artwork
│   │   ├── btn-harvest-sprites.jpg              # Back to Nature (PS1) Harvest Sprites illustration
│   │   └── sprites/                             # Seven Harvest Sprite portraits (chef.png ... bold.png)
│   ├── graphify-integration.md                  # graphify setup, memory bounds, and runbook
│   ├── graphify-indexed-session-artifacts.md    # One session's review report and ledger, kept visible to graphify query
│   ├── graphify-indexed-install-methods.md      # The install-methods session: lock, plan, findings, kept visible to graphify query
│   └── code-plan/
│       ├── <date>-<slug>.manifest.md            # Batch manifests written before dispatch
│       ├── plans/
│       │   └── <date>-<slug>.md                 # ultra-plan/v1 plans this repo executed
│       └── spikes/                              # Spike reports & hypothesis evaluation
├── examples/
│   ├── worked-example.md                        # Full pipeline walkthrough (filled-in reference)
│   ├── deep-research-worked-example.md          # Citation-grounded report at target density
│   ├── graph-viewer-demo.html                   # Self-contained knowledge-graph viewer demo (synthetic data)
│   └── graph-viewer-demo.md                     # What the demo shows and how it is generated
├── scripts/
│   ├── sync.sh                                  # Bidirectional sync (~/.config/ai <-> repo)
│   ├── render-diagrams.sh                       # Render all mermaid blocks to SVG
│   ├── validate-skill.mjs                       # Frontmatter, link, token, mermaid & a11y lint
│   ├── check-runner-contract.mjs                # Fast structural check for runner frontmatter keys
│   ├── check-duplicate-defs.mjs                 # Diff-scoped gate: a definition a branch adds whose name already exists elsewhere
│   ├── check-duplicate-defs.test.mjs            # Languages, skips, waiver, exit codes, and the calibration rules
│   ├── check-file-size.mjs                      # Commit gate: a staged text file over 5,000 tokens (bytes / 4) is blocked
│   ├── check-file-size.test.mjs                 # Modes, skips, ratchet, exit codes, and the split instructions
│   ├── file-size-baseline.json                  # Ceilings for files already over the limit; they only go down
│   ├── file-size-gate-contract.test.mjs         # Pins the hook, install, package and docs wiring of the gate
│   ├── pre-commit-size-gate.test.mjs            # The hook blocks on the size gate and stays non-blocking for graphify
│   ├── validate-agents.mjs                      # Lint .claude/agents frontmatter (Claude Code ignores bad fields silently)
│   ├── validate-agents.test.mjs                 # Field, name, skills, and CLI exit-code tests
│   ├── gen-sprite-agents.mjs                    # Render the sprite crew for six harnesses (CLI over scripts/sprite-agents/)
│   ├── gen-sprite-agents.test.mjs               # CLI, hook pinning, drift, and hand-written-file guards
│   ├── sprite-agents/                           # Renderers behind gen-sprite-agents.mjs, one file per harness
│   │   ├── crew.mjs                             # Roster (agents/crew.json), template frontmatter, hook scripts
│   │   ├── sync.mjs                             # Write, check and clean the generated files (marker line)
│   │   ├── guard.mjs                            # Prose git guard for harnesses without a hook
│   │   ├── registry.mjs                         # Collects every targets/*.mjs, so a new harness needs no edit here
│   │   ├── common.mjs                           # Shared template reading and read-only role detection
│   │   └── targets/                             # claude, opencode, codex, cursor, copilot, antigravity (four have tests)
│   ├── install/                                 # The installer parts that install.sh sources
│   │   ├── lib.sh                               # Tool lookup, destination states, backup names, digests, entry lists
│   │   ├── digest.sh                            # Directory listing and equality helpers behind the digests
│   │   ├── place.sh                             # Link or copy one entry, with backup and restore
│   │   ├── prereq.sh                            # Tier and tool checks, read from tiers.tsv
│   │   ├── targets.sh                           # The 10 targets, detection, selection, install steps
│   │   ├── check.sh                             # --check
│   │   ├── update.sh                            # --update and prune
│   │   ├── uninstall.sh                         # --uninstall
│   │   ├── sprites.sh                           # Sprite agents for six harnesses
│   │   ├── tiers.tsv                            # Tool table: tool, required_from, capability lost
│   │   ├── windows-core.ps1                     # install.ps1 helpers: paths, digests, markers, judging a destination
│   │   └── windows-ops.ps1                      # install.ps1 target choice, install, -Update, -Check, -Uninstall
│   ├── bootstrap.sh                             # Pinned-release bootstrap: tag only, SHA-256 checked before extraction
│   ├── bootstrap-install.test.mjs               # Bootstrap: a good release, refusals, cleanup, resume hint
│   ├── bootstrap-validation.test.mjs            # Bootstrap: tag rule, checksum file, truncated and hostile archives
│   ├── bootstrap-network.test.mjs               # Bootstrap: https only, redirects with curl and wget (loopback servers)
│   ├── release/
│   │   └── build-archive.sh                     # Deterministic git archive plus .sha256 for a release tag
│   ├── install-*.test.mjs                       # Installer tests (baseline, targets, check, update, uninstall, copy, sprites, ps1, ...)
│   ├── block-git-writes.test.mjs                # Blocked and allowed command tables for the git guard hook
│   ├── skipif-registry-audit.mjs                # Tally and classify skip_if predicates across all plans
│   ├── ultra-plan-runner.mjs                    # ultra-plan/v1 DAG runner + visual map contract
│   ├── ultra-plan-runner.test.mjs               # Contract tests for the runner
│   ├── sync-snippets.mjs                        # Drift guard: snippets/ <-> Snipset database
│   ├── sync-snippets.test.mjs                   # Normalization + drift-detection tests
│   ├── export-opencode-history.mjs              # OpenCode SQLite session history -> Obsidian notes mirror
│   ├── lib/                                     # Exporter & chunk utilities (db, redact, note-name, sync-writer, etc.)
│   │   ├── install-sandbox.mjs                  # Temp HOME and a limited PATH for the installer tests
│   │   └── prereq.mjs                           # Reads scripts/install/tiers.tsv (shared with validate-skill.mjs)
│   ├── plan-publish.mjs                         # Publish plans into the Obsidian vault (one-way mirror)
│   ├── plan-publish.test.mjs                    # Publish, idempotency, drift, and refusal tests
│   ├── plan-publish-registry.mjs                # Vault + project registry and destination paths
│   ├── plan-publish-registry.test.mjs           # Config, project resolution, enumeration tests
│   ├── plan-publish-frontmatter.mjs             # Pure ultra-plan/v1 -> PARA frontmatter transform
│   ├── plan-publish-frontmatter.test.mjs        # Merge rules, related-link, title fallback tests
│   ├── plan-closeout.mjs                        # Close-out gaps, --readiness from skip_if, --audit of merged plans left open
│   ├── pr-registry.mjs                          # PR session slots: derived branch/worktree, recorded repo, state machine, merge order
│   ├── pr-registry.test.mjs                     # Collision, terminal-state, and merge-order guards
│   ├── plan-issue-sync.mjs                      # Plan -> GitHub issue mirror (one-way, hash-keyed)
│   ├── plan-issue-sync.test.mjs                 # Action-matrix and real-argv/stdin guards
│   ├── graphify-sync.mjs                        # Union repo Markdown chunk nodes into graphify-out/graph.json
│   ├── graphify-sync.test.mjs                   # Remap, idempotency, retention, and gate tests
│   ├── vault-index.mjs                          # Vault index scanner & worklist generator
│   ├── vault-index-verify.mjs                   # Verify coverage, privacy boundaries, and graphify read paths
│   ├── vault-index-rebuild.mjs                  # Rebuild merged knowledge graph from structural + semantic chunks
│   ├── vault-index-cluster.mjs                  # Leiden clustering pass for knowledge graph
│   └── plan-mirror-check.sh                     # Local drift watchdog (systemd --user timer, check only)
├── snippets.manifest.json                      # Maps trigger prompts to Snipset database slots
├── plans.publish.json                          # Vault path, destination template, and project roots for the plan mirror (local config, gitignored; plans.publish.example.json is the committed template)
├── plan.issues.json                            # Project -> owner/repo for the plan-issue mirror (local config, gitignored; plan.issues.example.json is the committed template)
├── pr.registry.json                            # Live PR session slots (gitignored; per-machine coordination state)
├── snippets/                                    # Copy-paste trigger prompts
│   ├── orkestrasi-brainstorm.md                # Brainstorm intent lock (keyword: brn)
│   ├── orkestrasi-ngoding-plan.md               # Plan + TDD + mandatory subagent fan-out (keyword: ;')
│   ├── orkestrasi-debugging.md                  # RCA + mandatory hypothesis-parallel subagents (keyword: ';)
│   ├── orkestrasi-pr.md                         # PR delivery, review, and topological batch merge (keyword: ;;')
│   ├── orkestrasi-pr-review.md                  # Standalone PR review & verification gate (keyword: prr)
│   ├── orkestrasi-overnight.md                  # Approved plan to verified PR while away, never merges (keyword: ovn)
│   └── cmd-*.md                                 # Ten short command snippets (mrg err apv dnn sts rsm cln aud prm fbk)
├── templates/                                   # Companion templates (blank scaffolds)
│   ├── brainstorm-intent-template.md           # Brainstorm intent lock, task list A/B/C/D, & approval gate
│   ├── spec-template.md                         # Architectural design spec, no file paths
│   ├── implementation-plan-template.md          # Visual work breakdown & task mapping
│   ├── spike-report-template.md                 # Timeboxed exploratory spike & hypotheses
│   ├── systematic-debugging-log-template.md     # Feedback loop, ranked hypotheses & RCA log
│   ├── verification-checklist-template.md       # Multi-layer proof & sign-off checklist
│   ├── handoff-template.md                      # Session handoff - resume from exact state
│   ├── progress-log-template.md                 # Persistent task state across sessions
│   ├── adr-template.md                          # Architecture Decision Record with decision tree
│   ├── subagent-contract-template.md            # Subagent task contract & parent audit gate
│   ├── vault-index-subagent-contract.md         # Subagent contract for note reading & semantic extraction
│   ├── code-review-template.md                  # Reviewer output contract & verdict
│   ├── deep-research-report-template.md         # Citation-grounded long-form research report
│   ├── follow-up-injection-template.md          # Session-close debt sweep & follow-up question
│   ├── pull-request-template.md                 # PR body, local evidence table, delivery metadata
│   ├── pr-review-template.md                    # Remote PR review, coverage table, binary verdict
│   └── session-learning-ledger-template.md      # Self-learning ledger for operational mistakes
├── vault-index/                                 # Subagent-extracted semantic vault knowledge graph
│   ├── manifest.json                            # Vault files, sha256 hashes, byte sizes, and node counts
│   └── semantic/                                # Subagent chunk outputs (chunk-*.json)
└── skills/
    ├── super-ultra-code-plan/                   # Full skill package with bundled templates & examples
    │   ├── SKILL.md -> ../../Super Ultra Code Plan Implementation.md
    │   ├── templates -> ../../templates
    │   ├── examples -> ../../examples
    │   ├── mermaid.config.json -> ../../mermaid.config.json
    │   └── mermaid.dark.config.json -> ../../mermaid.dark.config.json
    ├── sucp-rules/SKILL.md                      # Phase skill: shared operating rules (loaded every run)
    ├── sucp-brainstorm/SKILL.md                 # Phase skill: Step 2 path process and deep research
    ├── sucp-plan/SKILL.md                       # Phase skill: Step 3 writing plans and GitHub issue sync
    ├── sucp-tdd-debug/SKILL.md                  # Phase skill: Step 4 TDD and systematic debugging
    ├── sucp-verify-deliver/SKILL.md             # Phase skill: Step 5 verification and PR delivery
    ├── sucp-debt-sweep/SKILL.md                 # Phase skill: Step 6 debt sweep (scans code for defer: markers), plan closeout decision, learning harvest
    └── sucp-overnight/SKILL.md                  # Phase skill: unattended run from approved plan to verified PR
```

TinyFish didokumentasikan di dalam master skill itu sendiri, di bagian
`🌐 Web Evidence & Retrieval` (TinyFish): tangga eskalasi empat anak tangga
(`search` → `fetch_content` → `run_web_automation` → `create_browser_session`),
set parameter yang penting, aturan pengelolaan run dan biaya, serta jebakan yang
perlu diwaspadai. Dulu TinyFish dikirim sebagai skill vendored terpisah (`skills/use-tinyfish/`,
dipasang oleh `install.sh` §6b yang kini sudah dihapus); pemisahan itu dihentikan karena
kedua sumber kebenaran sudah tidak sinkron, dan salinan khusus CLI tidak pernah menjelaskan
tool MCP yang benar-benar dipanggil agent. Satu master skill, satu set aturan.

Skill dipasang melalui `skills/super-ultra-code-plan/`, yang berupa kumpulan symlink ke
root repo, bukan salinan. File master tetap bersumber tunggal, dan
`render-diagrams.sh` melewati file symlink sehingga diagram yang sama tidak pernah dirender dua kali.

<a id="scripts-without-a-section-of-their-own"></a>
## Script yang tidak punya bagian sendiri

Pohon di atas hanya mencantumkan sebagian isi `scripts/`, dan bagian-bagian berikutnya
mendokumentasikan sebagian besar sisanya. Script berikut tidak punya bagian sendiri, jadi
tabel inilah tempat penjelasannya. Setiap baris diambil dari komentar header script itu
sendiri. File test (`*.test.mjs`) berada di samping script yang diujinya dan tidak dicantumkan.

| Script | Fungsinya |
|---|---|
| `install-skill-links.mjs` | Menautkan setiap skill di `skills/` ke `~/.config/opencode/skills/`, satu-satunya tempat yang dibaca tool skill OpenCode. Tidak pernah menimpa file asli atau symlink asing. `install.sh` juga menautkan phase skill; script ini adalah cara mandiri untuk menjalankan ulang atau memverifikasi bagian itu saja. `bun run skills:link` menerapkan tautan, `bun run skills:check` keluar dengan kode 1 jika ada tautan yang hilang atau usang, `--dry-run` mencetak aksinya. |
| `ci-targeted.mjs` | `bun run ci:targeted`, gate default untuk commit dan PR. Memilih pemeriksaan berdasarkan file yang berubah terhadap `origin/main`: graf import di `scripts/`, `validate` untuk skill dan template, pemeriksaan agents dan snippets hanya saat bagian itu berubah, `render-diagrams` hanya untuk sumber diagram, serta aturan copy dan pemeriksaan ukuran file selalu. File konfigurasi root dan toolchain (`package.json` kecuali yang berubah hanya `scripts`-nya, `bun.lock`, installer) atau path yang tidak dikenali memilih `bun run ci` penuh. `--rencana` (`--plan`) mencetak pemeriksaan yang dipilih beserta alasannya; `--penuh` (`--full`) menjalankan `bun run ci` penuh. |
| `frontmatter-strict.mjs` | Menjalankan frontmatter plan melalui pemeriksaan YAML yang ketat. Parser milik runner sendiri hanyalah subset yang longgar, jadi sebuah plan bisa lolos dari parser itu tetapi tetap bukan YAML yang valid. |
| `validate-lib.mjs` | Bagian murni yang bisa di-import dari `validate-skill.mjs`, ditambah `renderMermaidBatch`, agar unit test bisa mengunci pemeriksaannya. |
| `mermaid-batch.mjs` | Merender daftar file `.mmd` dari stdin dengan fallback batch-and-bisect, dipakai bersama oleh `render-diagrams.sh` dan `validate-skill.mjs`. |
| `puppeteer-browser.mjs` | Mengarahkan `mmdc` ke Chromium atau Chrome sistem di PATH saat `~/.cache/puppeteer` tidak ada dan `PUPPETEER_EXECUTABLE_PATH` tidak diset, dipakai bersama oleh `render-diagrams.sh` dan `validate-skill.mjs`. |
| `skill-corpus.mjs` | Menyimpan daftar phase skill dan `readSkillCorpus`, yang membaca master skill dan phase skill sekaligus untuk para validator. |
| `make-graph-demo.py` | Membuat ulang `examples/graph-viewer-demo.html` dari graf sintetis dengan seed tetap. Membutuhkan `numpy`. |
| `vault-index-batch.mjs` | Membagi vault yang belum terindeks ke subagent ekstraksi paralel berdasarkan ukuran byte, bukan jumlah file. |
| `vault-index-resolve-chunk.mjs` | Mengubah draf chunk dari subagent menjadi chunk final yang path `source_file`-nya persis sama dengan yang ada di `batches.json`. |
| `vault-index-ids.mjs` | Mencari node id yang sudah dihasilkan chunk, berdasarkan substring, agar subagent tidak mengarang duplikat. |
| `vault-index-merge.mjs` | Menggabungkan chunk-chunk menjadi satu `graph.json`. |
| `vault-index-fold-rationale.mjs` | Melipat edge `rationale_for` menjadi atribut `rationale` pada node target. |
| `vault-index-narration.py` | Meringkas transkrip sesi yang sudah dirender menjadi narasinya saja dengan membuang lalu lintas tool-call. |
| `vault-index-cluster.py` | Menghitung komunitas pada graf vault hasil merge, karena `graphify cluster-only` menolak menulis pada graf itu. |
