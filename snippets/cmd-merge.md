# Snippet Command: Merge Now

> Type this into the agent chat when a session's pull request is verified and you
> want it merged into main. It is the human authorization the pipeline waits for:
> merging into the base branch never happens without it. It authorizes the merge
> and nothing else: no deploy, no publish, no cleanup (use `cln` for cleanup).

---

Merge now. I authorize merging this session's open pull request(s) into main, nothing else. Re-measure first: `gh auth status`; `git fetch origin main`; session state `open` in `bun scripts/pr-registry.mjs status`; `gh pr checks <n>` green; `gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision` mergeable with no blocking decision. Several PRs: follow `bun scripts/pr-registry.mjs order`, one at a time, and after each merge `git fetch origin main` and re-verify locally. A red gate or a conflict is a status: quote the output, skip that PR, continue the others. Merge with `gh pr merge <n>` and the default method. Never `--admin`, `--force`, or a protection bypass. Then `bun scripts/pr-registry.mjs state <session> merged` and report each merge commit. Do not deploy, publish, or delete branches or worktrees.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
