# Snippet Command: Done on My Side, Verify

> Type this into the agent chat after you did a manual step the agent asked for
> (a login, a restart, a merge, a setting). The agent measures the real state
> instead of taking your word for it, and proves its check can fail.

---

Done on my side. Verify it yourself, read-only, before trusting me. Measure the real state now; if your check could fail silently, first prove it detects the thing with a positive control. Separate what you measured from what you infer and mark anything unmeasured "not verified". Report the evidence (command and result), then continue with the next unfinished step.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
