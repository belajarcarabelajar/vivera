// scripts/lib/test-paths.mjs
//
// `bun test <path>` runs the files that exist and exits 0 when a named file is
// missing, so a readiness probe or a gate step that names an unmerged test file
// passes against code that does not have it. missingTestPaths names those files.

import { existsSync } from 'node:fs';
import path from 'node:path';

const TEST_FILE = /\.test\.(?:mjs|js|ts|tsx)$/;
// Flags whose separate next token is a value, never a path: a name pattern can end in .test.mjs.
const VALUE_FLAGS = new Set(['-t', '--test-name-pattern', '--timeout']);

// defer: a word splitter, not a shell parser: `cd`, subshells, variables, `~` and globs are read
// literally, so such a path reads as missing (a false OPEN, never a false DONE); upgrade when a real
// skip_if or gate command is misread by readiness or the runner.
function words(segment) {
  return (segment.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
}

// The test file arguments of every `bun test` in cmd that do not exist under cwd, in order.
export function missingTestPaths(cmd, cwd = process.cwd()) {
  if (typeof cmd !== 'string') return [];
  const missing = [];
  for (const segment of cmd.split(/&&|\|\||[;|\n]/)) {
    const w = words(segment);
    const at = w.findIndex((x, i) => x === 'bun' && w[i + 1] === 'test');
    if (at < 0) continue;
    for (let i = at + 2; i < w.length; i++) {
      if (VALUE_FLAGS.has(w[i])) i++;
      else if (!w[i].startsWith('-') && TEST_FILE.test(w[i]) && !existsSync(path.resolve(cwd, w[i]))) missing.push(w[i]);
    }
  }
  return missing;
}
