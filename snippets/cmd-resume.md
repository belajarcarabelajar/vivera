# Snippet Command: Resume From the Plan File

> Type this into the agent chat after a compaction, a `/clear`, a crash, or an
> interrupted turn. Unlike a bare "continue", it rebuilds the state from the plan
> file, the diff, and the PR registry before doing anything.

---

Resume this session from its plan file. Read the plan's latest state, `git status`, the diff, and `bun scripts/pr-registry.mjs status`; if my last turn was interrupted, first find leftover processes by PID and reconcile partial edits. Continue from the last verified checkpoint. Do not replay finished work: a `[x]` alone does not justify skipping, a fresh `skip_if` run does. Do the next unchecked item, cite evidence when you check it, and tell me in one line where you resumed.
