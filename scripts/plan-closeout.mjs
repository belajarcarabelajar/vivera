// scripts/plan-closeout.mjs
//
// Close-out gaps for a plan, so `pr-registry state <session> merged` can refuse
// to record a merge while the plan is still at `Verification` or its GitHub
// issue is still open. The pipeline says a plan becomes `status: Complete` after
// the debt sweep and the issue then closes through plan-issue-sync.mjs, but
// nothing checked it.
//
// Offline on purpose: local files only, no network, no gh. The issue state read
// here is the sidecar's record, not GitHub's.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { planStatus, loadConfig, issueKey } from './plan-issue-sync.mjs';

// The plan template puts a `# Draft|Approved|...` comment after the status value,
// and plan-issue-sync records that raw text, so both sides are compared without it.
const bare = (s) => (typeof s === 'string' ? s.replace(/\s+#.*$/, '').trim() : s);

export function closeoutGaps({ status: rawStatus, entry: rawEntry, planPath, project }) {
  const status = bare(rawStatus);
  const entry = rawEntry && typeof rawEntry === 'object' ? { ...rawEntry, status: bare(rawEntry.status) } : rawEntry;
  const gaps = [];
  const proj = project || '<project>';
  const sync = `bun scripts/plan-issue-sync.mjs --project ${proj} ${planPath}`;

  if (status !== 'Complete') {
    gaps.push({
      code: 'PLAN_NOT_COMPLETE',
      message: status == null
        ? `${planPath} declares no status, so it is not Complete`
        : `${planPath} has status "${status}", not Complete`,
      fix: `set "status: Complete" in ${planPath}, then run: bun scripts/plan-publish.mjs ${planPath} && ${sync}`,
    });
  }

  if (entry && typeof entry === 'object') {
    const ref = entry.url ? `#${entry.number} (${entry.url})` : `#${entry.number}`;
    if (entry.state !== 'closed') {
      gaps.push({
        code: 'ISSUE_NOT_CLOSED',
        message: `issue ${ref} is recorded as "${entry.state}", not closed`,
        fix: sync,
      });
    }
    if (entry.status !== status) {
      gaps.push({
        code: 'ISSUE_STALE',
        message: `issue ${ref} was synced at status "${entry.status}" but the plan is "${status}"`,
        fix: sync,
      });
    }
  }

  return gaps;
}

export function checkCloseout({ repoRoot, planSlug, configPath = path.join(repoRoot, 'plan.issues.json') }) {
  const planFile = path.join(repoRoot, 'docs', 'code-plan', 'plans', `${planSlug}.md`);
  if (!existsSync(planFile)) {
    return { skipped: `no plan file at ${planFile} (a one-task change has no plan file)`, gaps: [] };
  }

  const status = planStatus(readFileSync(planFile, 'utf8'));
  const planPath = issueKey(repoRoot, planFile);
  const skipped = [];

  if (!existsSync(configPath)) {
    skipped.push(`plan.issues.json not found at ${configPath}, issue not checked`);
    return { skipped: skipped.join('; '), gaps: closeoutGaps({ status, entry: null, planPath, project: null }) };
  }

  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    // A corrupt file must fail the gate; skipping here would let it pass silently.
    return {
      skipped: null,
      gaps: [
        ...closeoutGaps({ status, entry: null, planPath, project: null }),
        { code: 'CONFIG_UNREADABLE', message: e.message, fix: `repair ${configPath}` },
      ],
    };
  }

  // defer: local record only, upgrade when a closed-by-hand reopen is observed after a merge
  const entry = cfg.issues?.[planPath];
  if (!entry) skipped.push('plan has no issue record, nothing to close');
  const project = entry
    ? Object.keys(cfg.projects).find((k) => cfg.projects[k] === entry.repo) ?? null
    : null;

  return {
    skipped: skipped.length ? skipped.join('; ') : null,
    gaps: closeoutGaps({ status, entry, planPath, project }),
  };
}
