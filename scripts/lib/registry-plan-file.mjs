// scripts/lib/registry-plan-file.mjs
//
// Where a PR-registry session's plan lives. Entries claimed before `repo` was
// recorded fall back to `fallbackRepo`. Two optional fields cover plans that are
// not at docs/code-plan/plans/<plan>.md: `plan_file` (a path relative to the
// repository) and `plan_missing` (why the session has no plan file to read).

import path from 'node:path';

export function planFileOf(session, fallbackRepo) {
  const rel = session.plan_file ?? path.join('docs', 'code-plan', 'plans', `${session.plan}.md`);
  return path.join(session.repo ?? fallbackRepo, rel);
}

export function planMissingOf(session) {
  const reason = session.plan_missing;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}
