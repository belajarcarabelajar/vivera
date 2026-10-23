# Plan Mirroring: Obsidian and GitHub Issues

A plan gets two derived copies, and both are one-way. The project repository is
the source of truth; every other copy is derived state that is regenerated, never
edited.

| Copy | What it buys | Idempotency key |
|---|---|---|
| Obsidian note | Searchable, readable, rendered Mermaid, graph-linked | `source_hash` recorded in the note's own frontmatter |
| GitHub issue | **History**: who opened it, when it was approved, what closed and when, every comment in one timeline GitHub already indexes and links from the commit | Issue number recorded in `plan.issues.json` |

The issue is the plan rendered for a reader who did not write it. Its title is
the plan's own `# ` heading, it carries the `plan` label, and its body is a derived
header (the plan path, its `plan_id`, status, and checklist progress, all read from
the plan), the plan body verbatim, the runner frontmatter folded in `<details>`, and
a machine-readable trailer carrying the plan id, key, source path, status, hash, and
layout `format`. A hand-written summary is banned: a summary is a second source of
truth that goes quietly stale the moment the plan changes, and then the issue is
wrong in a way nothing reports. The header is not one, because every value in it is
read from the plan by a fixed rule. The trailer is what makes "is this issue
current?" answerable from the issue alone. A plan longer than GitHub's
65,536-character body limit loses the folded frontmatter first (one `**Omitted:**`
line names it); only prose that is still too long becomes its longest verbatim
prefix, cut at a line boundary, followed by one explicit `**Truncated:**` line naming
N of M characters of the plan body and the plan's repository path, then the
unchanged trailer, whose hash still covers the full plan: a prefix with a marker,
never a summary. The session PR links the issue with `Refs #<n>`, never
`Closes #<n>`, because the plan's status closes it, and the sync runs again when the
PR is opened and after every push that changes the plan.

## Three things that will bite you, and why they are built this way

**The issue number is never written into the plan's frontmatter.** The vault mirror
hashes the entire plan text, so injecting a number would change `source_hash` and
instantly make every vault mirror stale, so every `--execute` warns. The
number lives in a sidecar, `plan.issues.json`, which is why the plan file stays
byte-stable.

**The body goes on stdin, never on argv.** A 10 KB plan body on the command line
hits `ARG_MAX` and goes through the shell's quoting rules, so the bytes stop being
identical to the plan, which is the entire premise of the mirror. Every write uses
`--body-file -`.

**The issue state is derived from the plan's `status`, never chosen.**

| Plan `status` | Issue state | Why |
|---|---|---|
| `Draft`, `Approved`, `InProgress`, `Verification` | open | |
| `Blocked` | open | Blocked work is not done. Closing it would report finished work. |
| `Complete` | closed | |

A hand-closed issue does not win, because the issue is derived state. An
in-progress plan whose issue somebody closed by hand reopens it on the next sync,
so tidying a board never permanently detaches a plan from its mirror.

## The decision is pure, which is why it is tested without a network

`syncOne` resolves to exactly one of five actions, from `(recorded entry, plan
text, plan status)`:

| Action | Trigger | Effect |
|---|---|---|
| `create` | nothing recorded | one `gh issue create`, body on stdin |
| `update-body` | hash differs | one `gh issue edit` with title and body |
| `update-state` | open/closed differs | one `gh issue edit --state` |
| `update-and-state` | both differ | **one** edit call, not three |
| `current` | nothing differs | **zero** `gh` calls |

`current` is the real no-op and is reported as its own kind, so `--check` and
`--status` can tell "already current" from "dry run wrote nothing". Running the
sync twice performs no second write, which is what stops a duplicate issue from
appearing in a real repository.

```bash
bun run issue:sync <plan.md>...     # create or sync
bun run issue:check <plan.md>...     # drift report, never writes, exit 1 on drift
bun run issue:status                 # table of every recorded link, always exit 0
```

A project with no entry in `plan.issues.json` is **refused, not guessed**: a plan
filed under the wrong repository is worse than one that is not filed. A plan with
no `status:` in its frontmatter is refused too, because there is no state to
derive. A sync failure does not invalidate the plan; report the exit code, and do
not hand-create the issue as a workaround, because a hand-made issue carries no
trailer and so reads as permanent drift.

> `plan.issues.json` holds the `project -> owner/repo` mapping and **is** committed,
> because it is configuration. The recorded issue links it accumulates are live
> coordination state; point `PLAN_ISSUES_CONFIG` at a gitignored copy
> (`plan.issues.local.json`) on a machine that syncs plans, so twenty sessions
> writing one file cannot collide in version control.

Every repository's issue records share one store, `ISSUES_STORE` in
`scripts/plan-issue-sync.mjs`: the `plan.issues.json` at the root of the checkout
the script runs from, or the path in `PLAN_ISSUES_CONFIG`. A run from a vivera
worktree therefore uses that worktree's file unless the variable is set. Records
are keyed by the plan path relative to its repository, with no repository in the
key, so two repositories with a same-named plan land on one record. `syncOne`
refuses a record whose repository is not the one being synced, before any `gh` call
or write; rename the plan file to fix it. The merged gate (`pr-registry state <s>
merged`, through `checkCloseout`) reads the same store, decides "this repository"
with the same `resolveProjectRepo`, and reports such a record as `ISSUE_OTHER_REPO`.
