import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MASTER_NAME, readSkillCorpus, readSkillText } from './skill-corpus.mjs';

let root;

function write(rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-corpus-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readSkillText', () => {
  test('a SKILL.md without references returns its own text', () => {
    write('skills/x/SKILL.md', 'SKILL');
    expect(readSkillText(root, 'skills/x/SKILL.md')).toBe('SKILL');
  });

  test('a SKILL.md appends its references in file name order', () => {
    write('skills/x/SKILL.md', 'SKILL');
    write('skills/x/references/02-b.md', 'b');
    write('skills/x/references/01-a.md', 'a');
    expect(readSkillText(root, 'skills/x/SKILL.md')).toBe('SKILL\na\nb');
  });

  test('a non-markdown file in references is ignored', () => {
    write('skills/x/SKILL.md', 'SKILL');
    write('skills/x/references/01-a.md', 'a');
    write('skills/x/references/notes.txt', 'txt');
    expect(readSkillText(root, 'skills/x/SKILL.md')).toBe('SKILL\na');
  });

  test('a non-SKILL path ignores a sibling references directory', () => {
    write('skills/x/OTHER.md', 'OTHER');
    write('skills/x/references/01-a.md', 'a');
    expect(readSkillText(root, 'skills/x/OTHER.md')).toBe('OTHER');
  });

  test('a missing file throws', () => {
    expect(() => readSkillText(root, 'skills/none/SKILL.md')).toThrow();
  });
});

describe('readSkillCorpus', () => {
  test('includes the reference text of a phase skill', () => {
    write(MASTER_NAME, 'MASTER');
    write('skills/sucp-rules/SKILL.md', 'RULES-INDEX');
    write('skills/sucp-rules/references/01-safety.md', 'RULES-SAFETY');
    expect(readSkillCorpus(root)).toBe('MASTER\nRULES-INDEX\nRULES-SAFETY');
  });
});
