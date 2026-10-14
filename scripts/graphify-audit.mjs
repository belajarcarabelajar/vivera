#!/usr/bin/env bun
// scripts/graphify-audit.mjs
//
// Lists every git repository under the given roots with its graphify state:
// registered (with node, edge, and staleness figures), unregistered, or opted
// out, plus the linked worktrees that read their main checkout's graph.
//
// The hooks only see the repository a session happens to open, so a repository
// nobody has opened since graphify arrived stays unregistered without anyone
// noticing. This command sweeps whole trees at once and exits 1 while any
// repository is unregistered, so a checklist or a scheduled job can gate on it.
// Linked worktrees are listed apart because their graph lives in the main
// checkout; counting them as unregistered would demand a second graph.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { graphifyStatus } from './lib/graphify-status.mjs';

const DEFAULT_MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', '.cache', 'graphify-out']);

const USAGE = `Usage: bun scripts/graphify-audit.mjs <root>... [--json] [--max-depth N]

Lists the git repositories under each root (up to depth ${DEFAULT_MAX_DEPTH} by default) with
their graphify state. Exits 1 while any repository is unregistered, 0 otherwise,
and 2 on a usage error or a root that does not exist.`;

function walk(dir, depth, maxDepth, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const dotGit = entries.find((e) => e.name === '.git');
  if (dotGit) {
    // A `.git` file points at a git dir elsewhere: a linked worktree.
    (dotGit.isFile() ? found.worktrees : found.repos).add(dir);
    return;
  }
  if (depth >= maxDepth) return;
  for (const e of entries) {
    // Dirent.isDirectory() is false for symlinks, so a link cycle cannot loop the walk.
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1, maxDepth, found);
  }
}

function graphCounts(graphPath) {
  let graph;
  try {
    graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  } catch (err) {
    return { nodes: null, edges: null, note: `graph.json unreadable: ${err.message}` };
  }
  const edgeList = Array.isArray(graph?.links) ? graph.links : graph?.edges;
  const counts = {
    nodes: Array.isArray(graph?.nodes) ? graph.nodes.length : null,
    edges: Array.isArray(edgeList) ? edgeList.length : null,
  };
  if (counts.nodes === null && counts.edges === null) counts.note = 'graph.json has no nodes, links, or edges array';
  return counts;
}

function repoEntry(dir) {
  const status = graphifyStatus(dir);
  const entry = { path: dir, kind: status.kind, nodes: null, edges: null, stale: null };
  if (status.kind !== 'registered') return entry;
  entry.stale = status.stale;
  return Object.assign(entry, graphCounts(status.graphPath));
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function audit(roots, { maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const found = { repos: new Set(), worktrees: new Set() };
  for (const root of roots) walk(path.resolve(root), 0, maxDepth, found);
  return {
    repos: [...found.repos].sort(byPath).map(repoEntry),
    worktrees: [...found.worktrees]
      .sort(byPath)
      .map((dir) => ({ path: dir, mainRoot: graphifyStatus(dir).mainRoot ?? null })),
  };
}

function totalsLine({ repos, worktrees }) {
  const count = (pred) => repos.filter(pred).length;
  return [
    `totals: repositories ${repos.length}`,
    `registered ${count((r) => r.kind === 'registered')}`,
    `stale ${count((r) => r.stale === true)}`,
    `unregistered ${count((r) => r.kind === 'unregistered')}`,
    `opted-out ${count((r) => r.kind === 'opted-out')}`,
    `worktrees ${worktrees.length}`,
  ].join(', ');
}

function formatText(result) {
  const cell = (v) => (v === null || v === undefined ? '-' : v === true ? 'yes' : v === false ? 'no' : String(v));
  const rows = [
    ['path', 'kind', 'nodes', 'edges', 'stale'],
    ...result.repos.map((r) => [r.path, r.kind, cell(r.nodes), cell(r.edges), cell(r.stale)]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  const lines = rows.map((row) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join('  '));
  for (const r of result.repos) if (r.note) lines.push(`note: ${r.path}: ${r.note}`);
  for (const w of result.worktrees) lines.push(`worktree: ${w.path} (graph from ${cell(w.mainRoot)})`);
  lines.push(totalsLine(result));
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const opts = { roots: [], json: false, maxDepth: DEFAULT_MAX_DEPTH };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') opts.json = true;
    else if (a === '--max-depth' || a.startsWith('--max-depth=')) {
      const raw = a === '--max-depth' ? args[++i] : a.slice('--max-depth='.length);
      if (!/^\d+$/.test(raw ?? '')) return { error: `--max-depth needs a non-negative integer, got ${raw ?? 'nothing'}` };
      opts.maxDepth = Number(raw);
    } else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else opts.roots.push(a);
  }
  if (opts.roots.length === 0) return { error: 'no root given' };
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.error) {
    console.error(`graphify-audit: ${opts.error}\n\n${USAGE}`);
    return 2;
  }
  for (const root of opts.roots) {
    let st = null;
    try {
      st = statSync(root);
    } catch {}
    if (!st?.isDirectory()) {
      console.error(`graphify-audit: root is not an existing directory: ${path.resolve(root)}`);
      return 2;
    }
  }
  const result = audit(opts.roots, { maxDepth: opts.maxDepth });
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatText(result));
  return result.repos.some((r) => r.kind === 'unregistered') ? 1 : 0;
}

if (import.meta.main) {
  // exitCode instead of exit() so a large JSON report finishes flushing to a pipe.
  process.exitCode = main(process.argv.slice(2));
}
