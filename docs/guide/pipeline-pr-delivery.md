# Pull Request Delivery & Batch Merge

A session ends in a pull request on its own branch, never in a commit on the working
branch. That is what makes running twenty or more sessions at once survivable, and the
reason is mechanical: when more than one session touches one repository, three failures
appear, and **none of them raises an error at the git level**, because each individual
command is valid on its own.

| Failure | What actually happens | Prevented by |
|---|---|---|
| Two sessions on one branch | The second push fast-forwards or is rejected, the agent reaches for `--force`, and the first session's PR now carries the second session's commits | Branch names **derived** by `pr-registry claim`, duplicate refused at claim, load, and save time |
| Two sessions in one worktree | `git worktree add` fails, or the second session works inside the first session's checkout and both diffs become garbage | Worktree paths derived the same way, and the worktree sits *beside* the repository, never inside it |
| Merging in finish order | A session that depends on another lands first, then conflicts with the rest of the batch | Topological order computed from a recorded `depends_on` graph, ties broken on name so the order is reproducible |

## Two ownership rules that make concurrency safe

**Git writes are parent-only.** A subagent edits files and runs tests. It never runs
`git commit`, `git add`, `git checkout`, `git switch`, `git merge`, `git rebase`,
`git stash`, `git reset`, `git push`, or `gh`. The git index is shared mutable state
with no per-writer lock, so two subagents staging at once produce a commit containing a
half-applied change from the other, and that commit was never tested in that shape. The
parent integrates per chunk by reading `git diff -- <permitted paths>` and staging by
explicit path, never `git add .`.

**One session, one PR.** Twenty subagents inside one session are one PR. Twenty sessions
are twenty PRs. One PR per subagent turns a twenty-session run into a two-hundred-PR
merge queue.

## The session state machine

`pr-registry.mjs` holds the state, and the states exist to make two specific mistakes
impossible:

```
isolated → active → verified → open → merged
                                    ↘ closed
```

| Constraint | Why it is a hard error |
|---|---|
| A PR number cannot be recorded before `verified` | Recording one implies the work is finished and checked, so `isolated → open` would skip the gate that makes a merge safe |
| Only an `open` session with a PR can merge | A green local run alone is not a mergeable session |
| `merged` and `closed` are terminal | Reverting or redoing a session is a new session with a new branch. A file that can "un-merge" hides the revert from the merge order |
| A closed session did not move the base | `merged` is a reason to update the branch because it advanced `origin/main`; `closed` is not, so `surface` never lists it as landed, while `order` still treats it as a satisfied dependency |
| A duplicate branch or worktree is refused | A registry that reports success for a layout that will lose work is worse than no registry |

```bash
bun scripts/pr-registry.mjs claim --plan <plan-id> --session <slug> --worktree [--depends-on <slug>,<slug>]
bun scripts/pr-registry.mjs state <session> <isolated|active|verified|open|merged|closed>
bun scripts/pr-registry.mjs state <session> merged [--repo <path>]
bun scripts/pr-registry.mjs open <session> --title "<t>" --body-file <f> [--draft]
bun scripts/pr-registry.mjs pr <session> --number 42   # a PR opened by hand
bun scripts/pr-registry.mjs reconcile [--dry-run] [--stale-days N] [--close-stale]
bun scripts/pr-registry.mjs order       # topological merge order
bun scripts/pr-registry.mjs surface w3  # what must land in the branch first, what blocks it
bun scripts/pr-registry.mjs status
```

`claim --worktree` runs `git worktree prune`, `fetch` and `worktree add` itself, and is
idempotent: a retried claim after a crashed session returns the same slot. `open` refuses
a session that is not `verified`, pushes the branch, runs `gh pr create`, and records the number. `state <s>
merged` never refuses over the plan: it prints close-out gaps as warnings and records the
merge. `reconcile` records `merged` or `closed` from `gh pr view`, skips by name what it
cannot read or match, and closes PR-less stale sessions only with `--close-stale`.

The derived branch is `<plan-id>/<session-slug>`, with no tool or workflow prefix. There
used to be an `ai/` prefix, and it was removed on the same reasoning as the
attribution-footer rule below: a branch name is permanent, publicly readable
history, so a prefix asserts an authorship in the one artifact nobody can redact
afterwards. The plan id already dates and describes the work. A slot claimed
before the change keeps the branch it claimed, so there is no migration and no
rename to undo.
`pr.registry.json` is **gitignored** on purpose. It is per-machine live state recording
which branch each running session holds right now; committing it would merge twenty
machines' in-flight sessions into one file and guarantee a conflict on the next claim.

## Merging twenty PRs

One at a time, in the order `order` prints, and each merge carries its own evidence:

1. Merge `origin/main` into that session's branch **immediately before its own merge**.
   It is a merge, not a rebase: the branch already has a PR, and a rebase would need the
   force push this stage forbids. The base moves with every merge, so a branch updated at
   position 3 is already behind by position 7. `surface <s>` reports which sessions landed since the branch was cut.
2. Resolve any conflict **in the session's branch**, never on the base branch, then
   re-run that session's verification. Editing the base to "fix" a conflict produces a
   change no session can attribute or review.
3. Merge this one PR.
4. Re-run the local check on the new base. That run is the evidence for *that* merge.

Batching twenty merges and testing at the end leaves nineteen of them unverified. A
session that cannot be made mergeable is reported and skipped while the batch proceeds;
it is a status, not a reason to freeze nineteen others. Already-merged sessions drop out
of the order and stop blocking their dependents, and a dependency cycle is refused with
the cycle named, because no valid order exists for one.

## Two boundaries this stage does not cross

**Remote CI is reported, never adopted.** This repository's checks run locally by policy,
so a green GitHub Actions run is the author's evidence about a commit, not this session's
evidence about the working tree. Reading it as verification is the same error as pushing
to trigger someone else's runner.

**Generating a review and posting it are two acts.** The posted comment is a shorter
artifact than the internal report: verdict, blocking findings, nothing else. A human
reads the exact text first. See [`templates/pr-review-template.md`](../../templates/pr-review-template.md)
for the coverage table, the line-anchoring rule, and the binary verdict.
