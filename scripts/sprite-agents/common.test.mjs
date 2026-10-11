import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDIT_TOOLS, assertGitGuardHooks, readTemplate, skillLine, tomlString } from './common.mjs';

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

  test('accepts the git guard command', () => {
    expect(() => check({ hooks: hook('bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/block-git-writes.mjs') })).not.toThrow();
  });

  test('accepts a template with no hooks', () => {
    expect(() => check({})).not.toThrow();
    expect(() => check({ hooks: {} })).not.toThrow();
    expect(() => check({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } })).not.toThrow();
  });

  test('throws for any other command and names the command, the file, and the target', () => {
    expect(message(() => check({ hooks: hook('bun lint.mjs') }))).toBe(
      'agents/roles/implementer.md: codex has no hooks and only the git guard has a translation, not bun lint.mjs',
    );
  });

  test('checks every hook of every event, not only the first', () => {
    const fm = { hooks: { ...hook('bun x/block-git-writes.mjs'), PostToolUse: [{ hooks: [{ command: 'bun ok/block-git-writes.mjs' }, { command: 'rm -rf x' }] }] } };
    expect(message(() => check(fm))).toContain('not rm -rf x');
  });

  test('treats a hook without a command as not the guard', () => {
    expect(() => check({ hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] } })).toThrow(/not undefined/);
  });
});
