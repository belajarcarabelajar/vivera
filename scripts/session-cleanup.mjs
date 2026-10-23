// scripts/session-cleanup.mjs
//
// Run when the user declares a session done (sucp-rules, Git and Worktree
// Ownership): removes that session's worktree without asking, after the checks
// in lib/session-cleanup.mjs. The branch goes only when origin/<base> holds it.
//
//   bun scripts/session-cleanup.mjs --session <slug> [--registry <file>] [--dry-run]
//   bun scripts/session-cleanup.mjs --worktree <path> [--base <branch>] [--dry-run]
//
// Exit 0 removed (or dry run), 3 kept because of a blocker it names, 1 error.

import fs from 'node:fs';
import path from 'node:path';
import { runCleanup } from './lib/session-cleanup.mjs';

const USAGE = 'usage: session-cleanup.mjs (--session <slug> [--registry <file>] | --worktree <path> [--base <branch>]) [--dry-run]';

function parseArgs(argv) {
  const opts = { registry: path.join(import.meta.dir, '..', 'pr.registry.json'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (['--session', '--registry', '--worktree', '--base'].includes(a) && argv[i + 1]) opts[a.slice(2)] = argv[++i];
    else throw new Error(USAGE);
  }
  if (!opts.session === !opts.worktree) throw new Error(USAGE);
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
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
