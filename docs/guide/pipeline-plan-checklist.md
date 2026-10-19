# Plan Checklist (the to-do list)

The to-do list lives in the plan file, as a `- [ ]` checklist. Every completed item
cites its evidence (command, exit code, result) in the same update that checks it
off. Agents do not use the harness's own todo tool for this.

Why not the harness tool: it is a second copy of the list. It is lost on compaction
or a harness switch, it can drift from the plan file, and its name and permission
differ per harness (`todowrite`, `TodoWrite`, `update_plan`). A checklist in the
plan file survives all of those, and a resumed session reads it directly.

## Ownership

- **The parent owns the checklist.** A subagent gets a chunk and returns a report.
  Asking it to maintain a list produces a fabricated one in its report.
- **The checklist is per session, not per subagent.** Ten subagents updating ten
  lists is ten lists nobody reconciles. This mirrors the one-PR-per-session rule.

## Rules that keep the checklist honest

- One item per independently verifiable unit, at chunking granularity. An item that
  cannot fail on its own cannot be checked on its own.
- Every item names a **finish line**, not a topic. "Add `session.test.ts` covering
  token refresh and make it pass" is an item. "Fix the auth module" is not.
- **Exactly one item is in progress at a time.** Two in progress is two threads.
- Completion is recorded **with its evidence in the same update**: command, exit
  code, result. Marking complete and citing later is the false pass the runner's
  `skip_if` rules exist to prevent.
- A newly discovered item is **added**, never substituted for the current one.

If the plan file cannot be written, that is a blocker to report. It is not a reason
to move the list into a harness tool.
