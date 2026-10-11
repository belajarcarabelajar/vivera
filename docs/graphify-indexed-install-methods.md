# Install Methods: session `install-methods`

Date: 2026-10-11. Session slot `install-methods`, plan
`docs/code-plan/plans/2026-10-11-install-methods.md`, Intent Lock
`docs/code-plan/intent-locks/2026-10-11-install-methods-intent-lock.md`.

This file exists so the lock, the plan and what the session found are visible to
`graphify query` / `path` / `explain`. The originals live in `docs/code-plan/`, which is
excluded from graph indexing by design: `scripts/vault-index.mjs` scan reports
`docs/code-plan/` among its ignored paths. Artifacts written there cannot enter the graph,
which is a scope boundary of the indexer and not a failure of the sync.

The originals are retained at their own paths. This file is an index entry point, not a
replacement.

## What the session set out to do

Make the repository installable under many conditions and capabilities, not only "clone,
install Bun and git, run `./install.sh`". The Intent Lock fixed five areas:

| Area | What was built |
|---|---|
| Channels | a release tarball builder and a dispatch-only release workflow, `scripts/bootstrap.sh` (pinned release tag, SHA-256 checked before extraction), a Dockerfile and devcontainer; the Claude Code marketplace was researched and PARKED |
| Tiers | `minimal` (skills only, no git, no bun), `standard` (git and bun, the default), `full` (plus gh and tgrep), one table in `scripts/install/tiers.tsv` read by bash and Bun the same way |
| Platforms and modes | `--copy` mode, Git Bash default to copy, `install.ps1` for Windows (copy only), an offline install, macOS and WSL notes |
| Lifecycle and safety | backup then link, `--uninstall`, `--update`, `--check`, `--only` and `--skip`, `--dry-run`, a sandbox helper for tests, digests so an edited copy is never discarded |
| Harness breadth | `~/.gemini/skills` target, sprite agents rendered for Claude Code, OpenCode, Codex, Cursor, Copilot and Antigravity, `agy plugin` researched (adopt later) |

## Where the code lives

| Path | Role |
|---|---|
| `install.sh` | argument parsing and dispatch |
| `scripts/install/` | `lib.sh`, `digest.sh`, `place.sh`, `prereq.sh`, `targets.sh`, `check.sh`, `update.sh`, `uninstall.sh`, `sprites.sh`, `tiers.tsv`, `windows-core.ps1`, `windows-ops.ps1` |
| `install.ps1` | Windows installer entry point, copy mode |
| `scripts/bootstrap.sh`, `scripts/release/build-archive.sh`, `.github/workflows/release.yml` | the tarball channel |
| `Dockerfile`, `.dockerignore`, `.devcontainer/devcontainer.json` | the container channel (never built here) |
| `scripts/sprite-agents/`, `scripts/gen-sprite-agents.mjs` | one renderer per harness for the Harvest Sprite crew |
| `scripts/lib/install-sandbox.mjs`, `scripts/install-*.test.mjs` | the sandbox every install test runs in (temp HOME, PATH of symlinks) |

## Acceptance criteria, in brief

| AC | Claim | Where it is checked |
|---|---|---|
| AC-1 | tiers install what they promise and refuse what they cannot | `scripts/install-tier.test.mjs`, `scripts/prereq.test.mjs` |
| AC-2, AC-3, AC-4, AC-5 | backup, uninstall, update and check behave and never lose a user file | `scripts/install-overwrite.test.mjs`, `install-uninstall`, `install-update`, `install-check`, `install-digest` |
| AC-6 | harness flags and detection | `scripts/install-targets.test.mjs` |
| AC-7 | `--copy` | `scripts/install-copy.test.mjs` |
| AC-8, AC-9 | the sandbox never touches the real HOME; offline and dry-run are pure | `scripts/install-baseline.test.mjs`, `scripts/install-matrix.test.mjs` |
| AC-10, AC-11 | bootstrap and release workflow | `scripts/bootstrap.test.mjs`, `scripts/release-archive.test.mjs` |
| AC-13, AC-14 | container and Windows installer | `scripts/container.test.mjs`, `scripts/install-ps1.test.mjs`, `scripts/install-ps1-run.test.mjs` |
| AC-12, AC-17 | the Claude Code marketplace and `agy plugin` were researched, not built: parked and adopt later, each with its reason | research notes in `docs/code-plan/research/` (not graph-indexed), summarized in `README.md` |
| AC-18 | the maintainer's own machine is repaired from the merged checkout (`./install.sh --check`, then `--update`) | after the merge, not in this branch |
| AC-15, AC-16 | README states every channel, tier and platform with a verified label; sprites for six harnesses | `README.md`, `scripts/sprite-agents/` |
| AC-19, AC-20 | local verification and this index | plan task T29, this file |

## What the session found that is worth keeping

| Finding | Evidence |
|---|---|
| `install.ps1` had never worked: every `Split-Path -LiteralPath ... -Parent` throws under PowerShell 7.6.6, so install exited 1 before copying anything. A static review had missed it. | a real `pwsh` run, then 84 tests pass with `pwsh` and 54 pass with 30 skipped without it |
| Copy mode lost an edited directory when the digest could not see the change (an added empty dir, a dangling symlink, an unreadable file) because digest equality overrode `diff`; with no hash tool every copy looked identical | an adversarial run on commit `6903a61`; fixed by failing closed and letting `diff` decide (see the plan, T10e) |
| Codex may not enforce `sandbox_mode` for a custom agent | OpenAI's source at `rust-v0.162.1` (`role.rs`, `role_tests.rs`), quoted in the plan; the generated file says so |
| `agy agents` lists only `mainAgent: true` agents, and the sprites are written with `mainAgent: false` | a run with a positive control, `agy` 1.3.3 |
| `.dockerignore` let gitignored machine-local state into an image layer | a run with the `@balena/dockerignore` matcher; a test now compares `.gitignore` with `.dockerignore` |
| `bootstrap.sh` followed plain-http redirects | local servers, curl and wget; fixed with `--proto '=https'` and a `Location` check for wget |

## Not verified

macOS, WSL, Windows itself (Windows PowerShell 5.1, NTFS junctions), bash 3.2, BusyBox,
Docker (never built), a real release (0 tags exist), and the Claude Code, Codex, Cursor and
Copilot CLIs. Only OpenCode listed the generated sprite agents in a run.

## After the merge

The graph query check happens after the merge, not in this branch:
`graphify update .`, then `bun run graphify:sync`, then
`graphify query "install methods intent lock"` must return the lock, and
`bun run graphify:check` must exit 0.
