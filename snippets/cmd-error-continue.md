# Snippet Command: Continue Past a Failure

> Type this into the agent chat when a run stopped on an error and you want it to
> keep going without blind retries. It carries the retry budget of the overnight
> run into an attended session: 2 attempts per chunk, then park it and move on.

---

Continue past the failure without blind retries. Read the exact error and exit code, and name the kind: environment, test contract, or code. If a whole suite failed at once, suspect the test contract first. At most 2 attempts per chunk, the second different from the first; after that mark it `blocked` with the failing command and exit code and keep going on every independent chunk. Never turn red into green by skipping or loosening a test, `--no-verify`, or editing a gate. The same failure in two chunks means a shared cause: stop dispatching and check the contract. End with done, blocked, and the one decision you need from me.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
