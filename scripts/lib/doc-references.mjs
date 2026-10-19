import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PATH_PREFIXES = ['scripts/', 'skills/', 'templates/', 'examples/', 'agents/', 'apps/', 'docs/', 'snippets/'];
const SHELL_FENCES = new Set(['', 'bash', 'sh', 'shell']);
// docs/code-plan/ is gitignored local state, so a clean checkout never has it.
const LOCAL_STATE = 'docs/code-plan/';
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const SCRIPT_RE = /\bbun\s+(scripts\/[^\s`]+)/g;
const NPM_RE = /\bbun\s+run\s+([^\s`]+)/g;
const SPAN_RE = /`([^`\n]+)`/g;
const IMPORT_RE = /from\s+['"](\.\/[^'"]+)['"]/g;
const BUN_WORD_RE = /\bbun\s+([a-z][a-z-]*)(?=[\s`]|$)/g;
const FILE_NAME_RE = /^[A-Za-z][\w.-]*\.[A-Za-z0-9]+$/;
// `bun run` is left out: its script name is checked as an npm reference.
const BUN_SUBCOMMANDS = new Set([
  'test', 'x', 'repl', 'exec', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'audit', 'outdated',
  'link', 'unlink', 'publish', 'patch', 'patch-commit', 'pm', 'info', 'why', 'build', 'init', 'create', 'c',
  'upgrade', 'feedback', 'completions', 'help', 'ci',
]);
// Docs show these names as commands of other repositories, so they are never
// looked up in this package.json.
export const GENERIC_NPM_NAMES = new Set(['lint', 'format', 'typecheck', 'build', 'dev']);

// A flag counts only as a whole dashed token: '--x', "--x", `--x=${v}`, or /^--x$/.
// A bare word such as `length` or a longer flag such as `--x-y` does not count.
// dup-defs: allow a regex over script source, not the parsed flag list of block-git-writes.mjs
function hasFlag(source, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(source);
}

function isPlaceholder(text) {
  return /[<>*{}[\]$]/.test(text) || text.includes('...');
}

function trimProse(token) {
  return token.replace(/[.,;:)'"]+$/, '');
}

function flagsBefore(rest) {
  const stop = rest.search(/\||;|&&|`/);
  const segment = stop === -1 ? rest : rest.slice(0, stop);
  const flags = [];
  for (const token of segment.split(/\s+/)) {
    const match = /^(--[A-Za-z0-9][\w-]*)/.exec(token);
    if (match && !isPlaceholder(token)) flags.push(match[1]);
  }
  return flags;
}

function shellRefs(text, file, line) {
  const refs = [];
  for (const match of text.matchAll(SCRIPT_RE)) {
    const ref = trimProse(match[1]);
    if (isPlaceholder(ref)) continue;
    const rest = text.slice(match.index + match[0].length);
    refs.push({ file, line, kind: 'script', ref, flags: flagsBefore(rest) });
  }
  for (const match of text.matchAll(NPM_RE)) {
    const ref = trimProse(match[1]);
    if (!ref || ref.startsWith('-') || isPlaceholder(ref)) continue;
    refs.push({ file, line, kind: 'npm', ref, flags: [] });
  }
  return refs;
}

function bunRefs(text, file, line) {
  const refs = [];
  for (const match of text.matchAll(BUN_WORD_RE)) {
    if (match[1] !== 'run') refs.push({ file, line, kind: 'bun', ref: match[1], flags: [] });
  }
  return refs;
}

function pathRefs(text, file, line) {
  const refs = [];
  for (const match of text.matchAll(SPAN_RE)) {
    const ref = match[1];
    refs.push(...bunRefs(ref, file, line));
    if (/\s/.test(ref) || isPlaceholder(ref)) continue;
    if (FILE_NAME_RE.test(ref)) {
      refs.push({ file, line, kind: 'root', ref, flags: [] });
      continue;
    }
    if (!PATH_PREFIXES.some((prefix) => ref.startsWith(prefix))) continue;
    if (ref.startsWith(LOCAL_STATE)) continue;
    refs.push({ file, line, kind: 'path', ref, flags: [] });
  }
  return refs;
}

export function findDocReferences(text, file) {
  const refs = [];
  let fence = null;
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const fenceMatch = FENCE_RE.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker[0] && fenceMatch[1].length >= fence.marker.length && !fenceMatch[2]) {
        fence = null;
      } else if (fence.shell) {
        refs.push(...shellRefs(raw, file, line));
        refs.push(...bunRefs(raw, file, line));
      }
      return;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1], shell: SHELL_FENCES.has(fenceMatch[2].toLowerCase()) };
      return;
    }
    refs.push(...shellRefs(raw, file, line));
    refs.push(...pathRefs(raw, file, line));
  });
  return refs;
}

function readIfFile(abs) {
  try {
    return statSync(abs).isFile() ? readFileSync(abs, 'utf8') : '';
  } catch {
    return '';
  }
}

function scriptSource(abs) {
  const own = readIfFile(abs);
  let source = own;
  for (const match of own.matchAll(IMPORT_RE)) {
    source += '\n' + readIfFile(path.resolve(path.dirname(abs), match[1]));
  }
  return source;
}

// Optimal string alignment distance: an adjacent swap costs 1, so `tset` is 1 from `test`.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function rootFiles(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

// A bare file name is a root claim only when it is a root file or a near miss of
// one; names such as SKILL.md or another project's wrangler.jsonc are not.
function checkRootName(name, rootNames) {
  if (rootNames.includes(name)) return { checked: true };
  const near = rootNames.find((r) => editDistance(name, r) <= 2);
  return near ? { checked: true, message: `path ${name} does not exist at the repository root (did you mean ${near}?)` } : { checked: false };
}

function packageScripts(root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

export function checkDocReferences({ root, files }) {
  const names = new Set(packageScripts(root));
  const prefixes = new Set([...names].filter((name) => name.includes(':')).map((name) => name.split(':')[0]));
  const rootNames = rootFiles(root);
  const sources = new Map();
  const findings = [];
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(path.resolve(root, file), 'utf8');
    for (const ref of findDocReferences(text, file)) {
      const at = { file: ref.file, line: ref.line };
      if (ref.kind === 'script') {
        checked += 1;
        const abs = path.join(root, ref.ref);
        if (!existsSync(abs)) {
          findings.push({ ...at, message: `script ${ref.ref} does not exist` });
          continue;
        }
        if (!sources.has(abs)) sources.set(abs, scriptSource(abs));
        for (const flag of ref.flags) {
          if (!hasFlag(sources.get(abs), flag)) {
            findings.push({ ...at, message: `${ref.ref} has no flag ${flag}` });
          }
        }
      } else if (ref.kind === 'npm') {
        const prefixed = ref.ref.includes(':');
        if (prefixed ? !prefixes.has(ref.ref.split(':')[0]) : GENERIC_NPM_NAMES.has(ref.ref)) continue;
        checked += 1;
        if (!names.has(ref.ref)) findings.push({ ...at, message: `bun run ${ref.ref}: no such script in package.json` });
      } else if (ref.kind === 'bun') {
        checked += 1;
        if (!BUN_SUBCOMMANDS.has(ref.ref)) findings.push({ ...at, message: `bun ${ref.ref}: not a bun subcommand` });
      } else if (ref.kind === 'root') {
        const result = checkRootName(ref.ref, rootNames);
        if (result.checked) checked += 1;
        if (result.message) findings.push({ ...at, message: result.message });
      } else {
        checked += 1;
        if (!existsSync(path.join(root, ref.ref))) findings.push({ ...at, message: `path ${ref.ref} does not exist` });
      }
    }
  }
  return { checked, findings };
}
