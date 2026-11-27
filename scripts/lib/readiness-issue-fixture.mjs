// scripts/lib/readiness-issue-fixture.mjs
//
// Test fixture: a plan.issues.json sidecar holding a CURRENT issue record for one
// plan, so a readiness CLI test that checks a READY path stays READY now that
// readiness also checks the issue mirror. The sidecar sits in the fixture's git
// directory, so it is removed with the fixture and never shows in git status.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hashOf, issueKey, ISSUE_FORMAT } from '../plan-issue-sync.mjs';
import { gitText } from './git.mjs';

// Returns the env entry for a spawned readiness CLI. A repoRoot that is not a
// git repository yet is initialised, because readiness keys the record by the
// plan's path from the git top level of the folder holding it.
export function currentIssueEnv(repoRoot, planFile) {
  if (!existsSync(path.join(repoRoot, '.git'))) gitText(repoRoot, ['init', '--quiet']);
  const top = gitText(path.dirname(planFile), ['rev-parse', '--show-toplevel']).trim();
  const repo = 'fixture-owner/fixture-repo';
  const record = {
    number: 1, url: `https://github.com/${repo}/issues/1`, hash: hashOf(readFileSync(planFile, 'utf8')), state: 'open',
    status: 'Verification', repo, synced_at: '2026-11-27T00:00:00.000Z', format: ISSUE_FORMAT,
  };
  const file = path.join(gitText(top, ['rev-parse', '--absolute-git-dir']).trim(), 'plan.issues.json');
  writeFileSync(file, JSON.stringify({ version: 1, projects: { [path.basename(top)]: repo }, issues: { [issueKey(top, planFile)]: record } }));
  return { PLAN_ISSUES_CONFIG: file };
}
