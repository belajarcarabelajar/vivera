---
name: vivera-overnight
description: Phase skill for vivera, unattended mode. Takes an already approved plan to a verified, registered pull request while the user is away, with an entry gate, hard stops, a retry budget, and a morning handoff file. Load only from vivera, after the plan is Approved, when the user says they are leaving ("overnight", "check back later", "tinggal tidur").
---

# Overnight Run

> Part of `vivera`. The orchestrating agent reads `vivera-rules` too; a subagent follows the Rules card of its role instead. This skill adds no new gate to the normal path. It only fixes what "unattended" means, so the rules already in `vivera-rules` (Unattended Continuation, Autonomous Completion Bias, Isolated Worktree, Draft PR) and `vivera-ship` (5.1 to 5.3) apply with nobody watching. The HARD GATE and every approval gate stay in the orchestrator.

The deliverable is a verified pull request that is waiting for a human. It is never a merge.

## 1. Entry gate (a human, before leaving)

Every line must hold. If one does not, STOP, name the line, and write nothing. Approval cannot be collected at 3 a.m., so a missing approval is a stop, not a guess.

| # | Check | How |
|---|---|---|
| 1 | The plan exists and says `status: Approved` | Read the plan file. `Draft` is a stop: run brainstorm and plan first. |
| 2 | The approved scope names the pull request as its deliverable | This is the standing inclusion that `vivera-rules` (Draft PR as Externally Visible Publication) requires. Unnamed means ask now, while awake. |
| 3 | `gh auth status` succeeds and `git fetch origin main` succeeds | 5.3: a token problem found after twenty commits is the worst place to find it. |
| 4 | The user's limits are recorded in the plan | Optional deadline ("no new chunk after 06:00"), paid services allowed, paths that are off limits, and `follow-ups: ask` when the owner wants to pick the debt-sweep follow-ups in the morning instead of having them run (section 5). Absent means none, and follow-ups run. |
| 5 | The harness runs at standard speed, or the plan's limits name its premium speed mode as an allowed paid service | Claude Code fast mode (`/fast`, `↯` beside the prompt) bills a higher per-token price (on a subscription, from usage credits even while plan usage remains) and by default stays on in later sessions. `fastMode: true` in the user settings is a hint; `/fast` shows the live state. Turning it off before leaving keeps the prompt cache. A harness with no speed mode passes this line. Sources: code.claude.com/docs/en/fast-mode and code.claude.com/docs/en/prompt-caching, read 2026-10-15. |
| 6 | Neither the plan nor the design approved for it says `Mode: test-later` | `vivera-tdd` 4.2 needs the owner's `Manual check` mid-run, so such a plan is a stop: finish it while the owner is present. |
| 7 | A fallback chain for overload or unavailable errors is configured: `fallbackModel` in the user settings, or the session was launched with `--fallback-model sonnet` | An unattended run dies on an overloaded-model error with nobody to retry. The chain also covers subagents (Claude Code v2.1.247 or later). It does not cover rate limits. Source: code.claude.com/docs/en/model-config, read 2026-11-08. |

Collect this gate while the user is present, as one question-tool call through the Confirmation Protocol (header `Overnight`, options `Start the overnight run (Recommended)` and `Not yet`) once the seven checks hold. The description of the `Start` option says that eligible debt-sweep follow-ups will run without a question (section 5), so the approval covers that class of work; nothing outside it. After the user leaves, nothing is asked: a mid-run decision follows the Unattended Continuation Rule (section 3).

When every line holds, the first file the run writes is the handoff (path in section 5) with `Result: running`, the start time as ISO 8601 with its UTC offset, and `Last update: <time> <checklist item>`. A run that dies (sleep, crash, or a usage limit the harness does not wait out) then leaves a record on disk instead of nothing. A failed check still writes nothing.

Right after the handoff, write the overnight marker: `mkdir -p ~/.local/state/vivera-overnight && printf 'plan=%s\nhandoff=%s\n' <plan-id> <handoff-path> > ~/.local/state/vivera-overnight/$CLAUDE_CODE_SESSION_ID`. While it exists, the user-scope hook `scripts/hooks/overnight-notify.mjs` sends one Telegram line when this session's turn ends on an API error (`StopFailure`) or a usage-limit wait resumes, goes stale, or is abandoned; any other session stays silent.

A usage limit is not always a death. Claude Code v2.1.234 or later, signed in with a claude.ai subscription, waits in the open interactive session and continues the task after the reset (`autoContinueAtUsageLimit`, default `true`, read from user or managed settings; a project settings file that sets it turns it off). It does not wait in `-p` runs, in Remote Control sessions, or for a reset more than 24 hours away, and after a host sleep longer than about 30 minutes it waits for Enter. So the host must stay awake through a reset window that can last hours, and a handoff whose `Last update` stopped moving may belong to a waiting session. Source: code.claude.com/docs/en/interactive-mode and settings-reference, read 2026-11-08; no overnight run here has hit the wait yet.

## 2. What the run may and may not do

| Runs without a human | Always waits for a human |
|---|---|
| Claim the slot (`pr-registry claim`), create the worktree, fan out subagents inside it | Merging into the base branch, including auto-merge |
| TDD, local verification, parent diff audit | Force push or force-with-lease, on any branch |
| Parent-only commits on the session branch, plain push of that branch (once it has a PR, the base comes in by merge, never by rebase) | Deploy, publish, release, or any change to a live system (a plan's terminal task, marked `(terminal)`, is parked under `Waiting on a human` after the sweep: `vivera-sweep` reference 06) |
| `gh pr create --body-file`, then `pr-registry pr` | Anything outside the repo and its session worktree, including promoting a rule to a global file |
| Plan checklist, debt sweep with its eligible follow-ups (section 5), learning harvest, graph sync | Widening scope beyond the plan and its eligible follow-ups, or deleting state the session did not create |
| | Paid or metered services the plan does not name |

## 3. Decisions with nobody to ask

- The Unattended Continuation Rule applies word for word: take the most reasonable reading, state it in one line, continue.
- Every such decision is one line in the handoff under `Decisions`: the reading taken and the alternative rejected, so the morning review can overturn it cheaply.
- A decision that is irreversible and could go either way is not made. Do all the preparation, write the question and the recommended answer under `Waiting on a human`, park that chunk, and keep working on the independent ones.
- No question mid-run or at the close. The debt sweep's eligible follow-ups run without one (section 5); only a plan whose limits say `follow-ups: ask` keeps the sweep question as the last act.

## 4. Retry budget and stops

- A red chunk is re-chunked and re-dispatched alone, at most **2 attempts**, and the second must differ from the first. A third failure marks the chunk `blocked` in the handoff with the failing command and its exit code. The other chunks continue.
- When the telegram-ask bridge is installed, a chunk marked `blocked` also sends a one-line notice: `bun ~/vivera/mods/telegram-ask/bridge/notify.ts "<plan-id>: chunk <id> blocked"`. It exits 0 even with no bridge, so it never fails the run.
- The same failure signature in two different chunks means a shared cause. Stop dispatching new chunks and investigate the contract and the shared input before touching more code.
- Never turn a red result green by weakening the check: no skipped or deleted test, no loosened assertion, no `--no-verify`, no gate edited to pass. Unattended runs make this the most tempting shortcut, so it is stated here.
- A deadline recorded at the entry gate stops new dispatch. Chunks already in flight finish.
- **A text-only end of turn with open checklist items is a report.** Before ending a turn with no tool call, read the plan checklist. If an item is still `[ ]` and no blocker is written for it, the turn does not end: take the next item in the same message. Four endings are refused while work is owed: (1) a long summary that closes by announcing the next step, with no tool call, so the step never starts; (2) an offer to carry on unless the user would prefer otherwise, which waits for an answer nobody will give; (3) a list of decisions for the user when, by the run's own account, none of them blocks the remaining work (those go under `Waiting on a human`, section 3); (4) deciding this is a good place to report because the turn is long or a milestone is done. A status note goes in the same message as the next tool call. The stops that are valid are the ones where nothing can move without a human, a deadline recorded at the entry gate (above), a `budget_limited` wrap-up (`vivera-rules`, Goal Continuation), or a blocker deliberately protected from the run. This does not relax the table in section 2.
- **Anything still running is not done.** A background command, a pending subagent, or a local job started in this run keeps its checklist item open. Wait for it and read its output before the item counts.
- **The handoff is the run record.** After each checklist item turns `[x]` or a chunk is marked `blocked`, rewrite the handoff's `Last update` line and add the matching Evidence or Blocked row. Provenance: this follows the run record in "Building effective agent automations" (claude.dev, published 2026-10-08, read 2026-10-10). No overnight run here has died mid-run on record yet; tighten or delete this after the first handoff that shows one.
- **Automatic continuations are capped.** When a harness or hook re-prompts the run on the same task with items still open, stop after the third re-prompt that adds no new evidence. Mark the task `blocked` in the handoff with what each attempt changed, so a run that is genuinely stuck ends where a human can review it.
- Provenance: this rule comes from published prompting guidance for one model family (Opus 5.5, read 2026-10-10), reworded to hold for any model. No incident in this repository has measured it. Keep it, tighten it, or delete it after the first overnight handoff that shows an early stop or a clean run without one.
- Work that never reaches `verified` gets **no pull request**. The registry refuses to record a PR before `verified`, and an unregistered PR is invisible to the merge order. Leave the committed branch and worktree intact and say so in the handoff.

## 5. Close

1. `verified`, then the PR from `templates/pull-request-template.md`, then `pr-registry pr <session> --number <N>`. When the telegram-ask bridge is installed, send `bun ~/vivera/mods/telegram-ask/bridge/notify.ts "<plan-id>: PR #<n> opened"`; it never fails the run.
2. Finish the handoff started at the entry gate, as a sibling of the plan (never inside it, plans stay small): `<plan-dir>/<plan-id>-overnight-handoff.md`. Add the PR to the result line but keep the word `running` first (`Result: running, PR #<n> opened, follow-ups in progress`), and write `Follow-ups: running` under `Waiting on a human`, so the record is complete before the sweep starts and `plan-status` still flags a run that dies during the follow-ups. Keep the overnight marker until step 4 ends, so a run that dies during the follow-ups still sends its notice.
3. Run the debt sweep (`vivera-sweep`) with one change: **every eligible follow-up executes without a question**. The owner approved this class at the entry gate, so nothing is asked at the close either.
   - **Eligible** means all of these hold: the candidate has a path and a checkable finish line (6.2); it stays inside the repository and the session branch; it can be undone with `git revert`; the repository's targeted gate can verify it on this machine; and it is none of: destructive, externally visible (deploy, publish, a message or comment), credential-touching, a paid or metered service the plan does not name, a write to a global file or a live system, work the repository's rules reserve for the owner (for example an opt-in test layer), or a choice between alternatives that could go either way. The NOW or LATER class (6.3) does not decide eligibility: a LATER item whose `defer:` only says "not now" is eligible, one whose trigger is a human decision, an external dependency, or a live check is not.
   - Eligible follow-ups run in rank order, one round, as real work (`vivera-sweep` 6.5): a numbered follow-up task in the plan, TDD, the retry budget of section 4, and its own commit, so the morning undo is one `git revert`. A follow-up still red after its two attempts leaves no commit behind (revert what it committed) and is marked `blocked` in the handoff, so the PR head stays green. The deadline stops new follow-ups.
   - After the batch: the re-pass sends new candidates to the backlog, the targeted gate runs again with its exit code in `Evidence`, the branch gets a plain push, and the PR body and the handoff list each follow-up with its commit and evidence.
   - An ineligible candidate goes to the plan backlog with its `defer: <ceiling>, <upgrade-trigger>` marker and under `Waiting on a human` with a recommended answer.
   - With `follow-ups: ask` in the plan limits, the old path holds: the multi-select question is the last act of the run, asked only when the harness has an interactive client; with no question tool, no client, or no answer, every follow-up goes to the backlog and the final message lists them as a numbered list.
4. An unattended run never flips the plan to `Complete` by itself. First tick from evidence (`vivera-sweep`, 6.5.5 item 1): `bun scripts/ultra-plan-runner.mjs <plan.md> --execute > runner.log`, then `bun scripts/plan-mark-done.mjs <plan.md> --from runner.log`, because an overnight run executes through subagents and has no runner log otherwise. The ticks are reversible edits backed by the log, so they need no question. Then run `bun scripts/plan-closeout.mjs --readiness <plan.md>` and park the `Close plan` decision (`vivera-sweep`, 6.5.5) under `Waiting on a human` in the handoff with the verdict and the open items. The plan keeps its status, with a `## Closeout status` section that says `pending`. Last, replace `Result: running` with the final result and remove the overnight marker (`bun ~/vivera/scripts/hooks/overnight-notify.mjs --clear $CLAUDE_CODE_SESSION_ID`; a plain `rm` there is refused by the owner's `rm-tmp-guard` hook). A run that dies cannot remove it; the handoff names it under `Waiting on a human` (table below).

| Handoff section | Content |
|---|---|
| Result | PR URL and number, session state, branch, worktree path. Or "no PR" with the reason. A handoff that still says `running` with no live process means the run died; its `Last update` names the last finished item |
| Evidence | Each verification command and its exit code |
| Decisions | One line each, from section 3 |
| Blocked | Chunk, failing command, exit code, attempts used |
| Waiting on a human | The merge, the follow-ups parked as ineligible with a recommended answer (with `follow-ups: ask`, the sweep question or the backlog location instead), the `Close plan` decision with its readiness verdict, any parked decision with a recommended answer; from the entry gate until the close removes it, the overnight marker path, so a morning session removes a marker a dead run left |
| Undo | Close the PR, `pr-registry state <session> closed`, remove the worktree, delete the session branch |

The first line of the final message is the PR URL, or the word `none` and why.

### Resuming a died run

A handoff that still says `Result: running` with no live process is a stale handoff: `plan-status` flags it `stale` once `Last update` is older than two hours.

0. Confirm no session still owns the run: `stale` fires after two hours, and a session waiting for a usage-limit reset (section 1) writes nothing for longer. A live `claude` process whose cwd is the session worktree means wait for it; never start a second run beside it.
1. Run `bun ~/vivera/scripts/plan-status.mjs <plan.md>` and trust its computed block (task steps, current task, open gates, `stale`) over any summary. Read `Last update`: it names the last finished item.
2. Re-run the runner on the plan. Steps already done report `SKIPPED-IDEMPOTENT`.
3. Never re-dispatch an item already `[x]`; continue from the current task.
4. Rewrite the handoff's `Last update` and add a `Decisions` line saying the run was resumed and from where.
