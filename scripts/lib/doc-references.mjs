import { existsSync, readFileSync, statSync } from 'node:fs';
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

function pathRefs(text, file, line) {
  const refs = [];
  for (const match of text.matchAll(SPAN_RE)) {
    const ref = match[1];
    if (/\s/.test(ref) || isPlaceholder(ref)) continue;
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
          if (!sources.get(abs).includes(flag.replace(/^-+/, ''))) {
            findings.push({ ...at, message: `${ref.ref} has no flag ${flag}` });
          }
        }
      } else if (ref.kind === 'npm') {
        if (!ref.ref.includes(':') || !prefixes.has(ref.ref.split(':')[0])) continue;
        checked += 1;
        if (!names.has(ref.ref)) findings.push({ ...at, message: `bun run ${ref.ref}: no such script in package.json` });
      } else {
        checked += 1;
        if (!existsSync(path.join(root, ref.ref))) findings.push({ ...at, message: `path ${ref.ref} does not exist` });
      }
    }
  }
  return { checked, findings };
}
