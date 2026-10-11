import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDIT_TOOLS, assertGitGuardHooks, readTemplate, skillLine, tomlString } from './common.mjs';
import { TARGETS } from './registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const role = (name) => fs.readFileSync(path.join(ROOT, 'agents', 'roles', `${name}.md`), 'utf8');

const ALLOWED = ['description', 'tools', 'skills', 'maxTurns', 'hooks'];
const timid = { sprite: 'timid', role: 'researcher', color: 'green' };
const chef = { sprite: 'chef', role: 'implementer', color: 'red' };
const read = (template, member = chef, extra = {}) => readTemplate(template, member, { allowedKeys: ALLOWED, target: 'cursor', ...extra });
const message = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  return undefined;
};
const withHead = (head) => `---\ndescription: Does one thing.\n${head}\n---\nbody\n`;

describe('EDIT_TOOLS', () => {
  test('lists the four tools that change files', () => {
    expect(EDIT_TOOLS).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  });
});

describe('readTemplate', () => {
  test('names the key, the target, and the file to extend when a key has no translation', () => {
    expect(message(() => read(withHead('model: sonnet'), chef, { allowedKeys: ['description'] }))).toBe(
      'agents/roles/implementer.md: "model" has no cursor translation in scripts/sprite-agents/targets/cursor.mjs; add one before using it',
    );
  });

  test('uses the given template label in every message', () => {
    const label = 'custom/label.md';
    expect(message(() => read(withHead('model: x'), chef, { allowedKeys: ['description'], templateLabel: label }))).toStartWith(`${label}: "model"`);
    expect(message(() => read('---\ntools: Read\n---\nbody\n', chef, { templateLabel: label }))).toBe(`${label}: "description" is required`);
    expect(message(() => read('no frontmatter', chef, { templateLabel: label }))).toStartWith(`${label}: no frontmatter`);
  });

  test('accepts every key it was allowed', () => {
    const template = withHead('tools: Read\nskills:\n  - s\nmaxTurns: 3\nhooks: {}');
    expect(() => read(template)).not.toThrow();
  });

  test('throws when the description is missing, blank, or not a string', () => {
    for (const head of ['---\ntools: Read\n---\nb\n', '---\ndescription: "   "\n---\nb\n', '---\ndescription: 5\n---\nb\n', '---\n---\nb\n']) {
      expect(message(() => read(head))).toBe('agents/roles/implementer.md: "description" is required');
    }
  });

  test('prefixes the description with the sprite, its role, and the crew line, and trims the template text', () => {
    const { description } = read(role('researcher'), timid);
    expect(description.startsWith('Timid, a Harvest Sprite on the researcher crew. Researcher that investigates')).toBe(true);
    expect(read('---\ndescription: "  padded  "\n---\nb\n').description).toBe('Chef, a Harvest Sprite on the implementer crew. padded');
  });

  test('returns the parsed frontmatter and the body after it', () => {
    const r = read(withHead('maxTurns: 7'));
    expect(r.fm.maxTurns).toBe(7);
    expect(r.body).toBe('body\n');
  });

  test('normalizes tools given as a comma string or as a list', () => {
    expect(read(withHead('tools: Read, Grep')).tools).toEqual(['Read', 'Grep']);
    expect(read(withHead('tools: [Read, Grep]')).tools).toEqual(['Read', 'Grep']);
    expect(read(withHead('tools: " Read ,Grep "')).tools).toEqual(['Read', 'Grep']);
  });

  test('a read-only role has tools and no edit tool', () => {
    const r = read(role('researcher'), timid);
    expect(r.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'mcp__tinyfish']);
    expect(r.readOnly).toBe(true);
  });

  test('a role without a tools key has tools undefined and is not read-only', () => {
    const r = read(role('implementer'));
    expect(r.tools).toBeUndefined();
    expect(r.readOnly).toBe(false);
    expect(read(withHead('tools:')).tools).toBeUndefined();
  });

  test('any single edit tool makes a role writable', () => {
    for (const tool of EDIT_TOOLS) expect(read(withHead(`tools: Read, ${tool}`)).readOnly).toBe(false);
  });

  test('an empty tools list is read-only', () => {
    expect(read(withHead('tools: []')).readOnly).toBe(true);
  });

  test('returns the skills list, empty when the template names none', () => {
    expect(read(role('researcher'), timid).skills).toEqual(['sucp-brainstorm']);
    expect(read(withHead('skills:\n  - a\n  - b')).skills).toEqual(['a', 'b']);
    expect(read(withHead('maxTurns: 3')).skills).toEqual([]);
  });

  test('takes a skill given as one name as a list of one, and an empty skills key as none', () => {
    expect(read(withHead('skills: sucp-tdd-debug')).skills).toEqual(['sucp-tdd-debug']);
    expect(read(withHead('skills: "sucp-tdd-debug"')).skills).toEqual(['sucp-tdd-debug']);
    expect(read(withHead('skills:')).skills).toEqual([]);
    expect(read(withHead('skills: []')).skills).toEqual([]);
  });

  test('rejects skills that are neither a name nor a list of names, instead of dropping them', () => {
    for (const skills of ['skills: 5', 'skills: true', 'skills: { a: b }', 'skills: [1]', 'skills: [a, { b: c }]', 'skills: ""', 'skills: ["a", ""]']) {
      expect(message(() => read(withHead(skills)))).toBe('agents/roles/implementer.md: "skills" must be a skill name or a list of skill names');
    }
  });

  test('rejects a maxTurns that is not a positive integer', () => {
    for (const turns of ['maxTurns: "40"', 'maxTurns: 40.5', 'maxTurns: -5', 'maxTurns: 0', 'maxTurns:', 'maxTurns: true']) {
      expect(message(() => read(withHead(turns)))).toBe('agents/roles/implementer.md: "maxTurns" must be a positive integer');
    }
    expect(read(withHead('maxTurns: 1')).fm.maxTurns).toBe(1);
  });

  test('every target built on it rejects a bad maxTurns and a bad skills shape', () => {
    for (const id of ['codex', 'opencode', 'antigravity', 'copilot', 'cursor']) {
      expect(() => TARGETS[id].render(withHead('maxTurns: "40"'), chef, {})).toThrow(/"maxTurns" must be a positive integer/);
      expect(() => TARGETS[id].render(withHead('skills: { a: b }'), chef, {})).toThrow(/"skills" must be/);
    }
  });

  test('every target built on it keeps a skill given as one name', () => {
    for (const id of ['codex', 'opencode', 'antigravity', 'copilot', 'cursor']) {
      expect(TARGETS[id].render(withHead('skills: sucp-tdd-debug'), chef, {})).toContain('`sucp-tdd-debug`');
    }
  });
});

describe('skillLine', () => {
  test('is empty when there is no skill', () => {
    expect(skillLine([], 'with the skill tool')).toBe('');
  });

  test('names each skill in backticks and says how to load them', () => {
    expect(skillLine(['sucp-tdd-debug'], 'with the skill tool')).toBe(
      'Load the `sucp-tdd-debug` skill with the skill tool before anything else; it holds the rules of your phase.',
    );
    expect(skillLine(['a', 'b'], 'by reading its SKILL.md')).toBe(
      'Load the `a`, `b` skill by reading its SKILL.md before anything else; it holds the rules of your phase.',
    );
  });
});

describe('tomlString', () => {
  test('wraps a plain string in double quotes', () => {
    expect(tomlString('plain text')).toBe('"plain text"');
  });

  test('escapes a quote and a backslash', () => {
    expect(tomlString('say "hi" \\ done')).toBe('"say \\"hi\\" \\\\ done"');
  });

  test('reads back as the same string for quotes, backslashes, newlines, tabs, control characters, and non-ASCII', () => {
    for (const s of ['say "hi" \\ done', 'a\nb\tc', 'bell\u0007 del\u007f nul\u0000', 'caf\u00e9 \u4e2d\u6587 \u{1f600}', '', 'C:\\dir\\new']) {
      expect(Bun.TOML.parse(`v = ${tomlString(s)}`).v).toBe(s);
    }
  });

  test('refuses a value that is not a string', () => {
    expect(() => tomlString(5)).toThrow(/string/);
  });
});

describe('assertGitGuardHooks', () => {
  const hook = (command) => ({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] });
  const check = (fm) => assertGitGuardHooks(fm, { templateLabel: 'agents/roles/implementer.md', target: 'codex' });

  const GUARD = 'bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/block-git-writes.mjs';

  test('accepts the git guard command, and the one in every real role is that exact string', () => {
    expect(() => check({ hooks: hook(GUARD) })).not.toThrow();
    for (const name of ['implementer', 'researcher', 'reviewer', 'debugger']) {
      expect(read(role(name)).fm.hooks.PreToolUse[0].hooks[0].command).toBe(GUARD);
    }
  });

  test('says whether the guard is there, so a target emits its rules only for a guarded role', () => {
    expect(check({ hooks: hook(GUARD) })).toBe(true);
    for (const fm of [{}, { hooks: {} }, { hooks: null }, { hooks: { PreToolUse: [] } }, { hooks: { PreToolUse: [{ matcher: 'Bash' }] } }]) {
      expect(check(fm)).toBe(false);
    }
  });

  test('accepts a template with no hooks', () => {
    expect(() => check({})).not.toThrow();
    expect(() => check({ hooks: {} })).not.toThrow();
    expect(() => check({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } })).not.toThrow();
  });

  test('rejects a command that only mentions the guard script, however it is dressed', () => {
    for (const command of ['rm -rf ~ # block-git-writes.mjs', `${GUARD} && rm -rf ~`, `echo ${GUARD}`, GUARD.replace('bun', 'node'), `${GUARD} `, 'bun other/block-git-writes.mjs']) {
      expect(message(() => check({ hooks: hook(command) }))).toBe(`agents/roles/implementer.md: codex has no hooks and only the git guard has a translation, not ${command}`);
    }
  });

  test('rejects hooks that are not a mapping of event to entry lists', () => {
    for (const hooks of ['x', 5, ['a'], { PreToolUse: 'x' }, { PreToolUse: [{ hooks: 'x' }] }]) {
      expect(message(() => check({ hooks }))).toBe('agents/roles/implementer.md: "hooks" must map each event to a list of entries that each hold a list of hooks');
    }
  });

  test('throws for any other command and names the command, the file, and the target', () => {
    expect(message(() => check({ hooks: hook('bun lint.mjs') }))).toBe(
      'agents/roles/implementer.md: codex has no hooks and only the git guard has a translation, not bun lint.mjs',
    );
  });

  test('checks every hook of every event, not only the first', () => {
    const fm = { hooks: { ...hook(GUARD), PostToolUse: [{ hooks: [{ command: GUARD }, { command: 'rm -rf x' }] }] } };
    expect(message(() => check(fm))).toContain('not rm -rf x');
  });

  test('treats a hook without a command as not the guard', () => {
    expect(() => check({ hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] } })).toThrow(/not undefined/);
  });
});
