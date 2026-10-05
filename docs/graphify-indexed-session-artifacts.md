# Session Artifacts: `loop-convergence` / PR 24

Date: 2026-10-05. Session slot `loop-convergence`, plan
`docs/code-plan/plans/2026-10-05-loop-convergence-contract.md`, PR 24.

This file exists so the session's review report and learning ledger are visible to
`graphify query` / `path` / `explain`. The originals live in `docs/code-plan/`,
which is excluded from graph indexing by design: `scripts/vault-index.mjs` scan
reports `docs/code-plan/` among exactly three ignored paths, alongside `bun.lock`
and `spike-out/`. Artifacts written there cannot enter the graph, which is a
scope boundary of the indexer and not a failure of the sync.

Both originals are retained at their own paths. This file is an index entry
point, not a replacement.

## The finding, in brief

A `tasks[].run[].loop_until` declared on a RED step (`expect_exit: 1`) could never
iterate. The runner assigned the probe result into `r`, then decided step success
by comparing `r.exit` against the step's own `want`; for a RED step whose probe
exits 1 that comparison is true, so the retry loop broke after one pass and spent
none of the declared budget. Measured before the fix, on a probe converging only
on its second invocation:

| Step | Probe | Status | retry | probe runs |
|---|---|---|---|---|
| `expect_exit: 0` | always exits 1 | FAILED-ISOLATED | 2/2 | 3 |
| `expect_exit: 1` | always exits 1 | FAILED-ISOLATED | 0/2 | 1 |
| `expect_exit: 1` | converges 2nd run | FAILED-ISOLATED | 0/2 | 1 |

The suite read `114 pass, 0 fail` over the defect because no test used a RED step
carrying a `loop_until`. The fix gates the step-success break on `loopConverged`
at `scripts/ultra-plan-runner.mjs:1200`, so the probe exit is only ever compared
against `LOOP_EXPECTED_EXIT`. Reverting that one line gives `114 pass, 2 fail`;
with it, `116 pass, 0 fail`.

## Artifact locations

| Artifact | Path | Graph-indexed |
|---|---|---|
| Review report | `docs/code-plan/loop-convergence-red-step-review.md` | no, by design |
| Learning ledger | `docs/code-plan/loop-convergence-learning-ledger.md` | no, by design |
| This index | `docs/graphify-indexed-session-artifacts.md` | yes |

## Verification on the committed tree

| Gate | Command | Exit | Result |
|---|---|---|---|
| Focused suite | `bun test scripts/ultra-plan-runner.test.mjs` | 0 | 116 pass, 0 fail |
| Full suite | `bun test scripts/` | 0 | 1397 pass, 38 skip, 0 fail |
| Contract parity | `bun scripts/check-runner-contract.mjs` | 0 | 23 keys, both artifacts |
| Graph freshness | `bun run graphify:check` | 0 | CURRENT, 2229 nodes |

## Two gates that are red on the base commit too

`bun run validate` exits 1 with 3 errors and `bun run copy:check` exits 1 with 212
em-dashes. Both reproduce identically on `origin/main`: `validate` fails on the
gitignored `plans.publish.json` and `plan.issues.json` plus an absent `mmdc`, and
`copy:check` counts the same 212 pre-existing em-dashes while this branch adds 0.