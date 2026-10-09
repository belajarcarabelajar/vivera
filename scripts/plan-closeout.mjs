// scripts/plan-closeout.mjs
//
// Close-out gaps for a plan, so `pr-registry state <session> merged` can refuse
// to record a merge while the plan is still at `Verification` or its GitHub
// issue is still open. The pipeline says a plan becomes `status: Complete` after
// the debt sweep and the issue then closes through plan-issue-sync.mjs, but
// nothing checked it.
//
// Offline on purpose: local files only, no network, no gh. The issue state read
// here is the sidecar's record, not GitHub's, and the mirror verdict comes from
// plan-publish.mjs comparing hashes on disk.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { planStatus, loadConfig, issueKey } from './plan-issue-sync.mjs';
import { planFreshness } from './plan-publish.mjs';

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

export function checkCloseout({
  repoRoot,
  planSlug,
  configPath = path.join(repoRoot, 'plan.issues.json'),
  publishConfig,
  freshness = planFreshness,
}) {
  const planFile = path.join(repoRoot, 'docs', 'code-plan', 'plans', `${planSlug}.md`);
  if (!existsSync(planFile)) {
    return { skipped: `no plan file at ${planFile} (a one-task change has no plan file)`, gaps: [] };
  }

  const status = planStatus(readFileSync(planFile, 'utf8'));
  const planPath = issueKey(repoRoot, planFile);
  const skipped = [];
  let entry = null;
  let project = null;
  let configError = null;

  if (!existsSync(configPath)) {
    skipped.push(`plan.issues.json not found at ${configPath}, issue not checked`);
  } else {
    try {
      const cfg = loadConfig(configPath);
      // defer: local record only, upgrade when a closed-by-hand reopen is observed after a merge
      entry = cfg.issues?.[planPath] ?? null;
      if (entry) project = Object.keys(cfg.projects).find((k) => cfg.projects[k] === entry.repo) ?? null;
      else skipped.push('plan has no issue record, nothing to close');
    } catch (e) {
      configError = e.message;
    }
  }

  const gaps = closeoutGaps({ status, entry, planPath, project });
  // A corrupt file must fail the gate; skipping here would let it pass silently.
  if (configError) gaps.push({ code: 'CONFIG_UNREADABLE', message: configError, fix: `repair ${configPath}` });

  const m = freshness(planFile, publishConfig ? { config: publishConfig } : {});
  if (m.state === 'NOT-APPLICABLE') {
    skipped.push(`vault mirror not checked: plan is not covered by a mirror${m.detail ? ` (${m.detail})` : ''}`);
  } else if (m.state === 'UNROUTABLE') {
    skipped.push(`vault mirror not checked: ${String(m.detail).split('\n')[0]}`);
  } else if (m.state !== 'OK') {
    gaps.push({
      code: 'MIRROR_STALE',
      message: `vault mirror for ${planPath} is ${m.state}: ${m.detail}`,
      fix: `bun scripts/plan-publish.mjs ${planPath}`,
    });
  }

  return { skipped: skipped.length ? skipped.join('; ') : null, gaps };
}
