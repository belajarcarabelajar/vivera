# Vault Indexing & Knowledge Graph Verification

This repository maintains the extraction contracts, scripts, and verification gates for building a comprehensive knowledge graph of the local Obsidian vault and archived conversations without cloud extraction costs:

- **Structural Layer (`vault-index-structural.mjs`)**: Local deterministic extraction of document nodes, ATX headings (`contains` edges), and `[[wikilinks]]` (`references` edges).
- **Semantic Layer (`vault-index/semantic/`)**: Subagents extract high-signal `concept` nodes and decision attributes into isolated chunk files strictly adhering to `scripts/lib/chunk-schema.mjs`.
- **Manifest (`vault-index/manifest.json`)**: Records tracked roots, sha256 content hashes, byte sizes, and node counts across 9,600+ lines.
