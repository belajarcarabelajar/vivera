#!/usr/bin/env bun
// scripts/ci-targeted.mjs
//
// Runs only the ci checks a change can affect, so a session gate takes seconds
// instead of the whole `bun run ci`. When the planner cannot tell what a change
// reaches, it falls back to the full list instead of guessing.
//
//   bun scripts/ci-targeted.mjs [--base <ref>] [--root <dir>] [--plan|--rencana] [--full|--penuh]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: ci-targeted.mjs [--base <ref>] [--root <dir>] [--plan|--rencana] [--full|--penuh]';
const TEST_CMD = ['bun', 'test', '--timeout', '30000'];

// Same order and commands as the `ci` script; a test keeps the two in sync.
export const FULL_CI = [
  { name: 'render-diagrams', cmd: ['bash', 'scripts/render-diagrams.sh'] },
  { name: 'validate-skill', cmd: ['bun', 'scripts/validate-skill.mjs'] },
  { name: 'validate-agents', cmd: ['bun', 'scripts/validate-agents.mjs'] },
  { name: 'gen-sprite-agents', cmd: ['bun', 'scripts/gen-sprite-agents.mjs', '--check'] },
  { name: 'tests', cmd: [...TEST_CMD, 'scripts/'] },
  { name: 'sync-snippets', cmd: ['bun', 'scripts/sync-snippets.mjs', '--check'] },
];

const SKIP_REASON = {
  'render-diagrams': 'no diagram source, mermaid config, changed mermaid block, or renderer script changed',
  'validate-skill': 'nothing under skills/, templates/, examples/, the root docs, or the validator changed',
  'validate-agents': 'nothing under agents/ or the agent scripts changed',
  'gen-sprite-agents': 'nothing under agents/ or the agent scripts changed',
  tests: 'no test reaches the changed files',
  'sync-snippets': 'nothing under snippets/, snippets.manifest.json, or the sync script changed',
};

const CATEGORIES = [
  {
    suites: ['render-diagrams'],
    scripts: ['scripts/render-diagrams.sh'],
    // puppeteer-config.json is read by render-diagrams.sh on every run.
    match: (p) => p.startsWith('docs/diagrams-src/') || p.startsWith('diagrams/')
      || /^mermaid[^/]*\.json$/.test(p) || p === 'puppeteer-config.json',
  },
  {
    suites: ['validate-skill'],
    scripts: ['scripts/validate-skill.mjs', 'scripts/validate-lib.mjs'],
    match: (p) => ['skills/', 'templates/', 'examples/'].some((d) => p.startsWith(d))
      || ['Super Ultra Code Plan Implementation.md', 'README.md', 'AGENTS.md'].includes(p),
  },
  {
    suites: ['validate-agents', 'gen-sprite-agents'],
    scripts: ['scripts/validate-agents.mjs', 'scripts/gen-sprite-agents.mjs'],
    match: (p) => p.startsWith('agents/'),
  },
  {
    suites: ['sync-snippets'],
    scripts: ['scripts/sync-snippets.mjs'],
    match: (p) => p.startsWith('snippets/') || p === 'snippets.manifest.json',
  },
];

const RECOGNIZED_DIRS = ['scripts/', 'skills/', 'templates/', 'examples/', 'agents/', 'snippets/', 'docs/', 'diagrams/', 'vault-index/'];
const RECOGNIZED_FILES = [
  'snippets.manifest.json', 'README.md', 'AGENTS.md', 'MEMORY.md', 'Super Ultra Code Plan Implementation.md',
  'LICENSE', 'THIRD-PARTY-NOTICES.md', '.gitignore', '.graphifyignore', 'puppeteer-config.json',
];
const CODE_EXT = /\.(?:mjs|cjs|js|sh|py)$/;
const INDEX_EXT = /\.(?:mjs|cjs|js|sh|py|ps1|tsv|json|md|txt|ya?ml)$/;
// Path-like tokens: import specifiers, spawn arguments, `path.join` segments, shell paths.
const REF = /[\w$./-]*[\w-]\.(?:mjs|cjs|js|sh|py|ps1|tsv|json|md|txt|ya?ml)(?![\w-])/g;
// A test that lists its own directory reaches every file in it without naming any.
const SELF_SCAN = /readdirSync\(\s*(?:new URL\(\s*['"`]\.\/['"`]|import\.meta\.dirname?\b|__dirname\b)/;

const isTest = (p) => p.endsWith('.test.mjs');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toolchainReason(p) {
  const base = path.posix.basename(p);
  if (base === 'package.json' || base === 'bun.lock' || /^tsconfig.*\.json$/.test(base)) return 'root config or toolchain file';
  if (p.startsWith('.githooks/') || p === 'install.sh' || p === 'install.ps1' || p.startsWith('scripts/install/')) {
    return 'installer or git hook';
  }
  return null;
}

function recognized(p) {
  return RECOGNIZED_DIRS.some((d) => p.startsWith(d)) || RECOGNIZED_FILES.includes(p) || /^mermaid[^/]*\.json$/.test(p);
}

function mentionsPath(source, p) {
  return new RegExp(`(?:^|[\\s'"\`/(=])${escapeRe(p)}(?:$|[\\s'"\`)])`, 'm').test(source);
}

function resolveRef(from, token, files) {
  const at = token.search(/(?:^|\/)scripts\//);
  if (at >= 0) {
    const rel = path.posix.normalize(token.slice(token.indexOf('scripts/', at)));
    return files.includes(rel) ? [rel] : [];
  }
  if (token.startsWith('./') || token.startsWith('../')) {
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), token));
    return files.includes(rel) ? [rel] : [];
  }
  // A bare name or a partial path, as in path.join(ROOT, 'scripts', 'install', 'prereq.sh').
  return files.filter((f) => f === token || f.endsWith(`/${token}`));
}

// Only whole-line comments: a `/*` or `//` inside a string (a glob, a URL) must not eat code.
function stripComments(file, src) {
  if (/\.(?:sh|py)$/.test(file)) return src.replace(/^[ \t]*#.*$/gm, '');
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/(^|[ \t])\/\/.*$/gm, '$1');
}

const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const WHOLE_PATH = new RegExp(`^${REF.source}$`);

// Inside an open call: an argument of path.join, new URL, spawnSync, and the like.
function inCall(src, at) {
  const before = src.slice(Math.max(0, at - 300), at);
  const open = before.lastIndexOf('(');
  return open >= 0 && !before.slice(open).includes(')') && /[\w$]$/.test(before.slice(0, open));
}

// A literal that is a path and nothing else: an import specifier, a spawn
// argument, a `path.join` segment. `'bun scripts/x.mjs --flag'` is a needle a
// validator searches docs for, not a dependency, and so is a bare `'x.mjs'` in a
// list of needles, which is why a name without a slash must be a call argument.
function pathLiterals(src) {
  const out = [];
  for (const m of src.matchAll(LITERAL)) {
    const body = m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, '');
    if (WHOLE_PATH.test(body) && (body.includes('/') || inCall(src, m.index))) out.push(body);
  }
  return out;
}

function referencesOf(file, src) {
  if (isTest(file)) return src.match(REF) ?? [];
  const code = stripComments(file, src);
  return /\.(?:sh|py)$/.test(file) ? code.match(REF) ?? [] : pathLiterals(code);
}

function namesPath(file, src, p) {
  return referencesOf(file, src).some((r) => {
    const t = r.replace(/^\.?\//, '');
    return t === p || t.endsWith(`/${p}`);
  });
}

/**
 * Edges from each indexed file to every indexed file it names. A module counts
 * only path literals outside comments, because prose and needles that mention
 * another script would chain most of scripts/ into one component. Tests are
 * leaves, so a mention anywhere in them still counts.
 */
export function buildGraph(sources) {
  const files = Object.keys(sources);
  const deps = new Map(files.map((f) => [f, new Set()]));
  const rdeps = new Map(files.map((f) => [f, new Set()]));
  for (const from of files) {
    for (const token of new Set(referencesOf(from, sources[from]))) {
      for (const to of resolveRef(from, token, files)) {
        if (to === from) continue;
        deps.get(from).add(to);
        rdeps.get(to).add(from);
      }
    }
  }
  return { deps, rdeps };
}

function closure(start, edges, { stopAtTests = false } = {}) {
  const seen = new Set();
  const queue = [...start];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (stopAtTests && isTest(f)) continue;
    for (const next of edges.get(f) ?? []) queue.push(next);
  }
  return seen;
}

function testsForScript(p, sources, graph) {
  const tests = new Set();
  if (isTest(p) && p in sources) tests.add(p);
  for (const f of closure([p], graph.rdeps)) if (isTest(f)) tests.add(f);
  const dir = path.posix.dirname(p);
  for (const [f, src] of Object.entries(sources)) {
    if (!isTest(f)) continue;
    if (mentionsPath(src, p)) tests.add(f);
    else if (path.posix.dirname(f) === dir && SELF_SCAN.test(src)) tests.add(f);
  }
  return tests;
}

function testsForOther(p, sources) {
  const top = p.split('/')[0];
  const topLiteral = new RegExp(`['"\`]${escapeRe(top)}(?:['"\`]|/)`);
  const tests = new Set();
  for (const [f, src] of Object.entries(sources)) {
    if (isTest(f) && (mentionsPath(src, p) || (p.includes('/') && topLiteral.test(src)))) tests.add(f);
  }
  return tests;
}

function fullPlan(base, reasons) {
  return {
    full: true,
    suites: [...FULL_CI.map((s) => ({ ...s, cmd: [...s.cmd], reasons: [...reasons] })), copySuite(base)],
    skipped: [],
  };
}

function copySuite(base) {
  return { name: 'copy-rules', cmd: ['bun', 'scripts/check-copy-rules.mjs', '--diff', base], reasons: ['always: commits and added lines since the base'] };
}

/**
 * Pure planner. `index.sources` maps every file under scripts/ to its text;
 * `index.mermaidChanged` lists markdown files whose mermaid blocks differ from the base.
 */
/** True when two package.json texts differ only inside `scripts`; a side that does not parse is never scripts-only. */
export function scriptsOnlyChange(before, after) {
  try {
    const a = JSON.parse(before);
    const b = JSON.parse(after);
    delete a.scripts;
    delete b.scripts;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function planChecks(changed, index, { base = 'origin/main' } = {}) {
  const sources = index.sources ?? {};
  const mermaidChanged = new Set(index.mermaidChanged ?? []);
  // A new or edited script entry changes no dependency or toolchain, so it does not need the full ci.
  const scriptsOnly = new Set(index.packageScriptsOnly ?? []);
  const paths = [...new Set(changed.map((p) => p.replace(/^\.\//, '')))]
    .filter((p) => p && !p.startsWith('graphify-out/'))
    .sort();

  const fullReasons = [];
  for (const p of paths) {
    const why = scriptsOnly.has(p) ? null : toolchainReason(p) ?? (recognized(p) ? null : 'unrecognized path');
    if (why) fullReasons.push(`${p}: ${why}`);
  }
  if (fullReasons.length) return fullPlan(base, fullReasons);

  const graph = buildGraph(sources);
  const selectedTests = new Set();
  const testReasons = [];
  for (const p of paths) {
    const tests = p.startsWith('scripts/') ? testsForScript(p, sources, graph) : testsForOther(p, sources);
    if (p.startsWith('scripts/') && !isTest(p) && CODE_EXT.test(p) && tests.size === 0) {
      fullReasons.push(`${p}: no test reaches it`);
    }
    if (tests.size) testReasons.push(`${p} -> ${[...tests].sort().join(', ')}`);
    for (const t of tests) selectedTests.add(t);
  }
  if (fullReasons.length) return fullPlan(base, fullReasons);

  const categoryReasons = new Map();
  const addReason = (suite, reason) => {
    if (!categoryReasons.has(suite)) categoryReasons.set(suite, []);
    categoryReasons.get(suite).push(reason);
  };
  for (const cat of CATEGORIES) {
    const reach = closure(cat.scripts.filter((s) => s in sources), graph.deps, { stopAtTests: true });
    const readers = [...reach].filter((f) => !isTest(f));
    for (const p of paths) {
      let why = null;
      if (cat.match(p) || cat.scripts.includes(p)) why = 'matches this check';
      else if (reach.has(p) && !isTest(p)) why = `used by ${cat.scripts.filter((s) => closure([s], graph.deps, { stopAtTests: true }).has(p)).join(', ')}`;
      else if (!p.startsWith('scripts/') && readers.some((f) => namesPath(f, sources[f], p))) why = 'read by the check';
      else if (cat.suites.includes('render-diagrams') && mermaidChanged.has(p)) why = 'mermaid block changed';
      if (why) for (const s of cat.suites) addReason(s, `${p}: ${why}`);
    }
  }

  const suites = [];
  const skipped = [];
  for (const s of FULL_CI) {
    if (s.name === 'tests') {
      if (selectedTests.size) {
        suites.push({ name: 'tests', cmd: [...TEST_CMD, ...[...selectedTests].sort().map((t) => `./${t}`)], reasons: testReasons });
      } else {
        skipped.push({ name: 'tests', reason: SKIP_REASON.tests });
      }
    } else if (categoryReasons.has(s.name)) {
      suites.push({ ...s, cmd: [...s.cmd], reasons: categoryReasons.get(s.name) });
    } else {
      skipped.push({ name: s.name, reason: SKIP_REASON[s.name] });
    }
  }
  suites.push(copySuite(base));
  return { full: false, suites, skipped };
}

/** Fenced mermaid blocks, delimited the way render-diagrams.sh extracts them. */
export function mermaidBlocks(text) {
  const blocks = [];
  let buf = null;
  for (const line of text.split('\n')) {
    if (buf === null && /^```mermaid[ \t]*$/.test(line)) buf = '';
    else if (buf !== null && /^```[ \t]*$/.test(line)) { blocks.push(buf); buf = null; }
    else if (buf !== null) buf += `${line}\n`;
  }
  return blocks;
}

class ArgError extends Error {}
class GitError extends Error {}

export function parseArgs(argv) {
  const opts = { base: 'origin/main', root: null, plan: false, full: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan' || a === '--rencana') opts.plan = true;
    else if (a === '--full' || a === '--penuh') opts.full = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--base' || a === '--root') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new ArgError(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else throw new ArgError(`unknown argument: ${a}`);
  }
  return opts;
}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new GitError(`git ${args.join(' ')} failed: ${(r.error?.message ?? r.stderr).trim()}`);
  }
  return r.stdout;
}

export function changedFiles(root, base) {
  const mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
  const lists = [
    git(root, ['diff', '--name-only', '-z', '--no-renames', mergeBase]),
    git(root, ['diff', '--name-only', '-z', '--no-renames', 'HEAD']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ];
  const files = [...new Set(lists.flatMap((s) => s.split('\0').filter(Boolean)))].sort();
  return { mergeBase, files };
}

function readSources(root) {
  const sources = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(child);
      } else if (e.isFile() && INDEX_EXT.test(e.name)) {
        sources[child] = fs.readFileSync(path.join(root, child), 'utf8');
      }
    }
  };
  if (fs.existsSync(path.join(root, 'scripts'))) walk('scripts');
  return sources;
}

function mermaidChangedFiles(root, files, mergeBase) {
  const out = [];
  for (const p of files) {
    if (!p.endsWith('.md') || p.startsWith('graphify-out/')) continue;
    const abs = path.join(root, p);
    const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const before = spawnSync('git', ['-C', root, 'show', `${mergeBase}:${p}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const old = before.status === 0 ? before.stdout : '';
    if (JSON.stringify(mermaidBlocks(now)) !== JSON.stringify(mermaidBlocks(old))) out.push(p);
  }
  return out;
}

function packageScriptsOnlyFiles(root, files, mergeBase) {
  return files.filter((p) => p === 'package.json').filter((p) => {
    const abs = path.join(root, p);
    const before = spawnSync('git', ['-C', root, 'show', `${mergeBase}:${p}`], { encoding: 'utf8' });
    return before.status === 0 && fs.existsSync(abs) && scriptsOnlyChange(before.stdout, fs.readFileSync(abs, 'utf8'));
  });
}

export function buildIndex(root, files, mergeBase) {
  return {
    sources: readSources(root),
    mermaidChanged: mermaidChangedFiles(root, files, mergeBase),
    packageScriptsOnly: packageScriptsOnlyFiles(root, files, mergeBase),
  };
}

function printPlan(log, { base, mergeBase, files, plan }) {
  log(`base: ${base} (merge-base ${mergeBase.slice(0, 12)})`);
  log(`changed files (${files.length}):`);
  for (const f of files) log(`  ${f}`);
  log(`mode: ${plan.full ? 'FULL' : 'targeted'}`);
  log(`suites (${plan.suites.length}):`);
  for (const s of plan.suites) {
    log(`  ${s.name}: ${s.cmd.join(' ')}`);
    for (const r of s.reasons) log(`    - ${r}`);
  }
  log(`skipped (${plan.skipped.length}):`);
  for (const s of plan.skipped) log(`  ${s.name}: ${s.reason}`);
}

function defaultSpawn(cmd, { cwd }) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? r.signal;
}

/** Runs every suite even after a failure; a suite that cannot start counts as failed. */
export function runSuites(suites, { root, spawn = defaultSpawn, log = console.log }) {
  const results = [];
  for (const s of suites) {
    log(`\n==> ${s.name}: ${s.cmd.join(' ')}`);
    const t0 = performance.now();
    let exit;
    try {
      exit = spawn(s.cmd, { cwd: root });
    } catch (e) {
      log(`cannot start ${s.name}: ${e.message}`);
      exit = 'not started';
    }
    const seconds = (performance.now() - t0) / 1000;
    results.push({ name: s.name, exit, seconds, status: exit === 0 ? 'PASS' : 'FAIL' });
  }
  const width = Math.max(5, ...results.map((r) => r.name.length));
  log(`\n${'suite'.padEnd(width)}  ${'exit'.padStart(11)}  ${'seconds'.padStart(7)}  status`);
  for (const r of results) {
    log(`${r.name.padEnd(width)}  ${String(r.exit).padStart(11)}  ${r.seconds.toFixed(1).padStart(7)}  ${r.status}`);
  }
  return { code: results.every((r) => r.status === 'PASS') ? 0 : 1, results };
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  try {
    const root = path.resolve(opts.root ?? git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
    const { mergeBase, files } = changedFiles(root, opts.base);
    const plan = opts.full
      ? fullPlan(opts.base, ['--full requested'])
      : planChecks(files, buildIndex(root, files, mergeBase), { base: opts.base });
    printPlan(log, { base: opts.base, mergeBase, files, plan });
    if (opts.plan) return 0;
    return runSuites(plan.suites, { root, log }).code;
  } catch (e) {
    if (e instanceof GitError) {
      error(e.message);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
