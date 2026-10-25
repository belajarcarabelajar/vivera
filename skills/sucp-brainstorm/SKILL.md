---
name: sucp-brainstorm
description: Phase skill for super-ultra-code-plan Step 2 (path process). Covers the Spike, Bounded, and Architectural brainstorm paths, the reasoning lenses, task-to-mode routing, and the deep research workflow with graphify and TinyFish. Load only from super-ultra-code-plan, after Step 1 classification.
---

# Brainstorming and Research

> Part of `super-ultra-code-plan`. The orchestrating agent reads `sucp-rules` too; a subagent follows the Rules card of its role instead. Next phase after design approval: `sucp-plan`.

## 📚 Load on demand

The core rules in this file are always loaded; a reference file is read in full whenever its trigger below applies.

| Reference | Read it |
|---|---|
| [01-reasoning-lenses.md](references/01-reasoning-lenses.md) | When selecting reasoning lenses for a task, or writing the Reasoning Lenses line of a plan. |
| [02-deep-research.md](references/02-deep-research.md) | Before deep research, a graphify preflight, or any web retrieval with TinyFish. |

## 🧠 Adaptive Reasoning Modes
Activate only the reasoning lenses relevant to the task. Always use the core lenses; add conditional lenses when the scope or risk requires them. Do not expose private chain-of-thought. Report the selected lenses through their conclusions, assumptions, decisions, risks, artifacts, and evidence.

Core lenses, computational thinking, conditional lenses, and Design It Twice: [references/01-reasoning-lenses.md](references/01-reasoning-lenses.md).

### 🧭 Task-to-Mode Routing

| Task path | Activate first |
|---|---|
| Spike | Intent, investigative, critical, computational when logic is involved, evidence |
| Bug fix | Investigative, computational, failure-oriented, behavioral/test-first, verification |
| Bounded change | Intent, investigative, analytical, computational when applicable, test-first, verification |
| Architectural change | All core lenses plus creative, systems, trade-off, and applicable security/compatibility/operations lenses |
| UI/UX change | Intent, investigative, user-centered/accessibility, systems for stateful flows, test-first, verification |
| API/data change | Computational, systems/contract, compatibility/migration, security/privacy, test-first, verification |
| Production change | Investigative, critical, security/privacy, operational/recovery, reproducibility, verification |

Deep research workflow, graphify preflight, and TinyFish web evidence: [references/02-deep-research.md](references/02-deep-research.md).

## Step 2 — Path Process

### 🧭 Epistemic Invariant: Two Kinds of Unknowns
Treat unknown elements according to their epistemic nature before asking the user:
1. **Discoverable Facts (Repo/System Truth)**: Explore first.
   - Run targeted non-mutating searches, inspect entrypoints, configs, schemas, types, constants, and recent commits.
   - Strictly prohibited: asking the user questions that the codebase or runtime environment can directly answer (e.g. "where is this struct defined?", "which UI library is used?").
   - Ask only if multiple equally valid candidates exist or the repo lacks the required external domain context, and present concrete discovered candidates with a recommended default.
2. **Preferences & Tradeoffs (Undiscoverable)**: Ask early.
   - Requirements, business priorities, architectural choices, and aesthetics cannot be derived from code inspection.
   - Formulate focused questions offering 2–4 mutually exclusive options plus an explicit recommended default.
   - The recommended default states its basis in one line (`Why:`), as the Confirmation Protocol requires, and says `Why: my judgment` when there is no verified basis.
   - If unanswered or ambiguous, proceed with the recommended default and record it as an explicit assumption in the plan. This applies to a clarifying preference question, never to a catalog gate.
   - Frontier grilling: model the open decisions as a design tree, where settling one decision opens the ones that depend on it. The frontier is every open decision whose prerequisites are settled. Ask the whole frontier each round through the question tool, at most 4 questions per call and several calls in the same round when the frontier is larger.
   - A question whose answer depends on another open question waits for the next round. After each round, recompute the frontier from the answers.
   - Facts the frontier needs go to fact-finding subagents. Only the questions downstream of a pending lookup wait for it; the rest of the frontier is asked now.
   - The session is done when the frontier is empty and nothing is silently assumed: a default taken is recorded as an assumption, so it is not silent.
   - Interactive Elicitation Protocol: Use structured options when understanding user preferences, constraints, or goals before providing advice or plans. Each question offers 2–4 concise, mutually exclusive options, and the frontier rule above sets how many questions a round asks. Negative Triggers (when NOT to offer structured options): (1) user asks "A or B" (requires AI analysis/recommendation, not options echoed back); (2) user already provided concrete constraints or detailed prompt (proceed with constraints and state assumptions inline); (3) factual questions, emotional processing, or code review prose; (4) answer is already present in conversation history or discoverable in code ("Homework First" invariant). These options are asked through the Confirmation Protocol (the harness question tool, never plain chat text).
3. **Visual & Artifact Specifications (Render, Don't Describe)**:
   - Specification Triggers: When the user provides a specification—a noun phrase describing a visual or structural artifact (e.g. "comparison table of REST vs GraphQL", "state machine for order lifecycle", "contact form layout")—the spec is the request. Render the artifact directly rather than describing it in prose.
   - Request Evaluation Checklist: (Step 0) Does the request need a visual at all? (Conveys spatial, architecture, or lifecycle flow vs text prose); (Step 1) Is a connected tool or MCP a category match? (Match category, not style preference; never subdivide categories to bypass tools); (Step 2) Did the user ask for a file? (Write to disk + present); (Step 3) Default inline visualizer (render Mermaid/SVG).

### 🛡️ Plan Mode Invariant: Strict Non-Mutation
- In any planning or design phase, mutating tools (file edits, writes, deletions, commits) are strictly locked.
- Sandbox Enforcement Mapping: the active sandbox is the mechanical form of this invariant. `read-only` permits planning and inspection only; `workspace-write` confines edits to the working directory and declared writable roots; `full access` relaxes the filesystem limit but never the plan-mode lock or the human approval gate. Any write outside the writable roots needs explicit approval, and a harness denial is evidence to report, never a route to work around.
- Non-mutating exploration is encouraged to ground the plan in reality.
- Imperative user language during planning ("fix it now", "execute") must be treated as an instruction to *plan the execution*, not mutate code, until the plan is approved and plan mode concludes.
- `<proposed_plan>` Encapsulation & Complete Replacement Protocol:
  - Wrap final implementation plans in `<proposed_plan>...</proposed_plan>` tags.
  - If the user requests modifications, any revised plan must be emitted as a *complete replacement* (`<proposed_plan>`) rather than an ambiguous partial delta.

### 📖 Project Glossary and ADRs
- Read the target repository's `GLOSSARY.md` when present, and use its terms in questions, the design, and test names.
- Challenge a term that conflicts with the glossary as soon as it appears. Propose one precise term for a fuzzy or overloaded one.
- Cross-check the user's claims about current behavior against the code, and surface a contradiction instead of picking a side silently.
- Show each resolved term in chat as it settles. The Plan Mode Invariant forbids writes during the design, so resolved terms are written together with the design doc at Architectural step 6. When at least one term was resolved, create `GLOSSARY.md` at the repository root in that step; when the repository already keeps a project glossary, extend that file instead of adding a second one. It holds terms and their meanings only, no implementation details or decisions.
- The Bounded path has no design doc, so its short design lists `GLOSSARY.md` under files touched whenever a term was resolved, and the terms are written as the first edit after the `Design` gate.
- Offer an ADR (`templates/adr-template.md`) only when a decision is hard to reverse, surprising without context, and the result of a real trade-off. If any of the three is missing, skip it.

### Spike
1. Explore project context — minimum to frame probe
2. Present question + probe plan (2-3 sentences)
3. Get approval through the Confirmation Protocol (header `Probe`)
4. Investigate — cheapest method preserving correctness
   Prototype code lives under `docs/code-plan/spikes/<spike-id>/` next to the report, which links to it. It is exempt from the temp-file purge, so it stays a primary source, and it states the question it answers at its top.
   Logic goes in a pure module (no I/O, no UI) that can be lifted into the real code. A UI question is answered with several clearly different variants on one route, switched by a parameter.
5. Report recommendation: label built code as a prototype, kept under `docs/code-plan/spikes/<spike-id>/` and never merged as product code; include a MANDATORY Mermaid diagram (hypothesis → probe → outcome → decision, per spike-report-template §1b)
### Bounded
1. Explore project context — files, docs, recent commits
2. Ask clarifying questions through the Confirmation Protocol in frontier rounds (see Two Kinds of Unknowns), only ones that matter
3. Present short design in chat: MANDATORY Mermaid diagram (even a 3-node `flowchart LR`), approach, files touched (including `GLOSSARY.md` when a term was resolved), testing plan (with a `Mode: test-later` line when the owner asked for `sucp-tdd-debug` 4.2), itemized pre-execution todo checklist (`[ ]`), and the delivery. The Bounded design names the pull request as its deliverable, so no separate Publish question follows.
4. STOP and ask through the Confirmation Protocol (header `Design`); implement only after the answer is Approve. For Bounded work the plan is validated before the Design question, so one call approves both: when step 6 requires a plan file, it reaches `Validation: OK` first, its path goes in the design, and this call is also Gate 2.
5. Implement: chunk the checklist into small verifiable units, fan out to subagents, then gather and synthesize their reports; TDD applies (4.2 of `sucp-tdd-debug` when the design says `Mode: test-later`)
6. Size Rule — the plan file is required exactly when the work is too big to hold in one checklist:
   - **One task, one file, no dependency:** no plan file. The in-chat Mermaid diagram and the `[ ]` checklist are the plan. Writing a file here is ceremony the skill already promised to scale away.
   - **Two or more tasks, any `depends_on` edge, or anything a subagent will own:** write a real plan to `docs/code-plan/plans/YYYY-MM-DD-<name>.md` with `ultra-plan/v1` frontmatter, and validate it with `bun scripts/ultra-plan-runner.mjs <plan.md>` before the `Design` question in step 4. The point is not the document; it is that the runner can then check the DAG, the Mermaid contract, and each task's `run[]`/`skip_if` hook mechanically. A Bounded task that fans out to subagents with no runner behind it is the least-checked work in the whole pipeline.
### 🧠 Architectural — Brainstorming → Design
1. Phase 1 — Ground in Environment: Non-mutating exploration of project context, configs, dependencies, and architecture before asking questions.
2. Phase 2 — Intent Chat: Clarify goal, success criteria, constraints, and tradeoffs using the Two Kinds of Unknowns protocol.
   Ask in frontier rounds until the frontier is empty, and apply Project Glossary and ADRs as terms come up.
   The phase closes with the intent-lock question (header `Intent`) asked through the Confirmation Protocol.
3. Phase 3 — Implementation Chat: Detail decision-complete architecture (interfaces, data flow, failure modes, acceptance criteria). Must include at least one Mermaid diagram as visual companion (a `flowchart` showing tasks, dependencies, gates, and verification is MANDATORY; add `sequenceDiagram`, `stateDiagram-v2`, or `erDiagram` when they clarify interactions, lifecycle, or data).
4. Propose 2-3 approaches — trade-offs, recommendation, YAGNI applied.
   When the approaches are interface or module shapes, produce them with Design It Twice.
5. Present the design in sections scaled to complexity, and ask approval after each section through the Confirmation Protocol (header `Section`).
6. Write design doc — save to docs/code-plan/specs/YYYY-MM-DD-<topic>-design.md, commit.
   Use `templates/spec-template.md` for its structure, and write the session's resolved terms to `GLOSSARY.md` in the same step.
7. Spec self-review — placeholders, contradictions, ambiguity, scope.
8. User reviews spec: ask through the Confirmation Protocol (header `Spec`); no plan before the answer is Approve.
9. Invoke writing-plans skill — generate decision-complete plan wrapped in `<proposed_plan>` block.
