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

// A skill index may move its body into a sibling references/ directory, so a
// SKILL.md reads as the index plus every reference file, in name order.
export function readSkillText(rootDir, rel) {
  const file = path.join(rootDir, rel);
  const parts = [fs.readFileSync(file, 'utf8')];
  const refDir = path.join(path.dirname(file), 'references');
  if (path.basename(rel) === 'SKILL.md' && fs.existsSync(refDir)) {
    const names = fs
      .readdirSync(refDir)
      .filter((n) => n.endsWith('.md'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const n of names) parts.push(fs.readFileSync(path.join(refDir, n), 'utf8'));
  }
  return parts.join('\n');
}

// Wording checks ask "is this rule still written down anywhere in the skill?",
// so they read the orchestrator and every phase skill together. Frontmatter
// and the orchestrator's own router stay on the master file alone.
export function readSkillCorpus(rootDir) {
  const parts = [fs.readFileSync(path.join(rootDir, MASTER_NAME), 'utf8')];
  for (const name of PHASE_SKILLS) {
    const rel = path.join('skills', name, 'SKILL.md');
    if (fs.existsSync(path.join(rootDir, rel))) parts.push(readSkillText(rootDir, rel));
  }
  return parts.join('\n');
}
