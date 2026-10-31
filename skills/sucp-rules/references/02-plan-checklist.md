## 📋 Plan Checklist
> The plan file holds the to-do list. Each item is a `[ ]` line, and it is checked off only with the evidence that proves it. The harness todo tool is not used: it duplicates the list, is lost on compaction or a harness switch, and differs in name and permissions across harnesses.

### Ownership
- **The parent owns the checklist.** A subagent gets a chunk and returns a report; asking it to maintain a list produces a fabricated one in its report.
- **The checklist is per session, not per subagent.** One checklist covers the session's chunks, mirroring the one-PR-per-session rule.

### Rules
- One item per independently verifiable unit, at chunking granularity. Each item names a finish line, not a topic.
- Exactly one item is `in progress` at a time.
- An item is checked `[x]` only in the same update that cites its evidence: command, exit code, result.
- A newly discovered item is **added**, never substituted for the current one.
- If the plan file cannot be written, report it as a blocker. Do not move the list into a harness tool.

```
- [ ] Reproduce: failing test proving the bug            (expect_exit 1)
- [ ] Implement: minimal fix in <path>
- [ ] Verify: targeted suite green, 0 regressions
- [ ] Review: parent diff audit, independent reviewer
- [ ] Deliver: commit on the session branch, open the PR
- [ ] Sweep: session-close debt sweep
```

### Resuming
- Update the state at task start, after each meaningful checkpoint, before compaction, and before handoff. Keep completed work and evidence separate from assumptions and planned work.
- A resumed task must read the latest state, inspect the current files and diff, and continue from the last verified checkpoint rather than replaying already completed work. After a compaction the session runs `bun ~/vivera/scripts/plan-status.mjs <plan.md>` on the plan file and trusts its computed block (checklist, current task, open gates, overnight handoff) over its own recollection.
- Unattended Continuation Rule: when the user is not watching (scheduled run, "check back later", unanswered question), take the most reasonable reading, state it in one line, and continue. This never applies to a catalog gate of the Confirmation Protocol: an approval is never defaulted. Stop only for decisions that are irreversible and could reasonably go either way; do the preparatory work, state the decision, and wait. A question never stalls cheap reversible progress.
- Cheap-vs-Expensive Question Heuristic: when the request is clear or cheap to redo (research spike, single lookup, small reversible edit), start immediately and ask alongside first results. When the task is expensive to redo (large fan-out, multi-file change, parallel deliverables, hard-to-reverse action) and ambiguous, ask first with 1-4 concrete options (first = recommended) before building.
- Idempotent skip (evidence-based, not checkbox-based): before executing a task, evaluate its `skip_if` command from the plan frontmatter. If `skip_if` exits 0, the task is already satisfied by fresh runtime proof; mark it `SKIPPED-IDEMPOTENT` and advance. A `[x]` mark alone never justifies a skip; skipping requires a fresh verifying command, so re-runs stay safe and non-destructive. The command must fail on behaviour, not on the presence of a string: a `grep` over a source or doc file proves the text is there, which survives the behaviour being reverted. See Idempotency Honesty.
- Stage & Todo Completion Re-Anchor Protocol:
  - At the completion of each discrete task, to-do list item, or execution stage, the agent MUST explicitly re-anchor against the engineering standards and active constraints defined in this skill before moving to the next item.
  - Verification & Evidence Audit: Verify fresh evidence for the completed item against the Iron Law of Verification (fresh log, exit code 0, test pass, VCS diff).
  - Context & Skill Alignment Check: Review upcoming steps against mandatory skill rules (TDD compliance, memory/RAM guardrails, maximized command chaining, large-output capping, and no-placeholder rules) to prevent instruction drift, context dilution, or subtle degradation in execution discipline over long sessions.
  - State Transition Checkpoint: Update the task state (`Completed` ← current task, `Current` ← next task) with explicit proof references before initiating execution on the subsequent task.
- Interrupted Turn Recovery Protocol:
  - When a previous turn was interrupted or aborted mid-stream by the user, assume any running unified background processes may still be alive and tools may have partially executed.
  - Before issuing new mutating commands: (1) audit and clean up running orphan processes (`pkill` dangling build/test workers), (2) check `git status` and diffs to identify partially modified files, and (3) reconcile working tree state so uncommitted partial edits are understood before continuing.
- Goal Continuation & Token Budget Limit (`budget_limited`):
  - Goal Persistence Across Turns: The active task goal persists across turns; ending a turn does not permit shrinking or redefining the objective around what fits immediately. Keep the full objective intact and make concrete, verified progress toward the real requested end state.
  - Token Budget Exhaustion Wrap-Up: When cumulative context or token budget approaches its limit, mark the goal state as `budget_limited`. Do NOT start new substantive work. Wrap up the turn immediately by: (1) summarizing concrete progress completed, (2) enumerating remaining tasks and blockers, and (3) providing the user with a clear, actionable next step.
- Progress Classification & Blocked Audit:
  - Classify the turn before reporting: `progress` (changed authoritative state, or produced evidence that changes the next action), `verified wait` (polled a specific process, handle, or file confirmed live now, or awaiting its completion notification), or `no progress` (restated a plan, repeated an unexecuted intention, or reported a status with no new state). Status restatements and unexecuted plans are NOT progress.
  - A pending, running, unchanged, or inconclusive result is not completion. An observation timeout or transient polling failure is not a terminal state: re-poll the same handle or inspect the authoritative source, and never restart solely because the observation window expired.
  - Declare `blocked` only when the same genuine blocking condition has recurred for at least three consecutive turns AND no meaningful in-scope progress remains. Until that threshold is met, keep working on everything unblocked and report the blocker as a status, not a stop.
  - When blocked, state exactly what external change or user decision would unblock it, and what independent work was completed meanwhile.

