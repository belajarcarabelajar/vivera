// scripts/lib/plan-closeout-fixtures.mjs
//
// Test fixtures shared by plan-closeout.test.mjs and plan-closeout-readiness-cli.test.mjs:
// the plan-closeout CLI runner, ultra-plan/v1 plan text for the open step box checks, and
// the tick command readiness prints for open step boxes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plan-closeout.mjs');
export const cli = (args, env) => Bun.spawnSync(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });

export const front = (ids, status = 'Complete') => [
  '---', 'schema: ultra-plan/v1', 'plan_id: demo', `status: ${status}`, 'tasks:',
  ...ids.flatMap((id) => [`  - id: ${id}`, '    depends_on: []', '    skip_if: "test -f marker"']),
  '---',
];
// Shaped like templates/implementation-plan-template.md: every step ticked, open boxes only in sections no task owns.
export const templatePlan = [
  ...front(['T1', 'T2']), '', '# Demo', '',
  '## 1. Acceptance Criteria',
  '- [ ] AC1 the gate reads ticks',
  '- [ ] AC2 nothing else',
  '',
  '### Task T1: first',
  '- [x] Step 1 write the test',
  '- [X] Step 2 run it',
  '',
  '### Task T2: second',
  '- [x] Step 1 done',
  '',
  '## 8. Approval',
  '- [ ] Approved by the owner',
  '',
].join('\n');

export const tickFor = (file) => `bun scripts/plan-closeout.mjs --readiness ${file} --evidence readiness.log; bun scripts/plan-mark-done.mjs ${file} --from readiness.log`;
