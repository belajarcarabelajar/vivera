### Plan and task templates

Plan header template:
```
---
schema: ultra-plan/v1
plan_id: YYYY-MM-DD-<feature-name>
status: Draft            # Draft|Approved|InProgress|Verification|Complete|Blocked
version: 1              # schema stamp for the plan FORMAT. No runner reads it; `schema:` above is what the runner enforces. `bun run contract:check` reports it on purpose.
runner_contract: true
defaults:
  retry_transient_max: 1            # explicit integer, never the word "bounded"
  step_timeout_s: 120               # per-step hang guardrail
  on_precondition_fail: stop-task-continue-independent   # or: halt-plan
  allow_loose_skip_if: []            # task ids grandfathered from the skip_if probe ban
  require_impacts: true              # every task must declare the surfaces it can break
  allow_no_impacts: []               # task ids exempted from impacts; a stale name is an error
  retry_if: any                      # any | transient; an unrecognised value throws
tasks:
  - id: T1
    depends_on: []                  # DAG edges: `A --> B` means B depends_on A; must match Mermaid
    impacts: ["<surface> - <the command or graph query that shows the impact>"]   # flow-style only
    files: { create: [exact/path.ext], modify: [], test: [exact/path.test.ext] }
    idempotency_key: "T1:exact/path.ext"
    skip_if: "<verification command>"  # exit 0 = already done → SKIPPED-IDEMPOTENT
    verify_exit: 0
    run:                            # the steps the runner executes
      - cmd: "<failing-test command>"
        expect_exit: 1              # RED, before any implementation
        retry: 0
      - cmd: "<verification command>"
        expect_exit: 0
        retry: 1
        loop_until: "<convergence check>"  # exit 0 = converged; optional, and only on a step that iterates
        timeout_s: 600              # optional; this step's own budget in s, replaces step_timeout_s
  - id: T2
    depends_on: [T1]
    files: { create: [exact/path2.ext], modify: [], test: [exact/path2.test.ext] }
    idempotency_key: "T2:exact/path2.ext"
    skip_if: "<verification command>"
    verify_exit: 0
    run:
      - cmd: "<failing-test command>"
        expect_exit: 1
        retry: 0
      - cmd: "<verification command>"
        expect_exit: 0
        retry: 1
---
# [Feature Name] Implementation Plan
> For agentic workers: REQUIRED EXECUTION METHOD: delegated task execution (recommended) or inline plan execution. Steps use checkbox syntax.
**Goal:** [one sentence]
**Architecture:** [2-3 sentences]
**Tech Stack:** [key technologies]
**Active Project Profile:** [repository root, target scope, toolchain, configuration sources, and revision]
**Project Commands:** [verified test, lint, type-check, build, package, migration, and deploy commands]
**Protected Boundaries:** [locked contracts, generated files, protected paths, and project-specific constraints]
**Spec:** [path to spec]
**Scope:** [included behavior and surfaces]
**Non-Goals:** [explicitly excluded behavior]
**Visual Map:** [MANDATORY Mermaid diagram(s): at least one flowchart mapping every task id, dependency edge, gate, and Verify step. Every diagram MUST also declare `accTitle:` and `accDescr:` right after its diagram-type line.]
**Reasoning Lenses:** [selected core and conditional lenses with their required outputs]
**Acceptance Criteria:** [observable conditions that define success]
**Traceability:** [acceptance criterion → task → test/check → evidence]
**Assumptions & Open Questions:** [resolved assumptions and questions that remain]
**Dependencies & Impact:** [dependencies, interfaces, migrations, and affected consumers]
**Risks & Rollback:** [known risks and recovery/rollback approach]
**Security & Compatibility:** [security surfaces and compatibility decision]
**Operations & Rollout:** [observability, rollout, post-deploy check, and rollback]
**CI/Review Gate:** [required checks and review status]
**Documentation:** [docs, examples, changelog, or runbook updates]
**Definition of Done:** [applicable gates and final completion conditions]
**Plan Status & Version:** [Draft/Approved/In Progress/Verification/Complete/Blocked and version]
**Reproducibility:** [runtime/tool versions, setup, fixtures, commands, and expected outputs]
**Test Reliability:** [determinism, isolation, external-state dependencies, and known flakiness]
**Privacy & Data Governance:** [data classification, minimization, retention, access, and audit requirements]
**Dependencies & Supply Chain:** [lockfile, license, vulnerability, integrity, and provenance review]
**UX States:** [applicable loading, empty, error, recovery, accessibility, responsive, and localization states]
**Persistent State & Artifact Storage:** [window.storage key schema, in-memory state, or N/A]
**Entity & Sourcing Verification:** [verified external packages/APIs and documentation freshness]
**Verification:** [commands and evidence required for completion]
## Global Constraints
[project-wide requirements, exact values from spec, one line each]
```
Task template:
```
### Task N: [Component Name]
**Files:**
- Create: exact/path/to/file
- Modify: exact/path/to/existing:line-range
- Test: exact/path/to/test
**Interfaces:**
- Consumes: [exact signatures from earlier tasks]
- Produces: [exact names/types for later tasks]
**Preconditions (assert FIRST; fail-fast, never improvise a substitute):**
- [ ] Upstream: artifact from Task <id> exists at <path> (else abort: `E_PRECOND_UPSTREAM`)
- [ ] Dependency: `<cmd> --version` exits 0 (else abort: `E_PRECOND_DEP`)
- [ ] Input contract: <VAR> defined and satisfies <constraint> (else abort: `E_PRECOND_INPUT`)
- On any failed precondition: STOP this task, do NOT guess a substitute, record it to the Error Ledger, and continue only tasks whose `depends_on` does not include this task.
**Idempotency Check (evaluate BEFORE Step 1):**
- [ ] Skip when the `skip_if` command from frontmatter exits 0 (fresh runtime proof). Mark the task `SKIPPED-IDEMPOTENT` and advance. A `[x]` checkbox alone is never sufficient to skip.
**Behavior & Acceptance:**
- [AC identifier and observable behavior delivered by this task]
**Edge Cases & Failure Behavior:**
- [relevant boundary, error, or fallback behavior]
**Deliberate Shortcuts & Deferrals:**
- [if taking a deliberate simplification, specify: `defer: <ceiling>, <upgrade-trigger>`, or `None`]
**Dependencies & Risks:**
- [dependency or risk that affects this task]
**Review & Evidence:**
- [review point, test/check, and evidence produced by this task]
**Reasoning Output:**
- [algorithm, dependency, risk, UX, compatibility, or operational result relevant to this task]
**Test Data & Determinism:**
- [fixture, isolation, cleanup, clock, external-state, and retry behavior]
- [ ] Step 1: Write failing test [code]
- [ ] Step 2: Run: verify fail | cmd: `<single runnable command>` | expect: exit <non-zero> | retry: 0 | on_fail: n/a (failure is expected here)
- [ ] Step 3: Write minimal implementation [code]
- [ ] Step 4: Run: verify pass | cmd: `<single runnable command>` | expect: exit 0, 0 failures | retry: 1 (transient only) | on_fail: mark task FAILED, write Error Ledger, halt only downstream tasks (those with this id in `depends_on`); independent tasks keep running
- [ ] Step 5: Commit: the PARENT commits, never a subagent. Stage by explicit path, never `git add .`, and never on the base branch: `git add <exact/path> && git commit -m "<conventional message>"`. The branch and worktree come from `bun scripts/pr-registry.mjs claim`, so this task's work lands on the session's single PR rather than a per-task branch.
```
Test-later mode (`sucp-tdd-debug` 4.2, owner's request only) changes the plan in three places:
- The body carries the line `Mode: test-later` (a body line, not a frontmatter key). The overnight entry gate (`sucp-overnight`, check 6) reads it and refuses the plan.
- A `## Manual check` section lists the owner's notes as `MC1`, `MC2`, ... in the owner's words.
- Each task's `run[]` and `skip_if` hold the test command written in 4.2 step 4, with no `expect_exit: 1` RED step, because the tests come after the code. Task Steps 1 and 2 drop out; the red proof is the run against the base (4.2 step 5), recorded with its exit codes under **Review & Evidence**.
