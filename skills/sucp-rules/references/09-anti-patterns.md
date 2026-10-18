## Consolidated Anti-Patterns
| Excuse | Reality |
|---|---|
| "Too simple to need approval/design/test" | Simple scales the artifact, not the gate |
| "I'll call it bounded to skip the spec" | Reaching for a label to dodge work = take heavier path |
| "It grew but I'm almost done" | Hidden complexity upgrades path mid-task |
| "Tests after achieve same goal" | Tests-after prove nothing: never watched them fail |
| "Agent said success" | Verify independently via diff |
| "The tests pass, so it is done" | Completion Audit: derive every requirement, judge each evidence item, and treat partial or too-weak proof as not achieved |
| "I'll ship the smaller, safer version" | Fidelity: a narrower or merely compatible solution is misalignment, not prudence. Surface the conflict instead of shrinking the goal |
| "It's blocked, so I'll stop here" | Blocked Audit: the same blocker must recur across three consecutive turns before it counts as blocked; until then keep completing independent work |
| "Updating the plan instead of running it" | A plan update is not progress. Keep it current, then execute; trivial single-step work needs no plan at all |
| "I left a few TODOs, I'll clean them later" | Session-Close Debt Sweep: every noticed-but-unclosed item becomes a selectable follow-up now, so nothing survives the handoff as debt |
| "Plan says done, so the session is over" | Plan Completion Saturation: tasks reach `Done 100%` with evidence, and the Step 6 sweep runs before the `Close plan` gate decides whether the plan flips to `Complete` |
| "A finished plan left at Approved is harmless, the PR merged" | Plan closeout decision: the plan status drives the issue, so a merged plan nobody closed keeps its issue open and hides real open work. Step 6 first ticks the task steps from evidence (the runner's `--execute` log, then `plan-mark-done.mjs --from` it), then runs `plan-closeout.mjs --readiness` and asks the `Close plan` gate; keeping it open writes a `## Closeout status` section with what remains |
| "I'll list the follow-ups at the end so you can read them" | Ask, don't narrate: one question-tool call of multi-select checkboxes, batched after the recap, so the user taps instead of retyping |
| "Here are 8 follow-ups, pick the important ones" | Rank then cap: default 3-5 ranked follow-ups; the tail goes to the written backlog with `defer:` markers instead of a longer question list |
| "You declined, so let me re-ask at the end" | A declined follow-up is closed. Record it in the backlog and finish; never re-ask the same question in one session |
| "Ending the turn with a summary that announces the next step" | A turn with no tool call and checklist items still open is a report. With no blocker written, take the next step in the same message (see `sucp-overnight`, section 4) |
| "Asking again for permission already granted" | Authorization Persistence: approval and preferences carry across turns; batch any genuinely new confirmation into one request, but a risky action is never part of the batch |
| "Shall I proceed?" in plain text | Confirmation Protocol: every human pause is a question-tool call with the recommended option first. A prose question makes the user type the answer |
| "I'll ask them to type what they want changed" | A revise option leads to a follow-up question whose options are the parts of the artifact. Free-form input stays available through the tool itself |
| "The dialog was dismissed, so I'll take the default" | A dismissed question is not an approval. A gate stays closed, one line says what is pending, independent work continues, and the question is not re-asked |
| "Enter should be fast for the delete too" | Safe option first: Enter must never run a destructive or externally visible action, so the go-ahead is the second option and is asked alone |
| "Reporting only the first bug I found" | Review Exhaustiveness: return every qualifying finding, deduplicated by location and defect/remedy |
| "This task is too small to bother with subagents" | Task-Chunking Principle: small total work that splits into several chunks means more chunks, not fewer subagents. Chunk and fan out anyway. The only exception is a genuinely single-step task (see Single-Step Inline Exception): do it inline, never as one wrapping agent |
| "One subagent can swallow all of this at once" | High Fan-Out Floor: 10 narrow subagents beat 5 overloaded ones on wall-clock, isolation, and report quality |
| "Pasting the subagent reports back as the result" | Gather & Synthesize: dedupe, resolve conflicts from evidence, verify independently, then merge into one result |
| "A subagent went quiet, so I re-dispatched it" | Silence is not evidence of a stall, and re-dispatching on top of a live original creates two writers on one file. Measure mtime and processes, nudge once, reap the stale writer, then re-chunk rather than re-run |
| "The stalled agent can keep going, I'll work around it" | A stalled agent holding a write scope will clobber an inline edit on its next write. Terminate it, confirm it is gone, then take over |
| "Re-running the same chunk will probably work this time" | Two stalls means the chunk is too big. Split it into bounded single-purpose units with an output cap |
| "A subagent committed its work so it wouldn't be lost" | Git writes are parent-only. A commit is not the deliverable, the tested file state is. `git reset --soft HEAD~1` and keep the changes |
| "I'll name the branch something obvious" | Branch and worktree names are derived by `pr-registry claim`. Two panes picking their own names is how one PR ends up carrying another session's commits |
| "This task is one PR, so let me open one per subagent" | One PR per session. Twenty subagents inside one session are one PR; twenty sessions are twenty PRs |
| "Pushing so CI can tell me if it builds" | Checks run locally on the machine holding the tree. A PR triggers a remote run, but its result is the author's evidence about a commit, not this session's verification |
| "All twenty look green, let me merge them in one batch and test at the end" | One merge at a time, each with its own rebase and its own local check. Twenty merges then one test means nineteen unverified merges |
| "This PR conflicts, let me fix it on main so it goes through" | Conflicts are resolved in the session's branch, then re-verified. Editing the base branch produces a change no session can attribute or review |
| "It's only a one-line fix, let me just commit to main" | There is no direct-to-base exception. A small change is a small session with its own branch and PR |
| "The reviewer approved it, so I can merge without re-checking" | An approval is not a rebase and not a local check. The base moved since the review; verify again after the merge |
| "I'll post my own review draft since I wrote it" | Generating a review and posting it are two acts. A human reads the exact text before it becomes externally visible |
| "Finishing a stalled chunk inline because the task is small" | Task size is not the test. The test is whether the parent already holds the whole contract and the remainder is precisely specified. State the reason at handoff either way |
| "Should work now" | Run verification, then claim |
| "Em dash for emphasis in user copy" | Reads as AI-generated. Use a period, colon, comma, or parentheses instead |
| "The user wrote in Chinese, so the plan/report goes out in Chinese" | Prompt language is an input-layer fact, never an output instruction. Artifacts follow the codebase language, and the vault mirror is byte-identical to the plan, so a translation is stale on arrival |
| "This repo names things in Indonesian, so my new function and its comment are Indonesian too" | Code Syntax Defaults to English: new identifiers and code comments are English even beside non-English code. Existing names keep their real spelling, and string content is unrestricted |
| "I'll optimize/refactor this later" (unmarked shortcut) | Deliberate shortcuts require `defer: <ceiling>, <upgrade-trigger>`. Without ceiling and trigger, later means never |
| "Small diff without checking callers" | Comprehension before reduction. Patching symptoms leaves sibling callers broken |
| "Part A is green, so I'm done" | Affected-Surface Audit: `tasks[].impacts` names what the task can break, and the runner refuses a plan that declares none. A green task proves the task, never its consumers |
| "I'll list the affected files later" | An impact noticed and left untouched is a named follow-up with a finish line, not a silent omission. The debt sweep finds it at the end of the session; `impacts` makes it findable at the moment it is created |
| "The subagent reported a file outside its chunk, so I'll note it mentally" | A name in a report that reaches no task and no backlog is a dropped impact. Every out-of-scope report becomes a task or a `defer:` line in the same session |
| "Factory/interface for future extensibility" | Speculative abstraction is debt. YAGNI: 1 implementation = 0 interfaces |
| "New dependency for a simple utility" | Climb the Simplicity Ladder: stdlib and platform features come before dependencies |
| "Comment restating code or workflow narration" | Comments explain non-obvious "why", invariants, or deliberate shortcuts; delete banners, echoes, and step narrations |
| "Decorative button or dummy link that does nothing" | Functional completeness: every interactive element works end-to-end or does not exist |
| "Fictional stats or placeholder testimonials" | Evidence over claims: display only verified facts; empty is better than deceptive |
| "Inflated AI vocabulary in copy" | Write direct, human, factual prose; ban buzzwords (seamless, elevate, delve, harness) |
| "Mobile layout as an afterthought" | Mobile first-class: 44px min tap targets, zero horizontal overflow, visible keyboard focus |
| "Dumping raw shell/API/log output into context" | Filter at the source: pipe through rg / tgrep / jq / head in the same command and inject only distilled findings |
| "Running command without checking log" | Command Log Tracking Protocol: every execution must be followed by explicit log inspection and verified exit code |
| "The search came back empty, so there is nothing" | An empty result proves absence only when the method was shown to detect a known positive, and a source that failed to load is unread rather than empty. Name it on the `Not read:` line |
| "Forcing heavy build through RAM panic" | Dynamic Resource Guardrail: abort command, clean orphan processes, and prompt user to prevent BSOD/system lockup |
| "Executing dependent terminal commands as separate round-trips" | Maximized Command Chaining: chain dependent operations with && into atomic scripts to minimize latency and token spend |
| "Proceeding to next todo without skill re-anchor" | Stage & Todo Completion Re-Anchor Protocol: verify evidence of completed task and align with skill instructions before moving to next item |
| "Executing code without an itemized todo checklist" | Mandatory Pre-Execution Todo Breakdown: define explicit [ ] checklist before first mutation, update [x] per step |
| "Asking questions answerable by repo search" | Epistemic Invariant: Discoverable facts must be explored first via code search; never ask the user what the repo can prove |
| "Bikeshedding code review without rule citation" | Repository Rule Attribution: Every review finding must cite the exact supporting rule in AGENTS.md or provable defect; uncodified nitpicks are banned |
| "Writing every trivial lesson into memory" | Minimum Signal NO-OP Gate: Only persist memory if a future agent will plausibly act differently and more effectively; otherwise no-op |
| "Mutating code while in plan mode" | Strict Non-Mutation Invariant: Plan mode is strictly read-only; treat imperative user requests ("fix it") as instructions to plan the fix |
| "Shrinking goal to fit turn limit" | Goal Continuation & Budget Limit: Maintain full objective across turns; wrap up cleanly with budget_limited state rather than redefining success down |
| "Assuming end-state approval permits arbitrary risky actions" | User Authorization Scoring: Judge actions by material semantics; authorizing a goal does not authorize unreviewed destructive intermediate steps |
| "Repeating user's A/B choice as buttons" | Elicitation misuse: user requested recommendation, not options echoed back |
| "Filing AI proposals as user stated preferences" | Provenance distortion: confusing AI option menu or unselected proposal with user commitment. Only tag direct user statements with [stated] |
| "Storing moving task state in persistent memory" | Horizon test failure: today's bug or ephemeral task pollutes long-term memory. Retain only stable residue that matters in 30 days |
| "Simulating MCP or fake tool outputs" | Strict No-Mocking violation: confabulating tool interactions without real execution destroys trustworthiness |
| "Stacking visuals back-to-back without prose context" | Visual interleaving violation: interleave prose → visual → prose → visual to provide structural context |
| "Planning without a Mermaid visual map" | Unreviewable plan: every plan (Bounded or Architectural) requires at least one valid Mermaid flowchart; missing diagram blocks the approval gate |
| "The steps are written out, so the plan is executable" | Written is not executable. Only `tasks[].run[]` makes the runner run anything; a task with neither `run[]` nor `skip_if` is a validation error, and a task with only prose is `NEEDS-AGENT` |
| "skip_if greps for the string, so the task is done" | A text probe survives the behaviour being reverted. `plan-mark-done` ticks on the claim alone, so a loose `skip_if` is a false-pass. Use a command that fails on behaviour |
| "It loops until it stops finding things, so it is done" | `retry` bounds how many times a step may re-run, never what proves the iteration finished. An iterative step declares `loop_until`, a command the runner executes: exit 0 is converged, non-zero re-runs within the retry budget. A loop with no declared stopping condition is unbounded, and only the author's patience ends it |
| "I need a green build, let me push and let CI check it" | Checks run locally, in this session, on the machine that holds the working tree. A remote runner cannot see local state, and pushing to trigger it spends the user's compute budget for a weaker answer |
| "It's a small Bounded change, no plan file needed" | Ceremony scales with size, but the size threshold is mechanical, not a feeling: two or more tasks, any `depends_on` edge, or any subagent-owned unit requires a runner-validated plan file |
| "Self-abasing apologies when caught in a mistake" | Accountability violation: performative regret or submissive apology; acknowledge what went wrong directly, stay on the problem, and fix it |
| "Using localStorage in artifacts" | Artifact runtime failure: browser storage fails in sandboxed iframes. Use in-memory state or window.storage with hierarchical keys |
| "Replying with just 'Done.' after tool calls" | Empty reply violation: turn completion requires substantive 1-2 sentence answer of what was delivered or found |
