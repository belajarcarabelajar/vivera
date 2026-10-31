---
name: sucp-debt-sweep
description: Phase skill for super-ultra-code-plan Step 6 (session-close debt sweep and follow-up injection, plus the learning harvest and graphify sync). Load only from super-ultra-code-plan, after the plan is Done 100% and the evidence gate is green.
---

# Session-Close Debt Sweep

> Part of `super-ultra-code-plan`. The orchestrating agent reads `sucp-rules` too; a subagent follows the Rules card of its role instead.

## 📚 Load on demand

The core rules in this file are always loaded; a reference file is read in full whenever its trigger below applies.

| Reference | Read it |
|---|---|
| [01-learning-harvest.md](references/01-learning-harvest.md) | Before the 6.2.8 learning harvest: the ledger, the two gates, mechanical versus judgement rules, and environment improvements. |
| [02-rank-and-execute.md](references/02-rank-and-execute.md) | Before ranking candidates (6.3) or executing selected follow-ups (6.5). |
| [03-graphify-sync.md](references/03-graphify-sync.md) | Before the 6.6 graphify sync, or when a sync reports no eligible docs. |
| [04-stars-anti-patterns.md](references/04-stars-anti-patterns.md) | Before drawing the progress-star meter, or when self-checking the sweep against its anti-patterns and flow diagram. |

## 6️⃣ 🧹 Session-Close Debt Sweep & Follow-Up Injection (Mandatory)
> 🧹 **Closing stage — zero-debt session:** once the plan is `Done 100%` and the evidence gate is green, the agent mines everything it learned during planning and execution, turns it into a short list of concrete follow-ups that can be finished right now, and asks the user to pick them with a single tap. Reporting alone is a failed close: the deliverable of this stage is a question the user answers with a checkbox, not a paragraph they must retype.

```
A SESSION ENDS WITH ZERO UNEXAMINED CODING DEBT
```

### 🧾 6.1 Preconditions — the plan must be finished first
- The approved plan is `Done 100%` per the Plan Completion Saturation Rule. Every task carries fresh evidence; nothing sits at "mostly done". The sweep is the step *after* a finished plan, never a substitute for finishing it.
- The Verification gate passed with fresh evidence, git hygiene is done, and the final diff has been audited. Starting the sweep on unverified work converts a completion claim into a bigger unverified claim.
- The session's pull request exists and its number is recorded in the registry (`bun scripts/pr-registry.mjs pr <session> --number <N>`). A follow-up selected in the sweep is a new chunk of work on the same branch, so an unrecorded PR means the follow-up work has nowhere to land.
- Anything that is genuinely `Blocked` by an external dependency is excluded from follow-up candidates and instead reported with the exact unblock condition. A blocked item is not a follow-up question; asking the user to "also fix" it is noise.
- Order of the close: the sweep (6.2 to 6.5) with the plan closeout question (6.5.5) asked in the same call as the follow-ups, then the graphify sync (6.6). The plan reaches `Complete` only through 6.5.5.

### 🔍 6.2 Harvest — collect debt candidates from the whole session
Sweep the session record, not just the last command, for anything that was noticed but not closed. Candidate sources, in priority order:
1. Recorded `defer:` deliberate shortcuts whose `<ceiling>` has actually been hit, so the debt the plan promised to revisit is now due. Find the markers with `git grep -nE '(#|//|/[*]) ?defer:'`, run from the session repository, whether that is vivera or any other repository; the comment prefix keeps prose mentions of the marker (documentation, skill text) out of the list. Each hit is a marker to evaluate, and it becomes a candidate when its ceiling has been hit or when it has no upgrade trigger. A marker with no comma, so no trigger after the ceiling, is tagged `no-trigger` (a comma is only a text proxy for a trigger, so read the text after it) and is a candidate by itself, because it names nothing that would ever make it due. Report `<N> markers, <M> with no trigger.`, and state a result of zero markers together with one line proving the command finds a known marker (for example the markers in `scripts/validate-agents.mjs`), because "nothing found" holds only when the method could have found something.
2. Findings deferred to follow-up by the code review, the review's Design Notes (non-blocking smells, which are not findings but are still debt candidates), the Zero-Tolerance Clean Pass pre-existing warnings, or the Simplicity Ladder pruning pass.
3. Adjacent code, sibling callers, or sibling files the fix touched only partially. Comprehension-before-reduction exposes these; leaving them unlisted is choosing debt. **Anything already named in a task's `impacts` and still open at sweep time is a debt item by definition**: the impact was declared, so failing to close it is a decision, not an oversight. The same holds for peers the Same-Class Sweep (`sucp-rules`) found in the container of an element the user flagged and that are still unchanged.
4. Missing test layers on the changed surface (no unit test, no contract test; a missing browser e2e is not debt, since e2e is off by owner decision 2026-10-29), missing accessibility/localization/empty/error states, missing docs or changelog or runbook entries.
5. TODO/FIXME/XXX/HACK comments, skipped or quarantined tests, `@ts-ignore`/`eslint-disable`/`.skip`/`.only` markers, dead code, stale feature flags, duplicate helpers, and orphaned files that the diff revealed.
6. Pre-existing lint/type/build warnings, flaky tests, unmeasured performance risk, unverified dependency or license assumptions, and security or compatibility observations that were out of scope for the plan.
7. Verification gaps themselves: claims resting on partial evidence, checks that could not run in this environment, or reviewers' findings that were accepted verbally without a code change.

Every candidate must be stated as an outcome with a file path and a checkable finish line, not as a topic. "Refactor the auth module" is not a candidate. "Extract token refresh out of session.ts:88-140 and cover it with a new session.test.ts case" is.

### 🧠 6.2.8 Learning Harvest — the agent's own mistakes, not just code debt

The ledger, the two gates, and the rule classification: [references/01-learning-harvest.md](references/01-learning-harvest.md).

- `KEEP` rules are written in-repo automatically. In a repository that keeps `docs/memory/` (as vivera does), each becomes a new row, with the next free ID (one above the highest there), in its topic file there, and its ID is added to that topic's row in the `MEMORY.md` index; in any other repository it is appended under a `Task Group:` header in `MEMORY.md`. A rule that recurs across projects on this machine may additionally be promoted to `~/AGENTS.md`, but global promotion is **per-item and requires explicit user approval**: each item is asked through the Confirmation Protocol (header `Promote`, first option `Keep in the repository only`). Promotion is never destructive or credential-touching, and always writes a revert note inside the edited file. Decline leaves the rule in the ledger only.

### 🧮 6.3 Rank & Cap — default 3 to 5 questions

Ranking, the question cap, and NOW versus LATER: [references/02-rank-and-execute.md](references/02-rank-and-execute.md).

- Banned from the batch: anything destructive, externally visible, credential-touching, or scope-expanding. Each such item is asked on its own, outside the sweep call, through the Confirmation Protocol with the safe option first, never as a quick-select chip.

### 🙋 6.4 Inject — ask, do not narrate (mandatory)
> Record the sweep with `templates/follow-up-injection-template.md` (candidates, ranking, the question, the execution record, the deferred backlog).
- Use the harness's own structured question mechanism. Find it through the tool table in the Confirmation Protocol and read its schema before the first call. Present the follow-ups as **multi-select checkboxes** so the user answers by tapping, never by typing.
- Batch every follow-up into **one single question-set call**, never one call per item, and place it after the final recap so the user first sees what was delivered, then decides what to finish.
- The Follow-ups and Close plan questions are asked in one call: at most three multi-select groups plus the `Close plan` question (6.5.5 steps 1 to 4 run first, so its verdict is in the chat). Its answer applies after the selected follow-ups land; if a selected follow-up fails, the plan stays open.
- Each option carries a short label plus a one-line description naming the file or surface it touches and the check that proves it closed. Label the first option of each question as the recommended default where one exists.
- The description of the recommended option begins with `Why:` and the ranking factor that put it first (leftover risk, blast radius, or cheapness to close), and says `Why: my judgment` when the ranking was not measured. The usual one line naming the surface and the check that closes it follows.
- Ask even when the list is short, even when the session looked clean, and even when the user seemed satisfied. A quiet session is exactly where unnoticed debt accumulates; the sweep is not a courtesy, it is the closing gate.
- If no structured question tool exists in the runtime, use the Confirmation Protocol fallback: a numbered list in the final message with an explicit instruction to reply with the item numbers to execute, and state plainly that the runtime lacks a prompt widget. The gate stays closed. Never silently skip the ask because the widget was missing. In an unattended run (`sucp-overnight`) the same items also go to the plan backlog.
- If the user selects nothing, picks `Nothing, close session`, or dismisses the question, accept it in one line, keep the items in the written backlog with their `defer:` markers, and close. Never re-ask the same question in the same session, and never treat a declined follow-up as a reason to re-open the completed plan.

6.5 Execute, how a selected follow-up runs as real work, and why the sweep has one round (the re-pass writes new debt to the backlog and ends with a stop line): [references/02-rank-and-execute.md](references/02-rank-and-execute.md).

### ✅ 6.5.5 Plan Closeout Decision
> ✅ **Closing stage: the plan status is a decision, not a side effect.** Measured 2026-10-12 in bcb: 14 issues stayed open while nine plans with merged work were still `Approved`, `InProgress` or `Draft`, because nothing asked the owner to close them.

This step is mandatory, including when the user picked `Nothing, close session`. Steps 1 to 4 run before the 6.4 call; step 5 runs after the selected follow-ups land. It runs before the graphify sync (6.6) so the graph indexes the final plan status.

**Timing.** Run `--readiness` and ask the `Close plan` gate before the merge of the session's final PR (the PR that carries the plan's last change). A status flip after that merge needs a new PR, whose own plan then needs another PR, and so on (measured 2026-10-12 in bcb: session closeout-sisa was recorded merged with its plan still open). On `Mark Complete`, commit `status: Complete` plus the readiness output on the session branch so it ships in that same PR; after the merge only `bun scripts/plan-sync.mjs <plan.md>` (mirror publish and issue sync) remains. When the decision is only possible after the merge (for example the evidence is a post-merge check), record it in the next session's PR and say so in the plan's `## Closeout status`. Never open a PR whose only purpose is flipping the status of the plan that just merged.

1. **Tick from evidence.** Run the plan once with `bun scripts/ultra-plan-runner.mjs <plan.md> --execute > runner.log`, because the subagent execution path never writes a runner log, then, as a second command and never chained with `&&` (the runner exits non-zero when a task fails, and the passed tasks still need their ticks), `bun scripts/plan-mark-done.mjs <plan.md> --from runner.log`. It ticks the step lines of every task the log records as `PASSED` or `SKIPPED-IDEMPOTENT`; a task it refuses is fixed and run again, or ticked with `--task`, which prints that the tick is asserted without evidence. Readiness reports `NOT-READY` while any task step box is open, and `pr-registry.mjs state merged` refuses the plan. Boxes outside task sections (acceptance criteria, approvals, checklists) are listed by readiness as other open boxes and are ticked by hand with evidence, not by mark-done.
2. **Measure.** Run `bun scripts/plan-closeout.mjs --readiness <plan.md>`. It runs each task's `skip_if` with a timeout, in the worktree of the plan's newest unfinished registry session when one exists (else the plan's repository), and marks the task `DONE` (exit 0), `OPEN` (non-zero), `UNREAD` (timed out) or `UNPROVEN` (`false` sentinel or no `skip_if`). A `skip_if` that names a missing test file is `OPEN` without running, because `bun test` exits 0 when a named file is missing. Backlog rows classed `NOW` and still open, and every open task step box, count against the plan; open boxes outside task sections are listed as `other open boxes: M` and do not count. Verdict: `READY` exit 0, `NOT-READY` exit 1, `NEEDS-HUMAN` exit 3 (nothing open, but some task has no machine proof).
3. **Show.** Put the verdict, every `OPEN`, `UNREAD` and `UNPROVEN` item, and the open task step boxes and other open boxes readiness lists in the chat before the question, so the owner decides on evidence.
4. **Ask the `Close plan` gate** through the Confirmation Protocol, inside the 6.4 `Follow-ups` call. The recommended option follows the verdict: `Mark Complete` is first and recommended only on `READY`. On `NOT-READY` or `NEEDS-HUMAN`, `Keep it open` is first and recommended, and its description names the open tasks. One question per plan; plans past the four-question limit go in the next call.
5. **Apply the answer.**
   - `Mark Complete`: Mark Complete applies only if a readiness run after the follow-ups land is still `READY`, so re-run `--readiness` first; any other verdict, or a failed follow-up, gets the `Keep it open` record instead. Then set `status: Complete` and record the readiness output (command, verdict, date) in the plan, committed on the session branch before the final merge. Next to it, the plan also records the output of `bun scripts/plan-cost.mjs --plan <plan-id>`, an estimate of the plan's cost whose two caveats it prints. After the merge, run `bun scripts/plan-sync.mjs <plan.md>` so the published copy updates and the issue closes.
   - `Keep it open`: write a `## Closeout status` section in the plan with the verdict, what remains, and the trigger that reopens the question (for example "when V6 passes" or "after the owner checks the live site"). An open plan is visible, never silent.
   - Dismissed: the status stays unchanged and the `## Closeout status` section says `pending`, with the verdict.
6. **Unattended runs** (`sucp-overnight`) never ask and never flip the status: they park the `Close plan` decision with the readiness verdict in the handoff.

Across sessions, run `bun scripts/plan-closeout.mjs --audit` during the sweep for the repository. It reports every plan whose registry sessions are all finished with at least one merged while the plan is not `Complete`. Each plan it lists gets the same `Close plan` question in this step.

### 📇 6.6 Sync Session Artifacts to Graphify: local, no model, mandatory (a repo without a graph is offered registration)
> 📇 **Closing stage — the documents you generated are part of the deliverable, so they belong in the knowledge graph.** A plan, batch manifest, spike report, handoff, progress log or learning ledger that only exists on disk is invisible to `graphify query`, `path` and `explain`. `graphify update .` cannot fix this: its help reads "re-extract code files and update the graph (no LLM needed)" and it parses code, so Markdown is never ingested by it.

```
RUN `graphify update .` FIRST, THEN THE SYNC WITH `--root "$(pwd)"`, IN THAT ORDER
```

Order, commands, idempotency, and how to prove the documents reached the graph: [references/03-graphify-sync.md](references/03-graphify-sync.md).

- **It also runs automatically at commit time, in the right order, but ONLY inside the vivera repository.** `install.sh` sets `core.hooksPath=.githooks` (at tier standard or full, when the checkout has its own `.git`), and vivera's `.githooks/pre-commit` runs the pair without anyone remembering: when the commit touched code it runs `graphify update .` first, then `bun run graphify:sync`, so the structural document layer is the last writer and survives. A Markdown-only commit skips the code rebuild and runs the sync alone. The graphify part never blocks, because a failed refresh of derived state must never block a commit, and `GRAPHIFY_SYNC_SKIP=1 git commit ...` disables it for one commit. The hook's one blocking path runs first and is separate: the file size gate (`bun run size:check`) refuses a staged file over 5,000 tokens.
- **A missing graph is not a reason to skip silently, and not a reason to build silently. Offer registration.** If `graphify-out/graph.json` does not exist, the repository was never registered, which does not block the step. Ask through the question tool (Confirmation Protocol) with the options `Register now` (Recommended), `Not now`, `Never for this repository`. `Register now` runs `bun <vivera>/scripts/graphify-register.mjs <root>`, which works offline, builds the code graph, and keeps `graphify-out/` ignored (it adds the graph to the global graph only with `--global`); then run the sync command above. `Not now` or `Never for this repository` skips the sync and records one line saying so; `Never for this repository` also runs the register command with `--never`, so later sessions do not ask again. An unattended run does not ask: it records the missing graph in one line. Skipping without asking is the single most common way this step silently never happens, and it looks exactly like compliance because the skip prints a line and exits 0. The other cases that are "record one line and move on": `graphify` not installed at all, or an *existing* graph whose refresh **failed**. In every case never hand-write a `graph.json` to make the step look done; the graph is derived state and a hand-authored one is a second source of truth.

Progress stars, the anti-pattern list, and the sweep flow diagram: [references/04-stars-anti-patterns.md](references/04-stars-anti-patterns.md).
