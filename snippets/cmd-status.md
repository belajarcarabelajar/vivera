# Snippet Command: Status Check

> Type this into the agent chat to ask where things stand: the session's plan, its
> pull requests, and any job still running. Read-only. It replaces "is it done?",
> "monitor", and "check the log again".

---

Status check, read-only. Answer as a table from the plan file checklist, `bun scripts/pr-registry.mjs status`, and the job's own log, not from memory: done (with evidence), running (state, elapsed, exit code if ended, last 20 log lines), blocked (on what), waiting on me. Do not restart or kill anything. Check remote hosts with `timeout`. If a state is unknown, say unknown and name the one command that settles it. Report once; do not poll in a loop.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
