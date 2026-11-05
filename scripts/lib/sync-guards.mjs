// scripts/lib/sync-guards.mjs
//
// Guards shared by scripts/pr-registry.mjs, scripts/lib/registry-sync.mjs,
// scripts/plan-issue-sync.mjs and scripts/plan-publish.mjs. They live here so
// those files stay under their ceilings in scripts/file-size-baseline.json.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Narrower than git's own ref rules on purpose: a registry value reaches git
// argv as a branch or a revision, so anything git could read as an option, a
// range or a lock file is refused at load instead of being passed along.
export function refNameProblem(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(value)) return 'has a character outside A-Z a-z 0-9 . _ / -';
  if (/^[-/.]/.test(value) || value.includes('/.') || value.includes('//')) return 'starts a name or a path part with - / or .';
  if (value.includes('..') || /[/.]$/.test(value) || value.endsWith('.lock')) return 'is not a valid git ref name';
  return null;
}

export function assertRefNames(s, where) {
  for (const field of ['branch', 'base']) {
    if (field === 'base' && s.base == null) continue;
    const why = refNameProblem(s[field]);
    if (why) throw new Error(`PR registry ${where}: session ${s.session} has ${field} ${JSON.stringify(s[field])}, which ${why}; fix the entry by hand`);
  }
}

// One session id holds one plan's branch, so a claim that names another plan
// would hand that plan a branch named after a different one.
export function assertSamePlan(existing, planSlug) {
  if (existing.plan !== planSlug) {
    throw new Error(`session "${existing.session}" is already claimed for plan ${existing.plan}, not ${planSlug}; pick another --session, or re-claim with --plan ${existing.plan}`);
  }
}

// An origin URL may carry `user:token@`; an error message must not.
export const maskUserinfo = (url) => String(url).replace(/\/\/[^/@\s]*@/g, '//***@');

// The plan-sync trailer is plain text in a public issue, so a copy of it proves
// nothing on its own. The issue must also be filed by the account gh runs as.
export function assertOwnIssue(run, row, refuse) {
  const r = run(['api', 'user', '--jq', '.login']);
  const me = r.ok ? (r.out || '').trim() : '';
  if (!me) throw refuse(`gh api user --jq .login did not name the running account (${r.err || 'no output'}), so #${row.number} cannot be proven to be this account's issue`);
  const author = row.author?.login;
  if (author !== me) {
    throw refuse(`#${row.number} carries this plan's trailer but was filed by ${author ?? 'an unknown account'}, not by ${me}, so it may be a copy. Record its number in plan.issues.json by hand if it is the right issue, then re-run`);
  }
}

// Stage ONLY the one mirror file. The vault's
// .obsidian/plugins/obsidian-git/data.json sets autoCommitOnlyStaged: true, so
// without an explicit `git add` the Obsidian Git plugin never commits a mirror
// and the copy silently rots in the working tree. This deliberately does NOT
// commit and does NOT push: a mirror is derived state, and committing is the
// vault owner's decision about their own history, made by the plugin on their
// schedule. A staging failure is reported as a failure, not swallowed, because
// the failure mode it prevents is silent.
export function stageInVault(registry, dest) {
  const r = spawnSync('git', ['-C', path.resolve(registry.vault), 'add', '--', path.resolve(dest)], {
    encoding: 'utf8',
  });
  if (r.error) return `cannot run git: ${r.error.message}`;
  if (r.status !== 0) {
    const first = (r.stderr || r.stdout || '').trim().split('\n')[0];
    return `git add failed (exit ${r.status}): ${first || 'no output'}`;
  }
  return null;
}

// True when git reports the mirror untracked (`??`) or changed in the working
// tree (second porcelain column). When git cannot answer, nothing is staged.
export function isUnstaged(registry, dest) {
  const r = spawnSync('git', ['-C', path.resolve(registry.vault), 'status', '--porcelain', '--untracked-files=all', '--', path.resolve(dest)], {
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return false;
  return r.stdout.split('\n').some((l) => l.startsWith('??') || (l.length > 2 && l[1] !== ' '));
}
