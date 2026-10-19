// scripts/sucp-practice-contract.test.mjs
//
// Pins the rules adopted from the mattpocock/skills comparison (plan
// 2026-10-15-sucp-practice-gaps) in the one file that owns each rule, so a later
// edit cannot drop or relocate one silently. Groups are named by plan task, so a
// task runs only its own group: `bun test ./scripts/sucp-practice-contract.test.mjs -t 'T1 gap'`.
// An `absent` needle is superseded wording that must not survive beside the new rule.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readSkillText } from './skill-corpus.mjs';

const root = path.join(import.meta.dir, '..');
const read = (rel) => readSkillText(root, rel);

const CONTRACT = [
  {
    task: 'T1', gaps: '1, 2, 7', file: 'skills/sucp-tdd-debug/SKILL.md',
    present: [
      'Phase 0: Build the Feedback Loop',
      'NO HYPOTHESIS WITHOUT A RED-CAPABLE FEEDBACK LOOP',
      'git bisect run',
      'raise the reproduction rate',
      'every remaining element is load-bearing',
      '3 to 5 ranked, falsifiable hypotheses',
      '[DEBUG-',
      'measure a baseline before bisecting',
      'no correct seam is itself a finding',
      'confirmed hypothesis goes into the commit message or the PR body',
      'Redact every secret',
      'only after Phase 0 has a red-capable command',
      'Seams first',
      'what it catches and what it misses',
      'Implementation-coupled',
      'Tautological',
      'Horizontal slicing',
      'independent source of truth',
      'Mock only at system boundaries',
      'a different rule from the Strict No-Mocking Invariant',
      'GLOSSARY.md',
    ],
  },
  {
    task: 'T1', gaps: '1', file: 'templates/systematic-debugging-log-template.md',
    present: ['Phase 0: Feedback Loop', 'Red-capable command', 'Ranked Hypotheses', 'Confirmed hypothesis', '[DEBUG-'],
  },
  {
    task: 'T2', gaps: '4, 6, 7, 8, 9', file: 'skills/sucp-brainstorm/SKILL.md',
    present: [
      'Design It Twice',
      'radically different',
      'depth, locality, and seam placement',
      'independent by construction',
      'design tree',
      'Ask the whole frontier',
      'waits for the next round',
      'nothing is silently assumed',
      'GLOSSARY.md',
      'Challenge a term',
      'written together with the design doc',
      'hard to reverse, surprising without context, and the result of a real trade-off',
      'templates/spec-template.md',
      'docs/code-plan/spikes/<spike-id>/',
      'pure module',
      'exempt from the temp-file purge',
      'is not verified by anything',
    ],
    absent: ['Keep to 1–3 focused questions', 'one decision at a time, only ones that matter'],
  },
  {
    task: 'T3', gaps: '3, 9, 13', file: 'skills/sucp-verify-deliver/SKILL.md',
    present: [
      'Two-Axis Review',
      'Spec reviewer',
      'never reranked',
      'scope creep',
      'Design notes',
      'except a spike prototype kept under docs/code-plan/spikes/<spike-id>/',
      'before and after evidence',
    ],
  },
  {
    task: 'T3', gaps: '3', file: 'templates/code-review-template.md',
    present: [
      'Spec Axis',
      'Design Notes (non-blocking)',
      'Feature Envy',
      'Shotgun Surgery',
      'Speculative Generality',
      'Refused Bequest',
      'A tautological test',
    ],
  },
  {
    task: 'T3', gaps: '13', file: 'templates/pull-request-template.md',
    present: ['**Before:**', '**After:**', '| Door |', 'Smallest visual'],
  },
  {
    task: 'T4', gaps: '5', file: 'skills/sucp-debt-sweep/SKILL.md',
    present: [
      'mechanical or judgement',
      'default destination is an automated check',
      'Environment improvements',
      'steering no-op',
    ],
    absent: ['Only propose a question here when a kept rule implies a concrete code or doc change'],
  },
  {
    task: 'T4', gaps: '5', file: 'templates/session-learning-ledger-template.md',
    present: ['## Environment Improvements', 'Mechanical or judgement', 'Steering no-ops'],
  },
  {
    task: 'T5', gaps: '8', file: 'skills/sucp-plan/SKILL.md',
    present: [
      'tracer-bullet vertical slice',
      'Prefactor first',
      'expand, migrate in batches, contract',
      'Blocked by',
      'What it delivers',
    ],
  },
  {
    task: 'T5', gaps: '8', file: 'templates/spec-template.md', createdBy: 'T5',
    present: [
      '## Problem Statement',
      '## User Stories',
      '## Implementation Decisions',
      '## Testing Decisions',
      '## Out of Scope',
      'no file paths',
      'accTitle:',
    ],
  },
  {
    task: 'T6', gaps: '10, 12', file: 'skills/sucp-rules/SKILL.md',
    present: [
      'Phase-Boundary Context Decision',
      'first yes wins',
      'never mid-phase',
      '200,000 tokens',
      'Frontier Dispatch',
      'never while one of its dependencies is in flight',
      'context pointer',
    ],
  },
  {
    task: 'T7', gaps: '7', file: 'templates/adr-template.md',
    present: ['Write an ADR only when all three hold', 'Hard to reverse', 'Surprising without context', 'real trade-off'],
  },
  {
    task: 'T7', gaps: '9', file: 'templates/spike-report-template.md',
    present: ['Prototype Location', 'docs/code-plan/spikes/<spike-id>/', 'Question this prototype answers'],
  },
  {
    task: 'T8', gaps: '1, 3, 8, 13', file: 'docs/guide/reference-companion-templates.md',
    present: ['templates/spec-template.md', 'red-capable feedback loop', 'Standards and Spec axes', 'before and after evidence'],
    absent: ['4-phase RCA state machine (REPRODUCE -> DIAGNOSE -> FIX -> VERIFY)'],
  },
  {
    task: 'T8', gaps: '1', file: 'snippets/orkestrasi-debugging.md',
    present: ['BUILD THE FEEDBACK LOOP FIRST', 'red-capable'],
  },
  // R1: fixes from the Standards and Spec reviews of the session diff.
  {
    task: 'R1', gaps: 'review fixes', file: 'Super Ultra Code Plan Implementation.md',
    present: ['Output = answer, not product code.'],
    absent: ['Output = answer, not kept code.'],
  },
  {
    task: 'R1', gaps: 'review fixes', file: 'skills/sucp-rules/SKILL.md',
    present: ['The ceiling wins over the phase boundary', 'consecutive calls within one round', 'the output is an answer, not product code'],
    absent: ['the output is an answer, not kept code'],
  },
  {
    task: 'R1', gaps: 'review fixes', file: 'skills/sucp-brainstorm/SKILL.md',
    present: ['lists `GLOSSARY.md` under files touched', 'extend that file instead of adding a second one'],
    absent: ['label built code as throwaway', 'Create `GLOSSARY.md` lazily at the repository root on the first resolved term'],
  },
  {
    task: 'R1', gaps: 'review fixes', file: 'skills/sucp-debt-sweep/SKILL.md',
    present: ["the review's Design Notes"],
  },
  {
    task: 'R1', gaps: 'review fixes', file: 'skills/sucp-tdd-debug/SKILL.md',
    present: ["the session's own tag", 'without a regression test is a TDD exception', "about the agent's own tool use"],
    absent: ['grep the `[DEBUG-` prefix to zero hits'],
  },
  {
    task: 'R1', gaps: 'review fixes', file: 'templates/systematic-debugging-log-template.md',
    present: ["the session's own tag"],
    absent: ["`grep -rnF '[DEBUG-' .` returns 0 hits"],
  },
  {
    task: 'R1', gaps: 'review fixes', file: 'snippets/orkestrasi-ngoding-plan.md',
    present: ['feedback loop → reproduce'],
  },
  {
    task: 'R1', gaps: 'review fixes', file: 'docs/diagrams-src/lifecycle.mmd',
    absent: ['4-Phase RCA Loop'],
  },
  // F1 to F4: debt-sweep follow-ups selected at session close.
  {
    task: 'F1', gaps: 'follow-up', file: 'templates/pr-review-template.md',
    present: ['Spec Axis', 'linked issue', 'never reranked'],
  },
  {
    task: 'F2', gaps: 'follow-up', file: 'skills/sucp-verify-deliver/SKILL.md',
    present: ['priorities in the Spec Axis table of `templates/code-review-template.md`'],
    absent: ['one built wrongly is `P0` or `P1`'],
  },
  {
    task: 'F3', gaps: 'follow-up', file: 'templates/subagent-contract-template.md',
    present: ['**Context pointers:**', 'instead of pasted text'],
  },
  {
    task: 'F4', gaps: 'follow-up', file: 'MEMORY.md',
    present: ['refuses `rm` outside `/tmp`', 'cannot verify a variable', '| L57 |', 'UNROUTABLE'],
  },
];

describe('T0 contract: target files exist', () => {
  for (const group of CONTRACT.filter((g) => !g.createdBy)) {
    test(group.file, () => {
      expect(fs.existsSync(path.join(root, group.file))).toBe(true);
    });
  }
});

for (const group of CONTRACT) {
  describe(`${group.task} gap ${group.gaps}: ${group.file}`, () => {
    for (const needle of group.present ?? []) {
      test(`contains "${needle}"`, () => {
        const text = fs.existsSync(path.join(root, group.file)) ? read(group.file) : '';
        expect(text).toContain(needle);
      });
    }
    for (const needle of group.absent ?? []) {
      test(`no longer contains "${needle}"`, () => {
        expect(read(group.file)).not.toContain(needle);
      });
    }
  });
}

describe('T5 gap 8: scripts/validate-skill.mjs', () => {
  test("registers 'spec-template.md' in both template lists", () => {
    const occurrences = read('scripts/validate-skill.mjs').split("'spec-template.md',").length - 1;
    expect(occurrences).toBe(2);
  });
});
