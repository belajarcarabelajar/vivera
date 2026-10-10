# Snippet Command: Fallback When a Tool Fails

> Type this into the agent chat when a tool or service failed and the agent is
> looping or improvising. It names the fallback ladder and the one boundary the
> agent must not cross: it never swaps in a local run for a remote one.

---

A tool or service failed. Do not loop on it. Quote the error once, then take the next rung and say which one: skill tool, then `~/vivera/skills/<name>/SKILL.md`; TinyFish `search`, then `fetch_content`, then `run_web_automation` only if the plan names it; structured question tool, then a numbered checklist in the final message. If an environment boundary blocks the step (VPS unreachable, auth missing, permission denied), stop that step and ask me; do not substitute a local run that changes where the work happens. Keep going on independent work.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
