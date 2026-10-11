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
import antigravity from './antigravity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GEN = path.join(ROOT, 'scripts', 'gen-sprite-agents.mjs');
const ROLES = path.join(ROOT, 'agents', 'roles');
const CREW = path.join(ROOT, 'agents', 'crew.json');

// The keys the Antigravity subagents page (read 2026-10-11) documents and that
// this renderer writes. `skills` and `mcpServers` are documented too, and are
// deliberately not written.
const PINNED_KEYS = ['name', 'description', 'mainAgent', 'subagent', 'model', 'commandExecutionPolicy', 'tools'];
const READ_ONLY = ['timid', 'aqua', 'staid'];
const WRITERS = ['chef', 'nappy', 'hoggy', 'bold'];
const DOCUMENTED_TOOLS = ['view_file', 'grep_search', 'run_command'];
const SKILL_HOW = 'from your skills';

const plan = loadCrewPlan({ rolesDir: ROLES, crewFile: CREW });
const chef = { sprite: 'chef', role: 'implementer', color: 'red' };
const render = (template, member = chef) => antigravity.render(template, member, {});
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
const guardHook = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: bun x/block-git-writes.mjs\n';

let tmp;
let out;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-target-'));
  out = path.join(tmp, 'out');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('antigravity target', () => {
  test('is registered as a <sprite>/agent.md target that needs --out', () => {
    expect(targetIds()).toContain('antigravity');
    expect(TARGETS.antigravity).toBe(antigravity);
    expect([antigravity.id, antigravity.ext, antigravity.outName('chef'), antigravity.requiresOut]).toEqual(['antigravity', '.md', 'chef/agent.md', true]);
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

        test('names the sprite and describes its role', () => {
          expect(fm.name).toBe(member.sprite);
          expect(fm.description.startsWith(`${capitalize(member.sprite)}, a Harvest Sprite on the ${member.role} crew`)).toBe(true);
        });

        test('is a subagent only, inherits the model, and runs commands in the sandbox', () => {
          expect(fm.mainAgent).toBe(false);
          expect(fm.subagent).toBe(true);
          expect(fm.model).toBe('inherit');
          expect(fm.commandExecutionPolicy).toBe('sandbox');
        });

        test('lists the three documented tools for a read-only role and leaves the key out for a writer', () => {
          if (READ_ONLY.includes(member.sprite)) expect(fm.tools).toEqual(DOCUMENTED_TOOLS);
          else {
            expect(WRITERS).toContain(member.sprite);
            expect('tools' in fm).toBe(false);
          }
        });

        test('never writes skills or mcpServers keys', () => {
          expect('skills' in fm).toBe(false);
          expect('mcpServers' in fm).toBe(false);
          expect(text).not.toMatch(/^(skills|mcpServers|maxTurns):/m);
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
    test('writes a role with tools and skills exactly in the documented order', () => {
      const guard = proseGuard();
      const expected = [
        '---',
        'name: chef',
        'description: "Chef, a Harvest Sprite on the implementer crew. Does one thing."',
        'mainAgent: false',
        'subagent: true',
        'model: inherit',
        'commandExecutionPolicy: sandbox',
        'tools: ["view_file"]',
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

    test('leaves out tools and the skill line for a writer without them', () => {
      const text = render(tpl('\nBody.\n'));
      expect(split(text).head.some((l) => l.startsWith('tools'))).toBe(false);
      expect(split(text).body).toBe(`\n${proseGuard().paragraph}\n\nBody.\n`);
    });

    test('translates Read, Grep, Glob and Bash, and keeps each name once in first-seen order', () => {
      expect(frontmatter(render(tpl('\nBody.\n', 'tools: Bash, Read, Grep, Glob\n'))).tools).toEqual(['run_command', 'view_file', 'grep_search']);
      expect(frontmatter(render(tpl('\nBody.\n', 'tools:\n  - Glob\n  - Grep\n  - Read\n'))).tools).toEqual(['grep_search', 'view_file']);
    });

    test('drops an mcp__ tool, and writes an empty list when nothing else is left', () => {
      expect(frontmatter(render(tpl('\nBody.\n', 'tools: Read, mcp__tinyfish\n'))).tools).toEqual(['view_file']);
      expect(frontmatter(render(tpl('\nBody.\n', 'tools: mcp__tinyfish\n'))).tools).toEqual([]);
    });

    test('drops maxTurns and writes no steps key', () => {
      const text = render(tpl('\nBody.\n', 'maxTurns: 5\n'));
      expect(Object.keys(frontmatter(text)).sort()).toEqual(['commandExecutionPolicy', 'description', 'mainAgent', 'model', 'name', 'subagent']);
      expect(text).not.toMatch(/^(maxTurns|steps)\b/m);
    });

    test('puts one blank line before the body however many the template has, and ends with one newline', () => {
      expect(split(render(tpl('\n\n\nBody.\n\n\n'))).body.endsWith(`${proseGuard().paragraph}\n\nBody.\n`)).toBe(true);
      expect(split(render(tpl('Body without newline'))).body.endsWith('\n\nBody without newline\n')).toBe(true);
    });

    test('quotes the description so a colon, a hash, a quote, or a backslash cannot change the YAML', () => {
      const text = render('---\ndescription: \'Use: this # that, "quoted" and \\ slash.\'\n---\nbody\n');
      expect(frontmatter(text).description).toBe('Chef, a Harvest Sprite on the implementer crew. Use: this # that, "quoted" and \\ slash.');
    });
  });

  describe('refusals', () => {
    test('throws for a hook that is not the git guard', () => {
      const head = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: bun lint.mjs\n';
      expect(message(() => render(tpl('\nBody.\n', head)))).toMatch(/antigravity has no hooks.*lint\.mjs/);
    });

    test('accepts the git guard hook and writes the prose guard for it', () => {
      expect(split(render(tpl('\nBody.\n', guardHook))).body).toContain(proseGuard().paragraph);
    });

    test('throws for a tool it has no name for, naming the tool and the file', () => {
      expect(message(() => render(tpl('\nBody.\n', 'tools: Read, WebFetch\n')))).toBe(
        'agents/roles/implementer.md: tool "WebFetch" has no Antigravity translation in scripts/sprite-agents/targets/antigravity.mjs',
      );
    });

    test('throws for a template key it cannot translate', () => {
      expect(message(() => render(tpl('\nBody.\n', 'model: sonnet\n')))).toContain('"model" has no antigravity translation in scripts/sprite-agents/targets/antigravity.mjs');
    });

    test('throws for a template without a description', () => {
      expect(message(() => render('---\ntools: Read\n---\nbody\n'))).toContain('"description" is required');
    });
  });
});

describe('antigravity through the generator', () => {
  const gen = (...args) => Bun.spawnSync(['bun', GEN, ...args], { cwd: ROOT });
  const text = (buf) => buf.toString();
  const sprites = plan.map((p) => p.member.sprite);
  const dirsOf = (dir) => fs.readdirSync(dir, { withFileTypes: true });

  test('planOutputs returns 7 keys, each <sprite>/agent.md with one directory level', () => {
    const keys = [...planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'antigravity' }).keys()];
    expect(keys.sort()).toEqual(sprites.map((s) => `${s}/agent.md`).sort());
    expect(keys).toHaveLength(7);
  });

  test('syncDir writes them once, then nothing, and shows no drift', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'antigravity' });
    expect(syncDir(out, outputs).written).toHaveLength(7);
    expect(syncDir(out, outputs).written).toEqual([]);
    expect(syncDir(out, outputs, { check: true }).drift).toEqual([]);
  });

  test('a normal run removes a stale marked file together with its empty directory, and spares an unmarked one', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'antigravity' });
    fs.mkdirSync(path.join(out, 'old'), { recursive: true });
    fs.writeFileSync(path.join(out, 'old', 'agent.md'), `---\nname: old\n${MARKER} from x\n---\nold\n`);
    fs.mkdirSync(path.join(out, 'mine'), { recursive: true });
    fs.writeFileSync(path.join(out, 'mine', 'agent.md'), '---\nname: mine\n---\nmine\n');

    const r = syncDir(out, outputs);
    expect(r.removed).toEqual(['old/agent.md']);
    expect(fs.existsSync(path.join(out, 'old'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'mine', 'agent.md'), 'utf8')).toBe('---\nname: mine\n---\nmine\n');
    expect(r.refused).toEqual([]);
  });

  test('the CLI writes 7 files in 7 directories, a second run writes none, and --clean removes files and directories but not a hand-written one', () => {
    const first = gen('--target', 'antigravity', '--out', out);
    expect(first.exitCode).toBe(0);
    expect(text(first.stdout)).toContain('7 written');
    expect(dirsOf(out).every((e) => e.isDirectory())).toBe(true);
    expect(dirsOf(out)).toHaveLength(7);
    for (const s of sprites) expect(fs.readdirSync(path.join(out, s))).toEqual(['agent.md']);

    const second = gen('--target', 'antigravity', '--out', out);
    expect(second.exitCode).toBe(0);
    expect(text(second.stdout)).toContain('0 written, 0 removed');
    expect(gen('--target', 'antigravity', '--out', out, '--check').exitCode).toBe(0);

    fs.mkdirSync(path.join(out, 'mine'));
    fs.writeFileSync(path.join(out, 'mine', 'agent.md'), '---\nname: mine\n---\nmine\n');
    const clean = gen('--target', 'antigravity', '--out', out, '--clean');
    expect(clean.exitCode).toBe(0);
    expect(text(clean.stdout)).toContain('7 generated file(s) removed');
    expect(fs.readdirSync(out)).toEqual(['mine']);
    expect(fs.readdirSync(path.join(out, 'mine'))).toEqual(['agent.md']);
  });

  test('--target antigravity without --out exits 1', () => {
    const r = gen('--target', 'antigravity');
    expect(r.exitCode).toBe(1);
    expect(text(r.stderr)).toContain('--out');
  });
});
