// scripts/hooks/worktree-remove.mjs
//
// Claude Code WorktreeRemove command hook. Reads one JSON object on stdin
// (field `worktree_path`), removes that wt-new worktree with git, and deletes
// its branch when the branch is merged. An unmerged branch is kept and named
// on stderr; that is not an error.
//
// Fail-closed (L98): any failure exits 1, which blocks only this removal. The
// path must resolve to exactly `<root>/<seg>-wt/<seg>`, checked before any git
// or filesystem call, so a bad payload can never reach `worktree remove -f -f`.
// wt-new locks its worktrees, hence the double -f.
//
// Env seam: VIVERA_WT_ROOT overrides the root (default /mnt/belajarcarabelajar).
//
// Revert: remove the WorktreeRemove entry from ~/.claude/settings.json, or
// restore ~/.claude/settings.json.bak-20261108-worktree-overnight-hooks.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SEG = /^[A-Za-z0-9._-]+$/;

function validSeg(s) {
  return SEG.test(s) && s !== '.' && s !== '..';
}

function allowedPath(raw, root) {
  if (typeof raw !== 'string' || raw === '') return null;
  const p = path.resolve(raw);
  const rel = path.relative(path.resolve(root), p);
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return null;
  const [wtDir, name] = parts;
  if (!wtDir.endsWith('-wt') || !validSeg(wtDir) || !validSeg(wtDir.slice(0, -3))) return null;
  if (!validSeg(name)) return null;
  return p;
}

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('worktree-remove: stdin is not JSON\n');
    return 1;
  }
  const root = process.env.VIVERA_WT_ROOT || '/mnt/belajarcarabelajar';
  const wt = allowedPath(input?.worktree_path, root);
  if (!wt) {
    process.stderr.write(`worktree-remove: refusing path outside ${root}/<repo>-wt/<name>\n`);
    return 1;
  }
  if (!existsSync(wt)) return 0;

  const branch = (git('-C', wt, 'branch', '--show-current').stdout || '').trim();
  const common = git('-C', wt, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (common.status !== 0) return 1;
  const mainRepo = path.dirname(common.stdout.trim());

  git('-C', mainRepo, 'worktree', 'remove', '-f', '-f', wt);
  if (branch) {
    const del = git('-C', mainRepo, 'branch', '-d', branch);
    if (del.status !== 0) process.stderr.write(`worktree-remove: kept branch ${branch} (not merged)\n`);
  }
  return existsSync(wt) ? 1 : 0;
}

process.exit(main());
