# Trigger Snippets

Copy-paste prompts for the six workflow entry points. They live in
[`snippets/`](../../snippets/) and are the fastest way to activate the skill correctly.

- **[`orkestrasi-brainstorm.md`](../../snippets/orkestrasi-brainstorm.md)** (keyword: `brn`): grill-until-locked brainstorm interview BEFORE any plan: grounds in the repository, surfaces trade-offs via the harness question tool, and locks tasks A/B/C/D into an approved intent artifact.
- **[`orkestrasi-ngoding-plan.md`](../../snippets/orkestrasi-ngoding-plan.md)** (keyword: `;`): plan generation, TDD execution, and the mandatory subagent pipeline.
- **[`orkestrasi-debugging.md`](../../snippets/orkestrasi-debugging.md)** (keyword: `;,`): root cause analysis with hypothesis-parallel investigation, and the mandatory subagent pipeline.
- **[`orkestrasi-pr.md`](../../snippets/orkestrasi-pr.md)** (keyword: `;;,`): PR delivery from a finished session, PR review, and the ordered batch merge.
- **[`orkestrasi-overnight.md`](../../snippets/orkestrasi-overnight.md)** (keyword: `ovn`): carry an approved plan to a verified PR while you are away. Its target comes from `#{clipboard}`: copy the approved plan's path. Entry gate, retry budget, never-merge, and a morning handoff file.
- **[`orkestrasi-pr-review.md`](../../snippets/orkestrasi-pr-review.md)** (keyword: `prr`): standalone remote PR review, line-anchored findings, coverage table, and binary verdict; merges to main only when pre-authorized and all gates pass. Its target comes from `#{clipboard}`: copy one PR URL for a single review, or several (one per line) for a batch of any size.

## Command snippets

Short prompts for the moments between the six entry points: authorizing a merge,
continuing past a failure, answering a check-in, resuming, cleaning up. Each is one
paragraph, carries no subagent contract (they run inside a session that already
has one), and is tracked in the manifest like the large ones.

| Keyword | File | Use it to |
|---|---|---|
| `mrg` | [`cmd-merge.md`](../../snippets/cmd-merge.md) | authorize merging this session's PR(s) into main; gates re-measured, never `--admin` or `--force` |
| `err` | [`cmd-error-continue.md`](../../snippets/cmd-error-continue.md) | keep going after a failure: 2 attempts per chunk, then park as `blocked` |
| `apv` | [`cmd-approved.md`](../../snippets/cmd-approved.md) | answer a "shall I continue?" check-in inside the approved scope |
| `dnn` | [`cmd-done-verify.md`](../../snippets/cmd-done-verify.md) | report a manual step done; the agent measures instead of trusting |
| `sts` | [`cmd-status.md`](../../snippets/cmd-status.md) | read-only status table: plan, PRs, running job |
| `rsm` | [`cmd-resume.md`](../../snippets/cmd-resume.md) | resume from the plan file after compaction, `/clear`, or an interrupted turn |
| `cln` | [`cmd-cleanup.md`](../../snippets/cmd-cleanup.md) | remove this session's merged worktree and local branch, by PID, never `rm -rf` |
| `aud` | [`cmd-audit.md`](../../snippets/cmd-audit.md) | read-only audit with ranked proposals and revert paths |
| `prm` | [`cmd-review-merge.md`](../../snippets/cmd-review-merge.md) | type after `prr`: the pre-authorization that lets it merge safe PRs |
| `fbk` | [`cmd-fallback.md`](../../snippets/cmd-fallback.md) | fallback ladder when a tool fails; never swap a remote run for a local one |

`mrg` authorizes the merge and nothing else: no deploy, no cleanup. Cleanup is `cln`,
a separate act. Undo any slot with `snipset snippet delete <uuid>` (the uuid is in
`snippets.manifest.json`) and remove its manifest entry and source file.

## Clipboard-driven review targets

`orkestrasi-pr-review.md` takes its target from `#{clipboard}`, substituted by Snipset at
expansion time. One URL reviews one PR; several (one per line) review a batch:

```bash
snipset snippet expand --by-keyword prr \
  --clipboard "https://github.com/owner/repo/pull/42"

# a batch
snipset snippet expand --by-keyword prr --clipboard "$(gh pr list --json url --jq '.[].url' | tr '\n' ' ')"
```

Accepted shapes: a full PR URL, `#123`, or `owner/repo#123`. A value with no
recognizable target is a **stop**, never a guess at a nearby number and never a
fallback to whatever `gh pr list` shows first.

Batch behaviour is defined rather than left to the agent reading a bigger number. One
verdict per PR, never one for the batch. Fan-out chunks per `(PR, coverage category)`
so no two subagents share a cell. Merges stay strictly sequential even though the
reviews ran in parallel, with a fetch and a local check after every individual merge.
Pre-authorization covers each PR in the list individually, so merging the first does
not authorize the second. One unreachable PR is recorded as `not reviewed` and the
batch continues.

## Copy rules: no em dash, no attribution footer

Two rules about the copy this repository ships, enforced by
`bun run copy:check` and asserted on every `bun run ci`:

```bash
bun run copy:check <file>...        # check an artifact (a PR body, a doc)
bun run copy:check --commits [N]    # check the last N commit messages
```

The checker reads the repository the command runs in: `--diff` and `--commits`
use the git toplevel of the current directory and exit 2 outside a repository,
and file paths resolve against the current directory. `bun run copy:check`
always runs from this repository's root, so to check another repository call the
script there: `cd <repo> && bun <vivera>/scripts/check-copy-rules.mjs --diff origin/main`.

| Rule | Pattern |
|---|---|
| No em dash | U+2014 in user-visible prose |
| No attribution footer | `Generated with <tool>`, a `🤖` credit badge, `Co-Authored-By:`, `Signed-off-by:` |
| No tool prefix on a branch name (the same attribution rule, on generated text) | `pr-registry.mjs claim` derives `<plan-id>/<session-slug>` |

The second rule exists because of PR #15 on 2026-10-04, where a
`Generated with [Claude Code]` footer was appended to a PR body that no
template, no instruction, and none of the seven other PRs in this repository
supported, in a session that was not Claude Code. It published a false claim
about authorship in a permanently public artifact. Both rules already existed as
prose; the em-dash rule was in the master skill and in the PR template checklist,
and 69 em dashes still rode out in one diff. A rule that only exists in prose
cannot stop anything.

Two scope decisions, both forced by running the checker rather than reading it:

**The patterns match attribution SHAPES, not tool names.** A first version also
matched bare vendor names and immediately flagged README's harness table, which
legitimately lists Claude Code and Copilot, plus a mermaid node reading
`🤖 Subagents execute`. Those are not attributions. A gate that fires on those
gets learned to be noise, and a noisy gate reports success while checking
nothing. `Generated with X` is an attribution whatever X is; a bare tool name is
not.

**Git history is not scanned by CI.** An earlier version checked the last 20
commit messages and failed on two commits from a previous session, which is not
CI's to fix and would leave the gate red forever on history nobody will rewrite.
Run `bun run copy:check --commits` on your own commits before pushing, where a
hit is a hit on work you just produced.

**The branch-name rule needs a different gate, because the name is generated.**
The pattern list above can only catch text someone typed, and a branch name is
printed by `pr-registry.mjs claim` rather than written by hand. So the gate is
`bun run validate`: it calls `branchFor` and compares the result against the
shape the master skill documents, which fails the moment a prefix is put back.
`pr-registry.mjs` once derived `ai/<plan-id>/<session-slug>`. A branch name is
permanent, publicly readable repository history, so that prefix was an
authorship claim in the one artifact nobody can redact afterwards, and it was
removed on that basis. Slots claimed before the change keep the branch they
claimed, so there is no migration and no rename to undo.

A line that states the rule is exempt from it, with a two-line lookback so a
wrapped markdown checklist item can quote the trigger phrase it forbids. The
window is bounded: a violation four lines below a rule statement is still caught.

## Design tells: no decorative left stripe

The master skill names seven frontend tells (an eyebrow badge, a decorative
status dot, a colored left stripe, and four more). The one with a mechanical
shape has a gate, `bun run design:check`:

```bash
bun run design:check <file-or-dir>...   # whole files; a directory is walked
cd <repo> && bun <vivera>/scripts/check-design-tells.mjs --diff origin/main
                                        # only stylesheet lines added since the base
```

It exists because on 2026-10-16 the Snipset website still carried 31 decorative
left stripes while the tell had been prose in `sucp-rules` all along: a 4px accent
`border-left` on the closing CTA card of every solutions page (23 inline
`style=""` attributes, EN and ID), on the compare page's TCO card, on every
testimonial card (a 4px gradient `::before`), on two terminal demo boxes, and on
the 404 page. None marked a state. The owner found the first one in a screenshot.

| Shape | Pattern |
|---|---|
| Border stripe | `border-left`, `border-left-width`, `border-inline-start(-width)` of 2px or more with a visible colour |
| Shadow stripe | `box-shadow: inset <N>px 0 0 ...` with N of 2 or more |
| Pseudo-element stripe | a `::before`/`::after` that is `position: absolute`, `left: 0`, 2 to 8px wide, and full height |
| Utility stripe | Tailwind `border-l-2`, `border-l-4`, `border-l-8` in a class list |

A stripe is a signal when its selector says which state it marks, so a selector
(or any enclosing selector, or the element's own tag for an inline style) that
contains `active`, `current`, `selected`, `warning`, `error`, `success`, `alert`,
`callout`, `blockquote`, `status`, `pass`, `fail`, or the rest of `STATE_WORDS`
passes on its own. Anything else needs `/* design-tells: allow <reason> */` on
the same line or the line above, and a waiver without a reason is a violation of
its own. A 1px border is a border, and top, right, and bottom borders stay out of
scope until one is measured as a tell. Like `copy:check`, `--diff` judges only
the lines the branch adds, so an old stripe never blocks an unrelated PR.

## Duplicate definitions: the reuse rung of the Simplicity Ladder

Rung 2 of the Simplicity Ladder says to reuse a helper the repository already has
before writing a new one. That rung was prose, so a duplicate helper was found by
hand or not at all. `bun run dups:check` is its mechanical form:

```bash
bun run dups:check --diff origin/main   # only definitions on lines the branch adds
```

It reports a top-level definition on a line this branch adds whose name, lower-cased
with `_` and `-` removed, is already defined in a different file (`formatPrice` and
`format_price` are one name). It reads JS and TS, Python, Go plain funcs, and Rust
`fn`. It skips generic names (including `parseArgs` and `usage`), test files,
`node_modules`, `vendor`, `dist`, `build`, `target`, `graphify-out`, and pairs across
language families. Exit 0 is clean, 1 is a possible duplicate, and 2 is a usage
error. The last line is always `scanned N added definitions in M files`, so a zero
is visible as a zero and not as a run that read nothing. The waiver is
`dup-defs: allow <reason>` on the same line or the line above, and a waiver without
a reason is a violation of its own.

A hit is a possible duplicate: the reviewer reads both definitions before filing it.
On the history of this repository on 2026-10-17 it reported 31 distinct hits over two
windows (the last 20 and the last 60 commits). Reading both definitions of each, 5
were true duplicates, 14 partial (same job, real differences), and 12 were not
duplicates. The two skips that came out of that read, `parseArgs` and `usage` as
generic names and pairs across language families, remove 7 of the 12, leaving 24
hits of which 19 are worth a read. Two rules were tried on paper and rejected
because they hide real duplicates: exported definitions only, and skipping
`checkDiff`. The limit is that it matches names only, so a helper rewritten under
another name is not found, and 5 same-name different-job pairs remain.

## File size: the split-it rule as a gate

A file an agent cannot read in one go gets read in parts and edited blind. `bun run size:check`
blocks a text file over 5,000 tokens (bytes / 4, limit 20,000 bytes). Three modes:

```bash
bun run size:check                                   # --staged (default, the hook): staged files, size from the index, their stale ceilings
bun scripts/check-file-size.mjs --all                # every tracked file plus stale ceilings (end of bun run ci)
bun scripts/check-file-size.mjs --write-baseline     # seed the ceilings once, then only lower or drop them
```

Exit 0 is a pass, 1 is a violation or a stale ceiling, and 2 is a usage error, a missing
git repository, an invalid baseline, or a failed git call. Files that
were over the limit when the gate landed keep their size as a ceiling in
`scripts/file-size-baseline.json`, a ratchet: growing is blocked, and a file that shrinks lowers its ceiling in the same commit (`--write-baseline`, then stage the baseline), because the hook refuses a staged file left below its ceiling. Ceilings are read from the staged copy of that file. When a
split is out of scope, raise the ceiling in the same commit with a message line
`size-raise: <plan-id> <reason>` (`.githooks/commit-msg`, `--all --base <ref>`). A renamed file counts as new, so move its ceiling. After a split, `git grep` the
old path and update references (`validate-skill` pins skill paths).

## Strict retries: `retry_if`

```yaml
defaults:
  retry_if: any        # any (default) | transient
```

| Value | A retry is spent on |
|---|---|
| `any` | Anything except a failure the exit code proves cannot change: 127, 126, 130, 143 |
| `transient` | Only `transient: true`, which in practice means a timeout |

**The strict policy is opt-in because `transient: 'unknown'` is the ordinary exit
1**, where a deterministic assertion failure and a flaky test are indistinguishable
from an exit code. Defaulting to the strict policy would stop retrying flaky tests
in every existing plan, including plans belonging to repositories this one does
not own. An unrecognised value throws rather than defaulting, the same as
`on_precondition_fail`.

## Mutual exclusion for the PR registry

`pr.registry.json` decides which session owns which branch and worktree, and it is
gitignored, so a lost write cannot be recovered. Atomic writes make each write
indivisible; they do not stop two writers from interleaving, where the second
rename silently discards the first.

`saveRegistry` therefore takes `expectedRaw`: the exact bytes the caller read. If
the file changed since, it refuses. There is **no lock file**, deliberately: a lock
needs a stale-lock policy, and a stale lock needs a decision about what a crashed
holder does to the next one. Compare and swap needs neither, because the state it
reads *is* the state.

```js
mutateRegistry((registry) => claimSlot(registry, { ... }).registry, { registryPath })
```

`mutate` must be pure, because it is re-applied on a fresh read when a conflict
happens. After four conflicts it fails loudly rather than spinning.

The residual window is stated, not hidden: between the re-read and the rename,
another process could still write. That window is one call wide instead of a whole
session, and `mutateRegistry` closes it by re-reading and re-applying.

## Backfilling `impacts` into plans that predate it

```bash
bun scripts/backfill-plan-impacts.mjs --dry-run   # report only
bun scripts/backfill-plan-impacts.mjs             # rewrite in place
```

Twelve plans held 108 tasks written before the key existed, each emitting a
validation warning. Hand-writing 108 impact claims would be writing 108 analyses,
and an analysis nobody performed is a fabrication wearing the costume of a record.
Every entry is instead **derived** from what each task already declared in its own
`files`, plus the consumers of those files in the current tree, plus the command
that shows them.

The first version of this script reported a file as having no consumer because its
regex stripped `.mjs` off the stem and then required the closing quote immediately,
so `from './plan-publish-frontmatter.mjs'` never matched. **83 of 127 tasks came
back as the "checked, nothing found" sentinel**, and every plan still validated,
because a sentinel is a legal entry. That is the failure the key exists to
prevent, reproduced inside the tool that fills it in. After the fix: 88 derived
entries, 39 sentinels, and a test that re-scans every claimed consumer count.
