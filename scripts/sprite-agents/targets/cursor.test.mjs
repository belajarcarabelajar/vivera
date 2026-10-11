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
import cursor from './cursor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GEN = path.join(ROOT, 'scripts', 'gen-sprite-agents.mjs');
const ROLES = path.join(ROOT, 'agents', 'roles');
const CREW = path.join(ROOT, 'agents', 'crew.json');

// The frontmatter keys the Cursor subagents page documents are name, description,
// model, readonly, and is_background. These four are the only ones written here.
const PINNED_KEYS = ['name', 'description', 'model', 'readonly'];
const READ_ONLY = ['timid', 'aqua', 'staid'];
const WRITERS = ['chef', 'nappy', 'hoggy', 'bold'];
const SKILL_HOW = 'from your skills';

const plan = loadCrewPlan({ rolesDir: ROLES, crewFile: CREW });
const chef = { sprite: 'chef', role: 'implementer', color: 'red' };
const render = (template, member = chef) => cursor.render(template, member, {});
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
// The lines between the first two "---" lines, comments included, and the text after.
const split = (text) => {
  const lines = text.split('\n');
  const end = lines.indexOf('---', 1);
  return { head: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
};
const frontmatter = (text) => Bun.YAML.parse(split(text).head.join('\n'));

let tmp;
let out;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-target-'));
  out = path.join(tmp, 'out');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cursor target', () => {
  test('is registered as a flat .md target that needs --out', () => {
    expect(targetIds()).toContain('cursor');
    expect(TARGETS.cursor).toBe(cursor);
    expect([cursor.id, cursor.ext, cursor.outName('chef'), cursor.requiresOut]).toEqual(['cursor', '.md', 'chef.md', true]);
  });

  describe('every sprite of the real crew', () => {
    for (const { member, template } of plan) {
      describe(member.sprite, () => {
        const text = render(template, member);
        const fm = frontmatter(text);

        test('has frontmatter that parses with the comment lines in it, and only the pinned keys', () => {
          for (const key of Object.keys(fm)) expect(PINNED_KEYS).toContain(key);
          expect(text.startsWith('---\n')).toBe(true);
        });

        test('names the sprite, inherits the model, and describes its role', () => {
          expect(fm.name).toBe(member.sprite);
          expect(fm.model).toBe('inherit');
          expect(fm.description.startsWith(`${capitalize(member.sprite)}, a Harvest Sprite on the ${member.role} crew`)).toBe(true);
        });

        test('sets readonly true for a read-only role and leaves the key out for a writer', () => {
          if (READ_ONLY.includes(member.sprite)) expect(fm.readonly).toBe(true);
          else {
            expect(WRITERS).toContain(member.sprite);
            expect('readonly' in fm).toBe(false);
          }
        });

        test('keeps the marker line and then the guard comment inside the frontmatter', () => {
          const { head } = split(text);
          const marker = head.findIndex((l) => l.startsWith(MARKER));
          expect(marker).toBeGreaterThan(-1);
          expect(head[marker + 1]).toBe(proseGuard().comment);
          expect(split(text).body.includes(MARKER)).toBe(false);
        });

        test('carries the skill line, the guard paragraph, and the template body, and ends with one newline', () => {
          const { body } = split(text);
          expect(body).toContain(proseGuard().paragraph);
          const skills = Bun.YAML.parse(splitFrontmatter(template, 'x').head.join('\n')).skills ?? [];
          if (skills.length > 0) expect(body).toContain(skillLine(skills, SKILL_HOW));
          expect(body.endsWith(bodyOf(template))).toBe(true);
          expect(text.endsWith('\n')).toBe(true);
          expect(text.endsWith('\n\n')).toBe(false);
        });
      });
    }

    test('the crew has the read-only and writer sprites the tests above name', () => {
      expect(plan.map((p) => p.member.sprite).sort()).toEqual([...READ_ONLY, ...WRITERS].sort());
    });
  });

  describe('output shape', () => {
    test('writes a read-only sprite with skills exactly in the documented order', () => {
      const guard = proseGuard();
      const expected = [
        '---',
        'name: chef',
        'description: "Chef, a Harvest Sprite on the implementer crew. Does one thing."',
        'model: inherit',
        'readonly: true',
        `${MARKER} from agents/roles/implementer.md and agents/crew.json; edit those, then run ./install.sh.`,
        guard.comment,
        '---',
        '',
        skillLine(['sucp-tdd-debug'], SKILL_HOW),
        '',
        guard.paragraph,
        '',
        'Body.',
        '',
      ].join('\n');
      expect(render(tpl('\nBody.\n', 'tools: Read\nskills:\n  - sucp-tdd-debug\n'))).toBe(expected);
    });

    test('leaves out readonly and the skill line for a writer without skills', () => {
      const text = render(tpl('\nBody.\n'));
      expect(split(text).head.some((l) => l.startsWith('readonly'))).toBe(false);
      expect(split(text).body).toBe(`\n${proseGuard().paragraph}\n\nBody.\n`);
    });

    test('puts one blank line before the body however many the template has, and ends with one newline', () => {
      expect(split(render(tpl('\n\n\nBody.\n\n\n'))).body.endsWith(`${proseGuard().paragraph}\n\nBody.\n`)).toBe(true);
      expect(split(render(tpl('Body without newline'))).body.endsWith('\n\nBody without newline\n')).toBe(true);
    });

    test('writes no model other than inherit, no maxTurns, no steps, and no tools key', () => {
      const text = render(tpl('\nBody.\n', 'maxTurns: 5\ntools: Read, Grep\n'));
      expect(Object.keys(frontmatter(text)).sort()).toEqual(['description', 'model', 'name', 'readonly']);
      expect(text).not.toMatch(/^(maxTurns|steps|tools)\b/m);
    });

    test('quotes the description so a colon, a hash, a quote, or a backslash cannot change the YAML', () => {
      const text = render('---\ndescription: \'Use: this # that, "quoted" and \\ slash.\'\n---\nbody\n');
      expect(frontmatter(text).description).toBe('Chef, a Harvest Sprite on the implementer crew. Use: this # that, "quoted" and \\ slash.');
    });
  });

  describe('refusals', () => {
    test('throws for a hook that is not the git guard', () => {
      const head = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: bun lint.mjs\n';
      expect(message(() => render(tpl('\nBody.\n', head)))).toMatch(/cursor has no hooks.*lint\.mjs/);
    });

    test('accepts the git guard hook and writes the prose guard for it', () => {
      const head = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/block-git-writes.mjs\n';
      expect(split(render(tpl('\nBody.\n', head))).body).toContain(proseGuard().paragraph);
    });

    test('throws for a template key it cannot translate', () => {
      expect(message(() => render(tpl('\nBody.\n', 'model: sonnet\n')))).toContain('"model" has no cursor translation in scripts/sprite-agents/targets/cursor.mjs');
    });

    test('throws for a template without a description', () => {
      expect(message(() => render('---\ntools: Read\n---\nbody\n'))).toContain('"description" is required');
    });
  });
});

describe('cursor through the generator', () => {
  const gen = (...args) => Bun.spawnSync(['bun', GEN, ...args], { cwd: ROOT });
  const text = (buf) => buf.toString();
  const sprites = plan.map((p) => p.member.sprite);

  test('planOutputs returns 7 flat <sprite>.md keys, none with a slash', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'cursor' });
    const keys = [...outputs.keys()];
    expect(keys.sort()).toEqual(sprites.map((s) => `${s}.md`).sort());
    expect(keys).toHaveLength(7);
    for (const key of keys) expect(key).not.toContain('/');
  });

  test('syncDir writes them once, then nothing, and shows no drift', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'cursor' });
    expect(syncDir(out, outputs).written).toHaveLength(7);
    expect(syncDir(out, outputs).written).toEqual([]);
    expect(syncDir(out, outputs, { check: true }).drift).toEqual([]);
  });

  test('the CLI writes 7 flat files, a second run writes none, and --clean removes them but not a hand-written one', () => {
    const first = gen('--target', 'cursor', '--out', out);
    expect(first.exitCode).toBe(0);
    expect(text(first.stdout)).toContain('7 written');
    expect(fs.readdirSync(out, { withFileTypes: true }).every((e) => e.isFile())).toBe(true);
    expect(fs.readdirSync(out)).toHaveLength(7);

    const second = gen('--target', 'cursor', '--out', out);
    expect(second.exitCode).toBe(0);
    expect(text(second.stdout)).toContain('0 written, 0 removed');
    expect(gen('--target', 'cursor', '--out', out, '--check').exitCode).toBe(0);

    fs.writeFileSync(path.join(out, 'mine.md'), '---\nname: mine\n---\nmine\n');
    const clean = gen('--target', 'cursor', '--out', out, '--clean');
    expect(clean.exitCode).toBe(0);
    expect(text(clean.stdout)).toContain('7 generated file(s) removed');
    expect(fs.readdirSync(out)).toEqual(['mine.md']);
  });

  test('--target cursor without --out exits 1', () => {
    const r = gen('--target', 'cursor');
    expect(r.exitCode).toBe(1);
    expect(text(r.stderr)).toContain('--out');
  });
});
