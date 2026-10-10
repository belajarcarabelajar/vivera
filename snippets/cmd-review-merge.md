# Snippet Command: Review and Merge If Safe

> Type this on a new line AFTER `prr` (the PR review trigger) in the same message.
> It is the explicit pre-authorization that `prr` requires before it may merge.
> Without it `prr` is review-only. Every AUTO-MERGE gate inside `prr` still applies.

---

Pre-authorized: review and merge if safe. Merge each PR that passes every AUTO-MERGE gate; a PR that fails a gate stays unmerged with its report.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
