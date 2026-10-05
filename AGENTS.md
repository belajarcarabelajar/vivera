Note: the graphify rules below apply when the `graphify` CLI and `graphify-out/graph.json` exist (run `graphify update .` to build the graph; see install.sh to install the CLI). If they are absent, skip the graphify steps and use normal file reading.

Vivera is the name of this repository (the farm). Documents and tool output may use Harvest Moon: Back to Nature flavored terms: the shipping bin (PR registry), Harvest Sprites (subagents: watering/menyiram is keep-alive, animal care/merawat is long-lived assets, harvesting/memanen is shipping), the Blue Feather (a pull request), and Power Berries (permanent capability upgrades). The mapping lives in docs/vivera-glossary.md; commands and paths keep their literal meaning.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## upgrade-hygiene

Set by user 2026-10-06: every successful upgrade ends with the old version removed, so nothing exists twice. Delete session backup copies, auto-created `*.bak` files, and uninstalled packages once the new version is verified. Revert paths must not depend on the deleted copies — re-download the old release, reinstall via the package manager, or `git checkout` the repo file instead.
