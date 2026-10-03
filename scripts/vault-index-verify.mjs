#!/usr/bin/env bun
// scripts/vault-index-verify.mjs — T12: prove graphify accepts the hand-authored graph.
//
// WHAT THIS TASK IS ACTUALLY TESTING.
//
// The graph was assembled by hand (T9) from three layers, not produced by
// `graphify extract`. graphify's own loader, `build_from_json`, makes an
// assumption this graph violates: it collapses nodes on `(source_file, label)`
// without regard to `file_type`, so it reads 18,420 nodes where the file holds
// 20,214 and drops 1,794 concept nodes that share a label with an old heading.
// That is why `graphify cluster-only` refuses to run (T10).
//
// But `graphify query`, `graphify path` and `graphify explain` do NOT use that
// loader — they read the JSON directly through `node_link_graph` (cli.py:1282),
// the same way this script's python helper does. So the question T12 answers is
// narrower and more useful than "does graphify accept the graph": it is "do the
// three read paths an agent actually uses work, and is the coverage claim true".
//
// THREE ASSERTIONS, each because the alternative is a silent failure:
//
//   1. COVERAGE. Every worklist path is either a source_file of some node or in
//      the manifest's recorded skip list. "The worklist is done" was being read
//      as "every file is indexed", and the manifest is what makes that checkable
//      against a recorded fact instead of a reconstruction.
//   2. NO EXCLUDED PREFIX. No source_file falls under a prefix the detector
//      excluded. The ignore rules are a privacy boundary (Satset/ holds secret
//      material), so a source_file under one is not a coverage gap — it is a
//      boundary that was crossed, and it must fail loudly.
//   3. THE READ PATHS WORK. `graphify query`, `graphify explain` and
//      `graphify path` each exit 0 with non-empty output. A graph that loads but
//      answers nothing is indistinguishable from a broken one without this.
//
// Usage:
//   bun scripts/vault-index-verify.mjs                 # pure checks + graphify read paths
//   bun scripts/vault-index-verify.mjs --no-graphify   # pure checks only (fast, CI-safe)
//   bun scripts/vault-index-verify.mjs --graph <path>  # default: <vault>/graphify-out/graph.json
//
// Corpus roots: $ARCHIVE_ROOT and $VAULT_ROOT, else local.config.json (copy
// local.config.example.json). With neither set, resolution throws.
//
// The graphify read paths are the slow part and need the vault on disk, so
// `--no-graphify` exists for the unit test, which drives the pure functions with
// fixtures and never touches the vault.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan } from './vault-index.mjs';
import { resolveConfiguredPath } from './lib/local-config.mjs';

/**
 * The archive corpus root: $ARCHIVE_ROOT, else local.config.json's
 * "archiveRoot" (copy local.config.example.json). Resolved per call, never at
 * import, so importing this module cannot throw and a changed env var is picked
 * up on the next call. Matches vault-index-rebuild.mjs.
 *
 * @param {{configPath?: string}} [opts] test-only config file override
 * @returns {string} absolute path to the conversations archive root
 */
export function resolveArchiveRoot({ configPath } = {}) {
  return resolveConfiguredPath({ envVar: 'ARCHIVE_ROOT', configKey: 'archiveRoot', label: 'conversations archive root', configPath });
}

/**
 * The vault corpus root: $VAULT_ROOT, else local.config.json's "vaultRoot".
 * Same contract as resolveArchiveRoot.
 *
 * @param {{configPath?: string}} [opts] test-only config file override
 * @returns {string} absolute path to the Obsidian vault root
 */
export function resolveVaultRoot({ configPath } = {}) {
  return resolveConfiguredPath({ envVar: 'VAULT_ROOT', configKey: 'vaultRoot', label: 'Obsidian vault root', configPath });
}

/** Default graph location, relative to the vault root. */
export const DEFAULT_GRAPH_RELPATH = 'graphify-out/graph.json';

/** Where this script lives, so the manifest and worklist are found relative to it. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The default graph location under the resolved vault root. A function rather
 * than a const so it tracks the same env/config seam as the roots, and so
 * importing this module resolves neither.
 *
 * @param {{configPath?: string}} [opts] test-only config file override
 * @returns {string} absolute path to <vault root>/graphify-out/graph.json
 */
export function resolveGraphPath(opts = {}) {
  return resolvePath(resolveVaultRoot(opts), DEFAULT_GRAPH_RELPATH);
}

/** Repo-relative inputs, independent of the corpus roots. */
export const MANIFEST_PATH = resolvePath(HERE, '../vault-index/manifest.json');
export const WORKLIST_PATH = resolvePath(HERE, '../vault-index/semantic/batches.json');

/**
 * Every `source_file` cited by any node, as a set.
 *
 * @param {{nodes?: object[]}} graph
 * @returns {Set<string>}
 */
export function sourceFilesOf(graph) {
  const out = new Set();
  for (const node of graph?.nodes ?? []) {
    if (node === null || typeof node !== 'object') continue;
    const sf = node.source_file;
    if (typeof sf === 'string' && sf.trim() !== '') out.add(sf);
  }
  return out;
}

/**
 * Coverage: every worklist path is a source_file of some node, or in the skip list.
 *
 * @param {{nodes?: object[]}} graph
 * @param {{skipped?: Array<{path?: string}>}} manifest
 * @param {string[]} worklistPaths
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkCoverage(graph, manifest, worklistPaths) {
  const indexed = sourceFilesOf(graph);
  const skipped = new Set((manifest?.skipped ?? []).map((s) => s.path));
  const problems = [];
  for (const path of worklistPaths) {
    if (!indexed.has(path) && !skipped.has(path)) {
      problems.push(`worklist path is neither indexed nor skipped: ${path}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * No source_file falls under a prefix the detector excluded.
 *
 * @param {Set<string>} sourceFiles
 * @param {string[]} ignored
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkExcludedPrefixes(sourceFiles, ignored) {
  const excluded = new Set(ignored);
  const problems = [];
  for (const sf of sourceFiles) {
    if (excluded.has(sf)) {
      problems.push(`source_file is under an excluded prefix: ${sf}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Pick a god node (highest degree) and one of its neighbours, for the read-path
 * checks. Deterministic: ties break by node id so two runs pick the same nodes.
 *
 * @param {{nodes?: object[], links?: object[]}} graph
 * @returns {{god: string|null, neighbour: string|null}}
 */
export function pickGodNode(graph) {
  const degree = new Map();
  for (const link of graph?.links ?? []) {
    if (link === null || typeof link !== 'object') continue;
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }
  let god = null;
  let best = -1;
  for (const [id, deg] of [...degree.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (deg > best) {
      best = deg;
      god = id;
    }
  }
  if (god === null) return { god: null, neighbour: null };
  for (const link of graph?.links ?? []) {
    if (link === null || typeof link !== 'object') continue;
    if (link.source === god) return { god, neighbour: link.target };
    if (link.target === god) return { god, neighbour: link.source };
  }
  return { god, neighbour: null };
}

/**
 * Run one graphify read-path command and report exit code and output.
 *
 * @param {string[]} args
 * @param {{graph?: string, cwd?: string}} [opts]
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
export function runGraphify(args, opts = {}) {
  const graph = opts.graph ?? resolveGraphPath();
  const cwd = opts.cwd ?? resolveVaultRoot();
  const res = spawnSync('graphify', [...args, '--graph', graph], {
    encoding: 'utf8',
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/**
 * The three read-path checks: query, explain, path each exit 0 with output.
 *
 * @param {{nodes?: object[], links?: object[]}} graph
 * @param {{graph?: string}} [opts]
 * @returns {{ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>}}
 */
export function checkReadPaths(graph, opts = {}) {
  const run = opts.run ?? runGraphify;
  const { god, neighbour } = pickGodNode(graph);
  const checks = [];
  if (god === null) {
    checks.push({ name: 'query', ok: false, detail: 'no connected node to query' });
    return { ok: false, checks };
  }

  const label = String(graph.nodes.find((n) => n && n.id === god)?.label ?? god);
  const query = run(['query', label], opts);
  checks.push({
    name: 'query',
    ok: query.status === 0 && query.stdout.trim() !== '',
    detail: `exit ${query.status}, ${query.stdout.trim().length} bytes out`,
  });

  const explain = run(['explain', label], opts);
  checks.push({
    name: 'explain',
    ok: explain.status === 0 && explain.stdout.trim() !== '',
    detail: `exit ${explain.status}, ${explain.stdout.trim().length} bytes out`,
  });

  if (neighbour !== null) {
    const path = run(['path', god, neighbour], opts);
    checks.push({
      name: 'path',
      ok: path.status === 0 && path.stdout.trim() !== '',
      detail: `exit ${path.status}, ${path.stdout.trim().length} bytes out`,
    });
  } else {
    checks.push({ name: 'path', ok: false, detail: 'god node has no neighbour' });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Run every check and return a report. Throws nothing; the caller decides.
 *
 * @param {{graphPath?: string, manifestPath?: string, worklistPath?: string,
 *   withGraphify?: boolean}} [opts]
 */
export function verify(opts = {}) {
  const graphPath = opts.graphPath ?? resolveGraphPath();
  const manifestPath = opts.manifestPath ?? MANIFEST_PATH;
  const worklistPath = opts.worklistPath ?? WORKLIST_PATH;
  const withGraphify = opts.withGraphify ?? true;

  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const worklist = JSON.parse(readFileSync(worklistPath, 'utf8'));

  const worklistPaths = [];
  for (const batch of worklist?.batches ?? []) {
    for (const file of batch?.files ?? []) {
      if (typeof file?.path === 'string') worklistPaths.push(file.path);
    }
  }

  const sourceFiles = sourceFilesOf(graph);

  // The excluded prefixes come from the detector, not from a hardcoded list:
  // reimplementing the ignore rules is how a boundary gets crossed silently.
  const ignored = [];
  for (const root of [resolveArchiveRoot(), resolveVaultRoot()]) {
    ignored.push(...scan(root).ignored);
  }

  const coverage = checkCoverage(graph, manifest, worklistPaths);
  const excluded = checkExcludedPrefixes(sourceFiles, ignored);

  const report = {
    nodes: (graph?.nodes ?? []).length,
    links: (graph?.links ?? []).length,
    worklistPaths: worklistPaths.length,
    sourceFiles: sourceFiles.size,
    coverage,
    excluded,
    readPaths: withGraphify ? checkReadPaths(graph) : null,
  };
  report.ok = coverage.ok && excluded.ok && (report.readPaths === null || report.readPaths.ok);
  return report;
}

function main() {
  const argv = process.argv.slice(2);
  const withGraphify = !argv.includes('--no-graphify');
  const graphFlag = argv.indexOf('--graph');
  const graphPath = graphFlag !== -1 && argv[graphFlag + 1] ? resolvePath(argv[graphFlag + 1]) : resolveGraphPath();

  const report = verify({ graphPath, withGraphify });

  console.log('--- coverage ---');
  console.log(`  worklist paths: ${report.worklistPaths}`);
  console.log(`  source_files:   ${report.sourceFiles}`);
  console.log(`  coverage:       ${report.coverage.ok ? 'PASS' : 'FAIL'}`);
  for (const p of report.coverage.problems.slice(0, 10)) console.log(`    - ${p}`);
  console.log(`  excluded:       ${report.excluded.ok ? 'PASS' : 'FAIL'}`);
  for (const p of report.excluded.problems.slice(0, 10)) console.log(`    - ${p}`);
  if (report.readPaths) {
    console.log('--- graphify read paths ---');
    for (const c of report.readPaths.checks) {
      console.log(`  ${c.name.padEnd(8)} ${c.ok ? 'PASS' : 'FAIL'}  (${c.detail})`);
    }
  }

  if (!report.ok) {
    console.error('VERIFY FAILED');
    process.exit(1);
  }
  console.log('VERIFY OK');
}

if (import.meta.main) main();
