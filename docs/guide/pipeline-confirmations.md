# Confirmations Without Typing

Every point where the pipeline pauses for a human decision, from the Step 1 intent lock to the Step 6 debt sweep, is a call to the harness's own question tool with ready-made options, so the answer is a tap or an Enter. No gate asks "proceed?" as plain chat text, and typing stays possible wherever the tool offers free-form input (Claude Code and OpenCode do). This changes how a gate is asked, never whether it exists.

| Harness | Tool | Limits | Free-form answer |
|---|---|---|---|
| Claude Code | `AskUserQuestion` | 1 to 4 questions, 2 to 4 options each, header up to 12 characters, `multiSelect` | the tool adds "Other" |
| OpenCode v2 | `question` | header, prompt, choices, `multiple`; dismissing cancels | always available |

Verified 2026-10-11: Claude Code against the tool schema, OpenCode v2 against <https://opencode.ai/v2/docs/tools/>. Any other harness (Antigravity included) is not verified: the agent looks for a question tool by name, reads its schema, and uses the closest equivalent. With no tool, a tool error, or no interactive client, it renders a numbered list in the final message, says the prompt widget is missing, and keeps the gate closed.

What a question looks like:

- The artifact (draft intent, design, plan summary, diff stat, exact comment text) is shown in chat first, then asked about.
- 2 to 4 options. The recommended one comes first, labelled `(Recommended)`, so Enter accepts it. Labels are five words or fewer, each with a one-line description.
- At most 4 questions per call and at most 4 options per question. The debt sweep groups its follow-ups into multi-select questions of at most 4 options.
- The debt sweep ends with the `Close plan` gate. It first ticks the task step boxes from evidence, as two commands in sequence: `bun scripts/ultra-plan-runner.mjs <plan.md> --execute > runner.log`, then `bun scripts/plan-mark-done.mjs <plan.md> --from runner.log`. Then `bun scripts/plan-closeout.mjs --readiness <plan.md>` runs each task's `skip_if` and reports `READY`, `NOT-READY` or `NEEDS-HUMAN` (`NOT-READY` while any task step box is open, counted as `open step boxes: N`; boxes outside task sections are listed as `other open boxes: M` and ticked by hand with evidence), and `Mark Complete` is the recommended option only on `READY`. A plan kept open gets a `## Closeout status` section with what remains. `bun scripts/plan-closeout.mjs --audit` lists plans whose sessions all merged while the plan is still open.
- Destructive, hard-to-reverse, externally visible, or shared-system actions (force push, delete, merge, publish, deploy) put the safe option first, `Cancel, do nothing`, and the go-ahead second, naming the exact action. Enter never runs the action, so no option carries `(Recommended)`, and such a question is asked alone, never batched.
- Every recommended option says why: its description starts with `Why:` and one line of basis (a repository fact, a measured result, or the pipeline rule behind the gate), then the usual one line of what happens next, or `Why: my judgment` when that is the only basis. A judgment is never presented as a best practice that was not checked.
- A risky question carries no tag, but its question text carries one `Facts:` line, for example the PR number, head commit, mergeable state and checks. It is evidence to weigh, not a nudge toward either option.
- Answering "not sure" never approves a gate, risky or not: the agent restates the reason or the facts, with what each option leads to, keeps the gate closed, and asks again once. Only a clarifying question that is not a gate takes its recommended default.
- A dismissed question is not an approval. The gate stays closed, one line says what is pending, and the same question is not asked again in that session unless the user asks. A clarifying question that is not a gate takes its recommended default and records it as an assumption.
- Unattended runs ask nothing mid-run. The overnight entry gate is collected while the user is present, and a mid-run decision follows the Unattended Continuation Rule: a reversible one continues on the most reasonable reading, an irreversible one that could go either way is parked in the handoff. The debt-sweep question is the one exception, as the last act of the run, and only when the harness has an interactive client.
- Question text follows the user's language preference, never a hardcoded language. Subagents never ask: a question goes into their report and the parent asks.

The full rule is the `### ⏸️ Confirmation Protocol` section of [`references/07-completion-confirmation.md`](../../skills/sucp-rules/references/07-completion-confirmation.md). Its last table is the gate catalog: the header and the ordered options for each gate, from the intent lock to the merge and the debt sweep.
The catalog also has a `Basis` column holding the standard reason for each gate, which the validator requires.
