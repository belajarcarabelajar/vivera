# Snippet Command: Resume From the Plan File

> Type this into the agent chat after a compaction, a `/clear`, a crash, or an
> interrupted turn. Unlike a bare "continue", it rebuilds the state from the plan
> file, the diff, and the PR registry before doing anything.

---

Resume this session from its plan file. Read the plan's latest state, `git status`, the diff, and `bun scripts/pr-registry.mjs status`; if my last turn was interrupted, first find leftover processes by PID and reconcile partial edits. Continue from the last verified checkpoint. Do not replay finished work: a `[x]` alone does not justify skipping, a fresh `skip_if` run does. Do the next unchecked item, cite evidence when you check it, and tell me in one line where you resumed.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
