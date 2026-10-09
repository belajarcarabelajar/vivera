---
name: sucp-overnight
description: Phase skill for super-ultra-code-plan, unattended mode. Takes an already approved plan to a verified, registered pull request while the user is away, with an entry gate, hard stops, a retry budget, and a morning handoff file. Load only from super-ultra-code-plan, after the plan is Approved, when the user says they are leaving ("overnight", "check back later", "tinggal tidur").
---

# Overnight Run

> Part of `super-ultra-code-plan`. Read `sucp-rules` too. This skill adds no new gate to the normal path. It only fixes what "unattended" means, so the rules already in `sucp-rules` (Unattended Continuation, Autonomous Completion Bias, Isolated Worktree, Draft PR) and `sucp-verify-deliver` (5.1 to 5.3) apply with nobody watching. The HARD GATE and every approval gate stay in the orchestrator.

The deliverable is a verified pull request that is waiting for a human. It is never a merge.

## 1. Entry gate (a human, before leaving)

Every line must hold. If one does not, STOP, name the line, and write nothing. Approval cannot be collected at 3 a.m., so a missing approval is a stop, not a guess.

| # | Check | How |
|---|---|---|
| 1 | The plan exists and says `status: Approved` | Read the plan file. `Draft` is a stop: run brainstorm and plan first. |
| 2 | The approved scope names the pull request as its deliverable | This is the standing inclusion that `sucp-rules` (Draft PR as Externally Visible Publication) requires. Unnamed means ask now, while awake. |
| 3 | `gh auth status` succeeds and `git fetch origin main` succeeds | 5.3: a token problem found after twenty commits is the worst place to find it. |
| 4 | The user's limits are recorded in the plan | Optional deadline ("no new chunk after 06:00"), paid services allowed, paths that are off limits. Absent means none. |

## 2. What the run may and may not do

| Runs without a human | Always waits for a human |
|---|---|
| Claim the slot (`pr-registry claim`), create the worktree, fan out subagents inside it | Merging into the base branch, including auto-merge |
| TDD, local verification, parent diff audit | Force push or force-with-lease, on any branch |
| Parent-only commits on the session branch, push of that branch (rebase-and-push only) | Deploy, publish, release, or any change to a live system |
| `gh pr create --body-file`, then `pr-registry pr` | Anything outside the repo and its session worktree, including promoting a rule to a global file |
| Plan checklist, debt sweep, learning harvest, graph sync | Widening scope, or deleting state the session did not create |
| | Paid or metered services the plan does not name |

## 3. Decisions with nobody to ask

- The Unattended Continuation Rule applies word for word: take the most reasonable reading, state it in one line, continue.
- Every such decision is one line in the handoff under `Decisions`: the reading taken and the alternative rejected, so the morning review can overturn it cheaply.
- A decision that is irreversible and could go either way is not made. Do all the preparation, write the question and the recommended answer under `Waiting on a human`, park that chunk, and keep working on the independent ones.
- No blocking question mid-run. The only question this run asks is the debt sweep's, and it is the last act (section 5).

## 4. Retry budget and stops

- A red chunk is re-chunked and re-dispatched alone, at most **2 attempts**, and the second must differ from the first. A third failure marks the chunk `blocked` in the handoff with the failing command and its exit code. The other chunks continue.
- The same failure signature in two different chunks means a shared cause. Stop dispatching new chunks and investigate the contract and the shared input before touching more code.
- Never turn a red result green by weakening the check: no skipped or deleted test, no loosened assertion, no `--no-verify`, no gate edited to pass. Unattended runs make this the most tempting shortcut, so it is stated here.
- A deadline recorded at the entry gate stops new dispatch. Chunks already in flight finish.
- Work that never reaches `verified` gets **no pull request**. The registry refuses to record a PR before `verified`, and an unregistered PR is invisible to the merge order. Leave the committed branch and worktree intact and say so in the handoff.

## 5. Close

1. `verified`, then the PR from `templates/pull-request-template.md`, then `pr-registry pr <session> --number <N>`.
2. Run the debt sweep (`sucp-debt-sweep`) as usual, with one change: **no follow-up executes unselected**. The multi-select question is the last act of the run. If no structured question tool exists or no answer arrives, every follow-up goes to the plan backlog with its `defer: <ceiling>, <upgrade-trigger>` marker. That is the sweep's own degrade path, so the session is complete either way.
3. Write the handoff as a sibling of the plan (never inside it, plans stay small): `<plan-dir>/<plan-id>-overnight-handoff.md`.

| Handoff section | Content |
|---|---|
| Result | PR URL and number, session state, branch, worktree path. Or "no PR" with the reason |
| Evidence | Each verification command and its exit code |
| Decisions | One line each, from section 3 |
| Blocked | Chunk, failing command, exit code, attempts used |
| Waiting on a human | The merge, the sweep question, any parked decision with a recommended answer |
| Undo | Close the PR, `pr-registry state <session> closed`, remove the worktree, delete the session branch |

The first line of the final message is the PR URL, or the word `none` and why.
