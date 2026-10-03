#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""vault-index cluster — T10: communities over the merged vault graph.

THE PROBLEM THIS SCRIPT EXISTS FOR.

T10 asks for `graphify cluster-only` in the vault. Measured 2026-10-03 against
the real merged graph, that command REFUSES to write, and the reason is not a
formality. `cluster-only` loads the graph through `graphify.build.build_from_json`,
whose ghost-merge pass collapses nodes on the pair `(source_file, label)` WITHOUT
regard to `file_type`. This graph legitimately carries, for the same file and the
same label, an old `document`/`heading` node AND a new `concept` node — 1,794 of
them (28% of all concept nodes). `build_from_json` keeps the heading and drops the
concept, so it reads 18,420 nodes where the file holds 20,214, and its overwrite
guard (export.py:315) then refuses to replace a 20,214-node file with a 18,420-node
one. Forcing it would delete 1,794 concept nodes from the only copy of the graph.

So the Leiden pass is still graphify's own — `graphify.cluster.cluster()` and
`graphify.cluster.label_communities_by_hub()` are the exact functions `cluster-only`
calls (cli.py:2105, cli.py:2247) — but the graph is built directly from the JSON
instead of through the lossy loader. Every node and link is preserved; only
`community` and `community_name` are added.

WHY THE DEFAULTS ARE WHAT THEY ARE.

`cluster(G)` is called with no arguments, which is `resolution=1.0` and
`exclude_hubs_percentile=None`. T10 step 2 is explicit that `--resolution` must not
be passed: measured on a copy of the real graph at 0.2, 0.5 and 2.0, the singleton
count stayed at exactly 1,415 every time, because a node with no incident edge has
nothing to cluster with. The parameter cannot move an isolated node, so it is not
passed. `exclude_hubs_percentile` is left at its default for the same reason the
plan does not mention it.

Usage:
    GRAPHIFY_SITE_PACKAGES=/path/to/graphify/site-packages \
        python3 vault-index-cluster.py GRAPH.json     # mapping JSON on stdout

GRAPHIFY_SITE_PACKAGES is required and has no default. The path is a
machine-specific uv tool venv, and a silent wrong guess would cluster with a
different graphify install than the one that built the graph. vault-index.mjs
resolves the same variable the same way for the detector, so one setting drives
both scripts; the runner (vault-index-cluster.mjs) inherits its environment
down to this script, so a value exported above it, or put in the git-ignored
local.config.json the JS side reads, is all a configured host needs. This
script reads only the environment.

The output is a single JSON object on stdout. Anything graphify prints goes to
stderr, so stdout stays parseable. The mapping is keyed by node id and carries the
community id and the hub-based name; a node that clustering left out (an isolated
node that Leiden did not assign) is reported in `unassigned` rather than invented.
"""

import json
import os
import sys


def require_site_packages():
    """Return graphify's site-packages from the environment, or refuse to guess.

    There is deliberately no fallback path: the correct value is a machine's uv
    tool venv, and any default baked in here would be one host's layout shipped
    to every other checkout (the bug this replaces).
    """
    site_packages = os.environ.get("GRAPHIFY_SITE_PACKAGES")
    if not site_packages:
        print(
            "vault-index-cluster.py: GRAPHIFY_SITE_PACKAGES is not set. Point it at"
            " graphify's installed site-packages directory (the same variable"
            " vault-index.mjs reads), e.g.:",
            file=sys.stderr,
        )
        print(
            "  GRAPHIFY_SITE_PACKAGES=/path/to/graphify/site-packages"
            " python3 vault-index-cluster.py GRAPH.json",
            file=sys.stderr,
        )
    return site_packages


def build_graph(data):
    """Build an undirected NetworkX graph straight from the JSON.

    Deliberately NOT `graphify.build.build_from_json`: that is the pass that drops
    1,794 concept nodes (see module docstring). Reading the JSON directly is what
    `graphify query` does (cli.py:1282), so the graph this clusters is the graph
    the rest of the tooling actually sees.
    """
    import networkx as nx

    G = nx.Graph()
    for node in data.get("nodes", []):
        if not isinstance(node, dict) or "id" not in node:
            continue
        G.add_node(node["id"], **{k: v for k, v in node.items() if k != "id"})
    for link in data.get("links", []):
        if not isinstance(link, dict):
            continue
        source = link.get("source")
        target = link.get("target")
        if source is None or target is None:
            continue
        G.add_edge(source, target)
    return G


def main():
    if len(sys.argv) != 2:
        print("usage: vault-index-cluster.py GRAPH.json", file=sys.stderr)
        return 2

    site_packages = require_site_packages()
    if site_packages is None:
        return 2
    # Both imports below (networkx in build_graph, graphify.cluster further
    # down) resolve from here, so a plain python3 works as long as the env var
    # points at a directory holding both.
    sys.path.insert(0, site_packages)

    graph_path = sys.argv[1]
    with open(graph_path, encoding="utf-8") as handle:
        data = json.load(handle)

    G = build_graph(data)

    from graphify.cluster import cluster, label_communities_by_hub

    communities = cluster(G)
    names = label_communities_by_hub(G, communities)

    mapping = {}
    for cid, members in communities.items():
        name = names.get(cid, "Community %d" % cid)
        for member in members:
            mapping[member] = {"community": cid, "community_name": name}

    assigned_ids = set(mapping)
    unassigned = [n for n in G.nodes() if n not in assigned_ids]

    sizes = sorted((len(m) for m in communities.values()), reverse=True)
    singletons = sum(1 for size in sizes if size == 1)

    # Degree-0 is computed on the full graph so a flat community-size median
    # cannot hide a regression (T10 step 3).
    connected = set()
    for source, target in G.edges():
        connected.add(source)
        connected.add(target)
    isolated = [n for n in G.nodes() if n not in connected]

    out = {
        "node_count": G.number_of_nodes(),
        "link_count": G.number_of_edges(),
        "community_count": len(communities),
        "degree_zero": len(isolated),
        "singletons": singletons,
        "largest": sizes[:10],
        "unassigned": unassigned,
        "mapping": mapping,
    }
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
