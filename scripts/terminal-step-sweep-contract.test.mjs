import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

// Contract for plan 2026-11-15-sweep-before-terminal: when a plan ends in a
// terminal task (render, deploy, publish), the Step 6 debt sweep runs before it,
// so that costly step runs once, after the sweep's follow-ups land.

const ROOT = path.join(import.meta.dir, '..');
const SWEEP = 'skills/vivera-sweep/SKILL.md';
const REF = 'skills/vivera-sweep/references/06-terminal-task.md';

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
    const row = readRepoFile('skills/vivera/SKILL.md').split('\n').find((l) => l.startsWith('| Step 6:'));
    expect(row).toBeDefined();
    expect(row).toContain('terminal task');
  });

  test('the plan writer marks the terminal task', () => {
    const plan = readRepoFile('skills/vivera-plan/SKILL.md');
    expect(plan).toContain('(terminal)');
    expect(plan).toContain('06-terminal-task.md');
  });

  test('the saturation rule lets the terminal task stay open at sweep time', () => {
    const line = readRepoFile('skills/vivera-ship/references/01-engineering-gates.md').split('\n').find((l) => l.startsWith('- Plan Completion Saturation Rule:'));
    expect(line).toContain('terminal task');
  });
});

describe('F follow-ups', () => {
  test('F2 the overnight run parks the terminal task', () => {
    expect(readRepoFile('skills/vivera-overnight/SKILL.md')).toContain('terminal task');
  });

  test('F1 the README names the terminal-task exception', () => {
    const line = readRepoFile('README.md').split('\n').find((l) => l.startsWith('- **Verification is the last gate, not the last step.**'));
    expect(line).toContain('terminal task');
  });

  test('F3 the task template shows the terminal marker', () => {
    expect(readRepoFile('skills/vivera-plan/references/02-plan-templates.md')).toContain('(terminal)');
  });
});

describe('R review fixes', () => {
  const lineWith = (rel, start) => {
    const line = readRepoFile(rel).split('\n').find((l) => l.trimStart().startsWith(start));
    if (!line) throw new Error(`${rel}: no line starting with ${start}`);
    return line;
  };

  test('R1 6.5.5 step 4 and its run order name the terminal exception', () => {
    expect(lineWith(SWEEP, '4. **Ask the `Close plan` gate**')).toContain('terminal task');
    expect(lineWith(SWEEP, 'This step is mandatory, including when')).toContain('terminal task');
  });

  test('R2 the Close plan mirrors name the terminal exception', () => {
    expect(lineWith('templates/follow-up-injection-template.md', 'Mandatory: readiness runs before the follow-ups call')).toContain('terminal task');
    expect(lineWith('templates/follow-up-injection-template.md', '| Question asked | `Close plan`')).toContain('terminal task');
    expect(lineWith('skills/vivera-rules/references/07-completion-confirmation.md', '| Plan closeout (Step 6) |')).toContain('terminal task');
    expect(lineWith('skills/vivera-sweep/references/04-stars-anti-patterns.md', 'accDescr: Once the plan is done')).toContain('terminal task');
  });

  test('R4 the follow-up template diagram names the terminal exception', () => {
    expect(lineWith('templates/follow-up-injection-template.md', 'accDescr: Harvest debt candidates')).toContain('terminal task');
    expect(lineWith('templates/follow-up-injection-template.md', 'First --> Ask[')).toContain('terminal task');
  });

  test('R3 the terminal task carries a real skip_if and no run[]', () => {
    const ref = readRepoFile(REF);
    for (const term of ['no `run[]`', 'NEEDS-HUMAN', 'runs the render or deploy again']) {
      expect({ term, found: ref.includes(term) }).toEqual({ term, found: true });
    }
    expect(readRepoFile('skills/vivera-plan/SKILL.md')).toContain('no `run[]`');
  });
});

describe('T2 mirrors', () => {
  const MIRRORS = [
    'templates/follow-up-injection-template.md',
    'templates/session-learning-ledger-template.md',
    'templates/implementation-plan-template.md',
    'skills/vivera-sweep/references/04-stars-anti-patterns.md',
    'skills/vivera-rules/references/09-anti-patterns.md',
    'skills/vivera-ship/references/03-verification-matrix.md',
  ];
  for (const rel of MIRRORS) {
    test(`${rel} restates the terminal-task exception`, () => {
      expect(readRepoFile(rel)).toContain('terminal task');
    });
  }
});
