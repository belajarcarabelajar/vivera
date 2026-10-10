import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENUMS } from './validate-agents.mjs';
import { MARKER, OPENCODE_COLORS, parseCrew, planOutputs, renderAgent, renderOpenCodeAgent, syncDir } from './gen-sprite-agents.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gen-sprite-agents.mjs');

const TEMPLATE = [
  '---',
  'description: Implements one chunk of an approved plan, test first.',
  'skills:',
  '  - sucp-tdd-debug',
  'maxTurns: 40',
  'hooks:',
  '  PreToolUse:',
  '    - matcher: "Bash"',
  '      hooks:',
  '        - type: command',
  '          command: "bun \\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/block-git-writes.mjs"',
  '---',
  '',
  'You own exactly one chunk.',
  '',
].join('\n');

const READ_ONLY = '---\ndescription: Audits a diff.\ntools: Read, Grep\n---\n\nYou check a claim.\n';

let tmp;
let rolesDir;
let crewFile;
let outDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-sprite-agents-'));
  rolesDir = path.join(tmp, 'roles');
  crewFile = path.join(tmp, 'crew.json');
  outDir = path.join(tmp, 'out');
  fs.mkdirSync(rolesDir);
  fs.writeFileSync(path.join(rolesDir, 'implementer.md'), TEMPLATE);
  fs.writeFileSync(path.join(rolesDir, 'reviewer.md'), READ_ONLY);
  writeCrew([
    { sprite: 'chef', role: 'implementer', color: 'red' },
    { sprite: 'hoggy', role: 'implementer', color: 'yellow' },
    { sprite: 'staid', role: 'reviewer', color: 'cyan' },
  ]);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeCrew(crew) {
  fs.writeFileSync(crewFile, JSON.stringify(crew));
}

function frontmatter(text) {
  const lines = text.split('\n');
  return Bun.YAML.parse(lines.slice(1, lines.indexOf('---', 1)).join('\n'));
}

describe('renderAgent', () => {
  const chef = { sprite: 'chef', role: 'implementer', color: 'red' };

  test('names the agent after the sprite and keeps the role behaviour', () => {
    const fm = frontmatter(renderAgent(TEMPLATE, chef));
    expect(fm.name).toBe('chef');
    expect(fm.color).toBe('red');
    expect(fm.description).toBe('Chef, a Harvest Sprite on the implementer crew. Implements one chunk of an approved plan, test first.');
    expect(fm.skills).toEqual(['sucp-tdd-debug']);
    expect(fm.maxTurns).toBe(40);
  });

  test('keeps the template body byte for byte', () => {
    const out = renderAgent(TEMPLATE, chef);
    expect(out.endsWith('---\n\nYou own exactly one chunk.\n')).toBe(true);
  });

  test('marks the file as generated inside the frontmatter', () => {
    const out = renderAgent(TEMPLATE, chef);
    const lines = out.split('\n');
    const close = lines.indexOf('---', 1);
    expect(lines.slice(0, close).some((l) => l.startsWith(MARKER))).toBe(true);
    expect(lines.slice(close).some((l) => l.startsWith(MARKER))).toBe(false);
  });

  test('leaves $CLAUDE_PROJECT_DIR alone without a hook root', () => {
    const fm = frontmatter(renderAgent(TEMPLATE, chef));
    expect(fm.hooks.PreToolUse[0].hooks[0].command).toBe('bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/block-git-writes.mjs');
  });

  test('pins the hook script to an absolute root for a user-level install', () => {
    const fm = frontmatter(renderAgent(TEMPLATE, chef, { hookRoot: '/home/u/my farm' }));
    expect(fm.hooks.PreToolUse[0].hooks[0].command).toBe('bun "/home/u/my farm"/.claude/hooks/block-git-writes.mjs');
  });

  test('rejects a hook root that would break the quoted command', () => {
    for (const bad of ['relative/path', '/a"b', '/a\\b', '/a$b', '/a`b', '/a\nb']) {
      expect(() => renderAgent(TEMPLATE, chef, { hookRoot: bad })).toThrow(/hook root/);
    }
  });

  test('rejects a template that already sets name or color', () => {
    expect(() => renderAgent(TEMPLATE.replace('description:', 'name: x\ndescription:'), chef)).toThrow(/"name"/);
    expect(() => renderAgent(TEMPLATE.replace('maxTurns: 40', 'color: blue'), chef)).toThrow(/"color"/);
  });

  test('rejects a template without a description', () => {
    expect(() => renderAgent('---\ntools: Read\n---\nbody\n', chef)).toThrow(/description/);
  });

  test('rejects a template without frontmatter', () => {
    expect(() => renderAgent('just text\n', chef)).toThrow(/frontmatter/);
  });
});

describe('renderOpenCodeAgent', () => {
  const chef = { sprite: 'chef', role: 'implementer', color: 'red' };
  const staid = { sprite: 'staid', role: 'reviewer', color: 'cyan' };
  const shell = (fm) => fm.permissions.filter((p) => p.action === 'shell');
  const effectOf = (fm, resource) => shell(fm).findLast((p) => p.resource === resource)?.effect;

  test('writes OpenCode v2 fields: subagent mode, hex color, steps', () => {
    const fm = frontmatter(renderOpenCodeAgent(TEMPLATE, chef));
    expect(fm.mode).toBe('subagent');
    expect(fm.color).toBe(OPENCODE_COLORS.red);
    expect(fm.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(fm.steps).toBe(40);
    expect(fm.description).toBe('Chef, a Harvest Sprite on the implementer crew. Implements one chunk of an approved plan, test first.');
  });

  test('drops every Claude Code field, since OpenCode skips an agent with a legacy tools field or a color name', () => {
    const fm = frontmatter(renderOpenCodeAgent(READ_ONLY, staid));
    for (const key of ['name', 'tools', 'skills', 'hooks', 'maxTurns']) expect(key in fm).toBe(false);
  });

  test('replaces the git guard hook with shell deny rules for git, gh, and their rtk rewrites', () => {
    const fm = frontmatter(renderOpenCodeAgent(TEMPLATE, chef));
    for (const r of ['git *', 'rtk git *', 'gh', 'gh *', 'rtk gh *', '*/git *', '*/gh *']) expect(effectOf(fm, r)).toBe('deny');
  });

  test('re-allows read-only git forms after the broad deny, because the last matching rule wins', () => {
    const fm = frontmatter(renderOpenCodeAgent(TEMPLATE, chef));
    const rules = shell(fm);
    const lastDeny = rules.findLastIndex((p) => p.effect === 'deny');
    const firstAllow = rules.findIndex((p) => p.effect === 'allow');
    expect(firstAllow).toBeGreaterThan(lastDeny);
    for (const r of ['git status*', 'rtk git status*', 'git diff*', 'git log*', 'rtk git show*', 'git branch']) expect(effectOf(fm, r)).toBe('allow');
  });

  test('never re-allows a pattern with a wildcard before its end, which could match a write command', () => {
    const fm = frontmatter(renderOpenCodeAgent(TEMPLATE, chef));
    for (const p of shell(fm).filter((r) => r.effect === 'allow')) expect(p.resource.slice(0, -1)).not.toContain('*');
  });

  test('denies edits for a role whose tools list has no Edit or Write', () => {
    const ro = frontmatter(renderOpenCodeAgent(READ_ONLY, staid));
    expect(ro.permissions).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' });
    const rw = frontmatter(renderOpenCodeAgent(TEMPLATE, chef));
    expect(rw.permissions.some((p) => p.action === 'edit')).toBe(false);
  });

  test('tells the agent to load its phase skill, since OpenCode has no skill preload', () => {
    const out = renderOpenCodeAgent(TEMPLATE, chef);
    expect(out).toContain('Load the `sucp-tdd-debug` skill');
    expect(out.endsWith('You own exactly one chunk.\n')).toBe(true);
  });

  test('marks the file as generated inside the frontmatter', () => {
    const lines = renderOpenCodeAgent(TEMPLATE, chef).split('\n');
    expect(lines.slice(0, lines.indexOf('---', 1)).some((l) => l.startsWith(MARKER))).toBe(true);
  });

  test('rejects a hook other than the git guard, which OpenCode cannot run', () => {
    const other = TEMPLATE.replace('.claude/hooks/block-git-writes.mjs', '.claude/hooks/lint.mjs');
    expect(() => renderOpenCodeAgent(other, chef)).toThrow(/lint\.mjs/);
  });

  test('rejects a template field it cannot translate, instead of dropping it silently', () => {
    expect(() => renderOpenCodeAgent(TEMPLATE.replace('maxTurns: 40', 'model: sonnet'), chef)).toThrow(/"model"/);
  });

  test('has a hex color for every Claude Code color', () => {
    for (const c of ENUMS.color) expect(OPENCODE_COLORS[c]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('parseCrew', () => {
  test('accepts a valid roster', () => {
    expect(parseCrew('[{"sprite":"chef","role":"implementer","color":"red"}]')).toHaveLength(1);
  });

  test('rejects duplicate sprites, bad names, unknown colors, and missing roles', () => {
    expect(() => parseCrew('[{"sprite":"chef","role":"a","color":"red"},{"sprite":"chef","role":"a","color":"blue"}]')).toThrow(/duplicate/);
    expect(() => parseCrew('[{"sprite":"Chef","role":"a","color":"red"}]')).toThrow(/sprite/);
    expect(() => parseCrew('[{"sprite":"chef","role":"a","color":"indigo"}]')).toThrow(/color/);
    expect(() => parseCrew('[{"sprite":"chef","color":"red"}]')).toThrow(/role/);
    expect(() => parseCrew('{}')).toThrow(/array/);
    expect(() => parseCrew('[]')).toThrow(/empty/);
  });
});

describe('planOutputs', () => {
  test('renders one file per sprite', () => {
    const outputs = planOutputs({ rolesDir, crewFile });
    expect([...outputs.keys()].sort()).toEqual(['chef.md', 'hoggy.md', 'staid.md']);
    expect(frontmatter(outputs.get('staid.md')).tools).toBe('Read, Grep');
  });

  test('fails when a sprite names a role with no template', () => {
    writeCrew([{ sprite: 'chef', role: 'chef-role', color: 'red' }]);
    expect(() => planOutputs({ rolesDir, crewFile })).toThrow(/chef-role/);
  });

  test('fails when a role template has no sprite, so a role cannot vanish silently', () => {
    writeCrew([{ sprite: 'chef', role: 'implementer', color: 'red' }]);
    expect(() => planOutputs({ rolesDir, crewFile })).toThrow(/reviewer/);
  });
});

describe('syncDir', () => {
  test('writes every output and reports it', () => {
    const outputs = planOutputs({ rolesDir, crewFile });
    const r = syncDir(outDir, outputs);
    expect(r.written.sort()).toEqual(['chef.md', 'hoggy.md', 'staid.md']);
    expect(fs.readFileSync(path.join(outDir, 'chef.md'), 'utf8')).toBe(outputs.get('chef.md'));
  });

  test('a second run writes nothing', () => {
    const outputs = planOutputs({ rolesDir, crewFile });
    syncDir(outDir, outputs);
    expect(syncDir(outDir, outputs).written).toEqual([]);
  });

  test('removes a generated file whose sprite left the roster, and keeps hand-written files', () => {
    syncDir(outDir, planOutputs({ rolesDir, crewFile }));
    fs.writeFileSync(path.join(outDir, 'mine.md'), '---\nname: mine\ndescription: x\n---\n');
    writeCrew([
      { sprite: 'chef', role: 'implementer', color: 'red' },
      { sprite: 'staid', role: 'reviewer', color: 'cyan' },
    ]);
    const r = syncDir(outDir, planOutputs({ rolesDir, crewFile }));
    expect(r.removed).toEqual(['hoggy.md']);
    expect(fs.existsSync(path.join(outDir, 'hoggy.md'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'mine.md'))).toBe(true);
  });

  test('refuses to overwrite a hand-written file with a sprite name', () => {
    fs.mkdirSync(outDir);
    const mine = '---\nname: chef\ndescription: my own chef\n---\n';
    fs.writeFileSync(path.join(outDir, 'chef.md'), mine);
    const r = syncDir(outDir, planOutputs({ rolesDir, crewFile }));
    expect(r.refused).toEqual(['chef.md']);
    expect(fs.readFileSync(path.join(outDir, 'chef.md'), 'utf8')).toBe(mine);
  });

  test('check mode reports drift and writes nothing', () => {
    const outputs = planOutputs({ rolesDir, crewFile });
    syncDir(outDir, outputs);
    fs.writeFileSync(path.join(outDir, 'chef.md'), `${outputs.get('chef.md')}edited\n`);
    fs.rmSync(path.join(outDir, 'hoggy.md'));
    const r = syncDir(outDir, outputs, { check: true });
    expect(r.drift.sort()).toEqual(['chef.md: out of date', 'hoggy.md: missing']);
    expect(fs.existsSync(path.join(outDir, 'hoggy.md'))).toBe(false);
  });
});

describe('CLI', () => {
  function run(...args) {
    return Bun.spawnSync(['bun', SCRIPT, '--roles', rolesDir, '--crew', crewFile, '--out', outDir, ...args]);
  }

  function writeHook(root) {
    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'hooks', 'block-git-writes.mjs'), '');
  }

  test('writes the crew and exits 0', () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('3 sprite agent(s)');
    expect(fs.existsSync(path.join(outDir, 'staid.md'))).toBe(true);
  });

  test('--check exits 1 on drift and 0 once in sync', () => {
    expect(run('--check').exitCode).toBe(1);
    run();
    expect(run('--check').exitCode).toBe(0);
  });

  test('--hook-root fails when the hook script is not under that root', () => {
    const r = run('--hook-root', path.join(tmp, 'nowhere'));
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('block-git-writes.mjs');
    expect(fs.existsSync(outDir)).toBe(false);
  });

  test('--hook-root writes absolute hook paths when the script exists', () => {
    const root = path.join(tmp, 'farm');
    writeHook(root);
    expect(run('--hook-root', root).exitCode).toBe(0);
    const fm = frontmatter(fs.readFileSync(path.join(outDir, 'chef.md'), 'utf8'));
    expect(fm.hooks.PreToolUse[0].hooks[0].command).toBe(`bun "${root}"/.claude/hooks/block-git-writes.mjs`);
  });

  test('--target opencode writes OpenCode agents', () => {
    expect(run('--target', 'opencode').exitCode).toBe(0);
    const fm = frontmatter(fs.readFileSync(path.join(outDir, 'chef.md'), 'utf8'));
    expect(fm.mode).toBe('subagent');
    expect('hooks' in fm).toBe(false);
  });

  test('--target opencode refuses --hook-root, which only Claude Code hooks use', () => {
    const r = run('--target', 'opencode', '--hook-root', tmp);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('--hook-root');
  });

  test('--target opencode needs an explicit --out', () => {
    const r = Bun.spawnSync(['bun', SCRIPT, '--roles', rolesDir, '--crew', crewFile, '--target', 'opencode']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('--out');
  });

  test('rejects an unknown target', () => {
    expect(run('--target', 'gemini').exitCode).toBe(1);
  });

  test('exits 1 when it refused to overwrite a hand-written file', () => {
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'chef.md'), '---\nname: chef\ndescription: mine\n---\n');
    const r = run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('chef.md');
  });
});
