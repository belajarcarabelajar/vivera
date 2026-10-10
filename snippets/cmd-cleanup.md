# Snippet Command: Clean Up After the Merge

> Type this into the agent chat after a merge, to remove the session's worktree
> and local branch. It only touches what the session created and what is provably
> merged. Remote branches are left alone.

---

Clean up after the merge, only what this session created. For each session worktree and branch: confirm the PR is merged (`gh pr view <n> --json state,mergeCommit`) and the branch is contained in origin/main (`git merge-base --is-ancestor <branch> origin/main`). Stop anything running from a worktree first, by PID (`/proc/*/cwd`), then `git worktree remove <path>`, `git branch -d <branch>` (never `-D`), `git worktree prune`. Never `rm -rf`. Leave remote branches alone. List and leave anything unmerged or not created by this session. Report removed, kept, and why.

PROGRESS METER: whatever this trigger asks for, open every message to me in the chat that reports progress (a checkpoint, a phase change, a status or recap, the final report) with one meter line, as `sucp-rules` Progress Meter at Checkpoints defines it: `▰▰▰▱▱▱▱▱▱▱ 30% · 3/10 · <item in progress>`. Ten segments, `▰` filled and `▱` empty, then percent, `N/M` and the item in progress. Filled means `[x]` items (each already cites evidence) over all items in the plan file checklist, rounded down, so 100% appears only when every item is `[x]`. Always show `N/M`; when M grows, say `+1 item` instead of letting the bar look like a regression. During a debt sweep use one star per debt found instead (`★` closed with evidence, `☆` open, for example `★★★☆☆`). If there is no plan checklist yet, print no meter and never estimate a percentage. The meter is chat only: never written to a file, plan, progress log, handoff, PR body, commit message, or issue.
