# Quick Start & Installation

Install the skill package into every agent harness the installer detects on your machine, with one command:

```bash
git clone https://github.com/belajarcarabelajar/vivera.git
cd vivera
./install.sh
```

A plain `./install.sh` runs the `standard` tier (see Prerequisites) and does this:

| Step | What it does |
|---|---|
| Links the skills | The skill package (`SKILL.md`, the seven `sucp-*` phase skills, `templates/`, `examples/` and the two Mermaid configs) is linked into each target with absolute paths into this checkout, so keep the checkout where it is. `--copy` copies the files instead. |
| Picks the targets | `~/.config/ai` and `~/.agents/skills` always. Every other harness only when it is detected (its directory under your home, or its CLI on `PATH`, `~/.local/bin` or `~/.bun/bin`; the table below names the directory and the CLI of each target, and the CLI is looked for in all three places for every row) or named with `--only ID,ID`. A bare home gets just those two. |
| Renders the sprite agents | The seven Harvest Sprite subagent files are generated, not linked, for each detected harness among Claude Code, OpenCode, Codex, Cursor, Copilot and Antigravity. This needs `bun`, so tier `minimal` skips it. |
| Enables the git hook | Sets `core.hooksPath=.githooks` in this checkout when it has its own `.git`, whether or not `graphify` is installed, because the hook carries the file size gate. Undo it with `git -C <checkout> config --unset core.hooksPath`. |
| Protects your files | A file or directory already at a destination that is not the installer's own is moved to `<name>.vivera-bak-<UTC time>` first (a `[BACKUP]` line), so nothing is overwritten. |

Look before you install, and check afterwards:

```bash
./install.sh --dry-run   # prints what it would do, writes nothing
./install.sh --check     # reports whether the install is current, changes nothing
./install.sh -h          # lists every flag
```

`--check` prints `check: CURRENT` and exits 0 when every selected target is in order, exits 1 when it found a
problem, and exits 2 when no selected target has skills and no sprite directory can be checked (for example `--only codex` with `--tier minimal`, or on a machine without `bun`; with `bun` present, `--only codex` checks the sprite directory and exits 1 if it is missing). A machine with nothing installed exits 1. A bad flag, an unknown target id or an unset `HOME`
exits 2.

## Install channels

The git clone is the one route that was run end to end. The others exist in the repository, and the Status
column says how far each one was tested. "Verified" means run on Linux x86_64 (Arch Linux, Bun 1.4.2) on
2026-10-11 in a throwaway home, with the exit code checked.

| Channel | What it is | Status |
|---|---|---|
| Git clone and `./install.sh` | The three commands above. | Verified on Linux. |
| Release tarball (offline) | `vivera-<tag>.tar.gz` plus `.sha256`, built by `scripts/release/build-archive.sh` from `git archive`. Extract it and run `./install.sh`. The tree has no `.git`, so the git hook step is skipped (with `graphify` absent it is skipped for that reason first). | An install from a `git archive HEAD` tree is verified (exit 0). The installer makes no network call. No release is published yet (0 tags), so there is nothing to download. |
| `scripts/bootstrap.sh` | `curl -fsSL <url>/bootstrap.sh \| bash -s -- --ref v1.2.3 -- --tier standard`. It accepts only a release tag of at most 100 characters (never a branch or a SHA), downloads the archive and its `.sha256`, checks the SHA-256 before it extracts anything, extracts into `${XDG_DATA_HOME:-$HOME/.local/share}/vivera/<tag>/` (`VIVERA_HOME` or `--dest` changes the place), then runs the extracted `install.sh` with the arguments after `--`. The network is reached over https only: a plain-http base, and any redirect to another scheme (with curl or with wget), is refused; a `file://` base for a local mirror needs curl; `--dest` must not be empty. | Not verified against a real release: there are 0 tags, and the tests use `file://` fixtures plus loopback http and self-signed https servers (to prove a plain-http base and an https-to-http redirect are refused); nothing is fetched from github.com. `<url>` is a placeholder, because where `bootstrap.sh` will be served is not decided: do not run that line from this README. |
| Release workflow | `.github/workflows/release.yml` runs only when a person dispatches it, with the inputs `tag` and `dry_run` (default true). A dry run runs the read-only `build` job and publishes nothing. `publish` runs only when `dry_run` is false, only on the default branch, and refuses a tag or release that already exists. | Not run. The first real publish is a human decision. |
| Docker and devcontainer | `Dockerfile` (base `oven/bun:1.4.2-debian`, the base image's non-root `bun` user (uid 1000), runs `./install.sh --tier standard --only agents`) and `.devcontainer/devcontainer.json`, which builds the `base` stage. | Not verified: `docker` and `podman` are absent here, nothing was built, and the tests only read the files. |
| `install.ps1` (Windows native) | A PowerShell installer: `install.ps1` in the repository root plus `scripts/install/windows-core.ps1` and `scripts/install/windows-ops.ps1`, which it loads from the checkout. It copies and never makes a symlink, installs the skills only (no sprite agents: use `./install.sh` from WSL or Git Bash), and takes `-Only -Skip -DryRun -Check -Update -Uninstall -Help` (`-Tier` is accepted and ignored: skills only at every tier). Run it as `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DryRun`. | Parsed and run under PowerShell 7.6.6 on Linux, by behaviour tests that run when `pwsh` is on `PATH` (or named in `PWSH`) and skip otherwise. **Not verified on Windows, on Windows PowerShell 5.1 or on NTFS junctions.** Start with `-DryRun`, then `-Check`. |
| Claude Code marketplace | The repository as a one-plugin marketplace. | **Parked**, see below. |
| Antigravity plugin (`agy plugin`) | `agy plugin install` from a GitHub URL or a local path. | Adopt later: nothing was installed. See below. |

What the bootstrap checksum proves: it is served from the same release origin as the archive, so it detects
a corrupted download or a swapped archive. It does not detect a compromised release, because whoever can
replace the archive can replace the checksum.

**Why the marketplace is parked.** A spike on 2026-10-11 ran `claude plugin validate`, `marketplace add`,
`install` and `details` on an isolated home. The packaging works: validation passed and 8 skills were
listed. It was parked for three reasons:

- The master skill loads its phase skills by bare name (`sucp-rules`, `sucp-plan`) and stops if one cannot
  be loaded. The docs show plugin skills with the plugin name as a prefix (`/vivera:sucp-rules`). Whether the
  model's Skill tool accepts the bare name is not documented, and no live session was run, so it is
  unverified.
- The fallback path `~/vivera/skills/<name>/SKILL.md` does not exist on a machine that has only the plugin.
- A plugin rooted at the repository installs about 498 MB of dependencies into the cache, against 720 KB for
  a skills-only copy.

It becomes a build if one live session on an isolated home shows the bare name loading, or if the owner
teaches the master skill both names.

**Why the Antigravity plugin waits.** `agy plugin validate` accepted a copy of the skills (8 processed), but
nothing was installed. Where a CLI install lands, whether staging keeps the symlinks of the skill package,
and how an update works were not measured. A plugin would add a channel and would not replace the links
into the Antigravity skills directories.

## Prerequisites

Choose a tier with `--tier minimal|standard|full` (default `standard`). The tool list is
`scripts/install/tiers.tsv`, which `install.sh` and `scripts/validate-skill.mjs` both read, so the installer
and the validator cannot disagree about a tier.

| Tier | Needs on your machine | What it installs |
|---|---|---|
| `minimal` | Nothing beyond bash and `basename`, `dirname`, `head`, `ln`, `mkdir`, `readlink` and `uname` for a first install, `--dry-run`, `--check` and an `--update` that moves nothing aside. Moving a file aside also needs `date` and `mv`, `--uninstall` needs `rm` (and `mv` to put a backup back), and `--copy` needs `cmp`, `diff`, `cp`, `mv` and `find`. | The skills only: no sprite agents (they need `bun`) and no git hook (it needs `git`). Verified with `git` and `bun` absent from `PATH`: install exits 0 and `--check` prints `check: CURRENT` (with ` (sprite agents not verified: ...)` appended when a sprite harness is selected). |
| `standard` (default) | `git`, `bun` | The skills and the sprite agents, plus the git hook when `graphify` is installed and this is a git checkout. A missing `gh` or `tgrep` prints one warning each, and the run goes on. The other optional tools in the table below (`rtk`, `context-mode`, `opencode`, `snipset`, `graphify`) warn the same way, so a machine that has only `git` and `bun` sees seven warnings (`gh`, `tgrep`, `graphify`, `rtk`, `context-mode`, `opencode`, `snipset`); a machine without `git` or `bun` stops with exit 1 at the first missing one, before any warning. |
| `full` | `git`, `bun`, `gh`, `tgrep` | The same files as `standard`. It only makes `gh` and `tgrep` mandatory. |

The tools, from `scripts/install/tiers.tsv`:

| Tool | Required from | What you lose when it is absent |
|---|---|---|
| `git` | `standard` | Repo self-check and `core.hooksPath` setup. |
| `bun` | `standard` | Every script, sprite rendering and tests. |
| `gh` | `full` | Plan issue sync and PR creation. |
| `tgrep` | `full` | Trigram-indexed code search and the validate gate. |
| `graphify` | never | Knowledge-graph query and the pre-commit graph refresh. |
| `rtk` | never | Output-compressing proxy. |
| `context-mode` | never | Token-efficient output routing. |
| `opencode` | never | The OpenCode harness. |
| `snipset` | never | Snipset database and MCP tools. |

- **A required tool that is missing exits 1.** That is `git` and `bun` at `standard`, plus `gh` and `tgrep` at `full`.
- **An optional tool that is missing warns.** At `standard` and `full`, a tool the chosen tier does not require prints one warning
  that names what is lost, and the run goes on. The installer finds a tool on `PATH`, then in
  `~/.local/bin`, then in `~/.bun/bin`.
- **`--check` and `--uninstall` ask for no tool, at any tier.** The sprite agent directories are checked and
  removed only when `bun` is present: without it `--check` skips them and `--uninstall` keeps the files and
  says to delete the marked ones by hand.
- **Bun >= 1.1.0** ([bun.sh](https://bun.sh)) is the runtime for this repository's scripts and tests, and
  `package.json` pins `bun@1.4.2`. All dependency installation uses `bun install` / `bun add`, and all JS/TS
  execution uses `bun test` / `bun run`. `npm install`, `npm test`, `yarn`, and `pnpm` are strictly
  prohibited. Install it with `curl -fsSL https://bun.sh/install | bash`. `./install.sh` itself needs no `bun install`
  first: a tree with no `node_modules` installed and rendered the sprites.
- **Node.js is not needed to install, or to run the Bun scripts.** It is needed to render Mermaid diagrams
  (`scripts/render-diagrams.sh` and the Mermaid part of `scripts/validate-skill.mjs`): `mmdc` from
  `@mermaid-js/mermaid-cli` starts with `#!/usr/bin/env node`, and `package.json` asks for Node >= 22.13.0.
  The only lockfile is `bun.lock`.
- **`ripgrep` (`rg`) & `tgrep`**: Primary code search uses `rg` (v15.2+ direct binary with smart-case). `tgrep` ([microsoft/tgrep](https://github.com/microsoft/tgrep)) is used for trigram-indexed search in indexed repositories and shell pipe filtering. Raw GNU `grep` is strictly prohibited. `tgrep` is required only at tier `full`: at `standard` install.sh prints one warning when it is missing (none at `minimal`) and the skill's search rule (`skills/sucp-rules/SKILL.md`) accepts `rg` or `tgrep`, so `rg` alone satisfies it.

## Platform matrix

"Verified" is the same definition as in Install channels: run on Linux x86_64 (Arch Linux, Bun 1.4.2) in a
throwaway home, exit code checked. Anything else is "not verified".

| Channel and tier | Linux x86_64 (this machine) | macOS | WSL | Windows native | Docker |
|---|---|---|---|---|---|
| `./install.sh`, `minimal` | Verified (no `git`, no `bun` on `PATH`: exit 0, and `check: CURRENT` with the sprite-agents note appended when a sprite harness is selected) | Not verified | Not verified | Not verified | Not verified |
| `./install.sh`, `standard` | Verified (install, `--check`, `--update`, `--uninstall`, `--copy` and backups, all exit 0) | Not verified | Not verified | Not verified | Not verified |
| `./install.sh`, `full` | Verified (real `git`, `gh`, `bun` and `tgrep` on `PATH`: install, `--check`, `--update` and `--uninstall` all exit 0; with `gh` or `tgrep` missing, install exits 1) | Not verified | Not verified | Not verified | Not verified |
| `./install.sh` in Git Bash, MSYS or Cygwin | n/a | n/a | n/a | Defaults to `--copy` and prints a `[NOTE]`. Seen only with a stub `uname`, not on Windows: not verified | n/a |
| Release tarball, any tier | Verified for an install from a `git archive` tree (exit 0); no release exists to download | Not verified | Not verified | Not verified | Not verified |
| `scripts/bootstrap.sh` | Not verified against a real release (`file://` and loopback test servers only) | Not verified | Not verified | Not verified | Not verified |
| `install.ps1` | Run under PowerShell 7.6.6 by behaviour tests (they skip without `pwsh`) | n/a | n/a | Not verified on Windows, Windows PowerShell 5.1 or NTFS junctions | n/a |
| Dockerfile and devcontainer, `standard` only | n/a | n/a | n/a | n/a | Not verified: never built |

- macOS: the bootstrap script says it runs on bash 3.2, but the installer was never run on bash 3.2 or on
  BSD tools.
- "Not verified" means untested, not known to fail.
- A `HOME` that is read-only makes install exit 1 and write nothing (verified on Linux).
