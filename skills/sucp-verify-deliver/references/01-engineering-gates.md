### 🔗 Requirements Traceability
- Give each acceptance criterion a stable identifier such as `AC-1`, `AC-2`, and `AC-3`.
- Map every criterion to the task that implements it, the test or check that exercises it, and the evidence that proves it.
- A requirement without a task, a test/check, or final evidence is incomplete even when the build passes.

### 👀 Review, Diff & Publication

- Autonomous Code Review Rubric & 8-Point Bug Qualification Filter: reviewer agents emit this contract via `templates/code-review-template.md`.
  - An issue is a genuine review bug ONLY if it meets all 8 qualification criteria:
    1. It meaningfully impacts accuracy, performance, security, or maintainability.
    2. It is discrete and actionable (not an amorphous codebase critique).
    3. It does not demand a level of rigor absent from the rest of the repository.
    4. It was introduced in the active commit/diff (pre-existing debt is ignored).
    5. The original author would appreciate fixing it upon notice.
    6. It does not rely on unstated assumptions about intent.
    7. Sibling callers or consumers are provably affected (speculative disruption is banned).
    8. It is clearly not an intentional author design choice.
  - Priority Classification: Tag every finding title with its priority level: `[P0]` (drop everything, blocking release/operations), `[P1]` (urgent, fix next cycle), `[P2]` (normal, fix eventually), `[P3]` (low, nice to have).

  - Review Comment Geometry: Body must be at most 1 concise paragraph; code chunks capped at 3 lines maximum; line ranges pinpointed to 5–10 lines maximum.
  - Deterministic Correctness Verdict: Conclude every code review with an explicit binary verdict: `correct` (patch will not break existing code/tests and is free of blocking defects) vs `not correct`.
  - Exhaustiveness: return EVERY qualifying finding, not the first one that qualifies. Deduplicate by changed location and by defect/remedy pair before reporting. If nothing qualifies, return none rather than padding the list with a nitpick.
  - Confidence & Remedy Discipline: state a confidence level per finding. A review reports findings; it does not ship the fix unless the user asks for one.
  - Instruction Precedence for Rule Attribution: resolve guidance in order of `AGENTS.override.md`, then `AGENTS.md`, then any configured fallback filename, walking from the repository root down to the changed file. The most specific applicable file wins, and explicit user instructions about review scope or style override repository files.
  - Suggestion Blocks: emit a suggestion block only for a concrete, minimal replacement that preserves leading whitespace and surrounding indentation. Never place commentary inside one.
- Two-Axis Review: the final review dispatches two `staid` reviewers in parallel, and neither sees the other's report, so a pass on one axis cannot hide a failure on the other.
  - Standards reviewer: applies the rubric above unchanged (the 8-point filter, rule attribution, `P0` to `P3`).
  - Spec reviewer: compares the diff with the approved spec, the plan's acceptance criteria, or the Bounded design checklist, and quotes the spec line behind every finding. It reports missing or partly built requirements, requirements built wrongly, and scope creep (behaviour nobody asked for), with the priorities in the Spec Axis table of `templates/code-review-template.md`. With no spec to compare against, it reports "no spec available".
  - The parent shows the two reports side by side, each in its own order; findings are never reranked or merged across axes. The verdict is `not correct` when either axis holds a `P0` or `P1`.
  - The Requirement-by-Requirement Completion Audit stays the parent's own check; the Spec reviewer does not replace it.
- Design notes: the Standards reviewer also reads the diff against the twelve-smell baseline in `templates/code-review-template.md`. A design note names a possible smell and the hunk it points at, sits only under Design Notes (non-blocking), carries no priority, never changes the verdict, and is never posted to the PR. A documented repository standard overrides a smell, and anything a linter, formatter, or type checker already enforces is skipped. The baseline is codified in that template and cannot block, so a design note is not a finding and does not breach the Repository Rule Attribution Invariant. The Step 6 debt sweep harvests the notes.

### 🚦 CI, Test Layers & Quality Gates
- Run the repository's required checks for the affected surface. Start with focused tests and expand to required integration, contract, lint, type, build, or package checks as the scope demands.
- Browser end-to-end and visual suites (Playwright, Chromium, pixel compare, `test:e2e`, `--dengan-e2e`, `E2E=1`) are off on the owner's machines (owner decision 2026-10-29: too slow). Do not run them, add them to a gate, or write them into a plan unless the user explicitly asks in this session; the repository gates already skip them by default.

- Checks run **locally in the agent's own session**, on the machine that holds the real working tree, the real vault, and the real service databases. A check that only runs on a remote runner cannot see that state, so a green remote result is not evidence about the thing being changed. Declare the checks complete only from local output, and quote the command and its exit code.
- Do not treat a hosted CI service as the executor, and do not push in order to make a remote pipeline run. Pushing to trigger someone else's runner converts a local verification problem into a remote one that costs the user's compute budget and still cannot see local state. If a check genuinely cannot run locally, report the boundary instead of relocating it.
- Select the test layer that matches the risk: unit tests for local logic and integration or contract tests for boundaries; browser end-to-end only on an explicit user request (see above). Do not substitute a passing lower-level test for a required boundary check.
- A failed required check blocks a completion claim. If an environment failure prevents verification, report the exact boundary instead of treating the check as passed.
- Zero-Tolerance Clean Pass: A passing run must be clean. Test output must report 0 failures and lint/type/build output 0 errors and 0 warnings. A single failure or warning in the affected surface is not a pass, and it may not be explained away as cosmetic or silenced with a suppression; resolve it and re-run until the run is clean before claiming completion. Distinguish pre-existing warnings outside the changed surface from new ones, and report any pre-existing warning explicitly as a follow-up rather than carrying it as part of the deliverable.

### 🔐 Security, Compatibility & Operations
- Treat authentication, authorization, input validation, secret handling, dependency changes, and sensitive data flows as explicit review surfaces.
- For API, IPC, schema, database, event, or file-format changes, enumerate consumers and decide whether compatibility, versioning, migration, backfill, rollback, and data preservation are required.
- For production-impacting changes, define what should be observed, how rollout is controlled, how failure is detected, how rollback works, and what post-deployment check proves the change is healthy.
- Update documentation only where the approved behavior, setup, configuration, API, migration, or operational procedure changes.

### ✅ Definition of Done & Plan Lifecycle
- Define `Definition of Done` for the approved scope before implementation. It must identify the applicable acceptance, implementation, test, review, security, documentation, and operational gates.
- Track plan status as `Draft → Approved → In Progress → Verification → Complete`, or `Blocked` when progress cannot continue without user input or an external change.
- Plan Completion Saturation Rule: when execution finishes, every task in the approved plan reaches `Done 100%` with cited evidence. A task left at 90%, "mostly done", or "done except the tests" is not a task state; it is either finished and evidenced, or `Blocked`/`DEFERRED` with a named reason. Never hand back a plan whose own scope is partially complete while claiming the plan is finished.
- Definition-of-Done scope boundary: `Done 100%` covers exactly what the approved plan defined. Anything discovered outside that scope belongs to the Step 6 debt sweep as a follow-up candidate, so plan completion is never inflated into unrelated cleanup.
- Plan status flips to `Complete` only after the Step 6 debt sweep has run, every remaining item is either resolved in-session or explicitly deferred with a `defer: <ceiling>, <upgrade-trigger>` marker, and the owner answered the `Close plan` gate with `Mark Complete` on the evidence of `bun scripts/plan-closeout.mjs --readiness` (`sucp-debt-sweep`, 6.5.5). A plan kept open carries a `## Closeout status` section instead. A plan is never closed while unexamined technical debt is still sitting in the task state.
- Before the `Close plan` gate, the task steps are ticked from evidence: `bun scripts/ultra-plan-runner.mjs <plan.md> --execute > runner.log` saves the runner log the subagent path never writes (the runner prints to stdout), then a second command, `bun scripts/plan-mark-done.mjs <plan.md> --from runner.log`, ticks the tasks it records as passed. `plan-closeout.mjs --readiness` and the `state merged` gate refuse a plan with an open task step box (`sucp-debt-sweep`, 6.5.5); boxes outside task sections are listed as other open boxes and ticked by hand with evidence.
- Record plan version, approval state, changed decisions, superseded sections, and the reason for each scope or contract change.
- A completion claim requires every applicable gate to pass or an explicit, documented risk acceptance from the authorized human partner.

### 🧰 Reproducibility & Environment
- Record the runtime, language, package manager, dependency, operating-system, database, service, and tool versions that materially affect the implementation or verification.
- Record setup prerequisites, environment variables by name without exposing secret values, exact commands, fixtures, seed data, and expected outputs needed to reproduce the result.
- Keep dependency manifests and lockfiles synchronized. Explain new dependencies, rejected alternatives, license impact, size/performance impact, and removal or upgrade considerations.
- Distinguish a repository failure from a local environment limitation. Do not claim reproducibility when the required environment or dependency is unavailable.

### 🧪 Test Reliability & Failure Classification
- Prefer deterministic, isolated tests with controlled fixtures, stable clocks, explicit cleanup, and no dependence on execution order or external state unless the test is specifically an integration test.
- When a test is flaky, classify the cause, capture evidence, and report the affected scope. Do not hide flakiness with unbounded retries or weaken assertions.
- Classify failed checks as code failure, test failure, contract failure, environment failure, infrastructure failure, or unrelated pre-existing failure. The classification must be supported by evidence.
- Retry only transient failures with a bounded policy. A retry is additional evidence, not proof that the original failure was irrelevant.
- **The runner classifies what the exit code proves, and reports the rest as unknown.** `scripts/ultra-plan-runner.mjs` resolves a failed step into `timeout` (124 or ETIMEDOUT), `environment` (127 absent, 126 not executable), `interrupted` (130), `terminated` (143), or `code`, with `contract` reserved for the runner's own pre/postcondition failures. `transient` is a separate axis: `true` only for a timeout, `false` only where a re-run provably cannot help (so a 127 fails once instead of twice, visibly), and `unknown` for the ordinary exit 1, because a flaky test and a deterministic failure are indistinguishable from an exit code. **Classify from evidence; never guess, and never report a guess as a class.** A missing binary filed as a code failure sends triage to the wrong place, which is the whole cost of the guess.
- **A failure row carries its own evidence.** The Error Ledger records the command's stderr tail (stdout when stderr is empty), bounded to the last few lines, plus the expectation the step actually carried. A row that states only "exit 1" cannot be acted on without re-running the command, and re-running a stateful step is not the same command twice. When the ledger says `_no output captured_`, that is itself the finding: the failing command produced nothing to diagnose with.
- **A timed-out step is terminated with its children.** `spawnSync` signals only the shell it spawned; measured on `sh -c "sleep N & wait"`, the backgrounded process outlived the reported ETIMEDOUT. The runner therefore runs steps in their own process group and signals the group, so a step that overruns `step_timeout_s` leaves no build or test worker holding a lock. This is the machine form of the Stalled Subagent & Stale-Writer Guardrail below, which the agent follows by hand.

### 🚀 Rollout, Observability & Recovery
- Deployment method default: deploy through the active repository's direct deployment script (e.g. `<deploy script>`) unless the user explicitly asks for CI, a workflow, or a pipeline to perform the deployment. Do not route a deployment through CI/CI-triggered jobs by default; treat CI-driven deployment as an explicit user choice.
- For production-impacting work, define the rollout mode, owner, health signal, success threshold, observation window, rollback trigger, and rollback owner before deployment.
- Prefer staged rollout, feature flags, canarying, or a reversible migration when the change has meaningful blast radius and the platform supports it.
- Define logs, metrics, traces, health checks, alerts, and user-visible signals needed to detect both failure and silent degradation. Avoid logging secrets or unnecessary personal data.
- For data or infrastructure changes, verify backup availability, restore procedure, migration rehearsal, rollback limits, and data integrity before applying the production change.
- After deployment, run the documented post-deployment check and record the result, timestamp, version, and any follow-up action.

### 🛡️ Privacy, Data Governance & Supply Chain
- Classify data before changing its collection, storage, transmission, display, export, or retention. Minimize collection and restrict access to the smallest required scope.
- Review redaction, deletion, retention, audit trail, encryption, and user-consent behavior when personal, confidential, or regulated data is involved.
- For dependencies and release artifacts, review lockfile changes, known vulnerabilities, license compatibility, integrity checks, provenance, and whether generated artifacts contain unintended content.

### 🌐 User-Visible Completeness
- For user-facing changes, define and verify the normal path plus loading, empty, error, retry, recovery, offline, permission-denied, and destructive-confirmation states that apply.
- Verify keyboard operation, focus behavior, semantics, contrast, screen-reader exposure, responsive layouts, localization, text expansion, and reduced-motion behavior when applicable.
- Treat WCAG 2.2 Level AA as the default accessibility target for web interfaces and user-facing flows, mapping applicable success criteria to acceptance criteria and verification evidence; document an explicit exception when the platform or approved design makes a criterion inapplicable.
- Preserve existing design-system, platform, accessibility, and localization conventions unless the approved design explicitly changes them.
