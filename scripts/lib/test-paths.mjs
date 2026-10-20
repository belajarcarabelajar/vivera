// scripts/lib/test-paths.mjs
//
// `bun test <path>` runs the files that exist and exits 0 when a named file is
// missing, so a readiness probe or a gate step that names an unmerged test file
// passes against code that does not have it. missingTestPaths names those files.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The file names bun test picks up as test files.
const TEST_FILE = /[._](?:test|spec)\.(?:[mc]?[jt]s|[jt]sx)$/;
// Flags whose separate next token is a value, never a path: a name pattern can end in .test.mjs.
const VALUE_FLAGS = new Set(['-t', '--test-name-pattern', '--timeout']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

// defer: a small word reader, not a shell. It follows quotes, backslashes, `&&` `||` `;` `|` `&`,
// subshell parentheses, redirections, `sh|bash|zsh -c` scripts, bun's own flags before `test`, a
// literal `cd <dir>` and a leading `~/`. Variables, globs, `$(...)` and backticks are read literally,
// so such a path reads as missing (a false OPEN); a directory change it does not follow (`pushd`,
// `bun --cwd`) can still hide a missing file, so only the shapes pinned in test-paths.test.mjs are
// known never to give a false DONE. Upgrade when a real skip_if or gate command is misread.
function lex(cmd) {
  const out = [];
  let word = null;
  let tilde = false;
  let drop = false;
  const end = () => {
    if (word !== null) {
      if (!drop) out.push({ word, tilde });
      drop = false;
    }
    word = null;
    tilde = false;
  };
  const add = (s) => { word = (word ?? '') + s; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      add(cmd.slice(i + 1, j < 0 ? cmd.length : j));
      i = j < 0 ? cmd.length : j;
    } else if (c === '"') {
      let s = '';
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === '\\' && '"\\$`'.includes(cmd[i + 1] ?? '-')) i++;
        s += cmd[i];
      }
      add(s);
    } else if (c === '\\') {
      add(cmd[++i] ?? '');
    } else if (c === '$' && cmd[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < cmd.length; j++) if (cmd[j] === '(') depth++; else if (cmd[j] === ')' && --depth === 0) break;
      add(cmd.slice(i, j + 1));
      i = j;
    } else if (c === '>' || c === '<' || (c === '&' && cmd[i + 1] === '>')) {
      // A redirection: a bare fd number before it and the target after it are not arguments.
      if (word !== null && /^\d+$/.test(word)) word = null;
      end();
      while ('<>&|'.includes(cmd[i + 1] ?? '-')) i++;
      drop = true;
    } else if (c === '(' || c === ')') {
      end();
      out.push({ op: c });
    } else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      end();
      if (cmd[i + 1] === c) i++;
      out.push({ op: ';' });
    } else if (/\s/.test(c)) {
      end();
    } else {
      if (word === null) tilde = c === '~';
      add(c);
    }
  }
  end();
  return out;
}

const expand = (t) => (t.tilde && (t.word === '~' || t.word.startsWith('~/')) ? path.join(os.homedir(), t.word.slice(1)) : t.word);

// One simple command: records its missing test files and returns the directory later commands run in.
function readSegment(tokens, base, missing) {
  const w = tokens.map(expand);
  if (w[0] === 'cd') return w.length === 2 ? path.resolve(base, w[1]) : base;
  const sh = w.findIndex((x) => SHELLS.has(path.basename(x)));
  const flag = sh < 0 ? -1 : w.findIndex((x, i) => i > sh && /^-[a-z]*c[a-z]*$/.test(x));
  if (flag > 0 && w[flag + 1] !== undefined) {
    missing.push(...missingTestPaths(w[flag + 1], base));
    return base;
  }
  let i = w.findIndex((x) => path.basename(x) === 'bun') + 1;
  if (i === 0) return base;
  while (w[i]?.startsWith('-')) i++;
  if (w[i] !== 'test') return base;
  for (i++; i < w.length; i++) {
    if (VALUE_FLAGS.has(w[i])) i++;
    else if (!w[i].startsWith('-') && TEST_FILE.test(w[i]) && !existsSync(path.resolve(base, w[i]))) missing.push(tokens[i].word);
  }
  return base;
}

// The test file arguments of every `bun test` in cmd that do not exist under cwd, in order, as written.
export function missingTestPaths(cmd, cwd = process.cwd()) {
  if (typeof cmd !== 'string') return [];
  const missing = [];
  const outer = [];
  let base = cwd;
  let tokens = [];
  for (const t of lex(cmd)) {
    if (!t.op) {
      tokens.push(t);
      continue;
    }
    base = readSegment(tokens, base, missing);
    tokens = [];
    // A subshell's cd ends with it.
    if (t.op === '(') outer.push(base);
    else if (t.op === ')') base = outer.pop() ?? base;
  }
  readSegment(tokens, base, missing);
  return missing;
}
