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

describe('symlinks', () => {
  test('a symlinked agent file is scanned like a regular file', () => {
    const target = path.join(tmp, 'target.md');
    fs.writeFileSync(target, '---\nname: linked\n---\nbody\n');
    fs.symlinkSync(target, path.join(agentsDir, 'linked.md'));
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('linked.md') && e.includes('description'))).toBe(true);
  });

  test('a valid symlinked agent file passes', () => {
    const target = path.join(tmp, 'target.md');
    fs.writeFileSync(target, `---\n${VALID}\n---\nbody\n`);
    fs.symlinkSync(target, path.join(agentsDir, 'linked.md'));
    const r = validateAgentsDir(agentsDir, skillsDir);
    expect(r.errors).toEqual([]);
    expect(r.agents).toEqual(['reviewer']);
  });

  test('a dangling symlink is an error naming the file', () => {
    writeAgent('ok.md', VALID);
    fs.symlinkSync(path.join(tmp, 'missing.md'), path.join(agentsDir, 'dangling.md'));
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('dangling.md'))).toBe(true);
  });

  test('a symlinked directory is not followed', () => {
    writeAgent('ok.md', VALID);
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'bad.md'), 'no frontmatter\n');
    fs.symlinkSync(other, path.join(agentsDir, 'linkdir'));
    fs.symlinkSync(agentsDir, path.join(other, 'cycle'));
    const r = validateAgentsDir(agentsDir, skillsDir);
    expect(r.errors).toEqual([]);
  });
});

describe('hooks structure', () => {
  const withHooks = (hooksYaml) => writeAgent('reviewer.md', `${VALID}\nhooks:\n${hooksYaml}`);
  const run = () => validateAgentsDir(agentsDir, skillsDir).errors;

  test('a well-formed hooks block passes', () => {
    withHooks(
      [
        '  PreToolUse:',
        '    - matcher: Bash',
        '      hooks:',
        '        - type: command',
        '          command: ./check.sh',
      ].join('\n'),
    );
    expect(run()).toEqual([]);
  });

  test('hooks must be a mapping', () => {
    writeAgent('reviewer.md', `${VALID}\nhooks:\n  - nope`);
    expect(run().some((e) => e.includes('reviewer.md') && e.includes('hooks') && e.includes('mapping'))).toBe(true);
  });

  test('a lower-camel event name is rejected', () => {
    withHooks(['  preToolUse:', '    - hooks:', '        - type: command', '          command: x'].join('\n'));
    expect(run().some((e) => e.includes('preToolUse'))).toBe(true);
  });

  test('an event value must be an array', () => {
    withHooks(['  PreToolUse:', '    matcher: Bash'].join('\n'));
    expect(run().some((e) => e.includes('hooks.PreToolUse') && e.includes('array'))).toBe(true);
  });

  test('an entry must be an object with a hooks array', () => {
    withHooks(['  PreToolUse:', '    - matcher: Bash'].join('\n'));
    expect(run().some((e) => e.includes('hooks.PreToolUse[0].hooks'))).toBe(true);
  });

  test('matcher must be a string', () => {
    withHooks(
      ['  PreToolUse:', '    - matcher: 5', '      hooks:', '        - type: command', '          command: x'].join('\n'),
    );
    expect(run().some((e) => e.includes('hooks.PreToolUse[0].matcher'))).toBe(true);
  });

  test('a hook needs a string type', () => {
    withHooks(['  PreToolUse:', '    - hooks:', '        - command: x'].join('\n'));
    expect(run().some((e) => e.includes('hooks.PreToolUse[0].hooks[0].type'))).toBe(true);
  });

  test('a command hook needs a non-empty command', () => {
    withHooks(['  PreToolUse:', '    - hooks:', '        - type: command', '          command: ""'].join('\n'));
    expect(run().some((e) => e.includes('hooks.PreToolUse[0].hooks[0].command'))).toBe(true);
  });

  test('a non-command hook does not need a command', () => {
    withHooks(['  PreToolUse:', '    - hooks:', '        - type: prompt'].join('\n'));
    expect(run()).toEqual([]);
  });
});

describe('field value types', () => {
  const check = (line) => {
    writeAgent('reviewer.md', `${VALID}\n${line}`);
    return validateAgentsDir(agentsDir, skillsDir).errors;
  };

  test.each([
    ['tools: 5', 'tools'],
    ['tools:\n  - 1', 'tools'],
    ['disallowedTools: true', 'disallowedTools'],
    ['model: ""', 'model'],
    ['model: 3', 'model'],
    ['permissionMode: yolo', 'permissionMode'],
    ['color: teal', 'color'],
    ['memory: global', 'memory'],
    ['background: "yes"', 'background'],
    ['omitClaudeMd: 1', 'omitClaudeMd'],
    ['effort: extreme', 'effort'],
    ['isolation: container', 'isolation'],
    ['initialPrompt: 7', 'initialPrompt'],
    ['mcpServers: abc', 'mcpServers'],
    ['experimental: [a]', 'experimental'],
  ])('rejects %j', (line, field) => {
    const errors = check(line);
    expect(errors.some((e) => e.includes('reviewer.md') && e.includes(`"${field}"`))).toBe(true);
  });

  test.each([
    'tools: Read, Grep',
    'tools:\n  - Read\n  - Grep',
    'disallowedTools: Bash',
    'model: sonnet',
    'permissionMode: acceptEdits',
    'permissionMode: bypassPermissions',
    'color: cyan',
    'memory: project',
    'background: true',
    'omitClaudeMd: false',
    'effort: xhigh',
    'isolation: worktree',
    'initialPrompt: start here',
    'mcpServers:\n  - github',
    'mcpServers:\n  github:\n    command: x',
    'experimental:\n  flag: true',
  ])('accepts %j', (line) => {
    expect(check(line)).toEqual([]);
  });
});

describe('skills path safety and wording', () => {
  test.each(['../skills/s1', 'a/b', 'a\\b', '..', 'x..y'])('rejects entry %j', (entry) => {
    writeSkill('s1');
    writeAgent('reviewer.md', `${VALID}\nskills:\n  - "${entry.replace(/\\/g, '\\\\')}"`);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('reviewer.md') && e.includes('must not contain'))).toBe(true);
    expect(errors.some((e) => e.includes('has no skills/'))).toBe(false);
  });

  test('the not-found message points at install.sh', () => {
    writeAgent('reviewer.md', `${VALID}\nskills:\n  - ghost`);
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(
      errors.some(
        (e) =>
          e.includes('skill "ghost" has no skills/ghost/SKILL.md in this repository') &&
          e.includes('Claude Code resolves skills from installed locations; run ./install.sh'),
      ),
    ).toBe(true);
  });
});

describe('README handling', () => {
  test('README.md at the top is skipped, not an error', () => {
    writeAgent('reviewer.md', VALID);
    fs.writeFileSync(path.join(agentsDir, 'README.md'), '# Agents\n\nNo frontmatter here.\n');
    const r = validateAgentsDir(agentsDir, skillsDir);
    expect(r.errors).toEqual([]);
    expect(r.agents).toEqual(['reviewer']);
  });

  test('a nested readme.MD is skipped case-insensitively', () => {
    writeAgent('reviewer.md', VALID);
    fs.mkdirSync(path.join(agentsDir, 'sub'));
    fs.writeFileSync(path.join(agentsDir, 'sub', 'readme.MD'), 'docs only\n');
    expect(validateAgentsDir(agentsDir, skillsDir).errors).toEqual([]);
  });

  test('a directory with only README.md has no agent files', () => {
    fs.writeFileSync(path.join(agentsDir, 'README.md'), 'docs\n');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('no agent files found'))).toBe(true);
  });

  test('another file without a name key stays an error', () => {
    writeAgent('notes.md', 'description: Something.');
    const { errors } = validateAgentsDir(agentsDir, skillsDir);
    expect(errors.some((e) => e.includes('notes.md') && e.includes('name'))).toBe(true);
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
