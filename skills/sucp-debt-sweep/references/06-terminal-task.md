# Sweep Before the Terminal Task

> Loaded from `sucp-debt-sweep` 6.1 when the plan has a terminal task. Plan: `2026-11-15-sweep-before-terminal`.

**Why.** Measured 2026-11-13 in social-media plan `2026-11-13-fb-time-travel-ep5`: the full render (T15) was a plan task, so the plan reached `Done 100%` only after it, and the sweep came after the render. The render ran four times before delivery. A sweep follow-up that touches the rendered output forces one more run of the most expensive step in the session.

**Terminal task.** A plan task whose output is costly to redo or visible outside the repository: a full render, a deploy, a publish, a release, a message sent. The plan writer marks it with `(terminal)` at the end of its `### Task` heading and makes it depend on every other task (`sucp-plan`). A plan has at most one terminal task; two costly steps that belong together (render then upload) are one terminal task. A plan without a terminal task keeps the order in 6.1 unchanged, and so does a post-merge production deploy, which already comes after the sweep.

**Order with a terminal task.**

1. The sweep starts when every non-terminal task is `Done 100%` with evidence and the evidence gate is green for them.
2. The sweep runs (6.2 to 6.5): harvest, rank, the `Follow-ups` call, the selected follow-ups land with fresh evidence. The `Close plan` question is not in this call.
3. The terminal task runs once, on the tree that already holds the follow-ups.
4. 6.5.5 runs after it: tick from evidence, `--readiness`, then the `Close plan` gate in its own call, still before the session's final merge (owner decision 2026-11-15).

**Defects the terminal output shows** (a wrong frame, a failed deploy check) are fixed inside the terminal task before it counts as done, then the task runs again; that rerun is the task's own work, not a sweep follow-up. Findings that do not block the output go to the plan's backlog with a `defer:` marker. There is no second sweep.

**Runner safety.** 6.5.5 runs `ultra-plan-runner.mjs --execute` after the terminal task, and an overnight run does the same (`sucp-overnight`). So the terminal task has no `run[]` (the parent runs its steps) and carries a real `skip_if` that proves the output exists, such as a check on the rendered file or the live URL. Then `--execute` reports it `SKIPPED-IDEMPOTENT`, mark-done ticks it, and readiness counts it `DONE`. A terminal task with a `run[]` whose `skip_if` fails (output not there yet) means `--execute` runs the render or deploy again. A prose task with `skip_if: "false"` is allowed but stays `UNPROVEN`, so readiness says `NEEDS-HUMAN` and `Close plan` recommends `Keep it open`.

**Unattended runs** never run a terminal task (`sucp-overnight`: no deploy, publish, or release); the run ends with the sweep and parks the terminal task under `Waiting on a human`.
