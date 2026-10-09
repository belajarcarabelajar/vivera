import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_FIELDS, validateAgentsDir } from './validate-agents.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validate-agents.mjs');

let tmp;
let agentsDir;
let skillsDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-agents-'));
  agentsDir = path.join(tmp, 'agents');
  skillsDir = path.join(tmp, 'skills');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeAgent(file, frontmatter, body = 'You are a helper.\n') {
  const full = path.join(agentsDir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\n${frontmatter}\n---\n${body}`);
  return full;
}

function writeSkill(name) {
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, name, 'SKILL.md'), '---\nname: x\n---\n');
}

const VALID = 'name: reviewer\ndescription: Reviews diffs for correctness.';

describe('validateAgentsDir', () => {
  test('a valid agent passes and is listed', () => {
    writeAgent('reviewer.md', VALID);
    const r = validateAgentsDir(agentsDir, skillsDir);
    expect(r.errors).toEqual([]);
    expect(r.agents).toEqual(['reviewer']);
  });

  test('a fully populated valid agent passes', () => {
    writeSkill('alpha');
    writeAgent(
      'full.md',
      [
        'name: full',
        'description: Everything set.',
        'tools: Read, Grep',
        'model: sonnet',
        'maxTurns: 12',
        'skills:',
        '  - alpha',
      ].join('\n'),
    );
    expect(validateAgentsDir(agentsDir, skillsDir).errors).toEqual([]);
  });

  test('the allowed field list is exported and pinned', () => {
    expect(ALLOWED_FIELDS).toContain('maxTurns');
    expect(ALLOWED_FIELDS).toContain('disallowedTools');
    expect(ALLOWED_FIELDS).not.toContain('maxTurn');
    expect(ALLOWED_FIELDS.length).toBe(18);
  });

  test('an unknown field is rejected and named', () => {
    writeAgent('reviewer.md', `${VALID}\nmaxTurn: 5`);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('reviewer.md');
    expect(errors[0]).toContain('maxTurn');
  });

  test('field names are case-sensitive', () => {
    writeAgent('reviewer.md', `${VALID}\nMaxTurns: 5`);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('MaxTurns'))).toBe(true);
  });

  test('missing description is an error', () => {
    writeAgent('reviewer.md', 'name: reviewer');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('reviewer.md') && e.includes('description'))).toBe(true);
  });

  test('empty description is an error', () => {
    writeAgent('reviewer.md', 'name: reviewer\ndescription: ""');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('description'))).toBe(true);
  });

  test('missing name is an error', () => {
    writeAgent('reviewer.md', 'description: Something.');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('reviewer.md') && e.includes('name'))).toBe(true);
  });

  test('a name containing a colon is an error', () => {
    writeAgent('reviewer.md', 'name: "ns:reviewer"\ndescription: Reviews.');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('reviewer.md') && e.includes(':'))).toBe(true);
  });

  test('a name starting with a dash is an error', () => {
    writeAgent('reviewer.md', 'name: "-reviewer"\ndescription: Reviews.');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('reviewer.md') && e.includes('-'))).toBe(true);
  });

  test('a name over 256 characters is an error', () => {
    writeAgent('reviewer.md', `name: ${'a'.repeat(257)}\ndescription: Reviews.`);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('256'))).toBe(true);
  });

  test('a non-string name is an error', () => {
    writeAgent('reviewer.md', 'name: 42\ndescription: Reviews.');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('name') && e.includes('string'))).toBe(true);
  });

  test('duplicate names name both files', () => {
    writeAgent('a.md', VALID);
    writeAgent('b.md', VALID);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    const dup = errors.find((e) => e.includes('duplicate'));
    expect(dup).toBeDefined();
    expect(dup).toContain('a.md');
    expect(dup).toContain('b.md');
  });

  test('a skills entry with no SKILL.md is an error', () => {
    writeAgent('reviewer.md', `${VALID}\nskills:\n  - ghost`);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('reviewer.md') && e.includes('ghost'))).toBe(true);
  });

  test('skills must be a list of strings', () => {
    writeAgent('reviewer.md', `${VALID}\nskills: alpha`);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('skills') && e.includes('list'))).toBe(true);
  });

  test('an existing skills entry passes', () => {
    writeSkill('alpha');
    writeAgent('reviewer.md', `${VALID}\nskills:\n  - alpha`);
    expect(validateAgentsDir(agentsDir, skillsDir).errors).toEqual([]);
  });

  test('a file with no frontmatter first line is an error', () => {
    fs.writeFileSync(path.join(agentsDir, 'doc.md'), '# Just docs\n\n---\nname: x\n---\n');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('doc.md') && e.includes('---'))).toBe(true);
  });

  test('unclosed frontmatter is an error', () => {
    fs.writeFileSync(path.join(agentsDir, 'open.md'), '---\nname: open\ndescription: x\n');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('open.md') && e.includes('closed'))).toBe(true);
  });

  test('zero agent files is an error', () => {
    const { errors, agents } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('no agent files found'))).toBe(true);
    expect(agents).toEqual([]);
  });

  test('a missing directory is an error', () => {
    const { errors } = validateAgentsDir(path.join(tmp, 'nope'), skillsDir);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('nope');
  });

  test('agent files in subdirectories are scanned', () => {
    writeAgent('nested/deep.md', VALID);
    const r = validateAgentsDir(agentsDir, skillsDir);
    expect(r.errors).toEqual([]);
    expect(r.agents).toEqual(['reviewer']);
  });

  test('invalid YAML is an error naming the file', () => {
    writeAgent('broken.md', 'name: [unclosed\ndescription: x: y: z');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('broken.md') && e.includes('YAML'))).toBe(true);
  });

  test('maxTurns that is not an integer is an error', () => {
    writeAgent('reviewer.md', `${VALID}\nmaxTurns: 2.5`);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('maxTurns'))).toBe(true);
  });

  test('maxTurns that is zero or a string is an error', () => {
    writeAgent('a.md', 'name: a\ndescription: x\nmaxTurns: 0');
    writeAgent('b.md', 'name: b\ndescription: x\nmaxTurns: "5"');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.filter((e) => e.includes('maxTurns')).length).toBe(2);
  });

  test('errors from several files are all reported', () => {
    writeAgent('a.md', 'name: a');
    writeAgent('b.md', 'description: x');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('CLI', () => {
  function run() {
    return Bun.spawnSync(['bun', SCRIPT, agentsDir, skillsDir]);
  }

  test('exits 0 and prints the count on success', () => {
    writeAgent('reviewer.md', VALID);
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('agents OK: 1 agent(s)');
  });

  test('exits 1 and prints file-prefixed errors on stderr', () => {
    writeAgent('reviewer.md', `${VALID}\nmaxTurn: 5`);
    const r = run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('reviewer.md');
    expect(r.stdout.toString()).not.toContain('agents OK');
  });
});
