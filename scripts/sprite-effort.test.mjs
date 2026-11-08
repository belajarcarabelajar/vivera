import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planOutputs } from './gen-sprite-agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rolesDir = path.join(ROOT, 'agents', 'roles');
const crewFile = path.join(ROOT, 'agents', 'crew.json');

// A sprite on a model other than the session's does not inherit the session effort, so the role pins it.
const EXPECTED = {
  timid: 'medium',
  aqua: 'medium',
  staid: 'high',
  bold: 'high',
  chef: undefined,
  nappy: undefined,
  hoggy: undefined,
};

function frontmatter(text) {
  const end = text.indexOf('\n---', 4);
  return text.slice(0, end);
}

describe('sprite effort', () => {
  const claude = planOutputs({ rolesDir, crewFile, target: 'claude' });

  for (const [sprite, level] of Object.entries(EXPECTED)) {
    test(`${sprite} ${level === undefined ? 'has no effort key' : `pins effort: ${level}`}`, () => {
      const fm = frontmatter(claude.get(`${sprite}.md`));
      const lines = fm.split('\n').filter((l) => l.startsWith('effort:'));
      if (level === undefined) expect(lines).toEqual([]);
      else expect(lines).toEqual([`effort: ${level}`]);
    });
  }

  for (const target of ['opencode', 'codex', 'cursor', 'copilot', 'antigravity']) {
    test(`${target} renders every sprite without an effort key`, () => {
      const outputs = planOutputs({ rolesDir, crewFile, target });
      expect(outputs.size).toBe(7);
      for (const text of outputs.values()) expect(text).not.toMatch(/^effort\b/m);
    });
  }
});
