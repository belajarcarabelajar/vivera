import fs from 'fs';
import path from 'path';

// The phase skills split out of the orchestrator. The orchestrator routes to
// each of them by name, so a missing or unrouted phase is a validator failure.
export const PHASE_SKILLS = [
  'sucp-rules',
  'sucp-brainstorm',
  'sucp-plan',
  'sucp-tdd-debug',
  'sucp-verify-deliver',
  'sucp-debt-sweep',
  'sucp-overnight',
];

export const MASTER_NAME = 'Super Ultra Code Plan Implementation.md';

// Wording checks ask "is this rule still written down anywhere in the skill?",
// so they read the orchestrator and every phase skill together. Frontmatter
// and the orchestrator's own router stay on the master file alone.
export function readSkillCorpus(rootDir) {
  const parts = [fs.readFileSync(path.join(rootDir, MASTER_NAME), 'utf8')];
  for (const name of PHASE_SKILLS) {
    const p = path.join(rootDir, 'skills', name, 'SKILL.md');
    if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf8'));
  }
  return parts.join('\n');
}
