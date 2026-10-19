## All five share the subagent and evidence rules

All five carry the same subagent and evidence rules, because the most common failure is an agent
that reads a trigger prompt, never sees a subagent requirement in it, and quietly
implements everything inline. Each one states the eight-step pipeline explicitly:
task-chunking, batch manifest, proportional fan-out, non-overlapping scopes, nested
fan-out, gather and synthesize, parent diff audit, and batched dispatch. Inline work is
allowed only as a written exception.

The brainstorming variant locks user intent through structured interview rounds before any plan
or code exists. The debugging variant chunks by **hypothesis** rather than by file, so competing
explanations are tested in parallel and a disproven cause is discarded without
contaminating the others. The PR delivery variant adds derived isolation, parent-only git ownership,
the PR body contract (`--body-file`), and topological batch merge. The PR review variant enforces
line-anchored review contracts and gates merging behind green local checks and a `correct` verdict.

All 16 snippets (six entry points and ten command snippets) carry one identical `CONFIRMATIONS:` paragraph right after the `PROGRESS METER:` paragraph, because a session started from a snippet never loads `sucp-rules`, and a test in [`scripts/sync-snippets.test.mjs`](../../scripts/sync-snippets.test.mjs) fails if one is missing, duplicated, or drifts. The Snipset database copy only catches up when the user runs `bun run snippets:push`.

## Keeping the database in sync

The markdown files are the source of truth. The Snipset database holds a copy, because
that copy is what an agent actually receives when the snippet is triggered.
[`snippets.manifest.json`](../../snippets.manifest.json) maps each file to its database slot
(uuid, keyword, name, description).

```bash
bun run snippets:status   # table of local vs database hashes
bun run snippets:check    # exit 1 on drift (also runs in CI)
bun run snippets:push     # write local content to the database
```

## Adding a new snippet is a create, not an update

`sync-snippets.mjs` only ever calls `snippet update`, which requires a uuid that
**already exists**. So a new trigger prompt needs its database slot provisioned once,
by hand, before `snippets:push` can do anything with it:

```bash
# 1. the CLI must agree with the database schema, or every write is refused
snipset doctor            # schema_match must be true

# 2. create the slot, taking the body from the file (never retyping it)
snipset snippet add \
  --name "<name>" --keyword "<keyword>" --group "Agentic Coding AI" \
  --description "<description>" \
  --content "$(bun -e "import {readFileSync} from 'fs'; import {extractPromptBody} from './scripts/sync-snippets.mjs'; process.stdout.write(extractPromptBody(readFileSync('snippets/<file>.md','utf8')))")"

# 3. paste the uuid the database returns into snippets.manifest.json, then
bun run snippets:push
```

The uuid is **chosen by the database**, so it cannot be pre-generated and written into
the manifest ahead of time. A manifest entry whose uuid does not exist yet reports
`snippet not found` from `snippets:check`, which is the correct verdict: the database
genuinely has no copy, and the agent would receive nothing when the snippet is triggered.

Both sides are normalized before comparison (em dash, curly quotes, rightwards arrow,
CRLF, trailing whitespace), so a typographic character in the Markdown source is not
reported as drift. A missing Snipset install is reported as a skipped comparison rather
than a failure, because a CI runner has no local database and that is an environment
boundary, not evidence of a problem. Real drift still fails.

`validate-skill.mjs` enforces the invariants that hold everywhere, including CI: the
manifest is valid JSON, every entry has all required fields, no duplicate uuid or
keyword, every referenced file exists, every tracked file carries the subagent contract,
and every required trigger snippet is tracked so it can never be silently left out of the
database.

## Mirroring plans into the Obsidian vault

A plan under `docs/code-plan/plans/` is a markdown file in a project repository, so the
vault cannot search it, render its Mermaid, or show it in the graph. `scripts/plan-publish.mjs`
copies each plan into `01 - Projects/<Project>/plans/` with the vault's PARA frontmatter
merged in. The copy is a **one-way, read-only mirror**: the project repository is the source
of truth, the vault copy is derived state, and the vault copy is never hand-edited. The
publisher never reads a mirror back as an input, so a stale mirror can rot visibly
(`--check` exists to catch that) but can never corrupt a plan.

```bash
bun run mirror:publish <plan.md>...   # mirror the named plans (or pass the flags below directly)
bun run mirror:check                  # exit 1 on drift or a missing mirror
bun run mirror:status                 # table of every plan and its mirror state, always exit 0
bun run issue:sync <plan.md>...       # the same plan, mirrored to a GitHub issue
bun run issue:check <plan.md>...      # issue drift report, never writes
bun run issue:status                  # table of recorded plan-issue links, always exit 0
```

A plan has **two** derived copies, both one-way: this Obsidian note, and a GitHub
issue carrying the same text. Run the issue sync immediately after each
`mirror:publish` for the same trigger, so the two never drift apart. See
[Plan Mirroring](pipeline-plan-mirroring.md) for the state mapping
and the three traps that shape the implementation.

- **`mirror:publish`** writes one file per plan and stages it in the vault with `git add` when
  `stageInVault` is on, so obsidian-git (configured with `autoCommitOnlyStaged: true`) commits
  it. It stages the single file and never commits or pushes. A re-publish of an unchanged plan
  prints `SKIPPED-IDEMPOTENT`, exits 0, and writes nothing.
- **`mirror:check`** is the CI-style gate: it never writes, and it exits 1 when a mirror's
  recorded `source_hash` no longer matches its source plan or the mirror is missing. Exit 0
  means every enumerated plan is mirrored and current.
- **`mirror:status`** is a report, not a verdict. It always exits 0, including when a mirror is
  missing, so it is safe inside a `&&` chain and in a shell pipeline.

Flags the CLI itself understands, for when you call `bun scripts/plan-publish.mjs` directly:

| Flag | Why it exists |
|---|---|
| `--check [--all]` | Verify only. `--all` enumerates every plan under every `mirror: true` project instead of requiring explicit paths. |
| `--status` | Report mirror state for every plan; never fails. |
| `--dry-run` | Print the destination and whether it would write, then write and stage nothing. |
| `--today YYYY-MM-DD` | Overrides the `updated` frontmatter value. It exists to make that property deterministic in tests; without it the value is today's local date. |
| `PLAN_PUBLISH_CONFIG` | Environment variable holding the path to `plans.publish.json`. It is the only way to point the tool at a different vault or a different set of project roots. |

Two more environment variables are host seams, so scripts that need a
machine-specific path can run on a machine that is not this one:

| Variable | Read by | Default |
|---|---|---|
| `GRAPHIFY_SITE_PACKAGES` | `vault-index.mjs` | unset: the `graphifySitePackages` key in gitignored `local.config.json` (see `local.config.example.json`), else an actionable error |
| `GRAPHIFY_PYTHON` | `vault-index.mjs` | unset: the `graphifyPython` key in `local.config.json`, else an actionable error |

`bun test scripts/` **skips, rather than fails,** the tests whose premise the
current host cannot satisfy: a checkout elsewhere, a machine without the
graphify detector installed, or a machine without the vault. The skip carries
its reason, so an absent prerequisite is never reported as a defect, and,
equally, never counted as a pass. Set the relevant variable to run those tests
here.

Exit codes: `0` success or idempotent skip, `1` drift / missing mirror / refused destination /
transform failure, `2` usage error.

## A worktree is not a project

`projects` is a routing table keyed on **path prefix**, and a plan file carries no
project name, so a plan is routed purely by where it sits on disk. That makes a git
worktree of an already-registered project unpublishable: its path is owned by nobody,
and `mirror:publish` refuses rather than guessing.

The tempting fix, registering the worktree as a project in its own right, is wrong,
and the damage is proportional to the repository's history. `mirror: true` does two
things: it permits explicit publishing *and* it enrolls the root in `--check --all`
enumeration, which walks **every** `.md` under `<root>/docs/code-plan/plans/`. A
worktree checkout contains the entire tracked history, so enumerating one republishes
every plan the repository has ever had. Registering the Snipset SEO worktree as a
project mirrored all 274 existing Snipset plans a second time, under a second project
folder, 286 files in one commit.

So a project may declare **`worktrees`**: extra directories that hold the same
project's plans on another branch.

```json
{ "name": "Snipset", "root": "/home/.../Proyek/Snipset", "mirror": true,
  "worktrees": ["/home/.../Proyek/Snipset-seo"] }
```

| Concern | How it is handled |
| --- | --- |
| Routing | `resolveProject()` treats a worktree as a candidate location for its project, so a plan written in a worktree mirrors into `01 - Projects/<Project>/plans/` beside its siblings. It creates no second project and no second index. |
| Enumeration | `enumeratePlans()` reads the **root only**, never the worktrees. This asymmetry is the whole point of the field: routing must accept a worktree, enumeration must not, because the worktree's plans are the root's plans. `enumeratePlans` is asserted against it directly. |
| Session worktrees | A plan under `<root>-wt/<slot>/`, the layout `scripts/pr-registry.mjs claim` creates, routes to the project whose `root` is `<root>` with no config entry, in both `plan-publish.mjs` and `plan-issue-sync.mjs`; an explicit `worktrees` entry still wins over that derived rule. |
| Origin remote | In `plan-issue-sync.mjs` only: a checkout whose directory name is not a project key, such as a detached `/tmp` gate worktree, resolves through its `origin` remote, read from the git config on disk (following `gitdir` and `commondir`), when that `owner/repo` is already a value in `projects`. When the directory key and the origin both resolve to configured repositories and those differ, the sync is refused, naming both; an origin that no project maps to is ignored when the directory key resolves, and `--project` still wins. |
| Precedence | Roots and worktrees compete on the same longest-prefix scale, so a real project nested inside a worktree still wins over the worktree that contains it. |
| Refusal | A `worktrees` value that is not an array, an entry that is empty or not a string, an entry that is already a registered root, and an entry two projects both claim are all load errors. One directory is never routable as two projects. |
| Detection | There is no git-identity check, so nothing infers that two roots are one repository. A worktree has to be declared. `loadRegistry` rejects the collision instead of letting the longer-prefix rule pick a winner by accident. |

A worktree that has been removed from disk should be dropped from `worktrees`. The
field costs nothing while stale, since enumeration never reads it, but a stale entry
silently keeps routing paths that no longer exist to a project that will never mirror
them.

`mirror:check` is deliberately **not** part of `bun run ci`. It reads `plans.publish.json`, which
names one vault by absolute path on one machine, and the plan set it enumerates currently has
mirrors for none of it, so the check is a local gate to run on the machine that owns the vault
rather than something a portable CI runner can ever pass.

## Indexing generated Markdown into the graph

`graphify update .` cannot do this. Its help reads "re-extract code files and update the
graph (no LLM needed)" and it parses code, so every plan, batch manifest, spike report,
handoff, progress log and learning ledger a session writes stays invisible to `graphify
query`, `path` and `explain`. `scripts/graphify-sync.mjs` closes that gap with the
deterministic half of the vault-index pipeline: one `document` node per eligible Markdown
file, its ATX `heading` nodes, and its resolvable `[[wikilinks]]` as `references` edges,
unioned into `graphify-out/graph.json`.

```bash
bun run graphify:sync     # structural extraction + merge, writes graph.json
bun run graphify:check    # exit 1 when the graph is stale; never writes
bun <vivera>/scripts/graphify-sync.mjs --root "$(pwd)"           # from any repository's root, vivera included
bun <vivera>/scripts/graphify-sync.mjs --check --root "$(pwd)"
bun scripts/graphify-sync.mjs --dry-run
bun scripts/graphify-sync.mjs docs/code-plan/plans/<plan>.md   # narrow to files
```

| Concern | How it is handled |
|---|---|
| Cloud boundary | It is a local line scan: no `extract`, no API key, no packet. The eligible set is decided by graphify's own detector through `scan()`, so the `.gitignore`/`.graphifyignore` boundary is the same one a future extraction would honour rather than a second matcher. |
| Ordering | Run it **after** `graphify update .`. `update` rewrites the code graph and is not known to preserve foreign nodes, so running it after the sync can discard the document nodes the sync just added. The pre-commit hook below enforces this order automatically. |
| Duplicate ids | The graph already carries graphify-era `document` ids. Before the union, previous `document` ids are remapped onto this layer's ids for the same `source_file`, so a known file is not indexed twice and its edges follow the remap. `node_kind: heading` nodes are never remapped: they are children of a file, not its identity. |
| Loss | `merge()` seeds the union from the previous graph, so code, concept and rationale nodes are retained and can only be added to. A gate refuses to write when the node count would fall. |
| Idempotency | `structural()` is deterministic and the merge is a union keyed on node id, so a second run over unchanged files writes byte-identical output. `graphify:check` is the gate. |
| Missing graph | It refuses and says so. It merges into an existing graph; it never fabricates one. |

The `bun run` and `bun scripts/...` lines run inside vivera and default to its root. Step 6.6
of the skill runs the sync at the end of a session in the `--root "$(pwd)"` form from the
session's repository, which is correct in vivera and in every other repository. Inside vivera
it also runs automatically through a committed git hook.
