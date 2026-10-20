## Session metrics

`bun run metrics` (`scripts/session-metrics.mjs`) reports what the pipeline cost and how it behaved, read only from the Claude Code transcripts in `~/.claude/projects/<slug>` and from `pr.registry.json`. It counts main sessions, subagent runs by type, API calls, tokens, the API list-price equivalent in USD, first-call context, `AskUserQuestion` calls, Skill loads, merged PRs, and escapes (commits on `origin/main` with a `Fixes:` trailer).

```bash
bun run metrics -- --since 2026-10-09 --until 2026-10-19 --json
```

A session is assigned to the `--since`/`--until` window (whole UTC days) by its first timestamp, and a message id that appears in two transcript files is counted once. It prints counts only and never any transcript text, tool input, or tool result. A missing project dir exits 1, because an unread source is not an empty result.

The dollar figure prices each API call by its own model and cache TTL (5-minute cache writes at 1.25x the input price, 1-hour writes at 2x) from a dated price table, whose date is printed as `pricesAsOf`, and it is broken down per model and per merged PR. It is the API list-price equivalent of the same tokens, not the amount billed: a subscription is billed differently. Calls from a model without a price are left out of the figure and listed in the notes, so the figure is not zero for them, only incomplete.

## Scripts without a section of their own

The tree lists only some of `scripts/`, and later sections document most of the rest. These have no
section, so this table is where they are described. Each line comes from the script's own header
comment. Test files (`*.test.mjs`) sit next to the script they cover and are omitted.

| Script | What it does |
|---|---|
| `install-skill-links.mjs` | Links every skill in `skills/` into `~/.config/opencode/skills/`, the only place the OpenCode skill tool reads. Never overwrites a real file or a foreign symlink. `install.sh` links the phase skills too; this is the standalone way to re-run or verify just that. `bun run skills:link` applies, `bun run skills:check` exits 1 on a missing or stale link, `--dry-run` prints the actions. |
| `ci-targeted.mjs` | `bun run ci:targeted`, the default commit and PR gate. Selects checks from the files changed against `origin/main`: the import graph over `scripts/`, `validate` for skills and templates, the agents and snippets checks only when those change, `render-diagrams` only for diagram sources, and the copy rules and the file size check always. Root config and toolchain files (`package.json` unless only its `scripts` changed, `bun.lock`, installers) or an unrecognized path select the full `bun run ci`. `--rencana` (`--plan`) prints the chosen checks with their reasons; `--penuh` (`--full`) runs the full `bun run ci`. |
| `frontmatter-strict.mjs` | Runs plan frontmatter through a strict YAML check. The runner's own parser is a lenient subset, so a plan can pass it and still not be valid YAML. |
| `validate-lib.mjs` | The pure, importable part of `validate-skill.mjs`, plus `renderMermaidBatch`, so unit tests can pin the checks. |
| `mermaid-batch.mjs` | Renders a list of `.mmd` files from stdin with a batch-and-bisect fallback, shared by `render-diagrams.sh` and `validate-skill.mjs`. |
| `puppeteer-browser.mjs` | Points `mmdc` at a system Chromium or Chrome on PATH when `~/.cache/puppeteer` is absent and `PUPPETEER_EXECUTABLE_PATH` is unset, shared by `render-diagrams.sh` and `validate-skill.mjs`. |
| `skill-corpus.mjs` | Holds the list of phase skills and `readSkillCorpus`, which reads the master skill and the phase skills together for the validators. |
| `vault-index-merge.mjs` | Joins the chunks into one `graph.json`. |

## Frozen surfaces

These surfaces keep their code and tests, but get no new features and no deploys until the first tagged release (the freeze lifts once a `v*` tag exists):

- The docs site under `apps/docs`.
- The Windows installer: `install.ps1` and `scripts/install/windows-*.ps1`.
- The container setup: `Dockerfile` and `.devcontainer`.
- The release tooling: `scripts/bootstrap.sh` and `scripts/release`.
