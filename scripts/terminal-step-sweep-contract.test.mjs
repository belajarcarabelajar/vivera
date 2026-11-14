import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

// Contract for plan 2026-11-15-sweep-before-terminal: when a plan ends in a
// terminal task (render, deploy, publish), the Step 6 debt sweep runs before it,
// so that costly step runs once, after the sweep's follow-ups land.

const ROOT = path.join(import.meta.dir, '..');
const SWEEP = 'skills/sucp-debt-sweep/SKILL.md';
const REF = 'skills/sucp-debt-sweep/references/06-terminal-task.md';

function readRepoFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`missing repository file: ${rel}`);
  return fs.readFileSync(abs, 'utf8');
}

/** The body of a Markdown section, from its heading line to the next heading of the same or a higher level. */
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`missing heading: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)[0].length <= level);
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function frontmatterDescription(text) {
  const line = text.split('\n').find((l) => l.startsWith('description:'));
  if (!line) throw new Error('missing description line');
  return line;
}

describe('T1 core rule', () => {
  test('the reference states the terminal-task order', () => {
    const ref = readRepoFile(REF);
    for (const term of ['(terminal)', 'every non-terminal task', 'runs once', 'its own call', 'no second sweep', 'skip_if']) {
      expect({ term, found: ref.includes(term) }).toEqual({ term, found: true });
    }
  });

  test('the sweep loads the reference and names the terminal task in its entry rules', () => {
    const sweep = readRepoFile(SWEEP);
    expect(frontmatterDescription(sweep)).toContain('terminal task');
    expect(sweep).toContain('(references/06-terminal-task.md)');
    expect(section(sweep, '### 6.1 Preconditions: the plan must be finished first')).toContain('terminal task');
    const timing = sweep.split('\n').find((l) => l.startsWith('**Timing.**'));
    expect(timing).toContain('terminal task');
  });

  test('the phase router enters Step 6 before a terminal task', () => {
    const row = readRepoFile('skills/super-ultra-code-plan/SKILL.md').split('\n').find((l) => l.startsWith('| Step 6:'));
    expect(row).toBeDefined();
    expect(row).toContain('terminal task');
  });

  test('the plan writer marks the terminal task', () => {
    const plan = readRepoFile('skills/sucp-plan/SKILL.md');
    expect(plan).toContain('(terminal)');
    expect(plan).toContain('06-terminal-task.md');
  });

  test('the saturation rule lets the terminal task stay open at sweep time', () => {
    const line = readRepoFile('skills/sucp-verify-deliver/references/01-engineering-gates.md').split('\n').find((l) => l.startsWith('- Plan Completion Saturation Rule:'));
    expect(line).toContain('terminal task');
  });
});

describe('T2 mirrors', () => {
  const MIRRORS = [
    'templates/follow-up-injection-template.md',
    'templates/session-learning-ledger-template.md',
    'templates/implementation-plan-template.md',
    'skills/sucp-debt-sweep/references/04-stars-anti-patterns.md',
    'skills/sucp-rules/references/09-anti-patterns.md',
    'skills/sucp-verify-deliver/references/03-verification-matrix.md',
  ];
  for (const rel of MIRRORS) {
    test(`${rel} restates the terminal-task exception`, () => {
      expect(readRepoFile(rel)).toContain('terminal task');
    });
  }
});
