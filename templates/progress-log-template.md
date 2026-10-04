# Progress Log: [Task Name]

> Two checklists exist for every task and **both are required**. The harness todo
> list (`todowrite` in OpenCode, `TodoWrite` in Claude Code, `update_plan` in
> Gemini) is the live one a user watches in a pane. The checklist in this file is
> the durable one that survives a compaction, a crash, and a switch to a harness
> with no todo tool. Neither replaces the other; when they disagree, this file
> wins and the tool list is corrected to match.
>
> The PARENT owns the todo list. OpenCode's `general` subagent has full tool
> access except todo, so a subagent cannot hold one, and the list is per session
> rather than per subagent.

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

> Every noticed-but-unclosed item lands here so no debt leaves the session unrecorded.
> `NOW` = closable in this session. `LATER` = needs a new plan, an external dependency, or a real scope decision.

| # | Follow-up (outcome + path + finish line) | Class | `defer: <ceiling>, <upgrade-trigger>` | Status |
|---|---|---|---|---|
| F1 | | `NOW` / `LATER` | | `OPEN` / `DONE` / `DECLINED` / `DEFERRED` |

- [ ] 3-5 ranked follow-ups injected as one multi-select question (checkboxes), not as a prose report.
- [ ] Every selected follow-up executed through the full pipeline with fresh evidence.
- [ ] Declined and out-of-cap items written above, never dropped.

---

## Session Log

*Append a one-liner per session — newest at top.*

| Session | Summary | Next |
|---|---|---|
| [2026-09-18 03:00] | [What was done] | [What to do next] |
