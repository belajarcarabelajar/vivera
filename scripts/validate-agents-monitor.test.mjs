// scripts/validate-agents-monitor.test.mjs
//
// Monitor runs a shell command in the same shell as Bash, so a PreToolUse guard
// whose matcher selects Bash alone is skipped by every Monitor call. Measured
// 2026-10-19: a relative rm that rm-tmp-guard blocked through Bash, and a git
// commit that block-git-writes blocked through Bash, both ran through Monitor.
// validate-agents refuses that matcher; these tests hold it to it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matcherCovers, validateAgentsDir } from './validate-agents.mjs';

let tmp;
let agentsDir;
let skillsDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-agents-monitor-'));
  agentsDir = path.join(tmp, 'agents');
  skillsDir = path.join(tmp, 'skills');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const errorsFor = (hooksYaml) => {
  fs.writeFileSync(
    path.join(agentsDir, 'guarded.md'),
    `---\nname: guarded\ndescription: Has a guard.\nhooks:\n${hooksYaml}\n---\nbody\n`,
  );
  return validateAgentsDir(agentsDir, skillsDir).errors;
};

const guard = (event, matcherLine) =>
  [`  ${event}:`, matcherLine ?? '    - hooks:', ...(matcherLine ? ['      hooks:'] : []),
    '        - type: command', '          command: ./check.sh'].join('\n');

describe('a PreToolUse guard must cover Monitor when it covers Bash', () => {
  test('a matcher of Bash alone is rejected and names the fix', () => {
    const errors = errorsFor(guard('PreToolUse', '    - matcher: Bash'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('hooks.PreToolUse[0].matcher');
    expect(errors[0]).toContain('"Bash|Monitor"');
  });

  test('an anchored regular expression for Bash alone is rejected too', () => {
    expect(errorsFor(guard('PreToolUse', '    - matcher: "^Bash$"'))).toHaveLength(1);
  });

  for (const ok of ['"Bash|Monitor"', '"Monitor|Bash"', '"^(Bash|Monitor)$"', '"Edit|Write"', '"*"']) {
    test(`a matcher of ${ok} passes`, () => {
      expect(errorsFor(guard('PreToolUse', `    - matcher: ${ok}`))).toEqual([]);
    });
  }

  test('an entry without a matcher covers every tool and passes', () => {
    expect(errorsFor(guard('PreToolUse'))).toEqual([]);
  });

  test('a PostToolUse matcher of Bash alone guards nothing and passes', () => {
    expect(errorsFor(guard('PostToolUse', '    - matcher: Bash'))).toEqual([]);
  });

  test('the real sprite crew passes: every generated guard covers Monitor', () => {
    const root = path.join(import.meta.dir, '..');
    expect(validateAgentsDir(path.join(root, '.claude', 'agents'), path.join(root, 'skills')).errors).toEqual([]);
  });
});

describe('matcherCovers reads a matcher the way Claude Code selects tools', () => {
  const cases = [
    [undefined, 'Monitor', true],
    ['', 'Monitor', true],
    ['*', 'Monitor', true],
    ['Bash', 'Bash', true],
    ['Bash', 'Monitor', false],
    ['Bash|Monitor', 'Monitor', true],
    ['Bas', 'Bash', false], // a plain name is exact, not a substring
    ['Bas.', 'Bash', true], // a regular expression is tested unanchored
    ['^Bash$', 'Monitor', false],
    ['^(Bash|Monitor)$', 'Monitor', true],
    ['mcp__.*', 'Bash', false],
    ['(', 'Bash', false], // an invalid expression selects nothing
  ];
  for (const [matcher, tool, want] of cases) {
    test(`${JSON.stringify(matcher)} ${want ? 'covers' : 'does not cover'} ${tool}`, () => {
      expect(matcherCovers(matcher, tool)).toBe(want);
    });
  }
});
