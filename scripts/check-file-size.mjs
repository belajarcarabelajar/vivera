#!/usr/bin/env bun
// scripts/check-file-size.mjs
//
// Blocks a commit that stages a text file over 5000 tokens (tokens = bytes / 4,
// limit 20000 bytes), so no file grows past what an agent reads comfortably in
// one pass. Files already over the limit carry a ceiling in
// scripts/file-size-baseline.json: they may shrink but never grow, and
// `--write-baseline` only ever lowers or drops a ceiling (a ratchet).
//
// WHAT IS JUDGED. The index blob of each path, never the working tree, so the
// pre-commit hook and `--all` judge the same bytes and partial staging is exact.
//   --staged          paths from `git diff --cached` (added, copied, modified, renamed)
//   --all             every index path, plus stale ceilings in the baseline
//   --write-baseline  rewrite the baseline from the index (seed or tighten)
//
// SKIPPED. Symlinks (mode 120000), submodules (160000), binary files (`i/-text`
// in `git ls-files --eol`), and paths whose `size-gate` attribute is unset, that
// is `<path> -size-gate` in .gitattributes, for lockfiles, generated or vendored.
//
// OUTPUT. The report goes to stderr. The last stdout line of every run is
// `checked <N> files, <M> over the limit`, except a `--staged` run with nothing
// staged, which prints nothing.
//
// defer: tokens are bytes / 4, not a tokenizer, so code with long identifiers and Indonesian prose can be off; upgrade when a measured tokenizer comparison shows a file judged wrongly by more than 20 percent
//
// Usage: bun scripts/check-file-size.mjs [--staged | --all | --write-baseline] [--root <dir>] [--baseline <path>]
// Exit: 0 pass, 1 violation or stale ceiling, 2 usage error, not a git repository,
// invalid baseline, or a git failure.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileAtomic } from './lib/atomic-write.mjs';

export const LIMIT_BYTES = 20000;
const LIMIT_TOKENS = LIMIT_BYTES / 4;
const BASELINE_REL = 'scripts/file-size-baseline.json';
const REWRITE_CMD = 'bun scripts/check-file-size.mjs --write-baseline';
const MODES = ['--staged', '--all', '--write-baseline'];
const USAGE = 'usage: bun scripts/check-file-size.mjs [--staged | --all | --write-baseline] [--root <dir>] [--baseline <path>]';

export function tokensOf(bytes) {
  return Math.ceil(bytes / 4);
}

const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.sh', '.py', '.rs']);
const DATA_EXT = new Set(['.json', '.yaml', '.yml', '.tsv', '.csv']);

// The kind only picks the advice printed; it never changes the verdict.
export function fileKind(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base.includes('.test.')) return 'test';
  if (base === 'SKILL.md') return 'skill';
  const ext = path.extname(base).toLowerCase();
  if (CODE_EXT.has(ext)) return 'code';
  if (ext === '.md') return 'markdown';
  if (DATA_EXT.has(ext)) return 'data';
  return 'other';
}

const ceilingOf = (baseline, p) => (baseline && Object.hasOwn(baseline, p) ? baseline[p] : null);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function judge(entries, baseline) {
  const violations = [];
  for (const { path: p, bytes } of entries) {
    if (bytes <= LIMIT_BYTES) continue;
    const ceiling = ceilingOf(baseline, p);
    if (ceiling === null || bytes > ceiling) violations.push({ path: p, bytes, ceiling });
  }
  return { violations, checked: entries.length };
}

export function staleCeilings(entries, baseline) {
  const sizes = new Map(entries.map((e) => [e.path, e.bytes]));
  const stale = [];
  for (const p of Object.keys(baseline ?? {}).sort()) {
    const ceiling = baseline[p];
    const bytes = sizes.get(p);
    if (bytes === undefined) stale.push({ path: p, reason: 'gone', ceiling });
    else if (bytes <= LIMIT_BYTES) stale.push({ path: p, reason: 'within-limit', ceiling, bytes });
    else if (bytes < ceiling) stale.push({ path: p, reason: 'shrunk', ceiling, bytes });
  }
  return stale;
}

// No baseline seeds every file over the limit. An existing baseline is only
// tightened: a path is never added and a ceiling is never raised.
export function tightenBaseline(entries, baseline) {
  const next = {};
  for (const { path: p, bytes } of [...entries].sort(byPath)) {
    if (bytes <= LIMIT_BYTES) continue;
    if (!baseline) next[p] = bytes;
    else if (Object.hasOwn(baseline, p)) next[p] = Math.min(baseline[p], bytes);
  }
  return next;
}

const ADVICE = {
  test: [
    'Split by describe concern into <name>-<concern>.test.mjs beside it, as vault-index-structural.test.mjs',
    'and vault-index-merge.test.mjs do, and move shared helpers into scripts/lib/.',
  ],
  code: [
    'Move one cohesive group of functions (parsing, git I/O, rendering) into scripts/lib/<name>-<part>.mjs,',
    'export it, and import it back. Keep argument parsing and main() in the original file, and re-export',
    'anything callers import from the old path so tests and other scripts keep working.',
  ],
  skill: [
    'Move a self-contained section into a phase skill or references/<topic>.md, leave a one-line pointer,',
    'then update every scripts/validate-skill.mjs needle that names the old file.',
  ],
  markdown: ['Split at H2 headings into sibling files and keep a short index of links in the original.'],
  data: ['Split by key or range into several files loaded together, or mark the file generated if a script writes it.'],
  other: ['Split by responsibility into sibling files.'],
};
const LABEL = { test: 'a test', code: 'a code', skill: 'a skill', markdown: 'a Markdown', data: 'a data', other: 'any other' };
const SH_LINE = '  For a .sh file, move the functions into scripts/lib/<name>-<part>.sh and source it instead.';
const README_LINE = '  For README.md, update the page map in apps/docs/pages.json and run: bun scripts/docs-gen.mjs --check --scope all';
const FOOTER = [
  'After splitting:',
  "  1. git grep -n '<old path>' and update every reference (scripts/validate-skill.mjs pins skill paths,",
  '     scripts/ci-targeted.mjs and README.md name scripts).',
  '  2. Stage the new files and commit again.',
  "If the file is a lockfile, generated, or vendored: add '<path> -size-gate' to .gitattributes instead.",
  `If splitting is out of scope for this change: raise its ceiling in ${BASELINE_REL} in this`,
  '  commit and name the follow-up in the PR body. The raise is visible in review.',
  'A renamed file counts as new: move its ceiling to the new path in the same commit.',
];

function growth(v) {
  const tokens = tokensOf(v.bytes) - tokensOf(v.ceiling);
  return tokens > 0 ? `${tokens} tokens` : `${v.bytes - v.ceiling} bytes`;
}

// `scope` is the word before "files" in the header: 'staged' for the hook, '' for --all.
export function renderReport(violations, scope = 'staged') {
  const n = violations.length;
  const noun = `${scope ? `${scope} ` : ''}${n === 1 ? 'file is' : 'files are'}`;
  const lines = [`[size-gate] blocked: ${n} ${noun} over ${LIMIT_TOKENS} tokens (tokens = bytes / 4, limit ${LIMIT_BYTES} bytes)`];
  const pathWidth = Math.max(...violations.map((v) => v.path.length));
  const tokenWidth = Math.max(...violations.map((v) => String(tokensOf(v.bytes)).length));
  for (const v of violations) {
    const tail = v.ceiling === null ? 'no ceiling' : `ceiling ${tokensOf(v.ceiling)} tokens, grew by ${growth(v)}`;
    lines.push(`  ${v.path.padEnd(pathWidth)}  ${String(tokensOf(v.bytes)).padStart(tokenWidth)} tokens (${v.bytes} bytes), ${tail}`);
  }
  const byKind = new Map();
  for (const v of violations) {
    const kind = fileKind(v.path);
    byKind.set(kind, [...(byKind.get(kind) ?? []), v.path]);
  }
  for (const [kind, paths] of byKind) {
    lines.push('', `How to split ${LABEL[kind]} file (${paths.join(', ')}):`, ...ADVICE[kind].map((l) => `  ${l}`));
    if (kind === 'code' && paths.some((p) => p.endsWith('.sh'))) lines.push(SH_LINE);
    if (kind === 'markdown' && paths.includes('README.md')) lines.push(README_LINE);
  }
  lines.push('', ...FOOTER);
  return lines.join('\n');
}

function renderStale(stale, baselineName) {
  const lines = [`[size-gate] stale ceilings in ${baselineName}:`];
  for (const s of stale) {
    const now = s.reason === 'gone'
      ? 'no longer judged (removed, binary, symlink, or -size-gate)'
      : s.reason === 'within-limit' ? `now ${s.bytes} bytes, within the limit` : `now ${s.bytes} bytes`;
    lines.push(`  ${s.path}: ceiling ${s.ceiling} bytes, ${now}`);
  }
  lines.push(`Lower them with: ${REWRITE_CMD}`);
  return lines.join('\n');
}

// Argument arrays only, never a shell string, so no path is ever interpreted.
function git(root, args, input) {
  const r = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function nulFields(text) {
  const fields = text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

function resolveRoot(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
}

function stagedPaths(root) {
  return nulFields(git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
}

// Returns [{ path, bytes }] for every judged index path, or only those in `only`.
export function indexEntries(root, only = null) {
  const want = only ? new Set(only) : null;
  const blobs = new Map();
  for (const rec of nulFields(git(root, ['ls-files', '-s', '-z']))) {
    const tab = rec.indexOf('\t');
    const [mode, oid, stage] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (stage !== '0' || mode === '120000' || mode === '160000' || (want && !want.has(p))) continue;
    blobs.set(p, oid);
  }
  for (const rec of nulFields(git(root, ['ls-files', '--eol', '-z']))) {
    if (rec.startsWith('i/-text')) blobs.delete(rec.slice(rec.indexOf('\t') + 1));
  }
  if (blobs.size) {
    const attrs = nulFields(git(root, ['check-attr', '--cached', '-z', '--stdin', 'size-gate'], [...blobs.keys()].join('\0') + '\0'));
    for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] === 'unset') blobs.delete(attrs[i]);
  }
  const kept = [...blobs];
  if (!kept.length) return [];
  const sizes = git(root, ['cat-file', '--batch-check'], kept.map(([, oid]) => oid).join('\n') + '\n').split('\n');
  return kept.map(([p, oid], i) => {
    const [gotOid, type, size] = sizes[i].split(' ');
    if (gotOid !== oid || type !== 'blob') throw new Error(`git cat-file: unexpected answer for ${p}: ${sizes[i]}`);
    return { path: p, bytes: Number(size) };
  }).sort(byPath);
}

function readBaseline(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { baseline: null };
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { error: `invalid baseline JSON in ${file}: ${e.message}` };
  }
  const valid = obj && typeof obj === 'object' && !Array.isArray(obj)
    && Object.values(obj).every((v) => Number.isInteger(v) && v >= 0);
  return valid ? { baseline: obj } : { error: `invalid baseline JSON in ${file}: expected an object of path to byte count` };
}

function parseArgs(argv) {
  const opts = { mode: null, root: null, baseline: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (MODES.includes(a)) {
      if (opts.mode && opts.mode !== a) return { error: `pick one of ${MODES.join(', ')}` };
      opts.mode = a;
    } else if (a === '--root' || a === '--baseline') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) return { error: `${a} needs a value, got: ${v ?? 'nothing'}` };
      opts[a.slice(2)] = v;
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }
  opts.mode ??= '--staged';
  return opts;
}

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const usageError = (msg) => (err(`[size-gate] ${msg}`), 2);

export function main(argv, cwd = process.cwd()) {
  const opts = parseArgs(argv);
  if (opts.error) return usageError(`${opts.error}\n${USAGE}`);
  const dir = opts.root ? path.resolve(cwd, opts.root) : cwd;
  const root = resolveRoot(dir);
  if (!root) return usageError(`not a git repository: ${dir}`);
  const file = opts.baseline ? path.resolve(cwd, opts.baseline) : path.join(root, BASELINE_REL);

  let only = null;
  if (opts.mode === '--staged') {
    only = stagedPaths(root);
    if (!only.length) return 0;
  }
  const { baseline, error } = readBaseline(file);
  if (error) return usageError(error);
  const entries = indexEntries(root, only);
  const overLimit = entries.filter((e) => e.bytes > LIMIT_BYTES).length;

  if (opts.mode === '--write-baseline') {
    const next = tightenBaseline(entries, baseline);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    out(`[size-gate] wrote ${Object.keys(next).length} ceilings to ${path.relative(root, file) || file}`);
    out(`checked ${entries.length} files, ${overLimit} over the limit`);
    return 0;
  }

  const { violations, checked } = judge(entries, baseline);
  if (violations.length) err(renderReport(violations, opts.mode === '--staged' ? 'staged' : ''));
  const stale = opts.mode === '--all' ? staleCeilings(entries, baseline) : [];
  if (stale.length) err(renderStale(stale, path.relative(root, file) || file));
  out(`checked ${checked} files, ${violations.length} over the limit`);
  return violations.length || stale.length ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    // A git or filesystem failure is not a size verdict, so it must not look like exit 1.
    err(`[size-gate] ${e.message}`);
    process.exitCode = 2;
  }
}
