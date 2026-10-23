---
name: sucp-plan
description: Phase skill for super-ultra-code-plan Step 3 (writing plans, architectural path). Covers the mandatory visual implementation map, the ultra-plan/v1 plan template, plan publishing, and plan-to-GitHub-issue sync. Load only from super-ultra-code-plan, after the design is approved.
---

# Writing Plans

> Part of `super-ultra-code-plan`. The orchestrating agent reads `sucp-rules` too; a subagent follows the Rules card of its role instead. Next phase: `sucp-tdd-debug`.

## 📚 Load on demand

The core rules in this file are always loaded; a reference file is read in full whenever its trigger below applies.

| Reference | Read it |
|---|---|
| [01-runner-contract.md](references/01-runner-contract.md) | Before writing or validating plan frontmatter: execution hooks, `skip_if`, and every field the runner enforces. |
| [02-plan-templates.md](references/02-plan-templates.md) | Before writing a plan file: the plan header template and the task template. |
| [03-publishing-and-issue.md](references/03-publishing-and-issue.md) | Before running the publisher or `plan-issue-sync`, or when a mirror or an issue disagrees with its plan. |

## 3️⃣ 🗺️ Writing Plans (architectural path only)
> 🗺️ **Component 2 — Plan output:** every task must be independently understandable, executable, and testable.

### 🗺️ Visual Implementation Map — MANDATORY for every plan
- Every plan (Bounded short design in chat AND Architectural plan file) MUST include at least one valid ` ```mermaid` diagram. No exceptions, no `N/A`. A plan without Mermaid is incomplete and blocks the approval gate.
- Minimum: one `flowchart` (TD or LR) placed near the plan overview showing task nodes (`T1`, `T2`, ...), `depends_on` edges, human approval gate(s) (`{{...}}`), and the Verify → Completion tail.
- Choose additional diagram types that match the reasoning when they add clarity: `flowchart` for process and decisions, `sequenceDiagram` for component/user interactions, `stateDiagram-v2` for lifecycle/status, `graph` for architecture/dependencies, `erDiagram` for data relationships.
- Every diagram MUST declare `accTitle:` and `accDescr:` on the lines immediately after the diagram-type declaration. Mermaid emits these as `<title>`/`<desc>` wired to `aria-labelledby`, which is what makes the diagram readable to a screen reader and to an agent that parses the SVG. The title names the diagram; the description states what it shows, in one or two sentences, without restating the node list. A diagram without them is incomplete and fails `scripts/validate-skill.mjs`.
- Keep diagrams free of decoration that carries no information: no gradient fills, no drop shadows, no emoji used as the only label. `accDescr` is the accessible equivalent of visual flourish.
- Label gates and decision points (`{{Gate}}`, `{Decision}`), keep node ids identical to `tasks[].id` frontmatter ids and `Task <id>` headings, and keep node labels consistent with the interfaces, components, files, and acceptance criteria in the plan.
- Before execution, read the plan and walk through the Mermaid diagram: identify the start, sequence, dependencies, branches, approval gates, failure paths, and expected outcome. Compare it with the current repository and approved spec.
- A missing diagram, an unrunnable diagram (mermaid syntax error), or a mismatch between the diagram, plan tasks, spec, or repository is a pre-execution blocker. Update the affected artifact or obtain approval for the changed interpretation before implementing.
- When the plan changes, update the Mermaid diagram and its related task, interface, acceptance, and verification details in the same change.
- Mermaid is a visual companion and a machine-checked contract (frontmatter `depends_on` == Mermaid edges == task headings), not a replacement for exact files, interfaces, acceptance criteria, test steps, commands, or evidence.
- Edge Direction Convention: `A --> B` means B depends on A. Every `depends_on` entry requires exactly one matching arrow, and every arrow between two task nodes must be declared in `depends_on`. `scripts/ultra-plan-runner.mjs` parses the map structurally and enforces both directions, so removing an arrow or adding one without updating the frontmatter fails the gate. Reachability is not a substitute: a transitive path does not satisfy a `depends_on` entry.
- A task id mentioned inside an unrelated label, comment, or second diagram does not count as a node. Node presence is determined by graph structure, not by text search.

Trigger: spec/requirements exist, before touching code.
Assume: engineer has zero codebase context, questionable taste, skilled developer, weak test design.
Save to: docs/code-plan/plans/YYYY-MM-DD-<feature-name>.md
Plan body lives in the file, not the session: write the full plan content into the .md deliverable and keep in-session explanation to a concise summary plus the file path and the key decisions needing approval. Do not paste or narrate the whole plan in chat; when the user wants the details, point to the saved file. In plan/spec review mode, present the file content as the reviewable artifact; the approval question is the Gate 2 bullet below (spec approval, header `Spec`, is in `sucp-brainstorm`).
- Gate 2: after the plan validates (and is published at Draft), show the plan path and a concise summary in chat, then ask approval through the Confirmation Protocol (header `Plan`); do not paste the plan. For Bounded work the Design call is Gate 2 when the plan was validated first (`sucp-brainstorm`), so no separate `Plan` question follows.
  - The summary lists each task with `Blocked by` (the task ids it waits on, or none) and `What it delivers` (the behaviour it makes verifiable), so the owner can judge the granularity.
Scope check: spec covers multiple independent subsystems → split into separate plans, each producing working testable software alone.
File structure: map files before defining tasks. One responsibility per file. Files that change together, live together. Split by responsibility not layer. Existing codebase → follow established patterns; split only files grown unwieldy under current task.
File-size trigger: a source file of imperative logic that exceeds ~500 lines must be split by responsibility during the same task; a single file must not exceed 1000 lines without an explicit `defer: <ceiling>, <upgrade-trigger>` exception. Generated code, fixture/data files, and stylesheets are exempt from the 500-line trigger. Cite the line count when flagging an over-threshold file. The commit gate `bun run size:check` enforces the byte form mechanically: a staged file over 20,000 bytes (5,000 tokens) is refused unless it is exempt (`-size-gate` in `.gitattributes`) or within its ceiling in `scripts/file-size-baseline.json`, so a task that grows a file past it splits the file in the same task.
Task sizing: smallest unit carrying its own test cycle, worth independent review gate. Fold setup/config/docs into the task needing them. Split only where reviewer could reject one task while approving neighbor.
Vertical slices: every task is a tracer-bullet vertical slice, a narrow path through each layer it needs (data, logic, interface, tests) that is verifiable on its own; never one layer per task.
Prefactor first: a refactor that makes the feature easier to add is its own task, and the tasks it unblocks depend on it ("make the change easy, then make the easy change").
Wide refactor: one mechanical change whose blast radius spans the codebase (a rename, a shared type) cannot land green as one slice, so it runs as expand, migrate in batches, contract. The expand task adds the new form beside the old; each migrate batch, sized by blast radius, depends on the expand task; the contract task removes the old form and depends on every batch.
Step granularity: 2-5 min per step.
- Write failing test
- Run — confirm fail
- Implement minimal code
- Run — confirm pass
- Commit
Runner Contract (determinism fondasi): the YAML frontmatter below is the single source of truth for routing, dependency order, retry, and idempotency. Prose and checklists under it explain but must never contradict it. Every `Task N` heading MUST use an `id` identical to its `tasks[].id` in frontmatter and to its node name in the Mermaid map; any mismatch is a pre-execution blocker. Commands inside the plan MUST be directly runnable and wrapper-agnostic (never MCP, rtk or tgrep specific) while still obeying the Mandatory Runtime rule: JS/TS commands are written with Bun (`bun test path`, `bun run lint`, `bun install`), never `npm`/`npx`/`node`. Optional wrappers such as rtk are applied by the runner or harness when present, not baked into the portable artifact.

Runner Contract detail (Frontmatter Must Be Real YAML, Execution Hook Contract, Idempotency Honesty, Declared Fields Are Enforced): [references/01-runner-contract.md](references/01-runner-contract.md).

Plan header template and task template: [references/02-plan-templates.md](references/02-plan-templates.md).

Deterministic step mapping: one execution step maps to exactly one runnable shell command (1-to-1). Never fold multiple non-chained commands into a single step. Each executable step carries `cmd`, `expect` (exit code / count), `retry` (explicit integer, transient-only), and `on_fail` (route, never silent). `retry: 0` means no retry; the word "bounded" is banned in favor of an integer. These four fields live in `tasks[].run[]` in the frontmatter, which is the copy the runner executes; the `- [ ] Step N` checklist in the task body is the human-readable copy of the same steps. When the two disagree, the frontmatter wins and the checklist is the defect.
No placeholders — banned: TBD, TODO, "implement later", "add appropriate error handling", "similar to Task N", steps without code, undefined references.
Plan self-review: spec and acceptance-criteria coverage (every requirement → a task), selected reasoning-lens coverage and outputs, visual-map presence + validity + consistency (at least one runnable Mermaid flowchart; every task id appears as a node; every `depends_on` edge appears in the diagram; missing diagram or mismatch = blocker), non-goals, assumptions, dependencies, risks, rollback, placeholder scan, anti-bloat pruning pass (scan with tags: `delete:` dead/speculative code, `stdlib:` stdlib replacement, `native:` platform feature, `yagni:` single-impl abstraction/unused config, `shrink:` fewer lines; target net line reduction), deliberate shortcut check (all simplifications must include `defer: <ceiling>, <upgrade-trigger>`), type consistency across tasks (signature names must match), and verification evidence. Fix inline, no re-review cycle.
Pre-execution walkthrough: refresh the active project profile and inspect the plan's Mermaid diagram and selected reasoning-lens outputs, then compare every path, dependency, gate, failure branch, contract, command, and acceptance criterion with the current repository and approved spec before starting implementation.
Execution handoff: fan-out is proportional to the work, and the reason for the chosen width is stated at the handoff.
1. Inline for a genuinely atomic task (atomic scope, no subagent tool in this runtime, or inseparable shared state).
2. Two to four subagents for the usual plan: chunk each task into small verifiable units, dispatch, then gather and synthesize their reports.
3. 10 to 15 only for that many disjoint scopes, at most 15 in flight, every chunk with one owner and no two writing the same file.

### 📤 Plan Publishing
> 📤 **Component 2b — Reachability:** a plan that exists only inside a project repository cannot be searched, rendered, or re-read months later. Publishing is a required step of finishing a plan, not an optional convenience.

- **The trigger is "the plan is finished", not "the plan is approved".** Three publishes, in this order:
  1. **Immediately after `bun scripts/ultra-plan-runner.mjs <plan.md>` prints `Validation: OK`, and before requesting approval.** The plan lands in the vault at `status: Draft` while the human is still deciding, so review happens in Obsidian — where they are looking — instead of only in a repository directory they have to go find.
  2. **Again after approval, and before `bun scripts/ultra-plan-runner.mjs <plan.md> --execute`.** The mirror then carries the approved state.
  3. **After execution and after the Session-Close Debt Sweep.** Close the plan in three sub-steps: apply the task ticks, set `status: Complete` only when the owner answers the `Close plan` gate with `Mark Complete` after `bun scripts/plan-closeout.mjs --readiness <plan.md>` (`sucp-debt-sweep`, 6.5.5), publish again. The ticks are applied by `bun scripts/plan-mark-done.mjs <plan.md> --from <runner.log>`, which reads the runner's own recorded statuses and refuses to tick anything the runner recorded as `NEEDS-AGENT`, `READY (dry-run)`, `HALTED-UPSTREAM` or `FAILED-*`. Capture the runner output to a log first; that log is the evidence.

  **The same three steps also drive the GitHub issue mirror**, run immediately after the vault publish of the same step. See `🐙 Plan → GitHub Issue` below. One command runs both: `bun scripts/plan-sync.mjs <plan.md> [--project <key>]` publishes, then syncs the issue, and prints `publish: exit N` and `issue-sync: exit M`, because a file write here and a network write to somebody else's API fail for different reasons. Both scripts stay callable alone.
  **Between steps 2 and 3, sync on delivery as well:** run `plan-sync.mjs` on the session branch's plan when the session PR is opened and after every push that changes the plan, so the issue does not show the approval snapshot through the whole execution. The PR links the issue with `Refs #<n>`, never `Closes #<n>`, because the plan's status closes it.
  Do not skip step 1 because approval feels close. The whole reason the trigger moved earlier is that the authoring and approval window is exactly when a human wants to read the plan, and it is currently the window in which the vault has no copy at all.

Publisher detail (exit codes, the vault mirror, the check) and the one-way GitHub issue mirror: [references/03-publishing-and-issue.md](references/03-publishing-and-issue.md).

- Mandate: you MUST run the publisher from the vivera repository: that is where the publisher and `plans.publish.json` live, whichever project owns the plan. Those two runs are what make "every plan is also in the vault" true rather than aspirational.
