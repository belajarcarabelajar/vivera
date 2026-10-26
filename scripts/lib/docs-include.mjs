// scripts/lib/docs-include.mjs
//
// Docs code blocks that must equal a repository file, so a page never drifts
// from the code it shows. The block stays in the Markdown, so GitHub renders it:
//
//   <!-- include: scripts/x.mjs#region -->
//   ```js
//   ...the exact content...
//   ```
//   <!-- /include -->
//
// Without #region the whole file is meant; a region is the lines between a line
// holding `docs-include:start <region>` and one holding `docs-include:end <region>`
// (any comment syntax), markers dropped, common indent removed, trailing blank
// lines trimmed. Markers inside a fenced block are an example, not an include.
// Used by scripts/docs-include.mjs, scripts/docs-gen.mjs, and the targeted gate.

import fs from 'node:fs';
import path from 'node:path';
import { sourceFiles } from './docs-gen-files.mjs';

const OPEN = /^\s*<!--\s*include:(.*?)-->\s*$/;
const CLOSE = /^\s*<!--\s*\/include\s*-->\s*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const MARKER = /docs-include:(start|end)\s+(\S+)/;
const WRITE_HINT = '(run bun scripts/docs-include.mjs --write)';
const MAP_FILE = 'apps/docs/pages.json';
const ID_DIR = 'apps/docs/content/id';

const closes = (line, fence) => {
  const m = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  return Boolean(m) && m[1][0] === fence[0] && m[1].length >= fence.length;
};

// A backtick info string cannot contain a backtick, so such a line is inline code.
function opener(line) {
  const m = line.match(FENCE);
  return m && !(m[2][0] === '`' && m[3].includes('`')) ? { indent: m[1], fence: m[2], info: m[3] } : null;
}

/** Includes in a Markdown text: `{ includes, errors }`, each error `file:line: message`. */
export function parseIncludes(file, text) {
  const lines = text.split('\n');
  const includes = [];
  const errors = [];
  let fence = null;
  let inc = null;
  lines.forEach((line, i) => {
    if (fence) {
      if (closes(line, fence.fence)) {
        fence.end = i;
        fence = null;
      } else fence.body.push(line);
      return;
    }
    const f = opener(line);
    if (f) {
      fence = { ...f, start: i, end: null, body: [] };
      if (inc) inc.blocks.push(fence);
      return;
    }
    if (OPEN.test(line)) {
      if (inc) errors.push(`${file}:${i + 1}: include inside the include opened at line ${inc.line}`);
      else inc = { line: i + 1, spec: line.match(OPEN)[1].trim(), blocks: [] };
    } else if (CLOSE.test(line)) {
      if (!inc) errors.push(`${file}:${i + 1}: <!-- /include --> without an open include`);
      else {
        if (inc.blocks.length !== 1) errors.push(`${file}:${inc.line}: include needs exactly one fenced block, found ${inc.blocks.length}`);
        else includes.push(inc);
        inc = null;
      }
    }
  });
  if (inc) errors.push(`${file}:${inc.line}: include is not closed with <!-- /include -->`);
  return { lines, includes, errors };
}

/** `{ target, region }` or `{ error }` for the text after `include:`. */
export function parseSpec(spec) {
  const hash = spec.indexOf('#');
  const raw = hash === -1 ? spec : spec.slice(0, hash);
  const region = hash === -1 ? null : spec.slice(hash + 1);
  if (raw === '' || /\s/.test(spec) || region === '') return { error: `include path "${spec}" is not <path>[#<region>]` };
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) return { error: `include path ${raw} must be relative to the repository root` };
  const target = path.posix.normalize(raw);
  if (target === '..' || target.startsWith('../')) return { error: `include path ${raw} leaves the repository` };
  return { target, region };
}

/** The lines of `region` in `text`, or `{ error }` without the `in <file>` part. */
export function regionLines(text, region) {
  const lines = text.split('\n');
  const at = { start: [], end: [] };
  lines.forEach((l, i) => {
    const m = l.match(MARKER);
    if (m && m[2].replace(/(?:-->|\*\/)$/, '') === region) at[m[1]].push(i);
  });
  if (!at.start.length && !at.end.length) return { error: 'missing' };
  if (at.start.length !== 1 || at.end.length !== 1) return { error: `needs one start and one end marker, found ${at.start.length} start, ${at.end.length} end` };
  if (at.end[0] < at.start[0]) return { error: 'ends before it starts' };
  const body = lines.slice(at.start[0] + 1, at.end[0]).filter((l) => !MARKER.test(l));
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return { lines: body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)) };
}

function trimEnd(lines) {
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

const unixText = (text) => text.replace(/\r\n?/g, '\n');

// The shortest fence of this character that no content line can close.
function neededFence(lines, ch, len) {
  let need = len;
  for (const l of lines) {
    const m = l.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (m && m[1][0] === ch) need = Math.max(need, m[1].length + 1);
  }
  return need;
}

/**
 * Checks the includes of one Markdown file. `read(rel)` returns a repository
 * file's text or null; an optional `read.outside(rel)` flags a symlink escape.
 * `output` is the text with stale blocks refreshed; when `blocked`, a finding
 * no rewrite can fix exists and `output` is the input.
 */
export function checkIncludes(file, text, read) {
  const src = unixText(text);
  // Rewritten text keeps the file's own line endings.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const { lines, includes, errors } = parseIncludes(file, src);
  const findings = [...errors];
  const fixes = [];
  let blocked = errors.length > 0;
  for (const inc of includes) {
    const where = `${file}:${inc.line}`;
    const spec = parseSpec(inc.spec);
    const source = spec.error ? null : read(spec.target);
    let want = null;
    if (spec.error) findings.push(`${where}: ${spec.error}`);
    else if (read.outside?.(spec.target)) findings.push(`${where}: include path ${spec.target} escapes the repository through a symlink`);
    else if (source === null) findings.push(`${where}: source ${spec.target} does not exist`);
    else if (spec.region === null) want = trimEnd(unixText(source).split('\n'));
    else {
      const r = regionLines(unixText(source), spec.region);
      if (r.error === 'missing') findings.push(`${where}: region ${spec.region} not found in ${spec.target}`);
      else if (r.error) findings.push(`${where}: region ${spec.region} in ${spec.target} ${r.error}`);
      else want = trimEnd(r.lines);
    }
    if (want === null) {
      blocked = true;
      continue;
    }
    const block = inc.blocks[0];
    const ch = block.fence[0];
    const need = neededFence(want, ch, block.fence.length);
    const indented = want.map((l) => (l === '' ? '' : block.indent + l));
    const stale = indented.join('\n') !== block.body.join('\n');
    const label = spec.region === null ? spec.target : `${spec.target}#${spec.region}`;
    if (stale) findings.push(`${where}: block differs from ${label} ${WRITE_HINT}`);
    if (need > block.fence.length) findings.push(`${where}: content of ${spec.target} would close the ${block.fence.length}-character fence, it needs ${need}`);
    if (stale || need > block.fence.length) {
      const fence = ch.repeat(need);
      fixes.push({ block, replace: [`${block.indent}${fence}${block.info}`, ...indented, `${block.indent}${fence}`], change: `${where}: updated include of ${label}` });
    }
  }
  if (blocked || !fixes.length) return { findings, blocked, output: text, changes: [] };
  const out = [...lines];
  for (const { block, replace } of [...fixes].reverse()) out.splice(block.start, block.end - block.start + 1, ...replace);
  return { findings, blocked, output: out.join(eol), changes: fixes.map((f) => f.change) };
}

/**
 * Reads repository files under `root`; null for a missing file, a directory, or
 * a path whose real location is outside the root, which `read.outside(rel)` tells.
 */
export function rootReader(root) {
  const realRoot = fs.realpathSync(root);
  const outside = (rel) => {
    try {
      const r = path.relative(realRoot, fs.realpathSync(path.join(root, rel)));
      return r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);
    } catch {
      return false;
    }
  };
  const read = (rel) => {
    if (outside(rel)) return null;
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  read.outside = outside;
  return read;
}

/** The files checked by default: `en` is README.md and the page map sources, `id` the ID twins. */
export function defaultFiles(root, scope = 'all') {
  const files = [];
  if (scope !== 'id') {
    files.push('README.md');
    try {
      const { pages = [] } = JSON.parse(fs.readFileSync(path.join(root, MAP_FILE), 'utf8'));
      for (const p of pages) files.push(...(sourceFiles(p?.source)?.files ?? []));
    } catch {
      // A missing or broken page map is docs-gen's finding, not this one.
    }
  }
  if (scope !== 'en' && fs.existsSync(path.join(root, ID_DIR))) {
    files.push(...fs.readdirSync(path.join(root, ID_DIR)).filter((n) => n.endsWith('.md')).sort().map((n) => `${ID_DIR}/${n}`));
  }
  return [...new Set(files)].filter((f) => fs.existsSync(path.join(root, f)));
}

/** Findings over the default files of `scope`, for `docs-gen --check`. */
export function includeFindings(root, scope) {
  const read = rootReader(root);
  return defaultFiles(root, scope).flatMap((f) => checkIncludes(f, read(f), read).findings);
}

/** Every repository path a default file includes, sorted, for the targeted gate. */
export function includedPaths(root) {
  const read = rootReader(root);
  const found = new Set();
  for (const f of defaultFiles(root)) {
    for (const inc of parseIncludes(f, unixText(read(f))).includes) {
      const spec = parseSpec(inc.spec);
      if (!spec.error) found.add(spec.target);
    }
  }
  return [...found].sort();
}
