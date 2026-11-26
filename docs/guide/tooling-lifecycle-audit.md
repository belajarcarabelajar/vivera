# Plan Lifecycle Audit & Task Completion

Two scripts manage the lifecycle state of `ultra-plan/v1` plans after execution.

## Plan Lifecycle Audit (`scripts/plan-lifecycle-audit.mjs`)

Audits the `status:` field across all tracked plans and splits the count into three honest buckets:

| Bucket | Meaning |
|---|---|
| `untracked` | No YAML frontmatter at all. The mirror's `Draft` is a publisher fallback, not a real claim. |
| `tracked` | Has frontmatter with `status: Draft`, a real lifecycle claim that may be stale. Only these are candidates for backfill. |
| `frontmatter-no-status` | Has a `---` fence but no `status:` key. Malformed plan. |

```bash
bun scripts/plan-lifecycle-audit.mjs         # human-readable tally
bun scripts/plan-lifecycle-audit.mjs --json  # same data as JSON
```

Always exits 0: a report, not a gate. A threshold would fail the moment a new plan is added.

## Task Completion (`scripts/plan-mark-done.mjs`)

Reads an evidence log and applies `[x]` ticks to plan `[ ]` step lines for every task that reached a terminal success (`PASSED` or `SKIPPED-IDEMPOTENT`). The primary log is the readiness evidence, which records every task whose `skip_if` exited 0; a runner execution log (`ultra-plan-runner.mjs <plan> --execute > runner.log`) is still valid. Three non-success statuses (`NEEDS-AGENT`, `READY (dry-run)`, `HALTED-UPSTREAM`) are explicitly refused: a task is marked done only when evidence says so.

```bash
bun scripts/plan-closeout.mjs --readiness docs/code-plan/plans/<plan>.md --evidence readiness.log
bun scripts/plan-mark-done.mjs --from readiness.log docs/code-plan/plans/<plan>.md
bun scripts/plan-mark-done.mjs --from runner.log docs/code-plan/plans/<plan>.md
bun scripts/plan-mark-done.mjs --task T3 docs/code-plan/plans/<plan>.md  # assert, no evidence
```
