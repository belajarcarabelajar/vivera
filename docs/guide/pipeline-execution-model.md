<a id="execution-model-subagent-first-high-fan-out"></a>
# Execution Model: Subagent-First, Proportional Fan-Out

Execution runs through subagents by default. The parent agent is the orchestrator: it chunks the work, dispatches a batch, then gathers and synthesizes the reports.

- **Task chunking before dispatch:** the work is split into the smallest independently verifiable units (one behavior, one file, one command chain, one hypothesis). Small units are bundled so each subagent gets 15+ turns of real work, because every new subagent pays a large startup cost.
- **Proportional fan-out:** a single-step task runs inline, medium work gets 2 to 4 subagents, and 10 to 15 only when there are that many disjoint chunks (at most 15 in flight). A sequential follow-up reuses a live subagent, since each new one pays its startup prefix again.
- **Gather and synthesize:** subagent reports are inputs, not conclusions. The parent dedupes, resolves conflicts from the evidence, re-verifies each claim via diff/log/exit status, and merges one result before continuing.
- **Audit gate:** every integrated chunk passes the parent diff audit before it counts as done. A red chunk is re-chunked and re-dispatched alone.
- **Advisor consults:** when the agent tool offers an advisor (a stronger model that reads the whole conversation), only the parent consults it, at three moments: before a grilling round of 2 or more questions, before choosing the approach the plan is written from, and after plan approval at a bottleneck (the same error a second time, a spiral stop, a change of approach). It is not consulted before a routine step or a done claim. Subagents never consult it: they execute what was decided before planning and report a blocker to the parent instead. This timing has not been measured yet.

Inline execution exists only as a documented exception, not a default.
