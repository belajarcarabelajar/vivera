# Snippet Command: Read-Only Audit

> Type this into the agent chat when you want an assessment and a recommendation,
> not a fix. The deliverable is a ranked list of proposals; nothing is changed
> until you choose.

---

Read-only audit. Do not edit, install, delete, commit, or change any setting. Ground every claim in something you measured this turn, citing the command or file; keep findings (measured) apart from guesses (unproven) and name what you could not check. End with a ranked list of proposed changes, each with its revert path, and wait for me to choose.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
