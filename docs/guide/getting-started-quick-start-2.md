## Supported Harnesses & Target Paths

The installer has 10 targets, listed here in install order. The first two are always installed. Every
other target is installed only when its harness is detected, or when you name it with `--only`.

| Target id | Harness | Detected when | Skills go to | Sprite agents go to | Do the sprites load? |
|---|---|---|---|---|---|
| `ai-config` | Personal config mirror | always | `~/.config/ai/Super Ultra Code Plan Implementation.md` (one link) | none | n/a |
| `agents` | Universal Agents | always | `~/.agents/skills/` | none | n/a |
| `antigravity` | Antigravity 2.0 and the IDE | `~/.gemini` exists, or `agy` is on `PATH` | `~/.gemini/config/skills/` | `~/.gemini/config/agents/<sprite>/agent.md` | not verified (Antigravity 1.3.3) |
| `antigravity-cli` | Antigravity CLI (`agy`) | `~/.gemini/antigravity-cli` exists, or `agy` is on `PATH` | `~/.gemini/antigravity-cli/skills/` | none | n/a |
| `antigravity-builtin` | Antigravity CLI built-in skills dir | `~/.gemini/antigravity-cli/builtin/skills` exists | `~/.gemini/antigravity-cli/builtin/skills/` | none | n/a |
| `opencode` | OpenCode | `~/.config/opencode` exists, or `opencode` is on `PATH` | `~/.config/opencode/skills/` | `~/.config/opencode/agents/<sprite>.md` | listed in `opencode debug agents` (OpenCode v2.0.24), not run with a prompt |
| `claude` | Claude Code | `~/.claude` exists (no CLI probe) | `~/.claude/skills/` | `~/.claude/agents/<sprite>.md` | not verified (Claude Code 2.1.296) |
| `codex` | Codex | `~/.codex` exists, or `codex` is on `PATH` | none | `~/.codex/agents/<sprite>.toml` | not verified (CLI not installed here) |
| `cursor` | Cursor | `~/.cursor` exists, or `cursor-agent` is on `PATH` | none | `~/.cursor/agents/<sprite>.md` | not verified (CLI not installed here) |
| `copilot` | Copilot CLI | `~/.copilot` exists, or `copilot` is on `PATH` | none | `~/.copilot/agents/<sprite>.agent.md` | not verified (CLI not installed here) |

Every skills directory above except `~/.config/ai` holds `super-ultra-code-plan/` (`SKILL.md`, `templates/`, `examples/` and the two
Mermaid configs) next to the seven phase skills, `sucp-<name>/SKILL.md`. Runs on Linux in a throwaway home
checked the directory-based and the CLI-based detection and the skills and sprite paths of all 10 targets,
using stub CLIs for detection.

Gemini CLI (`gemini`) is not a target. Google stopped serving it to free, AI Pro and Ultra accounts on
2026-06-18 and replaced it with Antigravity CLI (`agy`), which the `antigravity-cli` target covers
(<https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>).
It remains available under a Code Assist Standard or Enterprise licence or with a paid API key; those
users can link the skill package into `~/.gemini/skills/` themselves. An earlier revision of this
installer had a `gemini-cli` target; `--only gemini-cli` now exits 2 as an unknown target.

- **Detected, not installed.** A target that is absent after a successful `./install.sh` means its harness
  was not detected, not that the install failed. The installer does not create an empty config tree for a
  harness you do not have. `./install.sh --dry-run` lists the targets your machine qualifies for. A bare
  home gets only `~/.config/ai` and `~/.agents/skills`.
- **Naming a target.** `--only ID,ID` installs exactly those ids, detected or not, and does not add the two
  always-installed targets (`--only claude` installs `claude` and nothing else). `--skip ID,ID` removes
  ids and wins over `--only`. Both flags can repeat and accumulate, and an unknown id exits 2. Older
  versions of the installer created the OpenCode and Antigravity targets even when the harness was absent;
  `--only opencode,antigravity,antigravity-cli,antigravity-builtin` brings that back.
- **Two Antigravity skills directories.** The `antigravity` target (`~/.gemini/config/skills`) is where
  Antigravity 2.0 and the IDE read skills, and the CLI reads `~/.gemini/antigravity-cli/skills` (the
  `antigravity-cli` target), according to the Antigravity docs read for the `agy plugin` research. Neither
  path was confirmed by loading a skill.
- **Codex, Cursor and Copilot have no skills target.** The installer takes their skills to come from
  `~/.agents/skills`, which was not checked against those three harnesses. They get sprite agents only.
- **Sprite agents are rendered, and only OpenCode is confirmed to list them (no harness was run with a model prompt).** Six harnesses get them
  (Claude Code, OpenCode, Codex, Cursor, Copilot and the `antigravity` target). `antigravity-cli`
  and `antigravity-builtin` get none, and tier `minimal` renders none. OpenCode v2.0.24
  listed all seven sprites in `opencode debug agents`. Antigravity 1.3.3 was not confirmed: `agy agents`
  lists only agents written with `mainAgent: true`, and the sprites are written with `mainAgent: false`.
  Claude Code 2.1.296 has no non-interactive lister of subagent definitions (`claude agents --json` lists background sessions and printed `[]` with the sprites installed), and Codex, Cursor and Copilot were never run.

## Flags

`./install.sh -h` prints this list. The source of truth for the targets is the table above, and for the tiers
`scripts/install/tiers.tsv`.

| Flag | Default | Effect | Rules and exit 2 cases |
|---|---|---|---|
| `--tier minimal\|standard\|full` | `standard` | Which tools are required (see Prerequisites). | Any other value, or a missing value, exits 2. |
| `--only ID,ID` | off: every detected target plus the two always-installed ones | Act on exactly these targets, detected or not. Does not add `ai-config` or `agents`. | Repeats accumulate, and `--only=a,b` works too. An unknown id exits 2 and lists the valid ids; an empty value exits 2. |
| `--skip ID,ID` | none | Leave these targets out. Can remove `ai-config` or `agents`. | Wins over `--only`. Repeats accumulate. Same exit 2 cases as `--only`. |
| `--copy` | off (links) | Copy the files instead of linking them, and mark each copy (see Copy mode). Needs `cmp` and `diff`, or the run exits 1. | On Git Bash, MSYS and Cygwin it is on by default. |
| `--dry-run` | off | Print what would be done and write nothing, in every mode. Prerequisites are still checked first. | An install or `--update` dry run ends with `==> Dry run finished: nothing was written (run again without --dry-run to apply it)`. `--uninstall --dry-run` ends with its own summary (`would be removed`), and `--check` ends with its `check:` line. If entries are left alone or no target is selected, the closing line says so instead. |
| `--check` | off | Report whether the install is current and change nothing. Needs no `bun` and no `git`. | At most one of `--check`, `--update`, `--uninstall`; two of them exit 2. |
| `--update` | off | Bring the install in line with this checkout: link what is missing, repoint stale links, refresh copies, render the sprite agents again, prune. | Asks for the tools of the chosen tier, like an install. |
| `--uninstall` | off | Remove what the installer made and put the newest backup back. Needs no `bun` and no `git`. | Asks for no tool, whatever `--tier` says. |
| `-h`, `--help` | off | Print the usage text and exit 0. | |

| Exit | Meaning |
|---|---|
| 0 | The run finished, or `--check` found everything current, or `-h`. |
| 1 | A required tool is missing; `--check` found a problem; a link or copy could not be placed (your file is put back); a sprite renderer failed (the other targets still finish first); or `HOME` is not writable (`[FAIL] cannot create <dir>: <reason> (is HOME writable?)`, nothing is written). |
| 2 | Usage error: an unknown argument, a bad `--tier`, an unknown or empty target list, a missing value, more than one mode flag, an unset `HOME`, or a `HOME` or checkout path that holds a tab or a newline. Also `--check` when no selected target had anything to check. |

A plain install says which harnesses it left out, with `[INFO] not detected, skipped: <ids> (name one with --only to install anyway)`.
For `codex`, `cursor` and `copilot` it says `[INFO] <id>: no skills target of its own (its skills come from ~/.agents/skills); installing its sprite agents only`.
Tier `minimal`, `--check` and `--uninstall` print no warnings about optional tools.

## Backup, restore, update, check and uninstall

Before it places anything, the installer judges each destination from what is on disk. No state file exists,
so an install made by an older version, or by hand, is judged by the same rules.

| State | What it is | Install and `--update` do |
|---|---|---|
| `absent` | Nothing there. | Create the link (or copy). |
| `ok` | Already the wanted link (in copy mode, an identical copy). | Nothing. |
| `ours-stale` | The installer's own and wrong: a link into this checkout that points elsewhere or dangles, or a link into the items of the old `ai-skills` repository, live or dangling. | Replace it, with no backup, because nothing you wrote is in it. |
| `foreign` | Anything the installer cannot show is its own: a real file or directory without a marker, or a link that points anywhere else (even a dangling one). | Move it to a backup, then place. |
| `inrepo` | The destination is a file of this checkout itself (for example `~/.claude/skills/sucp-rules` linked to `<checkout>/skills/sucp-rules`). | Skip. |
| `viadir` | An existing real file behind a symlinked directory (for example `~/.claude/skills -> ~/dotfiles/skills`), or a link there that is not the installer's own; in `--copy` mode also the installer's own links and any absent entry. | Skip. |

| Operation | What it does | Tags you will see |
|---|---|---|
| Backup | The colliding file is moved with `mv` to `<dest>.vivera-bak-<UTC YYYYmmddTHHMMSSZ>`, for example `SKILL.md.vivera-bak-20261011T080000Z`. If that name is taken, `-1`, `-2` and so on are appended. If placing the link or copy then fails, your file is moved back and the run exits 1. | `[BACKUP]` |
| `--check` | Read-only: it creates, moves and removes nothing of the installer's, also with `--dry-run`, with `--copy` and on a read-only `HOME` (when it runs `bun` for the sprite check, `bun` itself may create its transpiler cache under `~/.bun`; `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` stops that). One line per path, then a verdict. | `[ok]`, `[missing]`, `[stale]`, `[dangling]`, `[foreign]`, `[skip]` |
| `--update` | Runs every step of a plain install, then prunes. A dangling link into the old `ai-skills` path is repointed with no backup. A `sucp-*` directory that this checkout no longer has is pruned, but only when it is a real directory that is the installer's own (it holds a marker, or its `SKILL.md` is a link the installer judges `ok` or `ours-stale`). Your own directory and a live link elsewhere are never pruned. In a directory that also holds other files, only the installer's link (or its `SKILL.md` and marker) is removed and the directory stays; the directory itself goes only when that leaves it empty. An edited `SKILL.md`, or a `SKILL.md` that is a symlink, is kept with a `[KEEP]` line. `--check` lists the same set as `[stale]`. | `[PRUNED]` |
| `--uninstall` | Removes every `ok` or `ours-stale` link and then puts the newest backup back: the later UTC stamp wins, then the larger `-N` as a number (`-10` beats `-2`); names that only look like a backup are ignored and older backups stay. It removes a directory with `rmdir` only when it is empty, with one exception: a managed copy directory (`templates/`, `examples/`) that is identical to its source, or still matches its recorded digest, is removed whole. A modified copy is kept, so your files survive. It never removes harness roots such as `~/.claude` or `~/.gemini`, `~/.config/ai` itself, the `antigravity-builtin` skills directory, or the `core.hooksPath` setting (undo it with `git -C <checkout> config --unset core.hooksPath`). It removes the generated sprite files too, when `bun` is present. | `[REMOVED]`, `[RESTORED]`, `[KEEP]` |
| `--dry-run` | Prints the plan and writes nothing, in install, `--update` and `--uninstall` alike. | `[DRY-RUN]` lines |

`--check` verdicts:

| Tag or last line | Meaning |
|---|---|
| `[ok]` | The wanted link resolves (in copy mode, the copy matches). |
| `[missing]` | Nothing there. `[missing] <dir> (sprite agents)` means an empty or partial sprite directory. |
| `[stale]` | The installer's own but wrong: a link that points elsewhere in the checkout or into `ai-skills`, a copy where a link is expected, a copy that differs or was edited, a `sucp-*` directory this checkout no longer has, or sprite files that are out of date or hand-edited. `--update` fixes it. |
| `[dangling]` | The installer's own link whose target does not exist (a link into this checkout or the old `ai-skills` repository, or the wanted link whose source file is gone). A dangling link that points anywhere else is `[foreign]`. |
| `[foreign]` | Not the installer's: a real file or another link (`--update` would move it aside), a `viadir` file, or an `inrepo` file that is not the expected one. It counts as a problem, so a `viadir` file keeps `--check` at exit 1 until you resolve it. |
| `[skip]` | A target with no skills to check, or a sprite directory that was not checked: no `bun`, tier `minimal`, or a directory inside this checkout or behind a symlink. The last line then says `sprite agents not verified: <why>`. |
| `[FAIL] <id> sprites: <generator line>` | The sprite generator failed for a reason that is not drift, and its own line is shown instead of calling the files stale. |
| `[hint] those are copies made by --copy: run ./install.sh --check --copy` | You checked a copy install without `--copy`. |
| `check: CURRENT` | Exit 0: everything selected is in order. |
| `check: CURRENT (sprite agents not verified: <why>)` | Exit 0, but the sprite directories were not checked (for example `bun` is absent). |
| `check: N problem(s)` | Exit 1. |
| `check: nothing to check ...` | Exit 2: no selected target has skills and no sprite directory could be checked. |

Uninstall, per destination:

| What is at the destination | `--uninstall` does |
|---|---|
| A link that is `ok` or `ours-stale` | Removes it (`[REMOVED]`), then moves the newest backup back (`[RESTORED]`) if one exists. |
| A managed copy that is identical, or untouched since install | Removes it and restores the newest backup the same way. |
| A managed copy you modified | `[KEEP] <dest> (modified copy: it stays as it is; ./install.sh --update --copy replaces it after backing yours up)` |
| A real file or another link (`foreign`), a file inside this checkout, a real file behind a symlinked directory | Keeps it with `[KEEP]`. |

The closing line is `==> Vivera uninstalled: N link(s) removed, R restored, K kept`, and it says
`link(s) or copy/copies` when copies were removed. A restored link dangles if the checkout it pointed at was
deleted in the meantime.
