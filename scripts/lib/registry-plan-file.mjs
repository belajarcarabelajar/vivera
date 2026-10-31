// scripts/lib/registry-plan-file.mjs
//
// Where a PR-registry session's plan lives. `repo` is the repository of the
// session's branch and PR; `plan_repo` is where its plan file lives when that is
// another repository (a vivera plan driving sessions elsewhere). Entries claimed
// before `repo` was recorded fall back to `fallbackRepo`. `plan_file` is a path
// relative to that repository, and `plan_missing` says why no plan file exists.

import { existsSync } from 'node:fs';
import path from 'node:path';

const planRel = (plan) => path.join('docs', 'code-plan', 'plans', `${plan}.md`);

export function planFileOf(session, fallbackRepo) {
  const rel = session.plan_file ?? planRel(session.plan);
  return path.join(session.plan_repo ?? session.repo ?? fallbackRepo, rel);
}

export function planMissingOf(session) {
  const reason = session.plan_missing;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}

// At claim time the plan is already written: when it exists only in the vivera
// checkout running the claim, that checkout is the session's plan_repo.
export function planRepoAtClaim({ plan, repoRoot, viveraRoot }) {
  const repo = path.resolve(repoRoot);
  const vivera = path.resolve(viveraRoot);
  if (repo === vivera || existsSync(path.join(repo, planRel(plan)))) return null;
  return existsSync(path.join(vivera, planRel(plan))) ? vivera : null;
}
