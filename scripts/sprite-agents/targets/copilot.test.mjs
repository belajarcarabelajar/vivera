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
import copilot from './copilot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GEN = path.join(ROOT, 'scripts', 'gen-sprite-agents.mjs');
const ROLES = path.join(ROOT, 'agents', 'roles');
const CREW = path.join(ROOT, 'agents', 'crew.json');

// Copilot documents more frontmatter keys (model, infer, mcp-servers, and others);
// these three are the only ones written here.
const PINNED_KEYS = ['name', 'description', 'tools'];
const READ_ONLY = ['timid', 'aqua', 'staid'];
const WRITERS = ['chef', 'nappy', 'hoggy', 'bold'];
const SKILL_HOW = 'from your skills';
const MAX_PROMPT = 30000;

const plan = loadCrewPlan({ rolesDir: ROLES, crewFile: CREW });
const chef = { sprite: 'chef', role: 'implementer', color: 'red' };
const render = (template, member = chef) => copilot.render(template, member, {});
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
const toolsOf = (list) => frontmatter(render(tpl('\nBody.\n', `tools: ${list}\n`))).tools;

let tmp;
let out;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-target-'));
  out = path.join(tmp, 'out');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('copilot target', () => {
  test('is registered as a .agent.md target that needs --out', () => {
    expect(targetIds()).toContain('copilot');
    expect(TARGETS.copilot).toBe(copilot);
    expect([copilot.id, copilot.ext, copilot.outName('chef'), copilot.requiresOut]).toEqual(['copilot', '.md', 'chef.agent.md', true]);
    expect(copilot.outName('chef').endsWith('.agent.md')).toBe(true);
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

        test('names the sprite and has a description prefixed with its role', () => {
          expect(fm.name).toBe(member.sprite);
          expect(fm.description.startsWith(`${capitalize(member.sprite)}, a Harvest Sprite on the ${member.role} crew`)).toBe(true);
        });

        test('lists read, search, execute for a read-only role and has no tools key for a writer', () => {
          if (READ_ONLY.includes(member.sprite)) expect(fm.tools).toEqual(['read', 'search', 'execute']);
          else {
            expect(WRITERS).toContain(member.sprite);
            expect('tools' in fm).toBe(false);
          }
        });

        test('keeps the marker line and then the guard comment inside the frontmatter', () => {
          const { head } = split(text);
          const marker = head.findIndex((l) => l.startsWith(MARKER));
          expect(marker).toBeGreaterThan(-1);
          expect(head[marker + 1]).toBe(proseGuard().comment);
          expect(split(text).body.includes(MARKER)).toBe(false);
        });

        test('carries the skill line, the guard paragraph, and the template body, within the prompt limit', () => {
          const { body } = split(text);
          expect(body).toContain(proseGuard().paragraph);
          const skills = Bun.YAML.parse(splitFrontmatter(template, 'x').head.join('\n')).skills ?? [];
          if (skills.length > 0) expect(body).toContain(skillLine(skills, SKILL_HOW));
          expect(body.endsWith(bodyOf(template))).toBe(true);
          expect(body.length).toBeLessThanOrEqual(MAX_PROMPT);
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
    test('writes a sprite with tools and skills exactly in the documented order', () => {
      const guard = proseGuard();
      const expected = [
        '---',
        'name: chef',
        'description: "Chef, a Harvest Sprite on the implementer crew. Does one thing."',
        'tools: ["read","search","execute"]',
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
      expect(render(tpl('\nBody.\n', 'tools: Read, Grep, Glob, Bash\nskills:\n  - sucp-tdd-debug\n'))).toBe(expected);
    });

    test('leaves out tools and the skill line for a template that sets neither', () => {
      const text = render(tpl('\nBody.\n'));
      expect(split(text).head.some((l) => l.startsWith('tools'))).toBe(false);
      expect(split(text).body).toBe(`\n${proseGuard().paragraph}\n\nBody.\n`);
    });

    test('puts one blank line before the body however many the template has, and ends with one newline', () => {
      expect(split(render(tpl('\n\n\nBody.\n\n\n'))).body.endsWith(`${proseGuard().paragraph}\n\nBody.\n`)).toBe(true);
      expect(split(render(tpl('Body without newline'))).body.endsWith('\n\nBody without newline\n')).toBe(true);
    });

    test('writes no model, no maxTurns, and no steps', () => {
      const text = render(tpl('\nBody.\n', 'maxTurns: 5\n'));
      expect(Object.keys(frontmatter(text)).sort()).toEqual(['description', 'name']);
      expect(text).not.toMatch(/^(model|maxTurns|steps|infer)\b/m);
    });

    test('quotes the description so a colon, a hash, a quote, or a backslash cannot change the YAML', () => {
      const text = render('---\ndescription: \'Use: this # that, "quoted" and \\ slash.\'\n---\nbody\n');
      expect(frontmatter(text).description).toBe('Chef, a Harvest Sprite on the implementer crew. Use: this # that, "quoted" and \\ slash.');
    });
  });

  describe('tool translation', () => {
    test('maps Read to read, Grep and Glob to search, and Bash to execute', () => {
      expect(toolsOf('Read')).toEqual(['read']);
      expect(toolsOf('Grep')).toEqual(['search']);
      expect(toolsOf('Glob')).toEqual(['search']);
      expect(toolsOf('Bash')).toEqual(['execute']);
    });

    test('maps Edit, Write, MultiEdit, and NotebookEdit to edit', () => {
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(toolsOf(`Read, ${tool}`)).toEqual(['read', 'edit']);
    });

    test('drops a tool whose name starts with mcp__', () => {
      expect(toolsOf('Read, mcp__tinyfish, mcp__x__y')).toEqual(['read']);
    });

    test('de-duplicates and keeps the first-seen order', () => {
      expect(toolsOf('Bash, Grep, Read, Glob, Write, Edit, Bash')).toEqual(['execute', 'search', 'read', 'edit']);
    });

    test('accepts the tools as a YAML list as well as a comma string', () => {
      expect(toolsOf('[Read, Bash]')).toEqual(['read', 'execute']);
    });

    test('writes an empty list, which Copilot reads as no tools, when nothing is left to translate', () => {
      expect(toolsOf('[]')).toEqual([]);
      expect(toolsOf('mcp__only')).toEqual([]);
    });

    test('throws for a tool it has no translation for, naming the file and the tool', () => {
      expect(message(() => toolsOf('Read, WebFetch'))).toBe(
        'agents/roles/implementer.md: tool "WebFetch" has no Copilot translation in scripts/sprite-agents/targets/copilot.mjs',
      );
      expect(message(() => toolsOf('constructor'))).toContain('tool "constructor"');
    });
  });

  describe('prompt limit', () => {
    const promptLength = (n) => split(render(tpl(`${'x'.repeat(n)}\n`))).body.length;

    test('accepts a prompt of exactly 30000 characters and throws for one more', () => {
      const overhead = promptLength(1) - 1;
      const fits = MAX_PROMPT - overhead;
      expect(promptLength(fits)).toBe(MAX_PROMPT);
      const msg = message(() => render(tpl(`${'x'.repeat(fits + 1)}\n`)));
      expect(msg).toContain('agents/roles/implementer.md');
      expect(msg).toContain('30000');
    });

    test('throws for a synthetic oversize body', () => {
      expect(message(() => render(tpl(`\n${'word '.repeat(7000)}\n`)))).toContain('30000');
    });
  });

  describe('refusals', () => {
    test('throws for a hook that is not the git guard', () => {
      const head = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: bun lint.mjs\n';
      expect(message(() => render(tpl('\nBody.\n', head)))).toMatch(/copilot has no hooks.*lint\.mjs/);
    });

    test('accepts the git guard hook and writes the prose guard for it', () => {
      const head = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/block-git-writes.mjs\n';
      expect(split(render(tpl('\nBody.\n', head))).body).toContain(proseGuard().paragraph);
    });

    test('throws for a template key it cannot translate', () => {
      expect(message(() => render(tpl('\nBody.\n', 'model: sonnet\n')))).toContain('"model" has no copilot translation in scripts/sprite-agents/targets/copilot.mjs');
    });

    test('throws for a template without a description', () => {
      expect(message(() => render('---\ntools: Read\n---\nbody\n'))).toContain('"description" is required');
    });
  });
});

describe('copilot through the generator', () => {
  const gen = (...args) => Bun.spawnSync(['bun', GEN, ...args], { cwd: ROOT });
  const text = (buf) => buf.toString();
  const sprites = plan.map((p) => p.member.sprite);

  test('planOutputs returns 7 flat <sprite>.agent.md keys, none with a slash', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'copilot' });
    const keys = [...outputs.keys()];
    expect(keys.sort()).toEqual(sprites.map((s) => `${s}.agent.md`).sort());
    expect(keys).toHaveLength(7);
    for (const key of keys) expect(key).not.toContain('/');
  });

  test('syncDir writes them once, then nothing, and shows no drift', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'copilot' });
    expect(syncDir(out, outputs).written).toHaveLength(7);
    expect(syncDir(out, outputs).written).toEqual([]);
    expect(syncDir(out, outputs, { check: true }).drift).toEqual([]);
  });

  test('syncDir finds and removes a stale marked .agent.md, and leaves an unmarked plain .md alone', () => {
    const outputs = planOutputs({ rolesDir: ROLES, crewFile: CREW, target: 'copilot' });
    syncDir(out, outputs);
    fs.writeFileSync(path.join(out, 'old.agent.md'), `---\n${MARKER} from test.\n---\n`);
    fs.writeFileSync(path.join(out, 'notes.md'), 'mine\n');
    const r = syncDir(out, outputs);
    expect(r.removed).toEqual(['old.agent.md']);
    expect(fs.existsSync(path.join(out, 'notes.md'))).toBe(true);
    expect(syncDir(out, outputs, { check: true }).drift).toEqual([]);
  });

  test('the CLI writes 7 files, a second run writes none, a stale marked file is removed, and --clean keeps a hand-written one', () => {
    const first = gen('--target', 'copilot', '--out', out);
    expect(first.exitCode).toBe(0);
    expect(text(first.stdout)).toContain('7 written');
    expect(fs.readdirSync(out).filter((f) => f.endsWith('.agent.md'))).toHaveLength(7);

    const second = gen('--target', 'copilot', '--out', out);
    expect(second.exitCode).toBe(0);
    expect(text(second.stdout)).toContain('0 written, 0 removed');
    expect(gen('--target', 'copilot', '--out', out, '--check').exitCode).toBe(0);

    fs.writeFileSync(path.join(out, 'old.agent.md'), `---\n${MARKER} from test.\n---\n`);
    const third = gen('--target', 'copilot', '--out', out);
    expect(third.exitCode).toBe(0);
    expect(text(third.stdout)).toContain('0 written, 1 removed');
    expect(fs.existsSync(path.join(out, 'old.agent.md'))).toBe(false);

    fs.writeFileSync(path.join(out, 'mine.agent.md'), '---\ndescription: mine\n---\nmine\n');
    const clean = gen('--target', 'copilot', '--out', out, '--clean');
    expect(clean.exitCode).toBe(0);
    expect(text(clean.stdout)).toContain('7 generated file(s) removed');
    expect(fs.readdirSync(out)).toEqual(['mine.agent.md']);
  });

  test('--target copilot without --out exits 1', () => {
    const r = gen('--target', 'copilot');
    expect(r.exitCode).toBe(1);
    expect(text(r.stderr)).toContain('--out');
  });
});
