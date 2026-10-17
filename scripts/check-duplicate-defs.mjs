#!/usr/bin/env bun
// scripts/check-duplicate-defs.mjs
//
// Rung 2 of the Simplicity Ladder (skills/sucp-rules/SKILL.md, "Codebase reuse")
// says to reuse a helper that already lives in the repository before writing a new
// one. That rung is prose, and the debt sweep finds duplicate helpers by hand. This
// gate turns the mechanical part of it into a check at the diff: a top-level
// definition added on this branch whose name is already defined in a different file.
//
// WHAT IS CHECKED. Top-level definitions only (column 0), by extension:
//   .js .mjs .cjs .jsx .ts .tsx  function, class, and `const name = (...) =>`
//   .py                          def, async def, class
//   .go                          plain `func name(`; a method with a receiver is not one
//   .rs                          fn, with optional pub, pub(crate), async
// Two names match when they are equal after lower-casing and dropping `_` and `-`,
// so `formatPrice` and `format_price` are one name. Only a definition in a DIFFERENT
// file counts; the same name twice in one file is not a hit.
//
// Existing code and added lines are read by the same `definitionsIn`, so there is one
// definition of a definition. An added definition is one on a line added since
// merge-base(<base>, HEAD), plus every definition of an untracked new file.
//
// SKIPPED. Generic names (GENERIC_NAMES, which includes `parseArgs` and `usage`, one
// per standalone script), test files on either side (`.test.`, `.spec.`, `_test.`, a
// `test_` prefix, a `tests/` or `__tests__/` directory), and anything under
// node_modules, vendor, dist, build, target, or graphify-out. A pair whose files are
// in different language families (JS and TS together, .py, .go, .rs each alone) is
// not a hit. Two new definitions in different files are reported once, on the path
// that sorts first.
//
// MEASURED. A calibration over the history of this repository on 2026-10-17
// classified 31 hits, 19 of them a true or partial duplicate; the two skips that
// calibration added, the generic names `parseArgs` and `usage` and the
// cross-language-family rule, remove the 7 that were not duplicates by convention
// or by language.
// defer: five of the 24 remaining calibration hits share a name but do a different job, upgrade to a body comparison when reviewers start ignoring hits
//
// WAIVER. `dup-defs: allow <reason>` in a comment on the definition line or the line
// above passes it. A waiver without a reason is a violation of its own.
//
// OUTPUT. One line per hit on stdout, then always `scanned <N> added definitions in
// <M> files`, so a run that found nothing is distinguishable from a run that read
// nothing. N counts the definitions found on added lines, generic names included.
//
// WHICH REPOSITORY. The git toplevel of the current directory; outside one, exit 2.
//
// Usage:  bun scripts/check-duplicate-defs.mjs --diff <base>
// Exit: 0 clean, 1 possible duplicate or waiver without a reason, 2 usage error.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAddedLines } from './check-copy-rules.mjs';

const NAME = '([A-Za-z_$][\\w$]*)';
const ARROW_HEAD = '(?:async\\s+)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>';
const JS_FORMS = [
  new RegExp(`^(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function(?:\\s*\\*\\s*|\\s+)${NAME}`, 'gm'),
  new RegExp(`^(?:export\\s+(?:default\\s+)?)?class\\s+${NAME}`, 'gm'),
  new RegExp(`^(?:export\\s+)?const\\s+${NAME}\\s*=\\s*${ARROW_HEAD}`, 'gm'),
];
const FORMS = {
  '.py': [/^(?:async\s+)?def\s+(\w+)/gm, /^class\s+(\w+)/gm],
  '.go': [/^func\s+([A-Za-z_]\w*)\s*\(/gm],
  '.rs': [/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm],
};
for (const ext of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']) FORMS[ext] = JS_FORMS;

const GENERIC_NAMES = new Set([
  'main', 'init', 'run', 'get', 'set', 'test', 'setup', 'open', 'close', 'read', 'write',
  'start', 'stop', 'load', 'save', 'update', 'create', 'delete', 'handle', 'render',
  'index', 'new', 'call', 'apply', 'parseargs', 'usage',
]);
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'graphify-out']);
const TEST_DIRS = new Set(['tests', '__tests__']);
const WAIVER_RE = /dup-defs:\s*allow\b\s*(.*?)\s*(?:\*\/|-->|$)/i;
const MAX_BUFFER = 64 * 1024 * 1024;

// defer: names only, a helper rewritten under another name is not found, upgrade when a missed duplicate is observed in a review
export function normalizeName(name) {
  return name.toLowerCase().replace(/[_-]/g, '');
}

/** Top-level definitions of `text`, by the extension of `rel`: `[{ name, line }]`, 1-based, in line order. */
export function definitionsIn(rel, text) {
  const out = [];
  for (const re of FORMS[path.extname(rel).toLowerCase()] ?? []) {
    let line = 1;
    let pos = 0;
    for (const m of text.matchAll(re)) {
      // Matches arrive in index order, so newlines are counted once per file, not per match.
      for (let nl = text.indexOf('\n', pos); nl !== -1 && nl < m.index; nl = text.indexOf('\n', pos)) {
        line += 1;
        pos = nl + 1;
      }
      out.push({ name: m[1], line });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

function isScannable(rel) {
  if (!(path.extname(rel).toLowerCase() in FORMS)) return false;
  const parts = rel.split('/');
  const file = parts.pop();
  if (parts.some((dir) => SKIP_DIRS.has(dir) || TEST_DIRS.has(dir))) return false;
  return !/(?:\.(?:test|spec)|_test)\./.test(file) && !file.startsWith('test_');
}

// JS and TS share one family; every other extension is its own. A helper is not
// reused across languages, so a shared spelling there is a coincidence.
const languageFamily = (rel) => {
  const ext = path.extname(rel).toLowerCase();
  return FORMS[ext] === JS_FORMS ? 'js' : ext;
};

// A name made only of underscores normalizes to '' and would match every other one.
function isGeneric(normalized) {
  return normalized === '' || GENERIC_NAMES.has(normalized);
}

function git(cwd, args, what) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (r.error || r.status !== 0) {
    throw new Error(`${what}: ${(r.error?.message ?? r.stderr).trim() || `exit ${r.status}`}`);
  }
  return r.stdout;
}

const nulList = (out) => out.split('\u0000').filter(Boolean);

/** The reason of a `dup-defs: allow` on the definition line or the line above; null when there is no waiver. */
function waiverReason(lines, line) {
  const m = WAIVER_RE.exec(lines[line - 1] ?? '') ?? WAIVER_RE.exec(lines[line - 2] ?? '');
  return m === null ? null : m[1].trim();
}

/**
 * Possible duplicates among the definitions a branch adds since `git merge-base
 * <base> HEAD`. Throws, with git's own message, on an unresolvable base or a git
 * failure, which the CLI reports as a usage error.
 */
export function checkDiff({ base, cwd = process.cwd() } = {}) {
  if (typeof base !== 'string' || base === '' || base.startsWith('-')) {
    throw new Error(`invalid --diff base: '${base}'`);
  }
  const mergeBase = git(cwd, ['merge-base', base, 'HEAD'], `cannot resolve merge-base of '${base}' and HEAD`).trim();
  // parseAddedLines strips only a `b/` prefix, so diff.mnemonicPrefix or diff.noprefix must not change it.
  const diff = git(cwd, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', mergeBase], `git diff ${mergeBase.slice(0, 8)} failed`);
  const addedLines = parseAddedLines(diff);
  // git diff never lists untracked files, so a new file not yet added would pass unread.
  const untracked = new Set(nulList(git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'], 'git ls-files --others failed')));
  const listed = nulList(git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 'git ls-files failed'));

  const byName = new Map();
  const added = [];
  let files = 0;
  let nextId = 0;
  // defer: reads every supported source file once per run, upgrade to a git grep index when a run on a real repository takes over a few seconds
  for (const rel of [...new Set(listed)].sort()) {
    const abs = path.resolve(cwd, rel);
    // A deleted file still in the index, a symlink, or a submodule has no text of its own.
    if (!isScannable(rel) || !fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) continue;
    const text = fs.readFileSync(abs, 'utf8');
    // null marks an untracked file, whose every line is new.
    const lines = untracked.has(rel) ? null : (addedLines.get(rel) ?? new Set());
    const hasAdded = lines === null || lines.size > 0;
    if (hasAdded) files += 1;
    const sourceLines = hasAdded ? text.split(/\r?\n/) : [];
    for (const d of definitionsIn(rel, text)) {
      const def = { ...d, path: rel, id: nextId++, added: lines === null || lines.has(d.line), sourceLines };
      const key = normalizeName(d.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(def);
      if (def.added) added.push(def);
    }
  }

  const violations = [];
  for (const def of added) {
    const key = normalizeName(def.name);
    if (isGeneric(key)) continue;
    // A new definition that matches an earlier new one was reported from that side.
    const other = byName.get(key).find((o) => o.path !== def.path && !(o.added && o.id < def.id) && languageFamily(o.path) === languageFamily(def.path));
    if (!other) continue;
    const where = `${def.path}:${def.line}`;
    const reason = waiverReason(def.sourceLines, def.line);
    if (reason === null) {
      violations.push({ where, rule: 'duplicate', message: `possible duplicate of ${other.name} (${other.path}:${other.line}); reuse it, or add dup-defs: allow <reason>` });
    } else if (reason === '') {
      violations.push({ where, rule: 'waiver without reason', message: 'dup-defs: allow needs a reason after it' });
    }
  }
  return { violations, definitions: added.length, files };
}

const USAGE = 'usage: check-duplicate-defs.mjs --diff <base>';

export function main(args) {
  if (args.length !== 2 || args[0] !== '--diff') {
    console.error(USAGE);
    return 2;
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' });
  if (top.error || top.status !== 0) {
    console.error(`not inside a git repository: ${process.cwd()}\n${USAGE}`);
    return 2;
  }
  let r;
  try {
    r = checkDiff({ base: args[1], cwd: top.stdout.trim() });
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  for (const v of r.violations) console.log(`${v.where}: ${v.message}`);
  console.log(`scanned ${r.definitions} added definitions in ${r.files} files`);
  return r.violations.length > 0 ? 1 : 0;
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-duplicate-defs.mjs');
if (isMain) process.exit(main(process.argv.slice(2)));
