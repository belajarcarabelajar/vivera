# Progress Log: [Task Name]

> The checklist in this file is the only to-do list for a task. Do not use the
> harness's own todo tool (`todowrite`, `TodoWrite`, `update_plan`): it duplicates
> this list and is lost on compaction or a harness switch.
>
> The parent owns the checklist. Subagents return reports and never maintain one.

> Persistent task state. Update this file after EVERY meaningful checkpoint.
> This is the single source of truth for task progress across all sessions.

---

## Task Identity

- **Goal:** [What this task achieves when done]
- **Approved scope:** [Link or description of approved plan]
- **Started:** [ISO timestamp]
- **Last updated:** [ISO timestamp]
- **Status:** `ACTIVE` | `PAUSED` | `BLOCKED` | `DONE`

---

## Acceptance Criteria

- [ ] [Criterion 1 — specific, testable]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

---

## Task Breakdown & Checklist

### Phase 1: [Name]
- [x] **[Step 1.1]** — `[command run]` → Exit 0, [evidence]
- [x] **[Step 1.2]** — `[command run]` → Exit 0, [evidence]
- [ ] **[Step 1.3]** — *(in progress)*

### Phase 2: [Name]
- [ ] **[Step 2.1]**
- [ ] **[Step 2.2]**

### Phase 3: Verification
- [ ] Unit tests — `[command]` → 0 failures
- [ ] Type check — `[command]` → 0 errors
- [ ] Lint — `[command]` → 0 warnings
- [ ] Build — `[command]` → success

---

## Current Focus

**Now working on:** [Step X.Y — description]

**Last action taken:**
```
[paste exact command or code change made]
```

**Result / observation:**
```
[paste relevant output]
```

---

## Decisions & Rejected Options

| Decision | Chosen | Rejected | Reason |
|---|---|---|---|
| [Topic] | [What was chosen] | [What was rejected] | [Why] |

---

## Blockers

| Blocker | Waiting on | Unblock by |
|---|---|---|
| [Description] | [Person / event / decision] | [Action needed] |

---

## Error Ledger

> Centralized failure aggregation. Independent tasks are NOT halted by a sibling's failure.
> Dependent chains halt at the failed node (`FAILED-BLOCKING`); independent-task failures are isolated (`FAILED-ISOLATED`). Report as one batch at end of turn.

| Task | Step | Classification | Exit | Expected | Transient | Root cause | Evidence (log tail) | Retry used | Fallback used | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| [T3] | [2] | [environment] | [127] | [0] | [false] | [dep X absent] | [tail of stderr] | [0/1] | [none] | `FAILED-ISOLATED` |
| [T5] | [4] | [code] | [1] | [0] | [unknown] | [null deref] | [tail of stderr] | [0/1] | [none] | `FAILED-BLOCKING` |

---

## Evidence Trail

| Checkpoint | Command | Exit | Evidence |
|---|---|---|---|
| [e.g. Repro test GREEN] | `bun test repro.test.ts` | 0 | 1 passed |
| [e.g. Full suite] | `bun test` | 0 | 42 passed, 0 failed |

---

## Follow-Up Backlog (Session-Close Debt Sweep)

> The plan file's backlog section (implementation-plan template section 8) is the record. This log lists only the item IDs and their status; an item the plan lacks is written there first, then the plan is synced with `bun scripts/plan-sync.mjs <plan.md>`.

| # | Status |
|---|---|
| F1 | `OPEN` / `DONE` / `DECLINED` / `DEFERRED` |

---

## Session Log

*Append a one-liner per session — newest at top.*

| Session | Summary | Next |
|---|---|---|
| [2026-09-18 03:00] | [What was done] | [What to do next] |
