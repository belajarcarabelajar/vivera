# Vivera: Ultimate All-in-One AI Coding Agent Pipeline

<p align="center">
  <img alt="Vivera, the project's mascot: a smiling short-haired girl in a blue cyberpunk maid outfit with a holographic apron, holding a glowing clipboard tablet in a rainy neon city street." src="docs/images/vivera.jpg" width="100%">
  <br>
  <em>Vivera, a fictional name inspired by Elli from Harvest Moon: Back to Nature.</em>
</p>

A skill pipeline that guides AI coding agents through the whole software engineering lifecycle: **Idea -> Design -> Plan -> Human Approval Gate -> TDD -> Systematic Debugging -> Subagent Orchestration -> Verification -> Finishing -> Session-Close Debt Sweep**.

- **Four gated components.** Brainstorming → Writing Plans → TDD → Verification, with a human approval gate between each one, plus a **Deep Research** path that runs only when a decision depends on information the codebase does not contain. The sub-agent pipeline that carries out the work is mandatory, not a recommendation.
- **One source of truth.** `Super Ultra Code Plan Implementation.md` keeps contextual invariants, safety constraints, and human-approval gates in view for the whole run.
- **Verification is the last gate, not the last step.** Once the plan is `Done 100%` and the evidence is green, the agent harvests every noticed-but-unclosed item from the session, ranks 3-5 follow-ups that can be finished right now, and asks them as multi-select checkboxes in the harness's own prompt widget. The session ends with zero unexamined coding debt.

### Install

```bash
git clone https://github.com/belajarcarabelajar/vivera.git
cd vivera
./install.sh           # installs into every agent harness it detects
./install.sh --check   # prints check: CURRENT and exits 0 when the install is in order
```

Run `./install.sh --dry-run` first to see what it would do without writing anything. Tiers, flags, and the other install channels are in [Quick Start & Installation](docs/guide/getting-started-quick-start-1.md).

### The Harvest Sprites

**Vivera** is a fictional name inspired by Elli, one of the characters in *Harvest Moon: Back to Nature*. The vocabulary around the pipeline borrows from the same game: skills are crops, pull requests are Blue Feather proposals, subagents are the seven Harvest Sprites (watering is keep-alive, animal care is long-lived assets, harvesting is shipping), and the PR registry is the shipping bin. The flavor is cosmetic; every command, path, and behavior in this document is literal. See [The Vivera Glossary](docs/vivera-glossary.md).

<p align="center">
  <a href="docs/guide/reference-harvest-sprites.md"><img src="docs/images/sprites/chef.png" alt="Chef, the red Harvest Sprite" width="72"></a>
  &nbsp;&nbsp;&nbsp;<a href="docs/guide/reference-harvest-sprites.md"><img src="docs/images/sprites/nappy.png" alt="Nappy, the orange Harvest Sprite" width="72"></a>
  &nbsp;&nbsp;&nbsp;<a href="docs/guide/reference-harvest-sprites.md"><img src="docs/images/sprites/hoggy.png" alt="Hoggy, the yellow Harvest Sprite" width="72"></a>
  &nbsp;&nbsp;&nbsp;<a href="docs/guide/reference-harvest-sprites.md"><img src="docs/images/sprites/timid.png" alt="Timid, the green Harvest Sprite" width="72"></a>
  &nbsp;&nbsp;&nbsp;<a href="docs/guide/reference-harvest-sprites.md"><img src="docs/images/sprites/aqua.png" alt="Aqua, the light blue Harvest Sprite" width="72"></a>
  &nbsp;&nbsp;&nbsp;<a href="docs/guide/reference-harvest-sprites.md"><img src="docs/images/sprites/staid.png" alt="Staid, the dark blue Harvest Sprite" width="72"></a>
  &nbsp;&nbsp;&nbsp;<a href="docs/guide/reference-harvest-sprites.md"><img src="docs/images/sprites/bold.png" alt="Bold, the purple Harvest Sprite" width="72"></a>
</p>

Each sprite is a named subagent with one fixed role: Chef, Nappy, and Hoggy implement, Timid and Aqua research, Staid reviews, and Bold debugs. [The Harvest Sprites](docs/guide/reference-harvest-sprites.md) has their portraits, game traits, and roles.

This documentation is also published at [vivera.belajarcarabelajar.com/docs](https://vivera.belajarcarabelajar.com/docs/), and team workshops have their own page at [vivera.belajarcarabelajar.com/workshop](https://vivera.belajarcarabelajar.com/workshop/).

### Guide

The rest of the documentation lives in [`docs/guide/`](docs/guide/) and in `docs/`, one file per docs site page, in site order. A page too long for one file is split at its subsections into numbered parts.

- [Repository Structure](docs/guide/getting-started-repository-structure-1.md), continued in part [2](docs/guide/getting-started-repository-structure-2.md)
- [Quick Start & Installation](docs/guide/getting-started-quick-start-1.md), continued in part [2](docs/guide/getting-started-quick-start-2.md), [3](docs/guide/getting-started-quick-start-3.md), [4](docs/guide/getting-started-quick-start-4.md)
- [Execution Lifecycle](docs/guide/pipeline-execution-lifecycle.md)
- [Execution Model: Subagent-First, Proportional Fan-Out](docs/guide/pipeline-execution-model.md)
- [Confirmations Without Typing](docs/guide/pipeline-confirmations.md)
- [Deep Research Workflow](docs/guide/pipeline-deep-research.md)
- [Executing an ultra-plan/v1 Plan](docs/guide/pipeline-executing-a-plan.md)
- [Plan Mirroring: Obsidian and GitHub Issues](docs/guide/pipeline-plan-mirroring.md)
- [Plan Checklist (the to-do list)](docs/guide/pipeline-plan-checklist.md)
- [Pull Request Delivery & Batch Merge](docs/guide/pipeline-pr-delivery.md)
- [Mermaid Rendering](docs/guide/tooling-mermaid-rendering.md)
- [Trigger Snippets](docs/guide/tooling-trigger-snippets-1.md), continued in part [2](docs/guide/tooling-trigger-snippets-2.md), [3](docs/guide/tooling-trigger-snippets-3.md)
- [Vault Indexing & Knowledge Graph Verification](docs/guide/tooling-vault-indexing.md)
- [Plan Lifecycle Audit & Task Completion](docs/guide/tooling-lifecycle-audit.md)
- [Validation & Quality Checks](docs/guide/tooling-validation.md)
- [Companion Templates](docs/guide/reference-companion-templates.md)
- [Examples](docs/guide/reference-examples.md)
- [Third-Party Notices and Disclaimer](docs/guide/reference-third-party-notices.md)
- [License](docs/guide/reference-license.md)
- [The Vivera Glossary](docs/guide/reference-glossary.md)
- [Full Vivera Glossary](docs/vivera-glossary.md)
- [The Harvest Sprites](docs/guide/reference-harvest-sprites.md)
- [graphify Integration Integrity](docs/guide/integrations-graphify-integrity.md)
- [graphify Integration Runbook](docs/graphify-integration.md)
