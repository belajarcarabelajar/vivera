#!/usr/bin/env bun
// scripts/vault-index-cluster.mjs — T10 runner: apply communities to the vault graph.
//
// WHY THIS RUNNER EXISTS INSTEAD OF `graphify cluster-only`.
//
// `cluster-only` loads the graph through `graphify.build.build_from_json`, whose
// ghost-merge pass collapses nodes on `(source_file, label)` without regard to
// `file_type`. This graph carries both an old `document`/`heading` node and a new
// `concept` node for 1,794 (file, label) pairs, so the loader reads 18,420 nodes
// where the file holds 20,214 and its overwrite guard refuses to write. Forcing it
// would delete 1,794 concept nodes from the only copy of the graph.
//
// So the Leiden pass is delegated to graphify's own `cluster()` and
// `label_communities_by_hub()` (the exact functions `cluster-only` calls), driven
// by `vault-index-cluster.py`, which builds the graph straight from the JSON the
// way `graphify query` does. This runner only applies the resulting mapping and
// serialises with the merger's own `serializeGraph`, so the file keeps the exact
// format and key order T9 wrote and every node and link survives.
//
// Usage:
//   bun scripts/vault-index-cluster.mjs                 # dry run, writes nothing
//   bun scripts/vault-index-cluster.mjs --write         # back up, then write graph.json
//   bun scripts/vault-index-cluster.mjs --graph <path>  # default: <vault>/graphify-out/graph.json
//
// The vault root and the graphify interpreter are machine-specific: $VAULT_ROOT
// and $GRAPHIFY_PYTHON, else local.config.json (copy local.config.example.json
// to the repo root and fill it in). With neither set, the run exits with an
// error naming both the env var and the config file.
//
// The dry run is the default on purpose: the file being overwritten is the vault's
// only record of 20,214 nodes of accumulated work.

import { readFileSync, copyFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeGraph } from './vault-index-merge.mjs';
import { resolveConfiguredPath } from './lib/local-config.mjs';

/**
 * The vault root: $VAULT_ROOT, else local.config.json's "vaultRoot". Resolved
 * per call, never at import, so importing this module cannot throw and a
 * changed env var is picked up on the next call. This is the same root
 * vault-index-rebuild.mjs clusters against, resolved through the same helper
 * so the two runners cannot disagree about where the vault is.
 *
 * @param {{configPath?: string}} [opts] test-only config file override
 * @returns {string} absolute path to the Obsidian vault root
 */
export function resolveVaultRoot({ configPath } = {}) {
  return resolveConfiguredPath({ envVar: 'VAULT_ROOT', configKey: 'vaultRoot', label: 'Obsidian vault root', configPath });
}

/** Default graph location, relative to the vault root. */
export const DEFAULT_GRAPH_RELPATH = 'graphify-out/graph.json';

/** Where this script lives, so the python helper is found relative to it. */
const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = resolvePath(HERE, 'vault-index-cluster.py');

const PYTHON_CONFIG = {
  envVar: 'GRAPHIFY_PYTHON',
  configKey: 'graphifyPython',
  label: 'the graphify python interpreter',
};

/**
 * The interpreter that can import graphify and networkx.
 *
 * graphify is a uv tool, so its dependencies live in the tool's own venv, not in
 * the system interpreter. Measured 2026-10-03: system `python3` has neither
 * `networkx` nor `graphify`; the venv python has both. Where that venv lives is
 * machine-specific, so the interpreter resolves per call through
 * `lib/local-config.mjs`: `$GRAPHIFY_PYTHON`, then the git-ignored
 * `local.config.json`'s "graphifyPython", then an error naming both. There is
 * deliberately no default path: a silent wrong guess would cluster a graph
 * through a different graphify install than the one that built it, and the only
 * hard-coded value would be one machine's absolute path. `opts.configPath`
 * overrides the config file location (test-only).
 *
 * @param {{configPath?: string}} [opts]
 * @returns {string} absolute path to a python binary
 */
export function pythonBinary({ configPath } = {}) {
  return resolveConfiguredPath({ ...PYTHON_CONFIG, configPath });
}

/**
 * Run the python clustering helper and parse its stdout.
 *
 * @param {string} graphPath
 * @param {{python?: string, configPath?: string}} [opts] `python` is a per-call
 *   interpreter override; `configPath` overrides the local.config.json location
 *   (test-only)
 * @returns {{nodeCount: number, linkCount: number, communityCount: number,
 *   degreeZero: number, singletons: number, largest: number[],
 *   unassigned: string[], mapping: Record<string, {community: number, community_name: string}>}}
 */
export function computeCommunities(graphPath, opts = {}) {
  const python = opts.python ?? pythonBinary(opts);
  const res = spawnSync(python, [PYTHON_SCRIPT, graphPath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`could not run ${python}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`vault-index-cluster.py exited ${res.status}: ${String(res.stderr ?? '').trim()}`);
  }
  const out = String(res.stdout ?? '').trim();
  if (!out) {
    throw new Error('vault-index-cluster.py produced no output');
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new Error(`could not parse vault-index-cluster.py output as JSON: ${err.message}`);
  }
  return {
    nodeCount: parsed.node_count,
    linkCount: parsed.link_count,
    communityCount: parsed.community_count,
    degreeZero: parsed.degree_zero,
    singletons: parsed.singletons,
    largest: parsed.largest ?? [],
    unassigned: parsed.unassigned ?? [],
    mapping: parsed.mapping ?? {},
  };
}

/**
 * Apply a community mapping to a graph, returning a NEW graph. The input is not
 * mutated, so a dry run and a write run produce the same object.
 *
 * @param {{nodes?: object[], links?: object[], [k: string]: unknown}} graph
 * @param {Record<string, {community: number, community_name: string}>} mapping
 * @returns {{graph: object, assigned: number, unassigned: number}}
 */
export function applyCommunities(graph, mapping) {
  const nodes = (graph?.nodes ?? []).map((node) => {
    if (node === null || typeof node !== 'object') return node;
    const hit = mapping[node.id];
    if (hit === undefined) return { ...node };
    return { ...node, community: hit.community, community_name: hit.community_name };
  });
  const assigned = nodes.filter(
    (n) => n !== null && typeof n === 'object' && mapping[n.id] !== undefined,
  ).length;
  return { graph: { ...graph, nodes }, assigned, unassigned: nodes.length - assigned };
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const graphFlag = argv.indexOf('--graph');
  const graphPath = graphFlag !== -1 && argv[graphFlag + 1]
    ? resolvePath(argv[graphFlag + 1])
    // Resolved here rather than at the top of main, so a `--graph` dry run on
    // an unconfigured host still works: the vault root is only needed when the
    // default graph location is.
    : resolvePath(resolveVaultRoot(), DEFAULT_GRAPH_RELPATH);

  if (!existsSync(graphPath)) {
    console.error(`no graph at ${graphPath} — nothing to cluster`);
    process.exit(2);
  }

  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const before = {
    nodes: (graph?.nodes ?? []).length,
    links: (graph?.links ?? []).length,
    withCommunity: (graph?.nodes ?? []).filter(
      (n) => n !== null && typeof n === 'object' && n.community !== undefined && n.community !== null,
    ).length,
  };

  const result = computeCommunities(graphPath);
  const { graph: clustered, assigned, unassigned } = applyCommunities(graph, result.mapping);

  console.log('--- clustering (graphify cluster + label_communities_by_hub) ---');
  console.log(`  nodes:            ${result.nodeCount} (file had ${before.nodes})`);
  console.log(`  links:            ${result.linkCount} (file had ${before.links})`);
  console.log(`  communities:      ${result.communityCount}`);
  console.log(`  assigned nodes:   ${assigned}  unassigned: ${unassigned}`);
  console.log(`  degree-0:         ${result.degreeZero}`);
  console.log(`  singleton comms:  ${result.singletons}`);
  console.log(`  largest comms:    ${result.largest.slice(0, 8).join(', ')}`);
  console.log(`  nodes already carrying community: ${before.withCommunity}`);

  // The whole point of the deviation: the node count must not move. A clustering
  // that changes it means the graph was rebuilt through the lossy loader, and
  // writing would destroy nodes.
  if (result.nodeCount !== before.nodes) {
    console.error(
      `GATE FAILED — clustering saw ${result.nodeCount} nodes but the file has ${before.nodes}. ` +
        'Refusing to write: the graph was not preserved.',
    );
    process.exit(1);
  }
  if (unassigned > 0) {
    console.error(
      `GATE FAILED — ${unassigned} node(s) got no community, starting with ${JSON.stringify(result.unassigned.slice(0, 3))}.`,
    );
    process.exit(1);
  }

  if (!write) {
    console.log('DRY RUN — nothing written. Re-run with --write to back up and write.');
    process.exit(0);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const backupDir = resolvePath(resolveVaultRoot(), `graphify-out/backup-${stamp}-t10`);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(graphPath, resolvePath(backupDir, 'graph.json'));
  console.log(`  backup: ${backupDir}`);

  const text = serializeGraph(clustered);
  writeFileSync(graphPath, text, 'utf8');
  console.log(`wrote ${graphPath} (${Buffer.byteLength(text, 'utf8')} bytes, ${clustered.nodes.length} nodes, ${clustered.links.length} links)`);
}

if (import.meta.main) main();
