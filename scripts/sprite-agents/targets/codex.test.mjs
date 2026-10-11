import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillLine } from '../common.mjs';
import { capitalize, loadCrewPlan, splitFrontmatter } from '../crew.mjs';
import { proseGuard } from '../guard.mjs';
import { TARGETS, targetIds } from '../registry.mjs';
import { MARKER, syncDir } from '../sync.mjs';
import { planOutputs } from '../../gen-sprite-agents.mjs';
import codex from './codex.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GEN = path.join(ROOT, 'scripts', 'gen-sprite-agents.mjs');
const ROLES = path.join(ROOT, 'agents', 'roles');
const CREW = path.join(ROOT, 'agents', 'crew.json');

// Keys a Codex custom agent file may hold are listed on the subagents page;
// these four are the only ones this renderer writes. maxTurns and model have none here.
const PINNED_KEYS = ['name', 'description', 'developer_instructions', 'sandbox_mode'];
const READ_ONLY = ['timid', 'aqua', 'staid'];
const WRITERS = ['chef', 'nappy', 'hoggy', 'bold'];
const SKILL_HOW = 'by naming it with a $ mention';

const plan = loadCrewPlan({ rolesDir: ROLES, crewFile: CREW });
const render = (template, member = { sprite: 'chef', role: 'implementer', color: 'red' }) => codex.render(template, member, {});
const message = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  return undefined;
};
const tpl = (body, head = '') => `---\ndescription: Does one thing.\n${head}---\n${body}`;
const bodyOf = (template) => splitFrontmatter(template, 'x').body.replace(/^\n+/, '');

let tmp;
let out;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-target-'));
  out = path.join(tmp, 'out');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('codex target', () => {
  test('is registered as a .toml target that needs --out', () => {
    expect(targetIds()).toContain('codex');
    expect(TARGETS.codex).toBe(codex);
    expect([codex.id, codex.ext, codex.outName('chef'), codex.requiresOut]).toEqual(['codex', '.toml', 'chef.toml', true]);
  });

  describe('every sprite of the real crew', () => {
    for (const { member, template } of plan) {
      describe(member.sprite, () => {
        const text = render(template, member);
        const parsed = Bun.TOML.parse(text);

        test('is valid TOML with only the pinned keys, and the required three', () => {
          for (const key of Object.keys(parsed)) expect(PINNED_KEYS).toContain(key);
          for (const key of ['name', 'description', 'developer_instructions']) expect(typeof parsed[key]).toBe('string');
        });

        test('names the sprite and describes its role', () => {
          expect(parsed.name).toBe(member.sprite);
          expect(parsed.description.startsWith(`${capitalize(member.sprite)}, a Harvest Sprite on the ${member.role} crew`)).toBe(true);
        });

        test('sets sandbox_mode read-only for a read-only role and leaves it out for a writer', () => {
          if (READ_ONLY.includes(member.sprite)) expect(parsed.sandbox_mode).toBe('read-only');
          else {
            expect(WRITERS).toContain(member.sprite);
            expect('sandbox_mode' in parsed).toBe(false);
          }
        });

        test('carries the guard paragraph, the skill line, and the template body', () => {
          expect(parsed.developer_instructions).toContain(proseGuard().paragraph);
          const skills = Bun.YAML.parse(splitFrontmatter(template, 'x').head.join('\n')).skills ?? [];
          if (skills.length > 0) expect(parsed.developer_instructions).toContain(skillLine(skills, SKILL_HOW));
          expect(parsed.developer_instructions.endsWith(bodyOf(template))).toBe(true);
        });

        test('starts with the marker line and then the guard comment', () => {
          const lines = text.split('\n');
          expect(lines[0].startsWith(MARKER)).toBe(true);
          expect(lines[1]).toBe(proseGuard().comment);
        });
      });
    }

    test('the crew has the read-only and writer sprites the tests above name', () => {
      expect(plan.map((p) => p.member.sprite).sort()).toEqual([...READ_ONLY, ...WRITERS].sort());
    });
  });

  describe('output shape', () => {
    test('writes the keys in the documented order and closes the multi-line string', () => {
      const text = render(tpl('\nBody.\n', 'tools: Read\n'));
      const lines = text.split('\n');
      expect(lines.slice(2, 6).map((l) => l.split(' = ')[0])).toEqual(['name', 'description', 'sandbox_mode', 'developer_instructions']);
      expect(lines[5]).toBe("developer_instructions = '''");
      expect(text.endsWith("Body.\n'''\n")).toBe(true);
    });

    test('puts the skill line, the guard, and the body in that order, one blank line apart', () => {
      const text = render(tpl('\nBody.\n', 'skills:\n  - sucp-tdd-debug\n'));
      const inner = Bun.TOML.parse(text).developer_instructions;
      expect(inner).toBe(`${skillLine(['sucp-tdd-debug'], SKILL_HOW)}\n\n${proseGuard().paragraph}\n\nBody.\n`);
    });

    test('leaves the skill line out when the template names no skill', () => {
      const inner = Bun.TOML.parse(render(tpl('\nBody.\n'))).developer_instructions;
      expect(inner).toBe(`${proseGuard().paragraph}\n\nBody.\n`);
    });

    test('ends the string on its own line even when the body has no final newline', () => {
      const text = render(tpl('Body without newline'));
      expect(text.endsWith("Body without newline\n'''\n")).toBe(true);
      expect(Bun.TOML.parse(text).developer_instructions.endsWith('Body without newline\n')).toBe(true);
    });

    test('keeps backslashes and quotes in the body exactly, since a literal string has no escapes', () => {
      const body = 'Path C:\\dir\\new and "quoted" and \'single\' and \\n stays two characters.\n';
      expect(Bun.TOML.parse(render(tpl(`\n${body}`))).developer_instructions.endsWith(body)).toBe(true);
    });

    test('escapes a quote and a backslash in the description', () => {
      const text = render('---\ndescription: \'Say "hi" \\ here.\'\n---\nbody\n');
      expect(Bun.TOML.parse(text).description).toBe('Chef, a Harvest Sprite on the implementer crew. Say "hi" \\ here.');
    });

    test('writes no model, no maxTurns, and no steps, since Codex has no turn limit key', () => {
      const text = render(tpl('\nBody.\n', 'maxTurns: 5\n'));
      expect(Object.keys(Bun.TOML.parse(text)).sort()).toEqual(['description', 'developer_instructions', 'name']);
      expect(text).not.toMatch(/^(model|maxTurns|steps)\b/m);
    });
  });

  describe('refusals', () => {
    test('throws when the body holds three single quotes, which would end the literal string', () => {
      const msg = message(() => render(tpl("\nIt's ''' broken.\n")));
      expect(msg).toContain('agents/roles/implementer.md');
      expect(msg).toContain("'''");
    });

    test('accepts one or two single quotes in a row', () => {
      expect(() => render(tpl("\nIt's '' fine.\n"))).not.toThrow();
    });

    test('throws when the body holds a control character a literal string cannot hold', () => {
      expect(message(() => render(tpl('\nbell\u0007\n')))).toContain('control character');
    });

    test('throws for a lone carriage return, which TOML rejects, and names the template', () => {
      const msg = message(() => render(tpl('\nline one\rline two\n')));
      expect(msg).toContain('agents/roles/implementer.md');
      expect(msg).toContain('carriage return');
      expect(message(() => render(tpl('\nline one\r\r\nline two\n')))).toContain('carriage return');
    });

    test('turns CRLF line endings into LF, so the file parses as TOML', () => {
      const text = render(tpl('\nline one\r\nline two\r\n'));
      expect(text).not.toContain('\r');
      expect(Bun.TOML.parse(text).developer_instructions.endsWith('line one\nline two\n')).toBe(true);
      const whole = render(tpl('\nline one\nline two\n').replaceAll('\n', '\r\n'));
      expect(Bun.TOML.parse(whole).developer_instructions.endsWith('line one\nline two\n')).toBe(true);
    });

    test('throws for a hook that is not the git guard', () => {
      const head = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: bun lint.mjs\n';
      expect(message(() => render(tpl('\nBody.\n', head)))).toMatch(/codex has no hooks.*lint\.mjs/);
    });

    test('accepts the git guard hook and writes the prose guard for it', () => {
      const head = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/block-git-writes.mjs\n';
      expect(Bun.TOML.parse(render(tpl('\nBody.\n', head))).developer_instructions).toContain(proseGuard().paragraph);
    });

    test('throws for a template key it cannot translate', () => {
      expect(message(() => render(tpl('\nBody.\n', 'model: sonnet\n')))).toContain('"model" has no codex translation in scripts/sprite-agents/targets/codex.mjs');
    });
  });
});

describe('codex through the generator', () => {
  const gen = (...args) => Bun.spawnSync(['bun', GEN, ...args], { cwd: ROOT });
  const text = (buf) => buf.toString();
  const sprites = plan.map((p) => p.member.sprite);

  test('planOutputs returns one <sprite>.toml per sprite', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'codex' });
    expect([...outputs.keys()].sort()).toEqual(sprites.map((s) => `${s}.toml`).sort());
    expect(outputs.size).toBe(7);
  });

  test('syncDir with ext .toml writes them once, then nothing, and shows no drift', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'codex' });
    expect(syncDir(out, outputs, { ext: '.toml' }).written).toHaveLength(7);
    expect(syncDir(out, outputs, { ext: '.toml' }).written).toEqual([]);
    expect(syncDir(out, outputs, { ext: '.toml', check: true }).drift).toEqual([]);
  });

  test('the CLI writes 7 files, a second run writes none, and --clean removes them but not a hand-written one', () => {
    const first = gen('--target', 'codex', '--out', out);
    expect(first.exitCode).toBe(0);
    expect(text(first.stdout)).toContain('7 written');
    expect(fs.readdirSync(out).filter((f) => f.endsWith('.toml'))).toHaveLength(7);

    const second = gen('--target', 'codex', '--out', out);
    expect(second.exitCode).toBe(0);
    expect(text(second.stdout)).toContain('0 written, 0 removed');

    expect(gen('--target', 'codex', '--out', out, '--check').exitCode).toBe(0);

    fs.writeFileSync(path.join(out, 'mine.toml'), 'name = "mine"\n');
    const clean = gen('--target', 'codex', '--out', out, '--clean');
    expect(clean.exitCode).toBe(0);
    expect(text(clean.stdout)).toContain('7 generated file(s) removed');
    expect(fs.readdirSync(out)).toEqual(['mine.toml']);
  });

  test('--target codex without --out exits 1', () => {
    const r = gen('--target', 'codex');
    expect(r.exitCode).toBe(1);
    expect(text(r.stderr)).toContain('--out');
  });
});
