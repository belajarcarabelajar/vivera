import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// The skills were renamed from super-ultra-code-plan and sucp-* to vivera and vivera-* on 2026-11-26
// (plan 2026-11-26-vivera-skill-rename). Tracked files may still carry an old name only where it is
// on purpose: the installer's legacy list that prunes old installs, its tests, and references to
// history (old plan IDs). The check is equality, not "no match": a stray new reference fails it, and
// so does an allowlisted file that no longer needs its entry.

const ROOT = path.resolve(import.meta.dir, '..');
const OLD = 'sucp|super[- ]ultra[- ]code[- ]plan';

export const ALLOW = [
  'scripts/install-legacy-names.test.mjs',
  'scripts/install/targets.sh',
  'scripts/install/windows-ops.ps1',
  'scripts/legacy-skill-names.test.mjs',
].sort();

function filesWithOldNames() {
  try {
    const out = execFileSync('git', ['grep', '-l', '-I', '-i', '-E', OLD], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').filter(Boolean).sort();
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

test('old skill names appear only in the allowlisted files', () => {
  const found = filesWithOldNames();
  const extra = found.filter((f) => !ALLOW.includes(f));
  const unused = ALLOW.filter((f) => !found.includes(f));
  expect({ extra, unused }).toEqual({ extra: [], unused: [] });
});
