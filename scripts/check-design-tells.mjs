#!/usr/bin/env bun
// scripts/check-design-tells.mjs
//
// The master skill names seven frontend "tells" (Frontend-Only Aesthetic Rules in
// skills/sucp-rules/SKILL.md). They are prose, and prose is applied only when
// someone happens to look. This gate turns the one tell with a mechanical shape
// into a check: a colored LEFT STRIPE on a card, row, panel, or section header
// that carries no state.
//
// WHY THIS EXISTS, measured.
//
// The tell was written down in sucp-rules, and on 2026-10-16 the Snipset website
// still carried 31 of them: a 4px accent `border-left` on the closing CTA card of
// every solutions page (23 inline `style=""` attributes, EN and ID), on the compare
// page's TCO card, on every testimonial card (a 4px gradient `::before`), on the
// terminal demo boxes of two solutions pages, and on the 404 page's output box.
// None marked a state. The owner found the first one in a screenshot and asked
// why the rule had not stopped it. Because it was prose.
//
// WHAT IS CHECKED. Four shapes of a left stripe, in stylesheet text:
//
//   1. `border-left`, `border-left-width`, `border-inline-start`, or
//      `border-inline-start-width` of 2px or more with a visible colour
//      (`transparent`, `none`, and `0` are a reserved slot, not a stripe).
//   2. `box-shadow: inset <N>px 0 0 ...` with N >= 2 (a stripe drawn as a shadow).
//   3. a `::before`/`::after` rule that is `position: absolute`, `left: 0`,
//      2..8px wide, and full height (`height: 100%`, or `top: 0` with `bottom: 0`).
//   4. a Tailwind `border-l-2`, `border-l-4`, or `border-l-8` utility in a class list.
//
// Stylesheet text means a whole .css/.scss/.less file; every `<style>` block and
// every quoted `style=""` attribute in .astro/.vue/.svelte/.html; and, in
// .tsx/.jsx/.ts/.js, any line holding a CSS declaration (styled-components and
// template CSS) or a quoted `borderLeft:` / `boxShadow:` object value. A computed
// value is not parsed.
//
// WHAT PASSES. A stripe is a signal when its selector says which state it marks,
// so a rule whose selector, or any enclosing selector, contains a STATE_WORD
// passes on its own: `.roadmap-card.active`, `[aria-current="page"]`,
// `.settings-warning-panel`, `.doc-callout`, `blockquote`, `.qa-item.qa-status-fail`.
// For an inline `style=""` the element's own tag head (its class list and
// attributes) is the selector; in JS/TS text it is the lines from the nearest
// opening tag, `styled.` call, or declaration above the hit (and one comment line
// above that) down to the hit itself.
// Anything else needs a waiver on the same line or the line above, with a reason:
//
//   /* design-tells: allow <reason> */      // design-tells: allow <reason>
//
// A waiver without a reason is a violation of its own, so "allow" alone cannot
// become the habit.
//
// NOT CHECKED, on purpose. A 1px border is a border. Top, right, and bottom
// borders are different conventions (a 3px top rule on a table header is one), so
// they stay out of scope until one of them is measured as a tell. Lines that
// already exist on the base are not the branch's doing: `--diff <base>` reports
// hits on added lines only, exactly like check-copy-rules.mjs, so an old stripe
// never blocks an unrelated PR and never trains anyone to ignore the gate.
//
// WHICH REPOSITORY. `--diff` checks the git toplevel of the current directory and
// exits 2 outside a repository. A file or directory path resolves against the
// current directory; a directory is walked, skipping node_modules, dist, build,
// target, coverage, and the dot directories of build tools.
//
// Usage:
//   bun scripts/check-design-tells.mjs <file-or-dir>...   # whole files
//   bun scripts/check-design-tells.mjs --diff <base>      # only lines added since
//                                                         # merge-base(<base>, HEAD)
//
// Exit: 0 clean, 1 violations found, 2 usage error.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAddedLines } from './check-copy-rules.mjs';

/** A selector containing one of these names a state, and its stripe is a signal. */
export const STATE_WORDS = [
  'active', 'current', 'selected', 'checked', 'open', 'expanded',
  'warning', 'warn', 'error', 'danger', 'success', 'info', 'alert',
  'callout', 'admonition', 'note', 'tip', 'caution', 'banner', 'toast', 'notice',
  'blockquote', 'quote', 'status', 'pass', 'fail', 'skip', 'new', 'unread', 'pinned',
];
// Word boundaries by hand: `\b` treats `_` as a word character, and `qa_status_pass`
// must match the same way `qa-status-pass` does.
const STATE_RE = new RegExp(`(?:^|[^a-z0-9])(?:${STATE_WORDS.join('|')})(?:[^a-z0-9]|$)`, 'i');
export function namesState(text) {
  return STATE_RE.test(text);
}

const STYLE_EXT = new Set(['.css', '.scss', '.less']);
const MARKUP_EXT = new Set(['.astro', '.vue', '.svelte', '.html', '.htm']);
const SCRIPT_EXT = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs']);
export const CHECKED_EXTENSIONS = new Set([...STYLE_EXT, ...MARKUP_EXT, ...SCRIPT_EXT]);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out', '.git', '.astro', '.next', '.svelte-kit', '.nuxt']);

export const MIN_STRIPE_PX = 2;
const PSEUDO_MAX_PX = 8;

const WAIVER_RE = /design-tells:\s*allow\b\s*([^]*?)\s*(?:\*\/|-->|$)/i;

/** Pixels for a CSS length token, or null when the token is not a literal length. */
function lengthPx(token) {
  if (token === undefined) return null;
  const t = token.toLowerCase().replace(/!important$/, '').trim();
  const m = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(t);
  if (m) return m[2] && m[2] !== 'px' ? Number(m[1]) * 16 : Number(m[1]);
  return { thin: 1, medium: 3, thick: 5 }[t] ?? null;
}

/** The rule a `prop: value` declaration breaks when it draws a left stripe, else null. */
export function stripeFromDeclaration(prop, value) {
  const p = prop.trim().toLowerCase();
  const v = value.replace(/!important/gi, '').trim();
  const tokens = v.split(/\s+/).filter(Boolean);
  if (p === 'border-left' || p === 'border-inline-start') {
    if (tokens.some((t) => /^(none|hidden|transparent)$/i.test(t))) return null;
    const px = tokens.map(lengthPx).find((n) => n !== null);
    if (px === undefined) {
      // `border-left: var(--w) solid red` has an unknown width; do not guess.
      // `border-left: solid red` is `medium`, 3px, and that is a stripe.
      return tokens.some((t) => t.includes('var(')) ? null : 'left stripe: border';
    }
    return px >= MIN_STRIPE_PX ? 'left stripe: border' : null;
  }
  if (p === 'border-left-width' || p === 'border-inline-start-width') {
    const px = lengthPx(tokens[0]);
    return px !== null && px >= MIN_STRIPE_PX ? 'left stripe: border' : null;
  }
  if (p === 'box-shadow') {
    // A negative inset offset is a right-edge bar; `\d` leaves it alone.
    const m = /(?:^|,)\s*inset\s+(\d*\.?\d+)(px|rem|em)?\s+0(?:px)?\s+0(?:px)?(?=\s|,|$)/i.exec(v);
    if (!m) return null;
    const px = lengthPx(m[1] + (m[2] ?? ''));
    return px !== null && px >= MIN_STRIPE_PX ? 'left stripe: inset shadow' : null;
  }
  return null;
}

/**
 * Every declaration in `css` with its enclosing selector chain. `line` is 1-based
 * within `css`. Comments and quoted strings are skipped, so a `;` or `{` inside
 * them cannot split a declaration. Nested blocks (SCSS, CSS nesting, `@media`)
 * keep their parents in `selectors`, outermost first.
 */
export function parseDeclarations(css) {
  const out = [];
  const stack = [];
  let buf = '';
  let bufLine = 0;
  let line = 1;
  let nextId = 0;
  const flush = () => {
    const s = buf.trim();
    const i = s.indexOf(':');
    if (s !== '' && i > 0) {
      out.push({
        prop: s.slice(0, i).trim(),
        value: s.slice(i + 1).trim(),
        line: bufLine,
        selectors: stack.map((b) => b.selector),
        block: stack.at(-1)?.id ?? -1,
      });
    }
    buf = '';
  };
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '\n') { line++; buf += c; continue; }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (let k = i; k < stop; k++) if (css[k] === '\n') line++;
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      if (buf.trim() === '') bufLine = line;
      let j = i + 1;
      while (j < css.length && css[j] !== c) {
        if (css[j] === '\\') j++;
        if (css[j] === '\n') line++;
        j++;
      }
      buf += css.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '{') {
      stack.push({ selector: buf.trim().replace(/\s+/g, ' '), id: nextId++ });
      buf = '';
      continue;
    }
    if (c === '}') { flush(); stack.pop(); continue; }
    if (c === ';') { flush(); continue; }
    if (buf.trim() === '' && !/\s/.test(c)) bufLine = line;
    buf += c;
  }
  flush();
  return out;
}

// Raw hits carry a 1-based `line` within the whole file and the `context` whose
// state words exempt them; `checkText` turns them into reported violations.
function checkStylesheet(css, lineOffset) {
  const out = [];
  const pseudo = new Map();
  for (const d of parseDeclarations(css)) {
    const chain = d.selectors.join(' ');
    if (/::?(before|after)(?![\w-])/i.test(d.selectors.at(-1) ?? '')) {
      if (!pseudo.has(d.block)) pseudo.set(d.block, { chain, decls: [] });
      pseudo.get(d.block).decls.push(d);
    }
    const rule = stripeFromDeclaration(d.prop, d.value);
    if (rule) out.push({ line: d.line + lineOffset, rule, detail: `${d.prop}: ${d.value}`, context: chain });
  }
  const isZero = (v) => v !== undefined && /^0(px|rem|em|%)?$/.test(v);
  for (const { chain, decls } of pseudo.values()) {
    const last = (p) => decls.filter((d) => d.prop.toLowerCase() === p).at(-1);
    const val = (p) => last(p)?.value.replace(/!important/gi, '').trim().toLowerCase();
    const width = last('width');
    if (!width) continue;
    const px = lengthPx(val('width'));
    const onLeft = isZero(val('left')) || isZero(val('inset-inline-start')) || isZero(val('inset'));
    const fullHeight = val('height') === '100%' || (isZero(val('top')) && isZero(val('bottom'))) || isZero(val('inset'));
    if (val('position') === 'absolute' && onLeft && fullHeight && px !== null && px >= MIN_STRIPE_PX && px <= PSEUDO_MAX_PX) {
      out.push({
        line: width.line + lineOffset,
        rule: 'left stripe: pseudo-element',
        detail: `${chain} is a ${val('width')} wide full-height bar on the left edge`,
        context: chain,
      });
    }
  }
  return out;
}

function lineAt(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') n++;
  return n;
}

function checkMarkup(text) {
  const out = [];
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const contentStart = m.index + m[0].indexOf('>') + 1;
    out.push(...checkStylesheet(m[1], lineAt(text, contentStart) - 1));
  }
  for (const m of text.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    const tagStart = text.lastIndexOf('<', m.index);
    const context = text.slice(tagStart === -1 ? m.index : tagStart, m.index);
    const line = lineAt(text, m.index + 1);
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i <= 0) continue;
      const prop = decl.slice(0, i);
      const value = decl.slice(i + 1);
      const rule = stripeFromDeclaration(prop, value);
      if (rule) out.push({ line, rule, detail: `${prop.trim()}: ${value.trim()}`, context });
    }
  }
  return out;
}

const SCRIPT_DECL_RE = /\b(border-left(?:-width)?|border-inline-start(?:-width)?|box-shadow)\s*:\s*([^;`'"}]+)/gi;
const SCRIPT_OBJECT_RE = /\b(borderLeft|borderLeftWidth|borderInlineStart|borderInlineStartWidth|boxShadow)\s*:\s*(["'`])([^"'`]+)\2/g;
const OBJECT_PROP = {
  borderLeft: 'border-left',
  borderLeftWidth: 'border-left-width',
  borderInlineStart: 'border-inline-start',
  borderInlineStartWidth: 'border-inline-start-width',
  boxShadow: 'box-shadow',
};

// A JSX style object or a styled-components template puts the declaration lines
// below the thing that names its state (`<blockquote` five lines up, measured on
// Snipset's SafeFormattedText.tsx), so the context runs from the nearest opening
// tag, `styled.` call, or declaration above the hit, plus the nearest comment
// line within three lines above that anchor (a `{/* Notes callout */}` often sits
// across a conditional wrapper line), down to the hit. An anchor on the hit line
// itself is the context, so an earlier sibling cannot exempt it. With no anchor
// within reach, the two lines above the hit are the context.
const SCRIPT_ANCHOR_RE = /<[A-Za-z]|styled[.(]|\bcss`|createGlobalStyle|^\s*(?:export\s+)?(?:const|let|var|function)\s/;
const SCRIPT_COMMENT_RE = /^\s*(?:\/\/|\/\*|\{\/\*|\*)/;
const SCRIPT_LOOKBACK = 20;
const SCRIPT_COMMENT_REACH = 3;

function scriptContext(lines, i) {
  for (let k = i; k >= 0 && k >= i - SCRIPT_LOOKBACK; k--) {
    if (!SCRIPT_ANCHOR_RE.test(lines[k])) continue;
    let from = k;
    for (let c = k - 1; c >= 0 && c >= k - SCRIPT_COMMENT_REACH; c--) {
      if (SCRIPT_COMMENT_RE.test(lines[c])) { from = c; break; }
    }
    return lines.slice(from, i + 1).join('\n');
  }
  return lines.slice(Math.max(0, i - 2), i + 1).join('\n');
}

function checkScriptText(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    const context = scriptContext(lines, i);
    for (const m of l.matchAll(SCRIPT_DECL_RE)) {
      const rule = stripeFromDeclaration(m[1], m[2]);
      if (rule) out.push({ line: i + 1, rule, detail: `${m[1]}: ${m[2].trim()}`, context });
    }
    for (const m of l.matchAll(SCRIPT_OBJECT_RE)) {
      const rule = stripeFromDeclaration(OBJECT_PROP[m[1]], m[3]);
      if (rule) out.push({ line: i + 1, rule, detail: `${m[1]}: ${m[3].trim()}`, context });
    }
  });
  return out;
}

const TAILWIND_RE = /(?:^|[\s"'`{])border-l-(?:2|4|8)(?=$|[\s"'`}])/;

function checkUtilities(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (TAILWIND_RE.test(l)) out.push({ line: i + 1, rule: 'left stripe: tailwind border-l', detail: l.trim(), context: l });
  });
  return out;
}

/**
 * Violations in `text`, each `{ where: '<where>:<line>', rule, detail, line }`.
 * `ext` defaults to the extension of `where`; a type the gate does not read
 * returns no violations.
 */
export function checkText(text, { where = '<text>', ext } = {}) {
  const e = (ext ?? path.extname(where)).toLowerCase();
  let raw;
  if (STYLE_EXT.has(e)) raw = checkStylesheet(text, 0);
  else if (MARKUP_EXT.has(e)) raw = checkMarkup(text);
  else if (SCRIPT_EXT.has(e)) raw = checkScriptText(text);
  else return [];
  raw.push(...checkUtilities(text));
  raw.sort((a, b) => a.line - b.line);

  const lines = text.split(/\r?\n/);
  const out = [];
  for (const v of raw) {
    if (namesState(v.context)) continue;
    const here = lines[v.line - 1] ?? '';
    const waiver = WAIVER_RE.exec(here) ?? WAIVER_RE.exec(lines[v.line - 2] ?? '');
    if (waiver) {
      if (waiver[1].trim() !== '') continue;
      out.push({ where: `${where}:${v.line}`, rule: 'waiver without reason', detail: '`design-tells: allow` needs the reason after it', line: here.trim() });
      continue;
    }
    out.push({ where: `${where}:${v.line}`, rule: v.rule, detail: v.detail, line: here.trim() });
  }
  return out;
}

export function checkFile(rel, { root = process.cwd() } = {}) {
  const abs = path.resolve(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return [{ where: rel, rule: 'missing-file', detail: 'not found', line: '' }];
  }
  if (!CHECKED_EXTENSIONS.has(path.extname(rel).toLowerCase())) return [];
  const text = fs.readFileSync(abs, 'utf8');
  if (text.includes('\u0000')) return [];
  return checkText(text, { where: rel });
}

/** Expand directories into the checked files under them, in a stable order. */
export function expandPaths(paths, { root = process.cwd() } = {}) {
  const files = [];
  const walk = (rel) => {
    const abs = path.resolve(root, rel);
    if (!fs.existsSync(abs)) { files.push(rel); return; }
    if (fs.statSync(abs).isFile()) { files.push(rel); return; }
    for (const name of fs.readdirSync(abs).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const child = path.join(rel, name);
      const childAbs = path.resolve(root, child);
      if (fs.lstatSync(childAbs).isSymbolicLink()) continue;
      if (fs.statSync(childAbs).isDirectory()) walk(child);
      else if (CHECKED_EXTENSIONS.has(path.extname(name).toLowerCase())) files.push(child);
    }
  };
  for (const p of paths) walk(p);
  return files;
}

/**
 * Check only what a branch adds since `git merge-base <base> HEAD`: added lines
 * in the working tree diff plus untracked files, in checked file types only.
 * Throws on an unresolvable base or a git failure, which the CLI reports as a
 * usage error.
 */
export function checkDiff({ base, cwd = process.cwd() } = {}) {
  const run = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (typeof base !== 'string' || base === '' || base.startsWith('-')) {
    throw new Error(`invalid --diff base: '${base}'`);
  }
  const mb = run(['merge-base', base, 'HEAD']);
  if (mb.error || mb.status !== 0) {
    throw new Error(`cannot resolve merge-base of '${base}' and HEAD: ${(mb.error?.message ?? mb.stderr).trim() || `exit ${mb.status}`}`);
  }
  const mergeBase = mb.stdout.trim();
  const diff = run(['diff', '--unified=0', '--no-color', '--no-ext-diff', mergeBase]);
  if (diff.error || diff.status !== 0) {
    throw new Error(`git diff ${mergeBase.slice(0, 8)} failed: ${(diff.error?.message ?? diff.stderr).trim()}`);
  }

  const violations = [];
  let addedLines = 0;
  let files = 0;
  for (const [rel, lines] of parseAddedLines(diff.stdout)) {
    if (!CHECKED_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.resolve(cwd, rel);
    if (lines.size === 0 || !fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) continue;
    files += 1;
    addedLines += lines.size;
    // The whole file is parsed so a nested block still sees its enclosing selector
    // and a waiver on an unchanged line above still counts; only hits on added
    // lines are kept.
    for (const v of checkText(fs.readFileSync(abs, 'utf8'), { where: rel })) {
      if (lines.has(Number(v.where.slice(rel.length + 1)))) violations.push(v);
    }
  }

  const others = run(['ls-files', '--others', '--exclude-standard', '-z']);
  if (others.error || others.status !== 0) {
    throw new Error(`git ls-files --others failed: ${(others.error?.message ?? others.stderr).trim()}`);
  }
  for (const rel of others.stdout.split('\u0000').filter(Boolean)) {
    if (!CHECKED_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    if (!fs.lstatSync(path.resolve(cwd, rel)).isFile()) continue;
    const text = fs.readFileSync(path.resolve(cwd, rel), 'utf8');
    if (text.includes('\u0000')) continue;
    files += 1;
    addedLines += text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
    violations.push(...checkText(text, { where: rel }));
  }
  return { violations, addedLines, files, mergeBase };
}

const USAGE = 'usage: check-design-tells.mjs <file-or-dir>... | --diff <base>';

function cwdRepoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    console.error(`not inside a git repository: ${process.cwd()}\n${USAGE}`);
    return null;
  }
  return r.stdout.trim();
}

function report(violations) {
  console.error(`❌ ${violations.length} design-tell violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.where}  [${v.rule}]${v.detail ? ` ${v.detail}` : ''}`);
    if (v.line) console.error(`      ${v.line}`);
  }
  console.error('\n   A colored left stripe that marks no state is decoration (sucp-rules, Frontend-Only Aesthetic Rules).');
  console.error('   A selector naming the state it marks (active, current, warning, error, callout, blockquote, ...) passes;');
  console.error('   anything else needs `/* design-tells: allow <reason> */` on the line above, with the reason.');
  return 1;
}

function mainDiff(args) {
  const base = args[1];
  if (args.length !== 2 || args[0] !== '--diff' || !base || base.startsWith('-')) {
    console.error(USAGE);
    return 2;
  }
  const root = cwdRepoRoot();
  if (root === null) return 2;
  let r;
  try {
    r = checkDiff({ base, cwd: root });
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (r.violations.length > 0) return report(r.violations);
  console.log(`✅ Design tells clean: ${r.addedLines} added line(s) in ${r.files} stylesheet-bearing file(s) since ${r.mergeBase.slice(0, 8)}.`);
  return 0;
}

export function main(args) {
  if (args.includes('--diff')) return mainDiff(args);
  const paths = args.filter((a) => !a.startsWith('--'));
  if (paths.length === 0 || paths.length !== args.length) {
    console.error(USAGE);
    return 2;
  }
  const files = expandPaths(paths);
  const violations = [];
  for (const f of files) violations.push(...checkFile(f));
  if (violations.length === 0) {
    console.log(`✅ Design tells clean: ${files.length} file(s).`);
    return 0;
  }
  return report(violations);
}

const isMain = process.argv[1] && process.argv[1].endsWith('check-design-tells.mjs');
if (isMain) process.exit(main(process.argv.slice(2)));

// REVERT: delete this file and scripts/check-design-tells.test.mjs; drop
// `design:check` from package.json scripts; remove the design-tells bullet in
// agents/roles/reviewer.md, the "Design tells" section in README.md, the gate
// sentence on the left-stripe tell in skills/sucp-rules/SKILL.md, and the entry
// in backfill-plan-impacts.mjs's gate list.
