import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Measured wording (plan 2026-11-26-advisor-timing, T1): frontmatter disallowedTools did not remove the
// advisor from a custom agent, while this role-card line stopped the call. Keep it byte for byte.
const ADVISOR_LINE =
  '- Never call the advisor tool: the approach was settled before the plan was approved, and the parent session consults the advisor at a bottleneck. If you are stuck, report the blocker to the parent instead.';

const crew = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'crew.json'), 'utf8'));
const roles = [...new Set(crew.map((m) => m.role))];

function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n');
}

describe('sprites never call the advisor', () => {
  test('the crew is not empty', () => {
    expect(crew.length).toBeGreaterThan(0);
  });

  for (const role of roles) {
    test(`role source ${role}.md carries the advisor line`, () => {
      expect(lines(path.join(ROOT, 'agents', 'roles', `${role}.md`))).toContain(ADVISOR_LINE);
    });
  }

  for (const { sprite } of crew) {
    test(`generated .claude/agents/${sprite}.md carries the advisor line`, () => {
      expect(lines(path.join(ROOT, '.claude', 'agents', `${sprite}.md`))).toContain(ADVISOR_LINE);
    });
  }
});
