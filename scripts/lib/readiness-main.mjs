// scripts/lib/readiness-main.mjs
//
// Where plan-closeout.mjs --readiness reads a plan's skip_if when no --cwd is
// given. By default it is the checkout that holds the plan. Once every registry
// session of the plan is merged or closed, that checkout often carries the
// plan's own closing commit, so it is ahead of origin/main and a skip_if asking
// whether HEAD reached origin/main fails there although the work landed. A task
// OPEN there is then read again in a temporary detached worktree at origin/main
// of the same repository; only a pass there changes its row. Offline: origin/main
// is read as it is, never fetched.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { missingTestPaths } from './test-paths.mjs';

export function defaultCwd(planFile) {
  const dir = path.dirname(planFile);
  if (dir.endsWith(path.join('docs', 'code-plan', 'plans'))) return path.resolve(dir, '..', '..', '..');
  return process.cwd();
}

const gitExit = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' }).status;

// The same rule as auditCloseout: at least one session merged and none unfinished.
export function planLanded(sessions, planId) {
  const own = sessions.filter((s) => s.plan === planId);
  return own.some((s) => s.state === 'merged') && own.every((s) => s.state === 'merged' || s.state === 'closed');
}

export function rereadAtMain(rows, { sessions = [], planId, cwd, run, timeoutMs, log = console.log }) {
  if (!rows.some((t) => t.state === 'OPEN') || !planLanded(sessions, planId)) return rows;
  // Exit 1 is "not an ancestor"; 128 (no repository, no origin/main) keeps today's rows.
  if (gitExit(cwd, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main') !== 1) return rows;
  const dir = mkdtempSync(path.join(tmpdir(), 'readiness-main-'));
  try {
    if (gitExit(cwd, 'worktree', 'add', '--detach', '--quiet', dir, 'origin/main') !== 0) return rows;
    log(`readiness origin/main: ${dir} (every session of ${planId} is merged or closed and ${cwd} is ahead of origin/main)`);
    return rows.map((t) => {
      // bun test exits 0 when a named file is missing, so a missing file keeps the row OPEN here too.
      if (t.state !== 'OPEN' || missingTestPaths(t.skipIf, dir).length) return t;
      const r = run(t.skipIf, { cwd: dir, timeoutMs });
      return !r.timedOut && r.exit === 0 ? { id: t.id, state: 'DONE', skipIf: t.skipIf } : t;
    });
  } finally {
    gitExit(cwd, 'worktree', 'remove', '--force', dir);
    rmSync(dir, { recursive: true, force: true });
    gitExit(cwd, 'worktree', 'prune');
  }
}
