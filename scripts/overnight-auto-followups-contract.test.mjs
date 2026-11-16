import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

// Contract for plan 2026-11-16-overnight-auto-followups: an overnight run executes every
// eligible debt-sweep follow-up without asking the sleeping owner, inside a fixed safety
// class, one round, one commit per follow-up; the rest is parked for a human.

const ROOT = path.join(import.meta.dir, '..');
const OVERNIGHT = 'skills/sucp-overnight/SKILL.md';
const SNIPPET = 'snippets/orkestrasi-overnight.md';

function readRepoFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`missing repository file: ${rel}`);
  return fs.readFileSync(abs, 'utf8');
}

function expectTerms(text, terms) {
  for (const term of terms) expect({ term, found: text.includes(term) }).toEqual({ term, found: true });
}

describe('overnight skill', () => {
  test('the entry gate approves the follow-up class while the owner is awake', () => {
    expectTerms(readRepoFile(OVERNIGHT), ['follow-ups: ask', 'so the approval covers that class of work']);
  });

  test('eligible follow-ups run without a question, inside a fixed class', () => {
    expectTerms(readRepoFile(OVERNIGHT), [
      'every eligible follow-up executes without a question',
      'can be undone with `git revert`',
      'does not decide eligibility',
      'a choice between alternatives that could go either way',
    ]);
  });

  test('each follow-up is its own commit and a red one leaves no commit behind', () => {
    expectTerms(readRepoFile(OVERNIGHT), ['its own commit', 'leaves no commit behind', 'one round']);
  });

  test('an ineligible candidate is parked for a human', () => {
    expectTerms(readRepoFile(OVERNIGHT), ['An ineligible candidate goes to the plan backlog']);
  });

  test('the overnight marker stays until the follow-ups are done', () => {
    const text = readRepoFile(OVERNIGHT);
    expectTerms(text, ['Keep the overnight marker until', 'keep the word `running` first']);
    expect(text).not.toContain('no follow-up executes unselected');
  });
});

describe('restatements', () => {
  test('the sweep, the rules, the guide and the gate catalog point at the overnight exception', () => {
    for (const rel of [
      'skills/sucp-debt-sweep/SKILL.md',
      'skills/sucp-debt-sweep/references/02-rank-and-execute.md',
      'skills/sucp-rules/SKILL.md',
      'skills/sucp-rules/references/07-completion-confirmation.md',
      'docs/guide/pipeline-confirmations.md',
    ]) {
      const text = readRepoFile(rel);
      expect({ rel, names: text.includes('eligible') && text.includes('sucp-overnight') }).toEqual({ rel, names: true });
    }
  });

  test('the overnight trigger snippet runs eligible follow-ups and keeps the opt-out', () => {
    const text = readRepoFile(SNIPPET);
    expectTerms(text, ['EVERY ELIGIBLE FOLLOW-UP RUNS WITHOUT A QUESTION', 'follow-ups: ask', 'leaves no commit behind']);
    expect(text).not.toContain('no follow-up executes unselected');
  });
});
