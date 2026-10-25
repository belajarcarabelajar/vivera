# Execution Lifecycle

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../diagrams/lifecycle-dark.svg">
  <img alt="Execution lifecycle: a request is classified as Spike, Bounded, or Architectural; all paths converge on Brainstorming (Gate 1) then a Visual Implementation Plan (Gate 2 – Hard Human Approval); optional Deep Research with Graphify preflight can inject evidence; execution routes to TDD, Systematic Debugging (4-Phase RCA), or Subagent Orchestration (chunk → proportional fan-out → gather → audit loop); a Verification gate (Gate 3) precedes Finishing and Git Hygiene; session closes with a Debt Sweep and Multi-Select Follow-Up Question; Compaction preserves state across context resets." src="../../diagrams/lifecycle.svg" width="820">
</picture>

<p align="center">
  <em>Execution lifecycle, from a request to a verified delivery and debt sweep.</em>
</p>

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
