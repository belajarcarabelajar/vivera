# Snippet Command: Merge Now

> Type this into the agent chat when a session's pull request is verified and you
> want it merged into main. It is the human authorization the pipeline waits for:
> merging into the base branch never happens without it. It authorizes the merge
> and nothing else: no deploy, no publish, no cleanup (use `cln` for cleanup).

---

Merge now. I authorize merging this session's open pull request(s) into main, nothing else. Re-measure first: `gh auth status`; `git fetch origin main`; session state `open` in `bun scripts/pr-registry.mjs status`; `gh pr checks <n>` green; `gh pr view <n> --json mergeable,mergeStateStatus,reviewDecision` mergeable with no blocking decision. Several PRs: follow `bun scripts/pr-registry.mjs order`, one at a time, and after each merge `git fetch origin main` and re-verify locally. A red gate or a conflict is a status: quote the output, skip that PR, continue the others. Merge with `gh pr merge <n>` and the default method. Never `--admin`, `--force`, or a protection bypass. Then `bun scripts/pr-registry.mjs state <session> merged` and report each merge commit. Do not deploy, publish, or delete branches or worktrees.
