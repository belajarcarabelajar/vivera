#!/usr/bin/env bun
// scripts/check-secrets.mjs
//
// Refuses a commit or a pull request that adds a credential or a personal path or
// address to this public repository. Until 2026-11-02 nothing here looked for either:
// the size gate, the copy rules and the duplicate gate read structure and wording, not
// secrets, and the only scanner on the machine (gitleaks) is not on a contributor's.
//
// WHAT IS JUDGED. The rules live in scripts/lib/secret-patterns.mjs (hard rules for
// credentials, waivable personal-data rules for home paths and private addresses).
// This file only decides which lines to hand to them.
//
// MODES (exactly one).
//   --staged          the lines added by the staged change (`git diff --cached`),
//                     read from the index; what the pre-commit hook runs
//   --diff <base>     the lines added since `git merge-base <base> HEAD`, committed or
//                     not, plus every line of an untracked new file; what the
//                     targeted-checks planner runs
//   --all             every line of every tracked file, from the index; the audit
// --staged and --diff judge ADDED lines only (memory rule L30): an old finding in a
// file never blocks an unrelated edit. --all is the only mode that reports old ones.
// --root <dir> runs against another repository (default: the current directory).
//
// SKIPPED. Symlinks and submodules, binary files (a NUL byte in the first 8000 bytes),
// and any path whose `secret-gate` attribute is unset (`<path> -secret-gate` in
// .gitattributes), for recorded or generated files that nobody edits by hand.
//
// OUTPUT. Each finding goes to stderr as `[secret-gate] <path>:<line> <rule>`, never
// with the matched text, followed by one hint line. The last stdout line of every run
// is `checked <N> files, <M> findings`, except a `--staged` run with nothing staged,
// which prints nothing (so the hook stays silent on an empty commit).
//
// defer: no per-rule disable flag; add one when a legitimate case appears that a waiver cannot express
// defer: git history is not scanned; add `--history` when a leak is suspected in an old commit
//
// Usage: bun scripts/check-secrets.mjs (--staged | --all | --diff <base>) [--root <dir>]
// Exit: 0 pass, 1 finding, 2 usage error, not a git repository, or a git failure.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAddedLines } from './check-copy-rules.mjs';
import { GitError, gitText } from './lib/git.mjs';
import { scanText } from './lib/secret-patterns.mjs';

const USAGE = 'usage: bun scripts/check-secrets.mjs (--staged | --all | --diff <base>) [--root <dir>]';
const HINT = '[secret-gate] a credential cannot be waived; a personal-data finding (home-path, private-ip) can be, with a comment "secrets: allow <reason>" on the line or the line above';
const DIFF_FLAGS = ['--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
const splitNul = (out) => out.split('\u0000').filter(Boolean);

class SecretsUsageError extends Error {}

export function parseArgs(argv) {
  const opts = { mode: null, base: null, root: null };
  const setMode = (m) => {
    if (opts.mode) throw new SecretsUsageError(`only one of --staged, --all, --diff (got ${opts.mode} and ${m})`);
    opts.mode = m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') setMode('staged');
    else if (a === '--all') setMode('all');
    else if (a === '--diff' || a === '--root') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new SecretsUsageError(`${a} needs a value`);
      if (a === '--diff') {
        setMode('diff');
        opts.base = v;
      } else opts.root = v;
    } else throw new SecretsUsageError(`unknown argument ${a}`);
  }
  if (!opts.mode) throw new SecretsUsageError('pick one of --staged, --all, --diff <base>');
  return opts;
}

/** Index entries: path -> { mode, oid }, from `git ls-files -s -z`. */
function trackedEntries(cwd) {
  const entries = new Map();
  for (const rec of splitNul(gitText(cwd, ['ls-files', '-s', '-z'], { label: 'git ls-files failed' }))) {
    const m = /^(\d+) ([0-9a-f]+) \d\t([\s\S]*)$/.exec(rec);
    if (m) entries.set(m[3], { mode: m[1], oid: m[2] });
  }
  return entries;
}

/** Blob contents by oid in one `git cat-file --batch` call (binary-safe parse). */
function readBlobs(cwd, oids) {
  const unique = [...new Set(oids)];
  const out = new Map();
  if (unique.length === 0) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd, input: `${unique.join('\n')}\n`, maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new GitError(`git cat-file failed: ${r.error?.message ?? r.stderr?.toString().trim()}`);
  const buf = r.stdout;
  let pos = 0;
  for (const oid of unique) {
    const nl = buf.indexOf(0x0a, pos);
    const head = buf.toString('utf8', pos, nl).split(' ');
    pos = nl + 1;
    if (head[1] === 'missing') continue;
    const size = Number(head[2]);
    out.set(oid, buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return out;
}

/** Paths whose `secret-gate` attribute is unset. */
function optedOut(cwd, paths) {
  const out = new Set();
  if (paths.length === 0) return out;
  const r = spawnSync('git', ['check-attr', '--stdin', '-z', 'secret-gate'], { cwd, input: `${paths.join('\u0000')}\u0000`, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new GitError(`git check-attr failed: ${r.error?.message ?? r.stderr.trim()}`);
  const f = splitNul(r.stdout);
  for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] === 'unset') out.add(f[i]);
  return out;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** Targets { path, text, lines } for a mode; `lines` null = every line. */
function targetsFor(opts, cwd) {
  const entries = trackedEntries(cwd);
  let wanted; // path -> Set of added line numbers, or null for the whole file
  let fromIndex = true;
  if (opts.mode === 'all') {
    wanted = new Map([...entries.keys()].map((p) => [p, null]));
  } else if (opts.mode === 'staged') {
    const names = splitNul(gitText(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { label: 'git diff --cached failed' }));
    if (names.length === 0) return null;
    const added = parseAddedLines(gitText(cwd, ['diff', '--cached', ...DIFF_FLAGS], { label: 'git diff --cached failed' }));
    wanted = new Map(names.map((p) => [p, added.get(p) ?? new Set()]));
  } else {
    fromIndex = false;
    const base = gitText(cwd, ['merge-base', opts.base, 'HEAD'], { label: `cannot resolve merge-base of '${opts.base}' and HEAD` }).trim();
    const added = parseAddedLines(gitText(cwd, ['diff', ...DIFF_FLAGS, base], { label: `git diff ${base.slice(0, 8)} failed` }));
    wanted = new Map(added);
    for (const p of splitNul(gitText(cwd, ['ls-files', '-z', '--others', '--exclude-standard'], { label: 'git ls-files --others failed' }))) wanted.set(p, null);
  }

  let paths = [...wanted.keys()].filter((p) => {
    const e = entries.get(p);
    if (e && (e.mode === '120000' || e.mode === '160000')) return false;
    if (fromIndex) return Boolean(e);
    try {
      return fs.lstatSync(path.join(cwd, p)).isFile();
    } catch {
      return false; // deleted
    }
  });
  const skip = optedOut(cwd, paths);
  paths = paths.filter((p) => !skip.has(p)).sort();

  const blobs = fromIndex ? readBlobs(cwd, paths.map((p) => entries.get(p).oid)) : null;
  const targets = [];
  for (const p of paths) {
    const buf = fromIndex ? blobs.get(entries.get(p).oid) : fs.readFileSync(path.join(cwd, p));
    if (!buf || isBinary(buf)) continue;
    targets.push({ path: p, text: buf.toString('utf8'), lines: wanted.get(p) });
  }
  return targets;
}

export function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    stderr.write(`${e.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const start = opts.root ? path.resolve(cwd, opts.root) : cwd;
    let top;
    try {
      top = gitText(start, ['rev-parse', '--show-toplevel'], { label: 'not a git repository' }).trim();
    } catch (e) {
      throw new GitError(`not a git repository: ${start}`);
    }
    const targets = targetsFor(opts, top);
    if (targets === null) return 0; // --staged with nothing staged: silent
    const findings = [];
    for (const t of targets) {
      const lines = t.lines === null ? null : [...t.lines];
      if (lines !== null && lines.length === 0) continue;
      for (const f of scanText(t.text, { path: t.path, lines })) findings.push({ path: t.path, ...f });
    }
    for (const f of findings) stderr.write(`[secret-gate] ${f.path}:${f.line} ${f.rule}\n`);
    if (findings.length > 0) stderr.write(`${HINT}\n`);
    stdout.write(`checked ${targets.length} files, ${findings.length} findings\n`);
    return findings.length > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof GitError) {
      stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
