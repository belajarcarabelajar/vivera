### Why a PR and not a commit
Three failure modes appear the moment more than one session touches one repository, and none of them raises an error at the git level, because each individual command is valid:

| Failure | What actually happens | Where it is prevented |
|---|---|---|
| Two sessions on one branch | The second push fast-forwards or is rejected; the agent reaches for `--force` and the first session's PR now carries the second session's commits | Derived branch names, refused at claim time |
| Two sessions in one worktree | `git worktree add` fails, or the second session works inside the first session's checkout and both diffs become garbage | Derived worktree paths, refused at claim time and at load time |
| Merging in finish order | A session that depends on another lands first, then conflicts with the rest of the batch | Topological merge order from a recorded `depends_on` graph |

So the naming is computed rather than chosen, and the order is computed rather than remembered.

**The delivery path**, one command per step:
1. `bun run plan:check <plan.md>` (runner validation)
2. `bun run plan:sync <plan.md>` at `Approved`
3. `bun scripts/pr-registry.mjs claim --plan <plan-id> --session <s> --worktree`
4. `bun run ci:targeted`
5. `bun scripts/pr-registry.mjs state <s> verified`
6. `bun scripts/pr-registry.mjs open <s> --title "<t>" --body-file <f>` (pushes the branch first)
7. `bun scripts/plan-closeout.mjs --readiness <plan.md>`
8. `bun run plan:sync <plan.md>` at `Complete`
9. `gh pr merge <N> --merge --match-head-commit <sha>`
10. `bun scripts/pr-registry.mjs reconcile`

### 5.1 Isolation, before any subagent is dispatched
```bash
# One claim per session. It derives the branch and worktree path, then runs
# git worktree prune, git fetch origin <base>, git worktree add.
bun scripts/pr-registry.mjs claim --plan <plan-id> --session <session-slug> --worktree \
  [--repo <repo-root>] [--depends-on <slug>,<slug>]
```

- The branch is exactly `<plan-id>/<session-slug>`, and carries **no tool, vendor, or workflow prefix**. A branch name is permanent, public history, so a prefix is an authorship claim nobody can redact (the attribution-footer defect, see the copy rule); the plan id already dates and describes the work. Slots claimed with the old `ai/` prefix keep it.
- The claim is **idempotent**. A retried claim after a crashed session returns the same slot instead of allocating a second one, because the names are a pure function of the two inputs; `--worktree` skips a worktree already on the branch, and a failed git step exits 1 with git's stderr.
- `--depends-on` is only accepted for sessions that already hold a slot. An unclaimable dependency would make the merge order unprovable, so it is refused at claim time rather than discovered at merge time.
- Every subagent's working directory is that worktree. Nothing is dispatched before it exists.
- The parent dispatches with the worktree path in the contract, so a subagent cannot resolve a relative path against the main checkout.

### 5.2 The session state machine
`pr-registry.mjs` holds the session state, and the states exist to make two specific mistakes impossible:

```
isolated → active → verified → open → merged
                                    ↘ closed
```

| State | Meaning | How it is reached |
|---|---|---|
| `isolated` | Branch and worktree exist, nothing written | `claim` |
| `active` | Subagents are writing inside the worktree | `state <s> active` |
| `verified` | Local evidence is green, parent diff audit passed | `state <s> verified` |
| `open` | The PR exists on the remote | `open <s> --title "<t>" --body-file <f>` (a hand-opened PR: `pr <s> --number <N>`) |
| `merged` | The PR reached the base branch | `reconcile`, or `state <s> merged`, which records it and prints the closeout verdict as a warning, never a refusal |
| `closed` | The PR was closed without merging (superseded, abandoned, or its change landed by another path) | `reconcile`, or `state <s> closed` |

- **A PR number cannot be recorded before `verified`.** `setPr` throws otherwise. Recording a PR implies the work is finished and checked, so `isolated → open` would skip the gate that makes a merge safe.
- **Only an `open` session can merge**, and only if it has a PR number. A green local run is not a mergeable session; a mergeable session is a green local run *and* a PR.
- **`state <s> merged` reports the close-out; it does not gate it.** It reads the plan file and the `plan.issues.json` record, prints a `warning:` per gap (plan not `Complete`, issue not closed or not re-synced), and records the merge: GitHub already merged it, so a refusal would only leave the registry wrong. `claim` records the session's repository (absolute path), and `state merged` reads the plan from `--repo` when given, else from that recorded repository, else from this repository, so a session of another repository is checked against its own plan. Each gap names its fix. The plan flips to `Complete` at the `Close plan` gate (6.5.5), before the merge, so this warning means a closing step was skipped. A missing plan file, a missing `plan.issues.json`, or a plan with no issue record is reported as skipped, not as a pass; a missing plan file for a session with no recorded repository is a `warning:` that names `--repo`. The check reads the last sync's record, not live GitHub.
- **`reconcile` records what GitHub says.** For each unfinished session with a PR it reads `gh pr view` and records `merged` or `closed` with GitHub's timestamp; a head-branch mismatch, an underivable repository, or a failed read is skipped by name (exit 1). PR-less sessions older than `--stale-days` (default 7) are listed; `--close-stale` closes them. `--dry-run` writes nothing.
- **`merged` and `closed` are terminal.** Reverting or redoing a session is a new session with a new branch, never a state edit. Letting the registry file "un-merge" would hide a revert from the merge order.
- **A `closed` session is finished but did not move the base.** Unlike `merged` it is not a rebase reason, so `surface` never lists it as landed; unlike an unmerged `open` session it satisfies a dependency, so `order` does not make a dependent wait on a PR that will never land.
- **Recording a PR moves `verified → open` automatically.** A PR that exists while the session is still `isolated` is a state contradiction, so the tool refuses to represent it.

### 5.3 Opening the PR
Follow `templates/pull-request-template.md` for the body.

- **Write the body to a file, post with `--body-file`.** Multi-line markdown in `--body` breaks on newlines, backticks, quoting, and checkbox markers.
- **The body is in the codebase's language, not the language the request arrived in** (see Artifact Language Follows the Codebase). A translated PR body breaks `grep` for the next reviewer.
- **No em dash anywhere in the body, the commit messages, or user-visible strings in the diff** (see the copy rule). This scan blocks the PR, not just the session.
- **No attribution footer, watermark, badge, or co-author line** (see the copy rule for the full statement and the measured case). An unrequested credit line is a defect even when it names the right tool, because it sets a house style nobody agreed to, and the tool it names is frequently wrong. Append one only when the user names the exact text.
- **The body carries before and after evidence and the door call.** The failing run or screenshot from before the change sits next to the passing one after it, and the risk table says whether the change is a one-way door (hard to undo once merged) or a two-way door (a revert undoes it).
- Title is imperative and names the outcome, not the mechanism. `fix: null deref in retry loop`, not `update retry code`.
- **A fix for code already on the base branch names its origin.** The fix commit carries a `Fixes: #<PR>` trailer naming the PR that introduced the defect, when that PR is known. `bun run metrics` counts these trailers on `origin/main` as escapes, defects that got past review, so a missing trailer hides one from the count.
- Draft (`--draft`) when the session is genuinely incomplete. A draft is not a smaller completion claim; it is an honest one. Never leave a session draft when its evidence is green, because a draft that nobody un-drafts is a session that silently never lands.
- Open and record in one step with `open` (below): it refuses unless the session is `verified`, pushes the branch, runs `gh pr create`, and records the number. A PR that exists but is not in the registry is invisible to the merge order, which means it never gets merged.
- **Run `gh auth status` once at session start, not at PR time.** A missing token found after twenty commits costs far more than one found before the first.

```bash
bun scripts/pr-registry.mjs open <session> \
  --title "<imperative title>" \
  --body-file <path-to-pr-body.md> [--draft]
```

### 5.4 Reviewing a PR
Use `templates/pr-review-template.md` for the report. Two things make it deterministic rather than a matter of reviewer taste:

**Every input is fetched and recorded before any judgement.** Metadata, diff, commits, existing review comments, prior verdicts, and CI status. A row marked "not consulted" with a reason is honest; a row left blank is indistinguishable from a row that was checked and found clean, and it reads as the latter.

**Remote CI status is reported, never adopted.** Checks run locally by policy, so a green remote run is the author's evidence about a commit, not this reviewer's evidence; adopting it is the same error as pushing to trigger someone else's runner.

**Line anchoring is part of the finding, not formatting.** A comment anchored to a line the PR did not touch either fails to post or degrades into a general remark that looks specific. Every finding names a changed line and the correct side.

**The verdict is binary and derived.** `not correct` if and only if there is at least one blocking (`P0`/`P1`) finding. No third state, no "looks good overall". A verdict names the specific checkable condition that would change it, because "after the author addresses comments" is not a condition.
