<a id="execution-model-subagent-first-high-fan-out"></a>
# Execution Model: Subagent-First, Proportional Fan-Out

Execution runs through subagents by default. The parent agent is the orchestrator: it chunks the work, dispatches a batch, then gathers and synthesizes the reports.

- **Task chunking before dispatch:** the work is split into the smallest independently verifiable units (one behavior, one file, one command chain, one hypothesis), and each unit gets its own subagent.
- **Proportional fan-out:** a single-step task runs inline, medium work gets 2 to 4 subagents, and 10 to 15 only when there are that many disjoint chunks (at most 15 in flight). A sequential follow-up reuses a live subagent, since each new one pays its startup prefix again.
- **Gather and synthesize:** subagent reports are inputs, not conclusions. The parent dedupes, resolves conflicts from the evidence, re-verifies each claim via diff/log/exit status, and merges one result before continuing.
- **Audit gate:** every integrated chunk passes the parent diff audit before it counts as done. A red chunk is re-chunked and re-dispatched alone.

Inline execution exists only as a documented exception, not a default.
