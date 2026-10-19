# graphify Integration Integrity

## AGENTS.md Section Drift (`scripts/agents-md-current.mjs`)

Detects when a repo's `## graphify` block in `AGENTS.md` is stale relative to the installed `graphify` binary. A **missing** block is self-correcting (agent falls back to grep). A **stale** block is worse: it asserts the graph is absent when it exists, causing the agent to silently skip `graphify query` for the entire session.

```bash
bun scripts/agents-md-current.mjs
```

## Plugin Drift Guard (`scripts/graphify-plugin-drift.mjs`)

Guards `.opencode/plugins/graphify.js` against silent overwrites by `graphify install --project`. The installer has been measured to change the plugin's exported shape to an unverified signature and delete hand-written module resolution notes. This script **reports only**: it has no write path, and a test asserts the local file's bytes are unchanged after any call.

```bash
bun scripts/graphify-plugin-drift.mjs
```

Full measured runbook: [`docs/graphify-integration.md`](../../docs/graphify-integration.md).
