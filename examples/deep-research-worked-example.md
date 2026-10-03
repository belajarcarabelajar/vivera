---
name: deep-research-worked-example
description: Worked example demonstrating the deep-research-report-template structure on a topic relevant to the vivera repo.
triggers:
  - example deep research
  - worked example research report
---

# Memory Persistence Patterns in Long-Running AI Coding Sessions

This report investigates how AI coding agents retain context across long, multi-session coding workflows. The question matters because the ultimate-skills pipeline described in this repository explicitly relies on session continuity for tasks that span hours or days, and the practical limits of that continuity are not yet well documented in the open literature. The principal finding is that effective persistence requires three orthogonal layers — short-term token-window compaction, mid-term episodic event capture, and long-term curated knowledge bases — and that most production systems in 2026 implement all three, but with very different cost and retrieval characteristics. The recommended action for this repository is to preserve the existing context-mode routing and add a periodic compaction event to the agent harness so the mid-term layer does not silently bloat.

## The Three-Layer Model

The literature on long-running agentic workflows converges on a three-layer memory model that separates concerns by retrieval latency, write cost, and durability[1][2]. The short-term layer is the model's context window plus any tool-mediated scratchpad; writes are essentially free but capacity is bounded and information is lost on compaction. The mid-term layer captures discrete events from completed sessions into a queryable store; writes are structured but bounded, and retrieval is index-based. The long-term layer holds curated knowledge that has been deliberately promoted from the mid-term store because it remained useful across many sessions; writes are expensive and retrieval is by semantic similarity.

The three layers do not compete; they compose. A fact that survives a session moves from short-term to mid-term; a fact that survives dozens of sessions and proves repeatedly useful graduates to long-term. The promotion step is the system's actual learning mechanism, not the model's weights[3].

## Short-Term Compaction Strategies

Compaction is the act of summarizing or evicting content from the short-term layer to keep the active context within budget. Three patterns dominate current practice: summarization, where an auxiliary model rewrites older turns into a shorter prose summary; sliding window with retrieval, where only the most recent N turns remain verbatim and older turns are indexed but not loaded until recalled; and structured distillation, where key facts are extracted into named slots and only the slots occupy the window[4].

Summarization is the simplest to implement but suffers from compounding error. Each successive summary loses more nuance than the last, and after three or four compaction cycles the original intent is often irretrievable. Sliding window with retrieval is more robust because the originals remain available, but it places hard requirements on the retrieval index and on the agent's ability to formulate good queries against past turns. Structured distillation is the most reliable but requires deliberate scaffolding — the agent must know which facts matter enough to slot before the window evicts them.

The vivera repository's routing rules favor sliding window with retrieval through the context-mode MCP, which provides a BM25-over-FTS5 index of past session events[5]. The choice is appropriate for the project's emphasis on recall over paraphrase.

## Mid-Term Episodic Capture

Episodic capture writes structured records about completed actions, decisions, errors, and user prompts to a queryable store. The schema varies, but the common fields are timestamp, event category, source identifier, content hash, and a search-friendly summary. The store is typically a local SQLite or FTS5 database because the write rate is modest and the queries are keyword-oriented rather than semantic[6].

The principal risk of mid-term capture is silent bloat. Without a periodic compaction or pruning step, the store grows linearly with activity, and retrieval quality degrades as the corpus becomes a noisy dump of micro-events. The remedy is a scheduled task that either summarizes old events into curated notes, drops events that have not been retrieved in N days, or promotes frequently retrieved events into the long-term store.

This repository already implements the write side through the context-mode hooks that auto-capture decisions, errors, blockers, and plans. It does not yet implement a scheduled prune or promotion step, which is the recommended addition from this report.

## Long-Term Curated Knowledge

The long-term layer is the slowest and most deliberate. Promotion into long-term storage typically requires either a human gate or a high-confidence heuristic such as "retrieved at least once per week for four consecutive weeks." The contents are curated notes, decisions, design constraints, and lessons learned — not raw events.

The retrieval cost is higher than mid-term because the index is usually semantic rather than keyword. Vector embeddings or BM25 over longer curated documents dominate. The benefit is that long-term hits are usually high signal — a curated note retrieved once usually matters to the active task, whereas a mid-term event hit may or may not.

For this repository, the analog of long-term storage is the curated memory graph recommended in the brainstorming skill for projects that span many sessions. The repo's README and the master skill document act as a manually maintained long-term layer that other agents cite from.

## Cross-Layer Tradeoffs

The three layers trade off against each other along four axes: write cost, read cost, durability, and retrieval precision. Short-term is cheap to write and read but fragile. Mid-term is moderately expensive in both directions but durable across sessions. Long-term is expensive to write, moderately expensive to read, and durable across projects, with high retrieval precision because the contents have already been filtered for usefulness.

An effective system does not minimize any one axis in isolation. The art is matching layer choice to the lifetime of the information. Configuration values that change weekly belong in mid-term. Architectural constraints that govern a multi-year project belong in long-term. The current turn's variable values belong in short-term.

## Failure Modes

Three failure modes recur across implementations. The first is promotion starvation, where nothing ever graduates to long-term and the curated layer remains stale. The second is retrieval collapse, where the mid-term index grows so large that the most common query terms match thousands of events with low precision. The third is cross-layer leakage, where the same fact lives in all three layers and updates to one do not propagate to the others.

Each failure mode has a known remedy — periodic promotion, scheduled pruning, and a single-writer-per-fact convention respectively — but the remedies are operational rather than automatic, which is why production systems usually require a human owner who watches for the symptoms.

## Conclusion

The three-layer memory model is the de facto architecture for long-running AI coding agents in 2026, and this repository's design aligns with it. The short-term layer is the model's context window managed through context-mode's token-efficient routing. The mid-term layer is the auto-captured event store maintained by context-mode hooks. The long-term layer is the curated documentation in this repository itself.

The principal gap is operational hygiene on the mid-term layer. The recommendation is to introduce a scheduled compaction step that runs daily, summarizes events older than thirty days into a single curated note per day, and drops micro-events that have not been retrieved in that period. The change is small, the risk is low because the originals remain in long-term storage, and the benefit is that retrieval precision in the mid-term layer remains high as the project ages.

Two open questions remain. First, should the long-term layer be promoted from the repository into a dedicated vector store so semantic retrieval is possible, or is BM25 over curated markdown sufficient? Second, who owns the promotion step — the agent itself, a scheduled job, or a human reviewer? The recommended next step is a one-day spike that prototypes the daily compaction and measures retrieval precision before and after.

---

[1] Park et al., "Generative Agents: Interactive Simulacra of Human Behavior," 2023.
[2] Packer et al., "MemGPT: Towards LLMs as Operating Systems," 2023.
[3] Schneider, "AI Memory Architectures: A Survey," 2025.
[4] Anthropic, "Effective Context Management for Long-Running Agents," 2025.
[5] context-mode project documentation, https://context-mode.com, accessed 2026.
[6] FTS5 SQLite documentation, https://www.sqlite.org/fts5.html, accessed 2026.