// scripts/lib/closeout-verdict.mjs
//
// What is printed when a session is recorded as merged, by `state <s> merged`
// and by `reconcile`. Kept apart from scripts/pr-registry.mjs so both merge
// paths share one verdict without importing the CLI.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCloseout } from '../plan-closeout.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Never a refusal: the merge already happened on GitHub, so the registry records
// it and the gaps stay visible. The check is injected so the line shapes are
// testable without a repository.
export function closeoutVerdict(session, { repoRoot, repoFromFlag = false, check = checkCloseout }) {
  const { skipped, gaps } = check({ repoRoot, planSlug: session.plan });
  const lines = [];
  // Matches the reason `checkCloseout` gives for a missing plan file. Without a
  // known repository the lookup fell back to this repository, so the miss most
  // likely means the wrong place was searched, not that the change had no plan.
  const guessedRepo = Boolean(skipped) && skipped.startsWith('no plan file at ') && !session.repo && !repoFromFlag;
  if (guessedRepo) {
    lines.push(
      `warning: close-out not fully checked: ${skipped}`,
      // The merge is recorded by this same call, so a rerun with --repo would be
      // refused; the hints name what still works afterwards.
      `  hint: the merge is recorded. "${session.session}" records no repository; if plan ${session.plan} lives in another repository, measure it with`,
      `    bun scripts/plan-closeout.mjs --readiness <repository>/docs/code-plan/plans/${session.plan}.md`,
      `  hint: record the repository for future commands by re-claiming the session:`,
      `    bun scripts/pr-registry.mjs claim --plan ${session.plan} --session ${session.session} --repo <repository>`,
    );
  } else if (skipped) {
    lines.push(`note: close-out not fully checked: ${skipped}`);
  }
  if (gaps.length === 0) return { lines };

  lines.push(`warning: recording "${session.session}" as merged, but plan ${session.plan} is not closed out:`);
  for (const g of gaps) {
    lines.push(`  - [${g.code}] ${g.message}`, `    fix: ${g.fix}`);
  }
  const planFile = path.resolve(repoRoot, 'docs', 'code-plan', 'plans', `${session.plan}.md`);
  lines.push(
    `readiness: bun scripts/plan-closeout.mjs --readiness ${planFile}`,
    'due: bun scripts/plan-close-loop.mjs --due',
  );
  return { lines };
}

// Where a merge looks for the plan: the flag, then `plan_repo`, then the
// claimed repository, then this repository for entries that predate `repo`.
export function resolveMergeRepo(session, flagRepo) {
  if (flagRepo) return path.resolve(flagRepo);
  return session.plan_repo ?? session.repo ?? rootDir;
}
