# MEMORY.md — Distilled Rules

> Domain knowledge handbook. Durable `WHEN → DO → NOT` rules distilled from the Step 6 Learning
> Harvest (`templates/session-learning-ledger-template.md`), organized under `Task Group:` headers.
> Each rule passed both the Minimum-Signal NO-OP gate and the 30-Day Horizon test before landing here.
> Moving task state and transient errors do NOT belong here — they expire with the session.

---

## Task Group: vivera repo (super-ultra-code-plan skill maintenance)

| # | Rule (`WHEN <situation> → DO <action>, NOT <anti-pattern>`) | Origin session |
|---|---|---|
| L1 | WHEN invoking a shell command → DO use the tool named exactly `bash`, NOT `shell` (there is no `shell` tool in this harness; calling it wastes a turn) | session that added the learning ledger |
| L2 | WHEN adding a new `templates/*.md` to this repo → DO register it in BOTH `requiredTemplates` and `mermaidRequiredTemplates` in `scripts/validate-skill.mjs` and embed a strict ` ```mermaid ` fence, NOT just drop the file (the validator fails the build otherwise) | session that added the learning ledger |
| L3 | WHEN a planning/artifact template needs a Mermaid block → DO use a bare ` ```mermaid ` fence on its own line with `accTitle` + `accDescr`, NOT ` ```mermaid {config} ` (the renderer and validator only match the strict fence) | session that added the learning ledger |
| L4 | WHEN piping a tracked-file list into a scan → DO use NUL-delimited `git ls-files -z \| xargs -0` or plain `git grep`, NOT unquoted `$(git ls-files)` (spaces in filenames split into phantom paths and silently skip files) | open-source-sanitize (PR #6) |
| L5 | WHEN a scan output feeds a scope decision → DO consume the full output and assert the hit count, NOT `head`-truncate it (a truncated findings list hides the real scope) | open-source-sanitize (PR #6) |
| L6 | WHEN chunking a repo-wide sanitize/migration sweep → DO enumerate the target set with a full mechanical scan over tracked files BEFORE chunking, NOT from sampled grounding reports | open-source-sanitize (PR #6) |
| L7 | WHEN dispatching parallel subagents in this environment → DO cap each wave at 3 concurrent, NOT one mega-batch (measured: larger waves fail with a concurrency limit and waste a dispatch round) | open-source-sanitize (PR #6) |
| L8 | WHEN running repo tooling that owns a state file (pr-registry, plan issue sync) → DO run it from the checkout that owns the state file, NOT from a session worktree (gitignored state does not propagate to worktrees) | open-source-sanitize (PR #6) |
| L9 | WHEN running `bun run validate` or `bun run ci` inside a session worktree → DO copy the gitignored machine-local configs (`plan.issues.json`, `plans.publish.json`) in for the run and remove them after, NOT accept the two "missing config" validator failures (extends L8 to the validator) | vivera-branding (PR #10) |
| L10 | WHEN `package.json` `name` changes → DO patch `bun.lock`'s root workspace name and prove it with `bun install --frozen-lockfile`, NOT assume `bun install` rewrites the lockfile root name (measured: it does not) | vivera-branding (PR #10) |
| L11 | WHEN asserting per-line diff invariants (em dash gate, swap checks) → DO parse the unified diff byte-wise keyed on `diff --git`, NOT loop `rg` over `git diff --name-only` (filenames with spaces split, and line-level diffs re-show pre-existing em dashes on swapped lines) | vivera-branding (PR #10) |