## 🧠 Adaptive Reasoning Modes

### 🔁 Core Reasoning Lenses

| Mode | Focus | Required output |
|---|---|---|
| 🧭 Intent & Scope | Goal, boundaries, non-goals, and definition of success | Scope, non-scope, assumptions, acceptance criteria |
| 🔎 Investigative & Evidence | Current repository, documentation, tests, history, and runtime facts | Findings, source references, baseline, confidence |
| 💻 Computational | Decomposition, patterns, abstractions, algorithms, data, and evaluation | Inputs/outputs, contracts, invariants, transitions, complexity, and test cases |
| 🧩 Analytical | Components, dependencies, constraints, and impact | Task decomposition, dependency map, affected surfaces |
| 🕸️ Systems & Contract | Boundaries, interfaces, consumers, data flow, and lifecycle | Architecture model, interface contract, MANDATORY Mermaid diagram for every plan (see Visual Implementation Map) |
| ⚔️ Critical & Adversarial | Assumptions, contradictions, blind spots, misuse, and failure | Risks, counterexamples, rejected interpretations, failure modes |
| 🧪 Behavioral & Test-First | Observable behavior and regression boundaries | Failing test, test matrix, expected behavior, regression scope |
| ✅ Evidence & Reflection | Whether the result actually satisfies the request | Self-review, traceability, verification evidence, unresolved gaps |

### 💻 Computational Thinking
- For changes involving logic, data, state, or workflow, decompose the problem into inputs, processing, outputs, and independently testable units.
- Identify existing patterns without copying accidental behavior. Define abstractions, boundaries, interfaces, preconditions, postconditions, invariants, and ownership.
- Specify the algorithm or state transitions, including ordering, branching, loops, retries, termination conditions, failure paths, and data mutation.
- Evaluate correctness, edge cases, time complexity, space complexity, latency, and maintainability when relevant to the scope.
- Produce a MANDATORY Mermaid diagram for every plan, plus pseudocode or a data-flow/state model when it materially improves understanding. Derive tests from the behavior and boundaries, not from one observed example.

### 🎛️ Conditional Reasoning Lenses

| Mode | Activate when | Required output |
|---|---|---|
| 💡 Creative & Convergent | Several viable designs or new behavior are possible | 2–3 alternatives, trade-offs, and one recommendation; criteria and a weight for each, written before the alternatives are scored, then an alternative-by-criterion score table with the weighted total; the recommendation names the criterion that decided it |
| 🔐 Security & Privacy | Auth, permissions, secrets, network, PII, or sensitive data are involved | Threats, trust boundaries, allowed/denied paths, data controls |
| 🔄 Compatibility & Migration | API, IPC, schema, database, event, or file format changes | Consumer impact, versioning, migration order, rollback, data preservation |
| 🚀 Operational & Recovery | Runtime, production, deployment, or infrastructure is affected | Observability, rollout, health signal, rollback, recovery, post-deploy check |
| 🎨 User-Centered & Accessible | UI, UX, localization, or user workflow changes | User states, accessibility, responsive, localization, and recovery behavior |
| 📈 Performance & Cost | Resource use, scale, latency, throughput, or spend is a material risk | Budget, measurement method, bottleneck hypothesis, and acceptance threshold |
| ⏳ Temporal & State | Async work, queues, retries, caching, lifecycle, or concurrency is involved | State model, ordering, race conditions, timeout, retry, and termination rules |
| 🧰 Reproducibility | Environment, dependency, fixture, or external service affects results | Versions, setup, fixture, command, expected output, and environment boundary |
| 🏷️ Epistemic & Provenance | External entities, new libraries/APIs, or past decisions referenced | Entity verification, source freshness, Human vs Assistant commitment attribution |

> **The 💡 Creative & Convergent output is not verified by anything.** That row asks for 2–3 alternatives, trade-offs, and one recommendation, and no test, lint, or runner step checks whether the alternatives are real, whether the trade-offs are honest, or whether the recommendation follows from them. Two spikes were opened to give it a check and both were closed without one: `2026-09-30-jev-decision-gate-spike.md` F6 was closed `corpus not viable` because the workspace holds 4 within-set alternative pairs and **0 near-duplicates** (`docs/code-plan/spikes/2026-09-30-jev-dedupe-corpus-spike-report.md`), so there is nothing to measure a dedupe model against; the earlier F1 was dropped for the same reason. Do not assume a gate exists downstream. The check on this row is the human reading it immediately after, and that is the whole of it.
>
> Design It Twice (below) adds no automated check either. What it changes is that, for interface or module shapes, the alternatives are independent by construction: separate sprites draft them under different constraints without seeing each other. The human reading stays the check.

### ✌️ Design It Twice
Use this for the 💡 Creative & Convergent row and Architectural step 4 when the alternatives are interface or module shapes. A first design is rarely the best one, and alternatives drafted by the same mind tend to be variations of it.
1. Frame the problem for the user: the constraints any interface must meet, and each dependency with its category (in-process, local-substitutable, remote but owned, true external). Show the framing, then dispatch without waiting.
2. Dispatch three or more research sprites in parallel (`timid`, `aqua`, then wrap around to `timid`), each asked for a radically different design. Each gets its own brief (paths, coupling, dependency categories, glossary terms) and one constraint: a minimal interface of one to three entry points; maximal flexibility; the most common caller made trivial; ports and adapters for dependencies that cross the seam.
3. Each sprite returns the interface (types, methods, invariants, error modes), a usage example, what the interface hides, its dependency strategy, and its trade-offs.
4. Compare the designs on depth, locality, and seam placement (how much each interface hides, where a later change lands, where the boundary sits) as an alternative matrix with the criteria and weights fixed first, then recommend one. A hybrid is allowed when parts combine well.
