# Deep Research Workflow

Some implementation choices cannot be settled from the codebase: the decision depends on a
library surface the agent has not observed, on comparing more than two alternatives along
several axes, or on being defensible to a reviewer who never saw the reasoning. The
`🔬 Deep Research Workflow` in the master skill exists for exactly that case, and it runs
between the spike and the implementation plan rather than replacing either.

| Concern | Rule |
|---|---|
| Invocation | Only when the decision depends on information absent from the codebase, the project overlay, and the agent's verified configuration. A question that fits in a spike report or an ADR does not need it. |
| Output | A long-form, citation-grounded report built from [`templates/deep-research-report-template.md`](../../templates/deep-research-report-template.md). Length follows the scope of the question, never a padded minimum. |
| Shape | Executive summary, 3-7 `##` themes with `###` subsections, closing synthesis. Inline `[n]` citations, LaTeX delimiters for notation, prose over lists, tables for multi-axis comparisons. |
| Provenance | The report lands as a dated artifact under `research/` in the active project. The plan cites its section anchors instead of restating findings; an ADR references the report rather than duplicating its citations. |
| Anti-patterns | Citing unconsulted sources, claiming authorship by a specific external system, padding to an artificial length, or hiding directives in markup are all failures. These are skill rules the agent is held to at review time, not a machine gate: `validate-skill.mjs` currently only asserts that the template and the worked example exist. |

[`examples/deep-research-worked-example.md`](../../examples/deep-research-worked-example.md) is
the calibration reference: read it before writing the first report to match its length,
citation density, and prose rhythm.
