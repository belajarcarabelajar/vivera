import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, isGenerated, syncDir } from './sync.mjs';
import { proseGuard } from './guard.mjs';
import { capitalize, checkHookRoot, hookScripts, loadCrewPlan, splitFrontmatter } from './crew.mjs';
import { TARGETS, loadTargets, targetIds } from './registry.mjs';
import claude, { renderAgent } from './targets/claude.mjs';
import opencode, { renderOpenCodeAgent } from './targets/opencode.mjs';
import { planOutputs } from '../gen-sprite-agents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GEN = path.join(ROOT, 'scripts', 'gen-sprite-agents.mjs');

const TEMPLATE = [
  '---',
  'description: Implements one chunk of an approved plan, test first.',
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

let tmp;
let out;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-agents-core-'));
  out = path.join(tmp, 'out');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const toml = (name) => `${MARKER} from test.\nname = "${name}"\n`;
const md = (name) => `---\nname: ${name}\n${MARKER} from test.\n---\n`;
const at = (...parts) => path.join(out, ...parts);
const put = (rel, content) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), content);
};

describe('syncDir with another extension', () => {
  const opt = { ext: '.toml' };

  test('a .toml output is written once, and a second run writes nothing and shows no drift', () => {
    const outputs = new Map([['chef.toml', toml('chef')], ['staid.toml', toml('staid')]]);
    expect(syncDir(out, outputs, opt).written.sort()).toEqual(['chef.toml', 'staid.toml']);
    expect(syncDir(out, outputs, opt).written).toEqual([]);
    expect(syncDir(out, outputs, { ...opt, check: true }).drift).toEqual([]);
  });

  test('removes a stale marked .toml and leaves an unmarked one', () => {
    syncDir(out, new Map([['chef.toml', toml('chef')], ['gone.toml', toml('gone')]]), opt);
    put('mine.toml', 'name = "mine"\n');
    const r = syncDir(out, new Map([['chef.toml', toml('chef')]]), opt);
    expect(r.removed).toEqual(['gone.toml']);
    expect(fs.existsSync(at('gone.toml'))).toBe(false);
    expect(fs.existsSync(at('mine.toml'))).toBe(true);
  });

  test('refuses an unmarked .toml that has an output name', () => {
    put('chef.toml', 'name = "mine"\n');
    const r = syncDir(out, new Map([['chef.toml', toml('chef')]]), opt);
    expect(r.refused).toEqual(['chef.toml']);
    expect(fs.readFileSync(at('chef.toml'), 'utf8')).toBe('name = "mine"\n');
  });

  test('never touches a marked file of another extension', () => {
    put('old.md', md('old'));
    expect(syncDir(out, new Map(), opt).removed).toEqual([]);
    expect(fs.existsSync(at('old.md'))).toBe(true);
    expect(syncDir(out, new Map(), { ext: '.md' }).removed).toEqual(['old.md']);
  });
});

describe('syncDir with nested keys', () => {
  test('writes a nested key, sees it as existing, and shows no drift', () => {
    const outputs = new Map([['a/agent.md', md('a')], ['b/agent.md', md('b')]]);
    expect(syncDir(out, outputs).written.sort()).toEqual(['a/agent.md', 'b/agent.md']);
    expect(fs.readFileSync(at('a', 'agent.md'), 'utf8')).toBe(md('a'));
    expect(syncDir(out, outputs).written).toEqual([]);
    expect(syncDir(out, outputs, { check: true }).drift).toEqual([]);
  });

  test('check mode reports a missing and an out of date nested file and writes nothing', () => {
    const outputs = new Map([['a/agent.md', md('a')], ['b/agent.md', md('b')]]);
    syncDir(out, new Map([['a/agent.md', md('a')]]));
    put('a/agent.md', `${md('a')}edited\n`);
    const r = syncDir(out, outputs, { check: true });
    expect(r.drift.sort()).toEqual(['a/agent.md: out of date', 'b/agent.md: missing']);
    expect(fs.existsSync(at('b'))).toBe(false);
  });

  test('refuses an unmarked nested file that has an output name', () => {
    put('a/agent.md', '---\nname: mine\n---\n');
    const r = syncDir(out, new Map([['a/agent.md', md('a')]]));
    expect(r.refused).toEqual(['a/agent.md']);
    expect(fs.readFileSync(at('a', 'agent.md'), 'utf8')).toBe('---\nname: mine\n---\n');
  });

  test('removes a stale nested file together with its directory once the directory is empty', () => {
    syncDir(out, new Map([['a/agent.md', md('a')], ['b/agent.md', md('b')]]));
    const r = syncDir(out, new Map([['b/agent.md', md('b')]]));
    expect(r.removed).toEqual(['a/agent.md']);
    expect(fs.existsSync(at('a'))).toBe(false);
    expect(fs.existsSync(at('b', 'agent.md'))).toBe(true);
  });

  test('keeps the directory of a stale nested file when a hand-written file is still in it', () => {
    syncDir(out, new Map([['a/agent.md', md('a')]]));
    put('a/notes.txt', 'mine\n');
    expect(syncDir(out, new Map()).removed).toEqual(['a/agent.md']);
    expect(fs.existsSync(at('a', 'notes.txt'))).toBe(true);
  });

  test('keeps the output directory itself after removing its last flat file', () => {
    syncDir(out, new Map([['chef.md', md('chef')]]));
    expect(syncDir(out, new Map()).removed).toEqual(['chef.md']);
    expect(fs.existsSync(out)).toBe(true);
  });

  test('manages one directory level only, so a marked file two levels down is left alone', () => {
    put('a/b/agent.md', md('deep'));
    expect(syncDir(out, new Map()).removed).toEqual([]);
    expect(fs.existsSync(at('a', 'b', 'agent.md'))).toBe(true);
  });

  test('rejects a key that escapes the directory, nests twice, or lacks the extension', () => {
    for (const key of ['../x.md', 'a/b/c.md', '/abs.md', 'a//b.md', './x.md', 'x.toml']) {
      expect(() => syncDir(out, new Map([[key, md('x')]]))).toThrow(/output key/);
    }
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('isGenerated', () => {
  test('is true for a marker at the start of any line, false otherwise or when the file is absent', () => {
    put('yes.toml', `name = "x"\n${MARKER} from t.\n`);
    put('no.toml', `name = "x" ${MARKER}\n`);
    expect(isGenerated(at('yes.toml'))).toBe(true);
    expect(isGenerated(at('no.toml'))).toBe(false);
    expect(isGenerated(at('absent.toml'))).toBe(false);
  });
});

describe('proseGuard', () => {
  const { comment, paragraph } = proseGuard();

  test('labels the guard as instruction only', () => {
    expect(comment).toBe('# guard: instruction only, not enforced by this harness');
  });

  test('is one paragraph that names the parent, the forbidden commands, and the allowed reads', () => {
    expect(paragraph).not.toContain('\n');
    expect(paragraph).toMatch(/parent/i);
    expect(paragraph).toMatch(/cannot enforce/i);
    for (const word of ['add', 'commit', 'checkout', 'switch', 'merge', 'rebase', 'stash', 'reset', 'push', 'gh']) {
      expect(paragraph).toMatch(new RegExp(`\\b${word}\\b`));
    }
    for (const word of ['status', 'diff', 'log', 'show']) expect(paragraph).toMatch(new RegExp(`\\b${word}\\b`));
    expect(paragraph).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('crew helpers', () => {
  test('splitFrontmatter separates the head lines from the body and names the label on failure', () => {
    expect(splitFrontmatter('---\na: 1\n---\nbody\n', 'x')).toEqual({ head: ['a: 1'], body: 'body\n' });
    expect(() => splitFrontmatter('text', 'agents/roles/x.md')).toThrow(/agents\/roles\/x\.md: no frontmatter/);
  });

  test('capitalize uppercases the first letter only', () => {
    expect(capitalize('chef')).toBe('Chef');
  });

  test('hookScripts lists the repository paths a template runs under $CLAUDE_PROJECT_DIR', () => {
    expect(hookScripts(TEMPLATE)).toEqual(['/.claude/hooks/block-git-writes.mjs']);
    expect(hookScripts('---\ndescription: x\n---\n')).toEqual([]);
  });

  test('checkHookRoot accepts an absolute plain path and rejects the rest', () => {
    expect(() => checkHookRoot('/home/u/farm')).not.toThrow();
    for (const bad of ['rel', '/a"b', '/a$b']) expect(() => checkHookRoot(bad)).toThrow(/hook root/);
  });

  describe('loadCrewPlan', () => {
    let rolesDir;
    let crewFile;

    beforeEach(() => {
      rolesDir = path.join(tmp, 'roles');
      crewFile = path.join(tmp, 'crew.json');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'implementer.md'), TEMPLATE);
      fs.writeFileSync(path.join(rolesDir, 'reviewer.md'), '---\ndescription: Audits.\ntools: Read\n---\nbody\n');
    });

    const crew = (list) => fs.writeFileSync(crewFile, JSON.stringify(list));

    test('pairs each sprite with its role template in roster order', () => {
      crew([
        { sprite: 'staid', role: 'reviewer', color: 'cyan' },
        { sprite: 'chef', role: 'implementer', color: 'red' },
      ]);
      const plan = loadCrewPlan({ rolesDir, crewFile });
      expect(plan.map((p) => p.member.sprite)).toEqual(['staid', 'chef']);
      expect(plan[1].template).toBe(TEMPLATE);
    });

    test('names a role that has no template, and a role that has no sprite', () => {
      crew([{ sprite: 'chef', role: 'ghost', color: 'red' }]);
      expect(() => loadCrewPlan({ rolesDir, crewFile })).toThrow(/names role "ghost"/);
      crew([{ sprite: 'chef', role: 'implementer', color: 'red' }]);
      expect(() => loadCrewPlan({ rolesDir, crewFile })).toThrow(/no sprite is assigned to role\(s\) reviewer/);
    });

    test('planOutputs checks the hook script only for the claude target', () => {
      crew([
        { sprite: 'chef', role: 'implementer', color: 'red' },
        { sprite: 'staid', role: 'reviewer', color: 'cyan' },
      ]);
      const hookRoot = path.join(tmp, 'nowhere');
      expect(() => planOutputs({ rolesDir, crewFile, hookRoot })).toThrow(/block-git-writes\.mjs/);
      expect([...planOutputs({ rolesDir, crewFile, hookRoot, target: 'opencode' }).keys()].sort()).toEqual(['chef.md', 'staid.md']);
    });

    test('planOutputs rejects an unknown target and lists the valid ids', () => {
      crew([{ sprite: 'chef', role: 'implementer', color: 'red' }]);
      expect(() => planOutputs({ rolesDir, crewFile, target: 'nope' })).toThrow(/claude, opencode/);
    });
  });
});

describe('registry', () => {
  const FIELDS = ['id', 'ext', 'outName', 'requiresOut', 'render'];

  function fixture(files) {
    const dir = fs.mkdtempSync(path.join(tmp, 'targets-'));
    for (const [name, mod] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), mod);
    return dir;
  }

  // The fixture is source text, so functions are written out rather than serialised.
  const source = (id, omit) => {
    const all = {
      id: JSON.stringify(id),
      ext: "'.toml'",
      outName: '(s) => `${s}.toml`',
      requiresOut: 'true',
      render: '() => ""',
    };
    return `export default { ${FIELDS.filter((f) => f !== omit).map((f) => `${f}: ${all[f]}`).join(', ')} };\n`;
  };

  test('exposes the claude and opencode targets', () => {
    expect(targetIds()).toEqual(expect.arrayContaining(['claude', 'opencode']));
    expect(Object.keys(TARGETS).sort()).toEqual([...targetIds()].sort());
    for (const id of targetIds()) for (const f of FIELDS) expect(TARGETS[id][f]).toBeDefined();
  });

  test('describes claude and opencode the way the CLI needs them', () => {
    expect(TARGETS.claude).toBe(claude);
    expect(TARGETS.opencode).toBe(opencode);
    expect([claude.ext, claude.outName('chef'), claude.requiresOut]).toEqual(['.md', 'chef.md', false]);
    expect([opencode.ext, opencode.outName('chef'), opencode.requiresOut]).toEqual(['.md', 'chef.md', true]);
  });

  test('target render is the same function output as the named renderer, byte for byte', () => {
    const chef = { sprite: 'chef', role: 'implementer', color: 'red' };
    expect(claude.render(TEMPLATE, chef, { hookRoot: '/home/u/farm' })).toBe(renderAgent(TEMPLATE, chef, { hookRoot: '/home/u/farm' }));
    expect(opencode.render(TEMPLATE, chef, { hookRoot: undefined })).toBe(renderOpenCodeAgent(TEMPLATE, chef));
  });

  test('loads every non-test module of a directory in sorted order, with no registry edit', async () => {
    const dir = fixture({
      'b-second.mjs': source('second'),
      'a-first.mjs': source('first'),
      'skipped.test.mjs': 'throw new Error("a test file must not be imported");\n',
      'notes.txt': 'not a module',
    });
    const loaded = await loadTargets(dir);
    expect(Object.keys(loaded)).toEqual(['first', 'second']);
    expect(loaded.first.outName('chef')).toBe('chef.toml');
  });

  for (const field of FIELDS) {
    test(`throws when a target module has no ${field}`, async () => {
      const dir = fixture({ 'broken.mjs': source('broken', field) });
      await expect(loadTargets(dir)).rejects.toThrow(new RegExp(`broken\\.mjs.*"${field}"`));
    });
  }

  test('throws when a module has no default export or reuses an id', async () => {
    await expect(loadTargets(fixture({ 'none.mjs': 'export const x = 1;\n' }))).rejects.toThrow(/none\.mjs/);
    await expect(loadTargets(fixture({ 'a.mjs': source('same'), 'b.mjs': source('same') }))).rejects.toThrow(/duplicate target id "same"/);
  });
});

describe('CLI through the registry', () => {
  const sprites = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'crew.json'), 'utf8')).map((m) => m.sprite);
  const gen = (...args) => Bun.spawnSync(['bun', GEN, ...args], { cwd: ROOT });
  const text = (buf) => buf.toString();

  test('--clean removes every generated file, leaves a hand-written file, and exits 0', () => {
    expect(gen('--target', 'opencode', '--out', out).exitCode).toBe(0);
    for (const s of sprites) expect(fs.existsSync(at(`${s}.md`))).toBe(true);
    put('mine.md', '---\ndescription: mine\n---\n');
    const r = gen('--target', 'opencode', '--out', out, '--clean');
    expect(r.exitCode).toBe(0);
    for (const s of sprites) {
      expect(fs.existsSync(at(`${s}.md`))).toBe(false);
      expect(text(r.stdout)).toContain(`${s}.md`);
    }
    expect(fs.readFileSync(at('mine.md'), 'utf8')).toBe('---\ndescription: mine\n---\n');
  });

  test('--clean leaves an unmarked file that has a sprite name', () => {
    gen('--target', 'opencode', '--out', out);
    put('chef.md', '---\ndescription: my own chef\n---\n');
    expect(gen('--target', 'opencode', '--out', out, '--clean').exitCode).toBe(0);
    expect(fs.readFileSync(at('chef.md'), 'utf8')).toBe('---\ndescription: my own chef\n---\n');
    expect(fs.existsSync(at('staid.md'))).toBe(false);
  });

  test('--clean cannot be combined with --check', () => {
    const r = gen('--target', 'opencode', '--out', out, '--clean', '--check');
    expect(r.exitCode).toBe(1);
    expect(text(r.stderr)).toContain('--clean');
  });

  test('--clean without --out is refused, so the committed Claude agents are never removed by default', () => {
    const committed = path.join(ROOT, '.claude', 'agents');
    const before = fs.readdirSync(committed).sort();
    const r = gen('--clean');
    expect(r.exitCode).toBe(1);
    expect(text(r.stderr)).toContain('--out');
    expect(fs.readdirSync(committed).sort()).toEqual(before);
  });

  test('--target with an unknown id exits non-zero and lists the valid ids', () => {
    for (const bad of ['nope', 'constructor']) {
      const r = gen('--target', bad, '--out', out);
      expect(r.exitCode).not.toBe(0);
      expect(text(r.stderr)).toContain('claude');
      expect(text(r.stderr)).toContain('opencode');
    }
    expect(fs.existsSync(out)).toBe(false);
  });

  test('--target opencode still needs --out, and --hook-root is for claude only', () => {
    const noOut = gen('--target', 'opencode');
    expect(noOut.exitCode).toBe(1);
    expect(text(noOut.stderr)).toContain('--out');
    const hook = gen('--target', 'opencode', '--out', out, '--hook-root', tmp);
    expect(hook.exitCode).toBe(1);
    expect(text(hook.stderr)).toContain('--hook-root');
  });

  test('the committed .claude/agents output stays byte identical to the generator', () => {
    const r = gen('--check');
    expect(r.exitCode).toBe(0);
    expect(text(r.stdout)).toContain('in sync');
  });
});
