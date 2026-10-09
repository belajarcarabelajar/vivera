# Snippet Command: Clean Up After the Merge

> Type this into the agent chat after a merge, to remove the session's worktree
> and local branch. It only touches what the session created and what is provably
> merged. Remote branches are left alone.

---

Clean up after the merge, only what this session created. For each session worktree and branch: confirm the PR is merged (`gh pr view <n> --json state,mergeCommit`) and the branch is contained in origin/main (`git merge-base --is-ancestor <branch> origin/main`). Stop anything running from a worktree first, by PID (`/proc/*/cwd`), then `git worktree remove <path>`, `git branch -d <branch>` (never `-D`), `git worktree prune`. Never `rm -rf`. Leave remote branches alone. List and leave anything unmerged or not created by this session. Report removed, kept, and why.
