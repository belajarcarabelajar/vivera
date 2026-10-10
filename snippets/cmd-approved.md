# Snippet Command: Approved, Carry to Completion

> Type this into the agent chat to answer a "shall I continue?" check-in. It
> approves the scope already agreed and tells the agent to stop asking about
> reversible steps. It does not approve anything destructive, external, or new.

---

Approved. Carry this to completion inside the approved scope: every reversible step that follows, without asking again. Stop only for a destructive or hard-to-reverse action, a real scope change, or an ambiguity that would change the result. If one part is blocked, finish the independent parts first and say exactly what decision unblocks it. Batch any confirmation you truly need into one question at the end.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
