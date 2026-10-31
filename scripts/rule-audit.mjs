#!/usr/bin/env bun
// scripts/rule-audit.mjs
//
// Read-only audit of the rule handbook. For each `| L<n> |` row in docs/memory/*.md it
// reports the topic file, the date git first saw the row, backticked repo paths that no
// longer exist, and the eval scenarios whose `rules` array links it. IDs on the
// `Retired:` line of MEMORY.md are counted, not listed. The audit is advice for the
// debt sweep; retiring a rule stays a human decision.
//
// Usage: bun scripts/rule-audit.mjs [--json] [--root <dir>]
// Exit: 0 ok, 1 docs/memory missing (E_PRECOND_INPUT), 2 usage error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULE_ROW = /^\| (L\d+) \|(.*)$/gm;
// Paths in this file name other repositories, so checking them here would only add noise.
const OTHER_REPOS = 'other-repositories.md';
const USAGE = 'usage: bun scripts/rule-audit.mjs [--json] [--root <dir>]';

function defaultGit(root) {
  return (args) => {
    try {
      const p = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
      return p.exitCode === 0 ? p.stdout.toString() : null;
    } catch {
      return null;
    }
  };
}

// A token is a repo path when it has no spaces, placeholders, or globs, is relative,
// and either ends in `/` or its last segment has a file extension.
export function repoPathOf(token) {
  if (/[\s<>*{}$]/.test(token) || token.includes('://') || /^[~/]/.test(token)) return null;
  const clean = token.replace(/^\.\//, '').replace(/:\d+(-\d+)?$/, '');
  if (!clean.includes('/')) return null;
  if (clean.endsWith('/')) return clean;
  return /\.[A-Za-z0-9]+$/.test(clean.split('/').at(-1)) ? clean : null;
}

// A cited path a rule names loosely: `lib/x.mjs` for scripts/lib/x.mjs, or `pr/` for a
// folder deeper in the tree. Any tracked file with that tail resolves it.
function isTrackedSuffix(p, tracked) {
  const dir = p.endsWith('/');
  return tracked.some((f) => (dir ? f.startsWith(p) || f.includes(`/${p}`) : f === p || f.endsWith(`/${p}`)));
}

// Gitignored paths (docs/code-plan/ and the like) are absent from a fresh worktree by design.
function isIgnored(git, p) {
  return Boolean(git(['check-ignore', '--', p])?.trim());
}

function missingPaths(text, root, git, tracked) {
  const cited = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => repoPathOf(m[1])).filter(Boolean);
  const found = new Set();
  for (const p of cited) {
    // `plans/` after `docs/code-plan/plans/` in one row is shorthand; the long form is checked.
    if (found.has(p) || cited.some((q) => q.endsWith(`/${p}`))) continue;
    if (fs.existsSync(path.join(root, p))) continue;
    if (isIgnored(git, p) || isTrackedSuffix(p, tracked())) continue;
    found.add(p);
  }
  return [...found];
}

function retiredIds(root) {
  const file = path.join(root, 'MEMORY.md');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').match(/^Retired: (.*)$/m)?.[1].match(/L\d+/g) ?? [];
}

function scenarioLinks(root) {
  const dir = path.join(root, 'evals', 'scenarios');
  const links = new Map();
  if (!fs.existsSync(dir)) return links;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    for (const id of Array.isArray(s.rules) ? s.rules : []) {
      if (!links.has(id)) links.set(id, []);
      links.get(id).push(s.id ?? path.basename(name, '.json'));
    }
  }
  return links;
}

// The earliest date wins whatever order the dates come back in.
function firstSeen(git, id) {
  const out = git(['log', '--format=%cs', '-S', `| ${id} |`, '--', 'MEMORY.md', 'docs/memory']);
  const dates = (out ?? '').split('\n').filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return dates.length ? dates.sort()[0] : 'unknown';
}

export function auditRules({ root, git = defaultGit(root) }) {
  const dir = path.join(root, 'docs', 'memory');
  if (!fs.existsSync(dir)) {
    const err = new Error(`E_PRECOND_INPUT: ${dir} not found`);
    err.code = 'E_PRECOND_INPUT';
    throw err;
  }
  const retired = new Set(retiredIds(root));
  const links = scenarioLinks(root);
  let files;
  const tracked = () => (files ??= (git(['ls-files']) ?? '').split('\n').filter(Boolean));
  const rules = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const [, id, rest] of text.matchAll(RULE_ROW)) {
      if (retired.has(id)) continue;
      rules.push({
        id,
        topic: `docs/memory/${name}`,
        firstSeen: firstSeen(git, id),
        missingPaths: name === OTHER_REPOS ? [] : missingPaths(rest, root, git, tracked),
        scenarios: links.get(id) ?? [],
      });
    }
  }
  rules.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const totals = {
    rules: rules.length,
    retired: retired.size,
    withScenario: rules.filter((r) => r.scenarios.length).length,
    withMissingPath: rules.filter((r) => r.missingPaths.length).length,
  };
  return { rules, totals };
}

export function formatTable({ rules, totals }) {
  const head = ['ID', 'Topic', 'First seen', 'Missing paths', 'Scenarios'];
  const body = rules.map((r) => [
    r.id,
    r.topic.replace(/^docs\/memory\//, ''),
    r.firstSeen,
    r.missingPaths.join(', ') || '-',
    r.scenarios.join(', ') || 'no scenario',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  return [line(head), ...body.map(line),
    `rules: ${totals.rules}, retired: ${totals.retired}, with a scenario: ${totals.withScenario}, with a missing path: ${totals.withMissingPath}`,
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { json: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--root' && argv[i + 1] && !argv[i + 1].startsWith('--')) opts.root = path.resolve(argv[++i]);
    else return null;
  }
  return opts;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(2);
  }
  let report;
  try {
    report = auditRules({ root: opts.root });
  } catch (err) {
    if (err.code !== 'E_PRECOND_INPUT') throw err;
    console.error(err.message);
    process.exit(1);
  }
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatTable(report));
}
