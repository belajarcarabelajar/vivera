// scripts/lib/git.mjs
//
// One git runner for the repo scripts: argument arrays only, never a shell
// string, and every failure (spawn error or non-zero exit) is a GitError so a
// caller can map it to its own exit code.

import { spawnSync } from 'node:child_process';

export class GitError extends Error {}

export function gitText(cwd, args, { input, label, maxBuffer = 1 << 30 } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer });
  if (r.error || r.status !== 0) {
    const detail = (r.error?.message ?? r.stderr).trim() || `exit ${r.status}`;
    throw new GitError(`${label ?? `git ${args.join(' ')} failed`}: ${detail}`);
  }
  return r.stdout;
}
