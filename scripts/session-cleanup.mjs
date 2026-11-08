// scripts/session-cleanup.mjs
//
// Run when the user declares a session done (sucp-rules, Git and Worktree
// Ownership): removes that session's worktree without asking, after the checks
// in lib/session-cleanup.mjs. The branch goes only when origin/<base> holds it.
//
//   bun scripts/session-cleanup.mjs --session <slug> [--registry <file>] [--dry-run]
//   bun scripts/session-cleanup.mjs --worktree <path> [--base <branch>] [--dry-run]
//   bun scripts/session-cleanup.mjs --native [--repo <path>] [--base <branch>] [--dry-run]
//
// --native sweeps Claude Code's own worktrees (branch worktree-<name>, made by the
// WorktreeCreate hook), which Claude Code stops removing once that hook exists.
// Each goes through the same checks; other branches and the main checkout are skipped.
//
// Exit 0 removed (or dry run, or nothing found), 3 kept because of a blocker it names, 1 error.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCleanup } from './lib/session-cleanup.mjs';

const USAGE = 'usage: session-cleanup.mjs (--session <slug> [--registry <file>] | --worktree <path> | --native [--repo <path>]) [--base <branch>] [--dry-run]';

function parseArgs(argv) {
  const opts = { registry: path.join(import.meta.dir, '..', 'pr.registry.json'), dryRun: false, native: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--native') opts.native = true;
    else if (['--session', '--registry', '--worktree', '--base', '--repo'].includes(a) && argv[i + 1]) opts[a.slice(2)] = argv[++i];
    else throw new Error(USAGE);
  }
  if ([opts.session, opts.worktree, opts.native].filter(Boolean).length !== 1) throw new Error(USAGE);
  return opts;
}

// Worktrees on a refs/heads/worktree-* branch, from the porcelain list; the first entry is the main checkout.
function nativeWorktrees(repo) {
  const r = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git worktree list in ${repo}: ${(r.stderr ?? '').trim()}`);
  return r.stdout.trim().split('\n\n').slice(1).flatMap((block) => {
    const lines = block.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    return wt && branch?.startsWith('refs/heads/worktree-') ? [wt] : [];
  });
}

function sweepNative(opts) {
  const worktrees = nativeWorktrees(opts.repo ?? process.cwd());
  if (!worktrees.length) {
    console.log('no native worktrees');
    return 0;
  }
  let kept = false;
  for (const worktree of worktrees) {
    if (!fs.existsSync(worktree)) {
      console.log(`nothing to remove: ${worktree} does not exist`);
      continue;
    }
    const r = runCleanup({ worktree, base: opts.base ?? 'main', dryRun: opts.dryRun });
    console.log(r.lines.join('\n'));
    if (r.status === 'kept') kept = true;
  }
  return kept ? 3 : 0;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.native) return sweepNative(opts);
  let { worktree, base } = opts;
  if (opts.session) {
    const sessions = JSON.parse(fs.readFileSync(opts.registry, 'utf8')).sessions ?? [];
    const s = sessions.find((x) => x.session === opts.session);
    if (!s) throw new Error(`session "${opts.session}" is not in ${opts.registry}`);
    worktree = s.worktree;
    base = base ?? s.base;
  }
  if (!fs.existsSync(worktree)) {
    console.log(`nothing to remove: ${worktree} does not exist`);
    return 0;
  }
  const r = runCleanup({ worktree, base: base ?? 'main', dryRun: opts.dryRun });
  console.log(r.lines.join('\n'));
  return r.status === 'kept' ? 3 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
