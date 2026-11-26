---
name: steward
description: House rules for a /steward watch (and PR Steward) on a vivera pull request
user-invocable: false
disable-model-invocation: true
---

# Watch rules for vivera pull requests

A watch started with `/steward` reads this file from the checkout, and PR Steward reads it from the default branch. Editing it while a watch runs ends the watch.

## Checks and tests

- Run only the checks the failure points at, never the whole suite. Heavy work goes to Claude Managed Agents: `ma-run --base origin/main --tools tgrep,gh,chromium -- <command>` (for example `-- bun test scripts/<file>.test.mjs` or `-- bun run ci:targeted`). Without `--base origin/main` the container has no `.git` and about 60 tests fail for environment reasons.
- `ma-run` exit 3 means the head is not pushed and exit 70 means the job did not finish. Only then run one test file here, prefixed `HEAVY_LOCAL=steward-fallback`.
- No end-to-end or browser runs unless the owner asks for them in a comment.
- A check that fails before any test ran, or that passed earlier on the same commit, is re-run once before you look for a cause.

## Before every push

The watch commits with `core.hooksPath=/dev/null`, so `.githooks/pre-commit` does not run. Run its gates yourself, in this order, and push only when each exits 0:

1. `bun scripts/check-secrets.mjs --staged` (this repository is public; GitHub push protection only knows provider tokens, not personal paths or addresses)
2. `bun scripts/check-file-size.mjs --staged`
3. When code changed: `graphify update .` and `bun run graphify:sync`, then stage the graph files they changed

A gate that fails is reported in a pull request comment, and nothing is pushed.

## Commits

- The commit message follows the repository's conventional style (`fix(scope): ...`) and carries no trailer or footer that credits a tool, model, or vendor (no co-author or sign-off line, no tool footer).
- Stage files by name, never `git add .`.

## What the watch never does

- Approve, merge, turn on auto-merge, or force-push. The owner merges through the vivera pipeline.
- Rebase the branch. The base comes in by `git merge origin/main`, because the branch already has a pull request.
- Edit `pr.registry.json`, `plans.publish.json`, or this file.

## Review comments

- A small, specific request (a rename, a missing test, a wording fix) is pushed and the thread resolved.
- A request about the design, the scope, or a large change gets a reply only, with no push, and stays open for the owner.
