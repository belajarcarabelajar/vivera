# Executing an `ultra-plan/v1` Plan

`scripts/ultra-plan-runner.mjs` is the machine half of the plan contract. It parses the
`ultra-plan/v1` frontmatter, validates the task DAG, enforces idempotent skips, executes
each task's `run[]` steps, and aggregates failures into an error ledger. Zero dependencies,
Bun only.

```bash
bun run plan:check docs/code-plan/plans/<plan>.md   # validate the DAG and the visual map
bun run plan:run   docs/code-plan/plans/<plan>.md   # same, then execute the tasks
bun run contract:check                              # fast structural check for all 23 runner keys (~1s)
bun run audit:skipif                                # tally & audit skip_if predicates across registry
```

## Regex performance: two scans that were quadratic

Two regex-based scanners were quadratic on this repository's own input, and both
have been rewritten to a single pass. Both fixes keep the quadratic original in
the test file as a **control**, so the claim stays falsifiable: a performance
claim with nothing to compare against is a comment, not a test.

| Site | Old shape | Measured old | New |
|---|---|---|---|
| `check-anchors.mjs` `parseAnchors` (retired 2026-10-19) | forward walk from every `[` | 250 KB → **3.0 s** | 1.4 ms |
| `vault-index-structural.mjs` `stripFrontmatter` | `/^([\s\S]*?)^---[ \t]*(?:\r?\n\|$)/m` | 781 KB → **3.8 s**; 3 MB → 30 s | ~2 ms |

The anchor auditor and its control test were retired on 2026-10-19 with the rest of the vault chunk tooling; its row stays as the measured record.

Both had the same underlying cause: **an unbounded lazy prefix with no literal for
the engine to jump to**. `[\s\S]*?` matches the empty string at every position, so
the engine retries from each one, roughly 4x per doubling of input size. The
`--all` corpus is OpenCode session notes, which routinely run to hundreds of KB, so
this was minutes of wall clock per audit rather than a theoretical concern.

The property that predicts the problem is **not** "contains a lazy quantifier".
Two sibling regexes with the same shape were measured and deliberately left alone:
`redact.mjs`'s PEM pattern and `ultra-plan-runner.mjs`'s mermaid-fence matcher both
open with a **literal** (`-----BEGIN `, ` ```mermaid `), so the engine's prefix
search jumps straight to the candidate (0.1 ms on an 800 KB input). Re-measure
before touching either.

Replacements, both linear and both verified against the original over a corpus that
includes the nasty cases (`----` is not a fence, `k: ---` is not a fence, a fence at
EOF with no newline, a BOM, CRLF, and an unterminated block):

- `parseAnchors` → a bracket stack. Equivalent by construction: the `]` that brings
  depth to 0 from position `i` is exactly the bracket matching `i` under standard
  matching, since everything between them is balanced.
- `stripFrontmatter` → a **sticky** regex (`y`) walked over line starts found with
  `indexOf('\n')`. The sticky flag is what makes "must match exactly here"
  expressible, which is what lets the caller walk line starts by hand.

One timing lesson is recorded in both test files, because it cost two wrong
assertions: a wall-clock ratio between two separately-timed runs measures the
scheduler as much as the algorithm. One assertion read 3.28x per doubling on a
provably linear function, and a best-of-N retry still went flaky once the suite ran
55 files concurrently. The assertions that hold are **comparative and interleaved**:
both implementations timed back to back on the same input, alternating order, so a
GC pause lands on both and cancels in the quotient.

`bun run contract:check` (`scripts/check-runner-contract.mjs`) verifies that `templates/implementation-plan-template.md` and the master skill plan header declare all 24 keys the runner reads (`tasks[].run[].cmd`, `tasks[].run[].loop_until`, `tasks[].skip_if`, `tasks[].impacts`, etc.) using AST/frontmatter comparison in ~1 second, bypassing the headless Mermaid browser rendering.

The visual map check is the part that catches a lying plan. Every task heading must have a
matching node in the Mermaid block, and every `depends_on` edge must match a Mermaid edge
**in both directions**: a task in the diagram with no `depends_on`, or a `depends_on` with
no arrow, is a contradiction between the two representations of the same plan, and the
runner fails rather than guessing which one is right.

## `run[]` is what makes a plan executable

A plan is only machine-runnable to the degree its steps live in `tasks[].run[]`. Each entry
is one command with `cmd`, `expect_exit`, and `retry`; the runner runs them in order,
compares the exit code, retries a transient mismatch, and reports `PASSED`,
`FAILED-BLOCKING`, `FAILED-ISOLATED`, `HALTED-UPSTREAM`, or `SKIPPED-IDEMPOTENT`. A RED
step is expected to fail, so it passes with `expect_exit: 1`.

| Task declares | Runner does |
|---|---|
| `run[]` | Executes the steps. `PASSED` or a classified failure. |
| `skip_if` only | `NEEDS-AGENT` plus a warning. Correct for prose, layouts, design calls. |
| Neither | **Validation error.** Invisible to the runner and exempt from every gate. |

## How a failure is reported

Three things make a failure actionable instead of merely recorded, and all three
were defects before 2026-10-04.

**1. The row carries its own evidence.** `run()` always captured stderr and stdout;
no caller read either, so a `FAILED-ISOLATED` row said `exit 1` and stopped. Diagnosing
it meant re-running the command by hand, and for a stateful step a re-run is not the
same command twice. The ledger now records the stderr tail (stdout when stderr is
empty), bounded to the last few lines, plus the expectation the step actually carried
(`exited 1, expected 0` is a fact; `exited 1` is half of one). `_no output captured_` is
itself the finding: the failing command produced nothing to diagnose with.

**2. Classification comes from the exit code, and only from the exit code.**

| Exit | Class | Transient | Why |
|---|---|---|---|
| 124 / ETIMEDOUT | `timeout` | `true` | the step outlived `timeout_s`/`step_timeout_s` |
| 127 | `environment` | `false` | the command is not on this machine; a re-run cannot change it |
| 126 | `environment` | `false` | found, but not executable |
| 130 | `interrupted` | `false` | SIGINT reached the step |
| 143 | `terminated` | `false` | SIGTERM reached the step |
| anything else | `code` | `unknown` | the command ran and disagreed with `expect_exit` |

`transient` is a second axis, not a synonym for the class: it answers "is re-running
worth anything". A flaky test and a deterministic failure both exit 1, so `unknown` is
reported rather than guessed (the same rule `classifySkipIf` already follows). A
`transient: false` row **skips its retry and says so in the run log**, which is why a
typo'd command now fails once instead of `retry: 3` times.

**3. A timed-out step dies with its children.** Measured: `spawnSync(..., { shell: true,
timeout })` signals only the shell, so on `sh -c "sleep N & wait"` the backgrounded
process was still running after the runner had already reported ETIMEDOUT. Steps now run
in their own process group (`detached: true`) and the group is signalled on timeout, so a
step that overruns leaves no build or test worker holding a lock. This is the machine
form of the Stalled Subagent & Stale-Writer Guardrail the agent follows by hand.

The ledger's column order is a contract, not a preference: `plan-mark-done.mjs` reads a
row back by **shape** (id-shaped first cell, backticked status last), which is what makes
widening the table safe, and the trace escapes `|` so a compiler's output can never
manufacture a phantom row. A test asserts the widened ledger still parses through
`plan-mark-done`'s own parser.

## State files are written atomically

`pr.registry.json`, `plan.issues.json`, and the plan `.md` that `plan-mark-done.mjs`
rewrites are all written through `scripts/lib/atomic-write.mjs`: temp file in the
target's own directory (same filesystem, so `rename(2)` is atomic), `fsync` before the
rename, then rename, with one generation of `.bak`.

The reason is recovery cost, not theory. All three are gitignored *because* they are
machine-local, so `git checkout` has nothing to restore and a truncated write has no
recovery path outside that machine. A bare `writeFileSync` opens with `O_TRUNC` first, so
a crash mid-write has already destroyed the old bytes by the time it fails.

Atomicity is not a lock, and the module does not pretend otherwise: two concurrent writers
can still interleave, because making that impossible needs a lock file and a stale-lock
policy with its own failure modes. `pr-registry.mjs` guards that case separately with
`assertNoCollisions`, which refuses a duplicate branch or worktree on both load and save.

A `skip_if` that only proves a string is present (`grep -q 'Marker' src/x.md`) is a
false-pass channel: it survives the behaviour being reverted, and `plan-mark-done.mjs`
ticks the task on that claim alone. The runner **rejects it as a validation error**. Use
a command that fails on behaviour: a test invocation, a build, a `git diff` query, a
state check. A `grep` filtering a tool's output (`bun test x 2>&1 | grep -q '...'`) is
fine, because the tool has to succeed first.

The classifier behind that check returns one of five classes: `empty` (nothing claimed),
`sentinel` (the literal `skip_if: "false"`, the documented "this task has no command"),
`behavioural` (runs a tool that has to succeed first), `loose` (reads a file and asserts
a string is in it, and is rejected), and `unknown` (matches neither rule). `unknown` **warns**
rather than errors, naming the task and the command, because 14 such tasks live in plans
belonging to repositories this one does not own and an error here would be one commit
changing someone else's repository. Run `bun scripts/skipif-registry-audit.mjs` for the
current per-plan tally, or `--compare-to-frozen` to see what the live rule changed since
the 2026-09-30 freeze.

## `impacts`: what the task can break, which `files` never asked

`files: { create, modify, test }` names the paths a task **touches**. Nothing in the
contract asked what it **breaks**, so a task could change a shared interface, a public
export shape, a CLI flag, or a documented rule, declare only its own file, and pass every
gate while its consumers stayed broken. `depends_on` cannot close that gap: it orders
tasks *inside one plan*, so a consumer in another module, another plan, or another
repository is not a node and cannot be an edge.

`tasks[].impacts` closes it. Each entry is a surface plus the command or graph query that
shows the impact, so the claim carries its own evidence:

```yaml
- id: T1
  impacts: ["scripts/check-runner-contract.mjs - structural key compare: bun scripts/check-runner-contract.mjs",
            "README.md §Runner contract - bun scripts/check-runner-contract.mjs"]
```

| Plan declares | Runner does |
|---|---|
| `require_impacts: true` + a task with no `impacts` | **Validation error**, naming the task. |
| `impacts: []` | **Validation error.** An empty list claims nothing and proves nothing. |
| `impacts: ["none: <reason> - <command>"]` | Passes. "Checked, nothing downstream" is a real answer, and it names the check (the same discipline as `skip_if: "false"`). |
| An entry with no ASCII ` - ` followed by at least 8 characters of evidence, or with an em dash | **Validation error** under `require_impacts: true`, naming the task and quoting the entry; one aggregated **warning** otherwise. The same shape `backfill-plan-impacts.test.mjs` enforces. |
| `require_impacts` absent | One aggregated **warning** naming every undeclared task, never an error. |
| `allow_no_impacts: [T3]` | Exempts one task. Naming a task that *does* declare impacts is itself an error, so the list cannot become a permanent blanket. |
| `loop_until: "<command>"` on an iterative step | The runner executes it after that step's own `cmd` succeeds. Exit 0 is converged and the step passes; non-zero re-runs the step inside the `retry` budget it already declares, and exhausting that budget is a failure naming `loop_until`. It is a command, never a string match: `grep -q 'Done' src/x.ts` survives the behaviour being reverted, so it reports convergence for work that is not converged. |
| `loop_until` absent | Legal, and the default. A step that does not iterate never runs a convergence check, so every plan that predates the key behaves exactly as before. |
| `loop_until` present but blank or not a string | **Validation error**, naming the task and the step. A condition the runner cannot execute is worse than no condition, because it reads as a claim and enforces nothing. |

Flow-style only (`impacts: ["a", "b"]`). The block form `- "text"` parses as an object
rather than a scalar, so a block-style list reaches the validator as objects where
strings were written, and the validator reports that, naming the form that works,
instead of counting it as a claim.

The prose mirror is §2b of the plan template, an **Affected Surfaces** table with an
evidence column, and the audit is re-run before Step 1 and again at Step 4 of every task.
Where the subagent contract forbids a child from editing outside its chunk, an
`IMPACT: <surface> - <what breaks> - <evidence>` line in the report is the handoff, and the
parent's gather checkpoint requires every such line to have an owner: a task or a `defer:`
backlog line, never a name that reaches no queue.

`validate-skill.mjs` asserts that the plan template and the master skill's plan header both
declare every key the runner reads, comparing the **parsed frontmatter structure** rather
than searching the text. The key list is imported from the runner, so adding an input
without documenting it fails CI. This check exists because the two halves did drift once
with CI green: `files`, `idempotency_key`, `verify_exit`, and `on_precondition_fail` were
all documented and none were read, while `run[]` was read by nothing and documented
nowhere.

This repository's own plans live in `docs/code-plan/plans/`, with
the pre-dispatch batch manifest beside them in `docs/code-plan/`. The
manifests are kept because they record the deviations that were approved during execution,
which is the part a finished plan can no longer explain.
