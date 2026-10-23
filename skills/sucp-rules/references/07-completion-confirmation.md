### 🔁 Approved-Work Completion
- After the user approves the intent or plan, complete every requested reversible step that follows from that approval. Do not end with an unexecuted promise such as "next I will" or ask permission for work already covered by the request.
- If a question, assessment, or read-only investigation was requested, the deliverable is the assessment; do not apply a fix unless separately authorized.
- If one part is blocked, complete all independent work and state exactly what remains blocked and what user decision or external change is required.
- Authorization Persistence: authorization and stated preferences from earlier in the session persist across turns. Never re-request permission for an action already authorized, and never end a turn on a confirmation question while approved work is still outstanding. Batch genuinely required confirmations into one request (a risky action is never part of the batch), and state the concrete risk and mechanism once instead of re-warning.
- Stop for destructive actions, hard-to-reverse actions, genuine scope changes, or ambiguity where different interpretations would materially change the result. Removing a finished session's worktree is the one exception, under **Done Means the Worktree Goes** below.
- Autonomous Completion Bias (approved work only): After approval of intent or plan, bias toward carrying the intended task to full completion and persist until the goal is done. Do not stop to re-ask permission for reversible steps already covered by the approved scope; complete all independent work while blocked items await a user decision. Do not treat an isolated difficulty as an excuse to abandon approved work.
- Isolated Worktree & Merge-Conflict Handling: When approved work touches files the user may be actively using, or the change is large, experimental, or risky, carry it out in an isolated worktree/checkout or feature branch so the user's tree stays usable. Resolve merge conflicts arising from approved changes locally and reversibly, and remove the temporary worktree as **Done Means the Worktree Goes** below says.
- Draft PR as Externally Visible Publication: Creating a draft or full PR is externally visible publication, so it still requires explicit confirmation or inclusion in the approved plan/rollout; it is not silently authorized by the autonomous completion bias above. When a session's approved scope already names the pull request as its deliverable, that is the inclusion, and asking again per PR is the twenty-times-repeated question this rule exists to prevent. The standing gate is on **merging into the base branch**, which always waits for a human.
- Action-Phrase = Stated Intent, Not a Capability Question: When the user writes an action request ("can you...", "I want you to...", "help me...", "please add...", "fix..."), treat it as an instruction carrying intent to do the work. Do not reply with mere capability acknowledgment ("Yes, I can") or an offer to continue, and do not stop at a partial, "helpful enough" outcome to save time or tokens. Respond by classifying and advancing through the applicable path (Spike/Bounded/Architectural) with concrete next steps. An action phrase states the intent but does not by itself bypass the mandatory design→approval gates of the path; once that approval is given, complete sustained work to the intended outcome rather than stopping at an intermediate milestone.
- Concrete-Reviewable Approval & Homework-First: Before asking the user clarifying questions, complete the read-only investigation and preparation needed to make the question or proposed action concrete and reviewable (inspect the repo, configs, docs, and prior decisions; state what was inspected). Within an approved milestone, finish the required reversible work first so the approval you request is the final step for that milestone, not a mid-execution check-in. Do not ask permission for reversible, read-only, review, or fix work already authorized by context or an earlier approval, and do not add unsolicited warnings, disclaimers, or safety checklists for hypothetical risk. This does not change milestone ordering: full implementation for a milestone still begins only after its design→approval gate.
- Finishing & Git Hygiene Protocol:
  - Working tree verification: Run `git status` to confirm only expected files are touched, with zero unintended edits.
  - Purge iteration artifacts: Remove temporary scratch files, debug scripts, reproduction logs, and ad-hoc test files outside the repository's permanent test suite.
  - **Done Means the Worktree Goes** (set by the user 2026-10-23, so finished worktrees stop filling the disk): when the user declares the session done, in any language ("selesai", "done", "this session is finished"), run `bun scripts/session-cleanup.mjs --session <slug>` right away and ask nothing: the declaration is the approval. The `Close plan` gate is not that declaration: it is asked before the final PR merges, while the worktree still has work to carry. Stop this session's own processes in the worktree by PID first. The script removes the worktree only when nothing is lost: a process inside it, an uncommitted change, or a gitignored file that differs from the same path in the main checkout keeps it (exit 3); unique gitignored files (generated audio, data, plans under `docs/code-plan/`) are copied to the main checkout first; a text file whose every line the main copy already holds counts as identical; tool directories such as `node_modules` are dropped at any depth, and `dist`, `build`, `target`, `coverage`, `.cache` only when git lists them as their own ignored entry. The branch goes with `git branch -d` only when `origin/<base>` holds it. Exit 3 is reported in one line with its reason and is never answered with `--force`, `rm -rf`, or `git branch -D`.
  - Conventional commit standard: Structure commit messages with standard prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`) providing a clear rationale.
  - Never commit or push directly to the base branch, and never `--force` a session branch that already has a PR. A one-line fix is a small session with its own branch, not an exception to this rule. The session's branch and worktree are derived by `bun scripts/pr-registry.mjs claim`; see `5.5️⃣ 📤 Pull Request Delivery, Review & Batch Merge`.
  - Commit author policy: All commits must use the repository's configured primary author (the name in the repo's git config). Check and verify the author identity from each respective repository's git config (`git config user.email` or `.git/config`).
  - No co-author trailers: Never insert `Co-authored-by:` or any AI assistant attribution trailers in commit messages or pull requests unless explicitly requested by the user.
  - Clean handoff: State exact modified files, fresh verification evidence (commands + exit codes), and remaining user actions.

```mermaid
flowchart LR
    accTitle: Approved-work completion and stop conditions
    accDescr: After approval every reversible in-scope step runs to completion. Destructive actions and scope changes stop for confirmation, while external blockers still let all independent work finish first.
    Approval(["✅ Human Approval\nreceived"]) --> Check{"Reversible &\nwithin scope?"}
    Check -->|"Yes"| Execute["Execute step\ncompletely"]
    Execute --> More{"More approved\nsteps remain?"}
    More -->|"Yes"| Check
    More -->|"No"| Verify["Run verification\n& git hygiene"]
    Verify --> Done(["🏁 Handoff with\nfresh evidence"])
    Check -->|"Destructive /\nscope change"| Stop["⏸️ Stop: request\nexplicit confirmation"]
    Check -->|"Blocked externally"| Unblock["Complete all\nindependent steps\nthen report blocker"]
    Unblock --> More
```

### ⏸️ Confirmation Protocol: gate catalog

Every row below is a gate; a question without a row is a clarifying question.

| Gate | Header | Options, in order | Basis |
|---|---|---|---|
| Intent lock (Gate 1) | `Intent` | Approve and continue (Recommended), Revise a part | HARD GATE: nothing is built before the intent is approved |
| Spike probe | `Probe` | Run the probe (Recommended), Change the probe | Spike: the output is an answer, not product code, so the cheapest probe that preserves correctness is enough |
| Bounded design | `Design` | Approve and start (Recommended), Revise the design | Bounded path: the short design with its diagram and checklist is what is approved before implementation; when a plan file is required it is validated first, so this call also approves the plan (Gate 2) |
| Architectural design section | `Section` | Approve this section (Recommended), Revise this section | Architectural path: approval is asked after each design section |
| Spec review | `Spec` | Approve and write the plan (Recommended), Revise the spec | The reviewed spec is the input of the plan, so the plan is not written before it |
| Plan (Gate 2) | `Plan` | Approve and execute (Recommended), Revise the plan | Approval is requested after the runner prints `Validation: OK`, and the diagram matches `depends_on` |
| TDD exception | `TDD waiver` | Keep test-first (Recommended), Waive for this change | Test-first is the iron law; the exceptions are throwaway, generated, documentation/configuration-only and visual-only work |
| Wider scope or heavier path | `Scope` | Keep the approved scope (Recommended), Accept the new scope | Instruction Precedence: the approved scope is preserved unless the user's latest explicit request changes it |
| Blocker that needs a decision | `Blocked` | One option per concrete way forward, the recommended one first; a risky way forward follows the safe-option-first rule | Blocked Audit: independent work continues while this waits; the pick among ways forward is my judgment |
| Credential hand-off finished | `Hand-off` | Done, continue (Recommended), Skip this step | The agent never enters a credential, and the answer is a claim, so the agent verifies the result before relying on it |
| Publication outside the approved scope (push, PR, posted comment) | `Publish` | Cancel, do nothing; Publish (names the exact text or target) | Facts: the exact text or target, where it becomes visible, and whether it can be retracted |
| Merge into the base branch | `Merge` | Do not merge; Merge the PR (names the number and the head commit) | Facts: the PR number, head commit, mergeable state, remote checks as reported plus the local run, and the review verdict |
| Destructive action | `Destructive` | Cancel, do nothing; the exact action | Facts: what is deleted or overwritten, whether it is recoverable, and what was inspected first |
| Promote a rule to a global file | `Promote` | Keep in the repository only; Promote this rule (names the file) | Facts: the exact line, the target file, and the backup and revert path |
| Overnight run start | `Overnight` | Start the overnight run (Recommended), Not yet | Entry gate: the plan is `Approved`, the PR is the named deliverable, `gh auth` and `git fetch` pass, limits are recorded, and the harness runs at standard speed unless the plan allows its premium speed mode |
| Root-cause fix (only where the debugging trigger requires an RCA gate) | `Root cause` | Approve the fix (Recommended), Revise the diagnosis | RCA gate: the fix follows a verified cause with a failing reproduction, not a plausible guess |
| Debt sweep (Step 6) | `Follow-ups` | Multi-select groups, see `sucp-debt-sweep` | Ranked by leftover risk times blast radius times cheapness to close; the top item of each group is the recommendation |
| Plan closeout (Step 6) | `Close plan` | Mark Complete (Recommended), Keep it open | Asked in the same call as `Follow-ups`, applied after the selected follow-ups land. The recommended option follows `plan-closeout.mjs --readiness`: Mark Complete only on `READY`; on `NOT-READY` or `NEEDS-HUMAN`, Keep it open comes first and is recommended, naming the open tasks |
| Graph registration of an unregistered repository | `Register` | Register now (Recommended), Not now, Never for this repository | Registration runs offline (local AST, no LLM, no network, about 13 s per 2,000 files), writes only the repository's `graphify-out/` and `.git/info/exclude` (the global graph only with `--global`), and is reversible with `git config --unset graphify.register` plus `graphify global remove <tag>` when `--global` was used; a dismissed question registers nothing |

- `Basis` is the `Why:` line for a recommended gate and the facts to state for a risky gate. The validator fails a missing column or an empty cell, so a gate cannot be added without its reason.
- A `Hand-off` answer is a claim, not proof: verify the result (for example `gh auth status`) before relying on it.

