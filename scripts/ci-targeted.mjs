#!/usr/bin/env bun
// scripts/ci-targeted.mjs
//
// Runs only the ci checks a change can affect, so a session gate takes seconds
// instead of the whole `bun run ci`. A change it cannot place gets the full list.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitError, gitText } from './lib/git.mjs';
import { buildIndex, modTests } from './lib/ci-targeted-index.mjs';
import { escapeRe } from './lib/escape-re.mjs';

export { buildIndex, mermaidBlocks, scriptsOnlyChange } from './lib/ci-targeted-index.mjs';

const USAGE = 'usage: ci-targeted.mjs [--base <ref>] [--root <dir>] [--plan|--rencana] [--full|--penuh]';
// docs-include:start full-ci
const TEST_CMD = ['bun', 'test', '--timeout', '30000'];

// Mirrors the `ci` script; a test keeps them in sync.
export const FULL_CI = [
  { name: 'render-diagrams', cmd: ['bash', 'scripts/render-diagrams.sh'] },
  { name: 'validate-skill', cmd: ['bun', 'scripts/validate-skill.mjs'] },
  { name: 'validate-agents', cmd: ['bun', 'scripts/validate-agents.mjs'] },
  { name: 'gen-sprite-agents', cmd: ['bun', 'scripts/gen-sprite-agents.mjs', '--check'] },
  { name: 'file-size', cmd: ['bun', 'scripts/check-file-size.mjs', '--all'] },
  { name: 'tests', cmd: [...TEST_CMD, 'scripts/'] },
  { name: 'sync-snippets', cmd: ['bun', 'scripts/sync-snippets.mjs', '--check'] },
];
// docs-include:end full-ci

const AGENTS_SKIP = 'nothing under agents/, .claude/agents/, or the agent scripts changed';
const SKIP_REASON = {
  'render-diagrams': 'no diagram source, mermaid config, changed mermaid block, or renderer script changed',
  'validate-skill': 'nothing under skills/, templates/, examples/, the root docs, or the validator changed',
  'validate-agents': AGENTS_SKIP,
  'gen-sprite-agents': AGENTS_SKIP,
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
    match: (p) => ['skills/', 'templates/', 'examples/', 'docs/guide/'].some((d) => p.startsWith(d))
      || ['Super Ultra Code Plan Implementation.md', 'README.md', 'AGENTS.md'].includes(p),
  },
  {
    suites: ['validate-agents', 'gen-sprite-agents'],
    scripts: ['scripts/validate-agents.mjs', 'scripts/gen-sprite-agents.mjs'],
    match: (p) => p.startsWith('agents/') || p.startsWith('.claude/agents/'),
  },
  {
    suites: ['sync-snippets'],
    scripts: ['scripts/sync-snippets.mjs'],
    // Its tests read snippets through the manifest, so no path names them.
    ownTests: true,
    match: (p) => p.startsWith('snippets/') || p === 'snippets.manifest.json',
  },
];

const RECOGNIZED_DIRS = ['scripts/', 'skills/', 'templates/', 'examples/', 'agents/', '.claude/agents/', 'snippets/', 'docs/', 'diagrams/', 'vault-index/', 'apps/', 'evals/'];
const RECOGNIZED_FILES = [
  'snippets.manifest.json', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'MEMORY.md', 'GLOSSARY.md', 'Super Ultra Code Plan Implementation.md',
  'LICENSE', 'THIRD-PARTY-NOTICES.md', '.gitignore', '.graphifyignore', 'puppeteer-config.json',
];
const CODE_EXT = /\.(?:mjs|cjs|js|sh|py)$/;
// Path-like tokens: imports, spawn arguments, path.join segments, shell paths.
const REF = /[\w$./-]*[\w-]\.(?:mjs|cjs|js|sh|py|ps1|tsv|json|md|txt|ya?ml)(?![\w-])/g;
// A test that lists its own directory reaches every file in it without naming any.
const SELF_SCAN = /readdirSync\(\s*(?:new URL\(\s*['"`]\.\/['"`]|import\.meta\.dirname?\b|__dirname\b)/;

const isTest = (p) => p.endsWith('.test.mjs');

function toolchainReason(p) {
  // A fixture's package.json belongs to a throwaway eval repository, not to this one.
  if (p.startsWith('evals/fixtures/')) return null;
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
  // A bare name or partial path, as in path.join(ROOT, 'scripts', 'x.sh').
  return files.filter((f) => f === token || f.endsWith(`/${token}`));
}

// Whole-line comments only: `/*` or `//` inside a string (a glob, a URL) is code.
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

// A path-only literal (import specifier, spawn argument, path.join segment). A doc needle
// such as 'bun scripts/x.mjs --flag' or a bare 'x.mjs' is no dependency, so a slashless
// name counts only as a call argument.
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

/** Edges from each indexed file to the files it names: a module by path literals outside
 * comments (prose would chain scripts/ into one component), a test (a leaf) by any mention. */
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
  // A doc directly under evals/ (its README) is read by no test that merely names evals/;
  // a mod's own suite test comes from modTests, not from every test naming mods/.
  const broad = p.includes('/') && !/^evals\/[^/]+$/.test(p) && !p.startsWith('mods/');
  const tests = new Set();
  for (const [f, src] of Object.entries(sources)) {
    if (isTest(f) && (mentionsPath(src, p) || (broad && topLiteral.test(src)))) tests.add(f);
  }
  return tests;
}

function fullPlan(base, reasons, ignored, paths) {
  return {
    full: true,
    suites: [...FULL_CI.map((s) => ({ ...s, cmd: withBase(s, base), reasons: [...reasons] })), ...docsSuites(reasons), copySuite(base), ...evalSuites(paths)],
    skipped: [],
    ignored,
  };
}

// A ceiling raised since the base must name a plan id.
const withBase = (s, base) => (s.name === 'file-size' ? [...s.cmd, '--base', base] : [...s.cmd]);

function copySuite(base) {
  return { name: 'copy-rules', cmd: ['bun', 'scripts/check-copy-rules.mjs', '--diff', base], reasons: ['always: commits and added lines since the base'] };
}

const EVAL_BASELINE = 'docs/code-plan/evals/baseline.json';
const EVAL_INPUT = /^(?:skills|agents|\.claude\/agents|evals\/scenarios|evals\/fixtures)\//;
// Every eval run costs money, so only a change to the rules it measures selects it, even under --full.
// $20, not the default $15: a flaky scenario always runs five times.
function evalSuites(paths) {
  const reasons = paths.filter((p) => EVAL_INPUT.test(p))
    .map((p) => `${p}: ${p.startsWith('evals/') ? 'eval scenario or fixture' : 'skill or agent rules'} changed`);
  return reasons.length ? [{ name: 'eval', cmd: ['bun', 'scripts/eval-run.mjs', '--baseline', EVAL_BASELINE, '--repeat', '1', '--confirm-flips', '2', '--budget-usd', '20'], requires: EVAL_BASELINE, reasons }] : [];
}

// docs/code-plan/ holds session records, not docs pages.
const isDocsSource = (p) => p === 'README.md' || p.startsWith('apps/docs/')
  || (p.startsWith('docs/') && !p.startsWith('docs/code-plan/'));

// Indonesian twins may lag while the docs site is frozen: `--warn` only reports them.
const docsSuites = (reasons) => [['docs-gen', '--check', '--scope', 'en'], ['docs-warn', '--warn']]
  .map(([name, ...flags]) => ({ name, cmd: ['bun', 'scripts/docs-gen.mjs', ...flags], reasons: [...reasons] }));

/** Planner: `index.sources` maps scripts/ to text; `index.mermaidChanged` lists edited mermaid blocks. */
export function planChecks(changed, index, { base = 'origin/main', full = false } = {}) {
  const sources = index.sources ?? {};
  const mermaidChanged = new Set(index.mermaidChanged ?? []);
  // A script-entry edit changes no dependency or toolchain: no full ci.
  const scriptsOnly = new Set(index.packageScriptsOnly ?? []);
  const untracked = new Set(index.untracked ?? []);
  const all = [...new Set(changed.map((p) => p.replace(/^\.\//, '')))]
    .filter((p) => p && !p.startsWith('graphify-out/'))
    .sort();
  // An untracked non-code file outside the known paths is reported, not a full-ci reason.
  const ignored = all
    .filter((p) => untracked.has(p) && !recognized(p) && !CODE_EXT.test(p) && !toolchainReason(p))
    .map((p) => ({ path: p, reason: 'untracked local file outside the repository paths' }));
  const paths = all.filter((p) => !ignored.some((i) => i.path === p));

  if (full) return fullPlan(base, ['--full requested'], ignored, paths);
  const fullReasons = [];
  for (const p of paths) {
    const why = scriptsOnly.has(p) ? null : toolchainReason(p) ?? (recognized(p) || modTests(p, sources, index.marketplaceMods) ? null : 'unrecognized path');
    if (why) fullReasons.push(`${p}: ${why}`);
  }
  if (fullReasons.length) return fullPlan(base, fullReasons, ignored, paths);

  const graph = buildGraph(sources);
  const selectedTests = new Set();
  const testReasons = [];
  for (const p of paths) {
    const tests = p.startsWith('scripts/') ? testsForScript(p, sources, graph) : testsForOther(p, sources);
    for (const t of modTests(p, sources, index.marketplaceMods) ?? []) tests.add(t);
    if (p.startsWith('scripts/') && !isTest(p) && CODE_EXT.test(p) && tests.size === 0) {
      fullReasons.push(`${p}: no test reaches it`);
    }
    if (tests.size) testReasons.push(`${p} -> ${[...tests].sort().join(', ')}`);
    for (const t of tests) selectedTests.add(t);
  }
  if (fullReasons.length) return fullPlan(base, fullReasons, ignored, paths);

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
      if (cat.match(p) || cat.scripts.includes(p)) {
        why = 'matches this check';
        const own = cat.ownTests ? cat.scripts.filter((s) => s in sources).flatMap((s) => [...testsForScript(s, sources, graph)]) : [];
        for (const t of own) selectedTests.add(t);
        if (own.length) testReasons.push(`${p} -> ${[...new Set(own)].sort().join(', ')} (tests of its check)`);
      } else if (reach.has(p) && !isTest(p)) why = `used by ${cat.scripts.filter((s) => closure([s], graph.deps, { stopAtTests: true }).has(p)).join(', ')}`;
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
    } else if (s.name === 'file-size') {
      suites.push({ ...s, cmd: withBase(s, base), reasons: ['always: a few git calls over the index'] });
    } else if (categoryReasons.has(s.name)) {
      suites.push({ ...s, cmd: [...s.cmd], reasons: categoryReasons.get(s.name) });
    } else {
      skipped.push({ name: s.name, reason: SKIP_REASON[s.name] });
    }
  }
  const inc = new Set(index.includedSources ?? []);
  const docsReasons = paths.filter((p) => isDocsSource(p) || inc.has(p))
    .map((p) => `${p}: ${isDocsSource(p) ? 'docs page source' : 'source included by a docs page'} changed`);
  if (docsReasons.length) suites.push(...docsSuites(docsReasons));
  suites.push(copySuite(base), ...evalSuites(paths));
  return { full: false, suites, skipped, ignored };
}

class ArgError extends Error {}

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

export function changedFiles(root, base) {
  // -C, not cwd: then git's own error names a bad root.
  const git = (...a) => gitText(process.cwd(), ['-C', root, ...a], { label: `git ${a.join(' ')} failed` });
  const mergeBase = git('merge-base', 'HEAD', base).trim();
  const lists = [
    git('diff', '--name-only', '-z', '--no-renames', mergeBase),
    git('diff', '--name-only', '-z', '--no-renames', 'HEAD'),
    git('ls-files', '--others', '--exclude-standard', '-z'),
  ];
  const files = [...new Set(lists.flatMap((s) => s.split('\0').filter(Boolean)))].sort();
  return { mergeBase, files, untracked: lists[2].split('\0').filter(Boolean) };
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
  const ignored = plan.ignored ?? [];
  if (ignored.length) {
    log(`ignored (${ignored.length}):`);
    for (const i of ignored) log(`  ${i.path}: ${i.reason}`);
  }
}

function defaultSpawn(cmd, { cwd }) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? r.signal;
}

/** Runs every suite even after a failure; a suite that cannot start counts as failed, one whose `requires` file is absent as SKIP. */
export function runSuites(suites, { root, spawn = defaultSpawn, log = console.log }) {
  const results = [];
  for (const s of suites) {
    log(`\n==> ${s.name}: ${s.cmd.join(' ')}`);
    if (s.requires && !fs.existsSync(path.join(root, s.requires))) {
      log(`SKIP ${s.name}: ${s.requires} is absent`);
      results.push({ name: s.name, exit: '-', seconds: 0, status: 'SKIP' });
      continue;
    }
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
  return { code: results.every((r) => r.status !== 'FAIL') ? 0 : 1, results };
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
    const root = path.resolve(opts.root ?? gitText(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
    const { mergeBase, files, untracked } = changedFiles(root, opts.base);
    const index = opts.full ? { untracked } : buildIndex(root, files, mergeBase, untracked);
    const plan = planChecks(files, index, { base: opts.base, full: opts.full });
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
