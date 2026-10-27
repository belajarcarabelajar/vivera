## The pre-commit hook

`.githooks/pre-commit` has two parts. The file size gate runs first and is the only part that
can block a commit. The graph refresh then keeps the graph consistent with what a commit
actually contains, without the agent having to remember: when code changed it runs
`graphify update .` (local AST), then `bun run graphify:sync` adds the Markdown's structural
nodes last. `install.sh` enables it with `git config core.hooksPath .githooks`.

| Concern | How it is handled |
|---|---|
| Size gate (blocking) | `bun scripts/check-file-size.mjs` blocks a staged text file over 5,000 tokens (bytes / 4, so 20,000 bytes), measured from the index, not the working tree. Only staged files are judged. Symlinks, submodules, binaries, and paths marked `-size-gate` in `.gitattributes` (lockfiles, rendered diagrams, vendored files) are skipped. The error prints split advice per file kind. `bun run size:check` runs it by hand. |
| Ratchet | Files already over the limit carry a ceiling in `scripts/file-size-baseline.json`: they may not grow, and a file that shrinks lowers its ceiling in the same commit. `--write-baseline` only lowers or drops ceilings; raising one is a hand edit in the same commit, whose message carries `size-raise: <plan-id> <reason>`. |
| Graph refresh not blocking | Every graphify step exits 0, and a missing bun or checker, or a checker exit 2, skips the size gate with `[size-gate] skipped: <reason>`; a checker crash (any other exit, or exit 1 without a report) blocks. The graph is derived, local and regenerable, so a failed step prints a bounded warning and the commit proceeds. A red graph must never block history. |
| Ordering | `graphify update` runs **before** the sync, never after. `update` rebuilds `graph.json` and its writer is not guaranteed to preserve foreign nodes, so the structural layer must be the last writer or the document nodes can vanish. Measured 2026-10-03: `update` took 5.3 s, grew the graph 2342 → 2832 nodes, preserved the semantic layers (concept 284 → 274, rationale 156 → 158), and the following sync restored the document layer to 2984 nodes with `graphify:check` CURRENT. |
| Gating / cost | Nothing runs when the staged diff is empty or there is no graph to update. A **Markdown-only** commit runs the sync alone and skips the 5.3 s code rebuild; a commit with **any non-Markdown** file runs `update` then the sync. Both steps are local: no LLM, no network. |
| Why a git hook and not an OpenCode plugin hook | OpenCode v2's only session-lifecycle event is `session.idle`, which fires after **every** assistant turn rather than at a session end, so a plugin hook there would re-scan constantly. A git hook is harness-agnostic (OpenCode, Claude Code, a terminal all end in `git commit`) and is a committed file rather than machine-local plugin state. |
| Enable / disable | `git config core.hooksPath .githooks` enables it; `GRAPHIFY_SYNC_SKIP=1 git commit ...` skips only the graph refresh for one commit; `git commit --no-verify` skips the whole hook, and `bun run ci` still catches an oversized file; `git config --unset core.hooksPath` reverts to the default `.git/hooks`. None of these touches `graphify-out/`. |

The graph refresh is deliberately **not** part of `bun run ci`: it writes a gitignored,
machine-local artifact whose correctness depends on the vault and the installed graphify,
neither of which a portable CI runner can see. The size check is: `bun run ci` ends with
`bun scripts/check-file-size.mjs --all`.

## Getting sessions to query the graph

A graph nobody queries is only a build cost. Claude Code does not load a repository's
`AGENTS.md` when a `CLAUDE.md` sits in a parent directory, so the graphify rules in that file
never reached most sessions, and nothing else prompted a query: 14 of 161 top-level Claude
Code sessions from 2026-10-08 to 2026-10-14 made one. Three user-level hooks now tell each
session and subagent about the graph at start, and two commands register a repository and
list the ones still without a graph.

```text
bun run graphify:hooks (--install | --uninstall | --check) [--settings <path>] [--hooks-dir <dir>] [--dry-run]
bun run graphify:register <dir> [--never] [--global]
bun run graphify:audit <root>... [--json] [--max-depth N]
```

| Command | What it does | Exit codes |
|---|---|---|
| `graphify:hooks` | Merges the three entries below into `--settings` (default `~/.claude/settings.json`), each running a script in `--hooks-dir` (default `scripts/hooks` in this checkout). An entry is its own when a command contains `/scripts/hooks/graphify-`: `--install` replaces those, so a second run changes nothing, and `--uninstall` removes only those. Every other key and hook is kept, and the previous file is kept at `<settings>.bak`. `--install` creates a missing settings file. `--dry-run` prints the resulting JSON and writes nothing. Run from a linked worktree without `--hooks-dir`, `--install` refuses and names the main checkout to run it from, because a session worktree is removed after its PR merges. | `--check`: 0 when all three entries and their scripts exist, else 1 naming what is missing. A settings file that is not valid JSON, or whose `hooks` is not an object: 1, nothing written. `--install` from a linked worktree without `--hooks-dir`: 1, nothing written. |
| `graphify:register` | Resolves the main checkout (run from a worktree, it registers the main checkout), runs `graphify update <mainRoot>`, appends `graphify-out/` to `<git-common-dir>/info/exclude` when it is not already ignored. Only with `--global` does it then run `graphify global add <graphPath> --as <basename of mainRoot>`; without it, it prints how to add the graph later. The global graph stays opt-in because every graphify MCP server loads all of it at startup (measured at 176 MB with 24,617 nodes and at least 625 MB with 126,291), so it holds only what should answer queries that name no repository. Safe to run twice. An opted-out repository is reported and not built. `--never` sets `git config graphify.register never` and builds nothing. | 0 done; 1 when `graphify` is missing or a graphify step exits non-zero (the output names the step and its code); 2 on usage or a directory outside a git repository. |
| `graphify:audit` | Walks each root to `--max-depth` (default 4), skipping `node_modules`, `.cache` and worktrees (listed separately, never counted as unregistered), and prints each repository's path, kind, node and edge counts and staleness with a totals line, or JSON with `--json`. | 1 while any repository is `unregistered` (opted-out ones do not count), else 0; 2 with no root or a root that does not exist. |

Registration is offline: `graphify update` parses code locally (AST), with no LLM and no
network. A 2,076-file repository built in about 13 s with networking disabled.

The three hook entries, each `"<path to bun>" "<hooks-dir>/<script>"` with a 10 s timeout:

- `SessionStart`, no matcher, so a `compact` re-injects it: `graphify-session-start.mjs`
- `SubagentStart`: `graphify-session-start.mjs`
- `PreToolUse`, matcher `^(Grep|Glob|Read|Bash|mcp__graphify__.*)$`: `graphify-search-nudge.mjs`

| Repository state | What the session or subagent sees at start |
|---|---|
| Registered | One paragraph: the graph path (from a worktree, the main checkout's graph, and the text says so); when the graph is older than the last commit, that `graphify update <mainRoot>` refreshes it offline; and the query command, `graphify query "<question>" --graph <graphPath>` (also `path`, `explain`) or the MCP tool `query_graph` with `project_path` set to the main checkout. |
| Unregistered | Session start only, not subagents: that the repository has no graph, the registration command, and the user's standing request to be offered registration through the question tool with Register now, Not now, and Never for this repository. Register now runs `graphify-register.mjs`, Never runs it with `--never`, and Not now records nothing, so the next session offers again. |
| Opted out, or not a git repository | Nothing. |

In a registered repository, the first search by a session or subagent before its first graph
query gets one reminder next to the result, naming the graph path and the query command. A
search is `Grep`, `Glob`, a `Read` of a file that is not Markdown and not under
`graphify-out/`, or a Bash command whose first word is `rg`, `grep`, `fd`, `find` or `ag`. A
query is any `mcp__graphify__` tool, or `graphify query`, `path` or `explain` in Bash. Each
session and agent is tracked separately. Both hooks exit 0 on every path and never allow or
block a tool call. `install.sh` only prints the install command; it does not edit the global
settings.

| Change | Revert |
|---|---|
| Hook entries in `~/.claude/settings.json` | `bun run graphify:hooks --uninstall` |
| Never for a repository | `git config --unset graphify.register`, run in that repository |
| A registration | Only when it ran with `--global`: `graphify global remove <tag>`, where the tag is the main checkout's directory name. The local graph stays in `graphify-out/`; delete it, and the `graphify-out/` line in `.git/info/exclude`, to undo the build too. |

The runbook section with the measurement details is §3.4.1 of
[`docs/graphify-integration.md`](../../docs/graphify-integration.md).

## The drift watchdog

`scripts/plan-mirror-check.sh` wraps `mirror:check` for unattended daily runs. It only ever
passes `--check`, so there is deliberately no publish path in that file.

| Concern | How it is handled |
|---|---|
| Scheduling | A `systemd --user` timer, not a GitHub Actions workflow. A workflow on a runner can see neither the vault nor the sibling repositories, so it would either fail forever on a missing path or pass vacuously by enumerating zero plans. |
| Vacuous pass | Reported as a distinct verdict rather than hidden. A gate that passes because it found nothing is worse than no gate, because it manufactures confidence. |
| Exit status | Propagated on purpose, so a failed run shows up in `systemctl --user --failed`. Swallowing it would make the script a log-dumper instead of a watchdog. |
| Missing runtime | `exit 127` when `bun` is absent from both `PATH` and `$HOME/.bun/bin/bun`, because systemd starts services with a minimal environment. |
| Log | `~/.local/state/plan-mirror/mirror-check.log`, append-only, capped at 500 records and 20 detail lines per run. The trim goes through a temp file, so an interrupted run cannot leave a truncated log. |

Disable it with:

```bash
systemctl --user disable --now plan-mirror-check.timer
systemctl --user reset-failed plan-mirror-check.service
```
