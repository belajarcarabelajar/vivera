# Execution Lifecycle

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../diagrams/lifecycle-dark.svg">
  <img alt="Execution lifecycle: a request is classified as Spike, Bounded, or Architectural; all paths converge on Brainstorming (Gate 1) then a Visual Implementation Plan (Gate 2 – Hard Human Approval); optional Deep Research with Graphify preflight can inject evidence; execution routes to TDD, Systematic Debugging (4-Phase RCA), or Subagent Orchestration (chunk → proportional fan-out → gather → audit loop); a Verification gate (Gate 3) precedes Finishing and Git Hygiene; session closes with a Debt Sweep and Multi-Select Follow-Up Question; Compaction preserves state across context resets." src="../../diagrams/lifecycle.svg" width="820">
</picture>

<p align="center">
  <em>Execution lifecycle, from a request to a verified delivery and debt sweep.</em>
</p>

## Step by Step

The diagram in eight stages, in order; on the docs site each step highlights its part of the diagram above.

<ol data-stepper="lifecycle">
<li data-nodes="Start Classify PathSpike PathBounded PathArch"><strong>Classify.</strong> A request is classified as a Spike, a Bounded fix (fewer than 2 files), or Architectural work, and each class takes its own path.</li>
<li data-nodes="DesignReport Brainstorm Gate1"><strong>Design.</strong> A spike ends in a report with recommendations, and architectural work brainstorms alternatives and trade-offs until the spec is locked. At Gate 1 a human approves the design or sends it back for revisions.</li>
<li data-nodes="ResearchDecision GraphPreflight DeepResearch"><strong>Research.</strong> Deep research runs only when external information is required: an optional graphify preflight of the codebase, then search, fetch, and synthesize. When the codebase is enough, this stage is skipped.</li>
<li data-nodes="WritePlan HardGate"><strong>Plan.</strong> The visual implementation plan holds a Mermaid diagram, a to-do checklist, and <code>skip_if</code> conditions; a Bounded fix comes straight here. Gate 2 is a hard human approval gate: nothing executes until the plan is approved.</li>
<li data-nodes="ExecRoute TDD Debug ChunkPlan FanOut SubWork Gather AuditChunk ReChunk"><strong>Execute.</strong> A feature or refactor goes to test-driven development, a bug to systematic debugging, and parallel work is cut into the smallest independently verifiable chunks. Chunks fan out to 2 to 4 subagents (at most 15) in isolated workspaces, their reports are gathered and re-verified, and a red chunk is re-chunked and re-dispatched alone.</li>
<li data-nodes="VerifyGate Gate3"><strong>Verify.</strong> Completion needs fresh evidence: a fresh log, exit 0, passing tests, and the VCS diff. When the evidence is insufficient, Gate 3 sends the work back to TDD.</li>
<li data-nodes="GitHygiene DebtSweep AskGate SweepFix Done"><strong>Deliver and sweep.</strong> The work is committed and delivered as a pull request without co-author trailers. A session-close debt sweep harvests 3 to 5 ranked follow-ups and asks which to do; selected items run as real work, and the session ends with zero debt or a documented deferral.</li>
<li data-nodes="Compact"><strong>Continuity.</strong> Compaction or a context reset can come at any point: state, decisions, and evidence are persisted, and work resumes from the last verified checkpoint.</li>
</ol>

## Test-Later Mode

The TDD step normally writes a failing test before any production code. Test-later mode reorders that step for feature work when the owner wants to see the result (a render, a preview, a build, a CLI run) and judge it by hand before any test exists. It moves the tests to the end of the change; it never removes them.

- **Trigger.** Only the owner's own words, such as "kilat", "test belakangan", or "test later". The agent never picks this mode itself. The design (or the plan) carries the line `Mode: test-later`, and approving that gate approves the mode.
- **Scope.** Feature work on the Bounded or Architectural path. Not a bug fix, and not an overnight run.
- **Order.**
  1. Code: implement the approved checklist without RED/GREEN cycles.
  2. Build and show: run the build, render, or preview and show the artifact in chat, not only the command.
  3. Manual check: the owner judges it at the `Manual check` gate, and each thing they report becomes a numbered criterion (`MC1`, `MC2`, ...) in their words. A wrong result loops back to step 1.
  4. Tests from the notes: one test per `MC` item, with the expected value taken from the owner's observation. An item no test can reach stays as manual evidence named in the PR body.
  5. RED against the base: the new tests run in a detached scratch worktree under `/tmp` at the base commit and must fail there, then pass in the session worktree.
- **Delivery.** Verification is unchanged: the pull request still waits for green tests, and its body lists each `MC` item, its test, and the red run against the base.
