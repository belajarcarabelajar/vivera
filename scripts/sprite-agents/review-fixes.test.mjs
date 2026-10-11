// Pins the fixes for an independent review of the sprite generator (F1, F2, F5, F6, F11).
// Every test runs inside its own scratch directory; the generator never writes anywhere else.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './registry.mjs';
import { MARKER, isGenerated, syncDir } from './sync.mjs';
import { renderAgent } from './targets/claude.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gen-sprite-agents.mjs');

const IMPLEMENTER = [
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
const REVIEWER = '---\ndescription: Audits a diff.\ntools: Read, Grep\n---\n\nYou check a claim.\n';
const CREW = [
  { sprite: 'chef', role: 'implementer', color: 'red' },
  { sprite: 'hoggy', role: 'implementer', color: 'yellow' },
  { sprite: 'staid', role: 'reviewer', color: 'cyan' },
];

let tmp;
let rolesDir;
let crewFile;
let outDir;
let cwd;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fixes-'));
  rolesDir = path.join(tmp, 'roles');
  crewFile = path.join(tmp, 'crew.json');
  outDir = path.join(tmp, 'out');
  cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(rolesDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(rolesDir, 'implementer.md'), IMPLEMENTER);
  fs.writeFileSync(path.join(rolesDir, 'reviewer.md'), REVIEWER);
  fs.writeFileSync(crewFile, JSON.stringify(CREW));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The working directory is a scratch one, so a path the generator creates by mistake lands there.
function gen(args, where = cwd) {
  const r = Bun.spawnSync(['bun', SCRIPT, ...args], { cwd: where });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const base = () => ['--roles', rolesDir, '--crew', crewFile, '--out', outDir];
const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const at = (...parts) => path.join(outDir, ...parts);
// A file the marker rule counts as generated, in the format of the target's extension.
const marked = (ext) => (ext === '.toml' ? `${MARKER} from a test.\nname = "x"\n` : `---\nname: x\n${MARKER} from a test.\n---\n`);
const mine = '---\nname: mine\ndescription: written by hand\n---\n';

describe('F1: a value flag never takes another flag as its value', () => {
  for (const flag of ['--out', '--roles', '--crew', '--hook-root', '--target']) {
    test(`${flag} --check is refused, exit 1, nothing written`, () => {
      // Every other value flag gets a real value, so the swallowed flag is the only fault.
      const given = { '--roles': rolesDir, '--crew': crewFile, '--out': outDir };
      const args = Object.entries(given)
        .filter(([f]) => f !== flag)
        .flat();
      const r = gen([...args, flag, '--check']);
      expect(r.err).toContain(`${flag} needs a value (got --check)`);
      expect(r.code).toBe(1);
      expect(fs.readdirSync(cwd)).toEqual([]);
      expect(fs.existsSync(outDir)).toBe(false);
    });
  }

  test('a value that is the bare "--" is refused too', () => {
    const r = gen([...base().slice(0, 4), '--out', '--']);
    expect(r.err).toContain('--out needs a value (got --)');
    expect(r.code).toBe(1);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  test('a plain path that starts with a single dash stays allowed', () => {
    const r = gen([...base().slice(0, 4), '--out', '-out']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(cwd, '-out', 'chef.md'))).toBe(true);
  });
});

describe('F2: the scan depth follows the layout of the target', () => {
  const FLAT = ['claude', 'opencode', 'codex', 'cursor', 'copilot'];

  describe('syncDir', () => {
    test('a flat sync leaves a marked file in a subdirectory, and the directory, alone', () => {
      put(at('sub', 'other.md'), marked('.md'));
      const r = syncDir(outDir, new Map(), { nested: false });
      expect(r.removed).toEqual([]);
      expect(fs.existsSync(at('sub', 'other.md'))).toBe(true);
    });

    test('flat is the default, so a caller that says nothing cannot reach into a subdirectory', () => {
      put(at('sub', 'other.md'), marked('.md'));
      expect(syncDir(outDir, new Map()).removed).toEqual([]);
      expect(fs.existsSync(at('sub', 'other.md'))).toBe(true);
    });

    test('a flat sync still removes a stale marked file at the top level', () => {
      put(at('old.md'), marked('.md'));
      expect(syncDir(outDir, new Map(), { nested: false }).removed).toEqual(['old.md']);
    });

    test('a directory named like an output is refused and its marked contents survive', () => {
      put(at('chef.md', 'inner.md'), marked('.md'));
      const r = syncDir(outDir, new Map([['chef.md', marked('.md')]]), { nested: false });
      expect(r.refused).toEqual(['chef.md']);
      expect(r.inTheWay).toEqual(['chef.md']);
      expect(r.removed).toEqual([]);
      expect(fs.existsSync(at('chef.md', 'inner.md'))).toBe(true);
    });

    test('a nested sync still removes a stale <dir>/<file> and the emptied directory', () => {
      put(at('old', 'agent.md'), marked('.md'));
      const r = syncDir(outDir, new Map([['chef/agent.md', marked('.md')]]), { nested: true });
      expect(r.removed).toEqual(['old/agent.md']);
      expect(fs.existsSync(at('old'))).toBe(false);
    });
  });

  for (const id of FLAT) {
    describe(`target ${id} (flat)`, () => {
      const ext = TARGETS[id].ext;
      const outFile = TARGETS[id].outName('chef');
      const args = () => [...base(), '--target', id];

      test('a normal run leaves a marked file in a user subdirectory alone', () => {
        put(at('sub', `other${ext}`), marked(ext));
        const r = gen(args());
        expect(r.code).toBe(0);
        expect(fs.existsSync(at('sub', `other${ext}`))).toBe(true);
        expect(fs.existsSync(at(outFile))).toBe(true);
      });

      test('--clean removes the marked top-level file and leaves the subdirectory alone', () => {
        expect(gen(args()).code).toBe(0);
        put(at('sub', `other${ext}`), marked(ext));
        const r = gen([...args(), '--clean']);
        expect(r.code).toBe(0);
        expect(fs.existsSync(at(outFile))).toBe(false);
        expect(fs.existsSync(at('sub', `other${ext}`))).toBe(true);
      });

      test('a directory named like an output is reported in the way and nothing in it is removed', () => {
        put(at(outFile, `inner${ext}`), marked(ext));
        const r = gen(args());
        expect(r.err).toContain(`${at(outFile)}: something that is not a generated file is in the way, left untouched`);
        expect(r.code).toBe(1);
        expect(fs.existsSync(at(outFile, `inner${ext}`))).toBe(true);
      });
    });
  }

  describe('target antigravity (<sprite>/agent.md)', () => {
    const args = () => [...base(), '--target', 'antigravity'];

    test('a stale marked <sprite>/agent.md goes, with its emptied directory', () => {
      put(at('gone', 'agent.md'), marked('.md'));
      const r = gen(args());
      expect(r.code).toBe(0);
      expect(fs.existsSync(at('gone'))).toBe(false);
      expect(fs.existsSync(at('chef', 'agent.md'))).toBe(true);
    });

    test('--clean removes every generated <sprite>/agent.md and its directory', () => {
      expect(gen(args()).code).toBe(0);
      const r = gen([...args(), '--clean']);
      expect(r.code).toBe(0);
      expect(fs.existsSync(at('chef'))).toBe(false);
      expect(r.out).toContain('3 generated file(s) removed');
    });
  });
});

describe('F5: a refused run still reports what it wrote and removed', () => {
  test('prints the removed lines and the summary, then exits 1, with the refusal line unchanged', () => {
    put(at('chef.md'), mine);
    put(at('old.md'), marked('.md'));
    const r = gen(base());
    expect(r.code).toBe(1);
    expect(r.err).toBe(`${at('chef.md')}: not generated by this script, left untouched\n`);
    expect(r.out).toContain(`removed ${at('old.md')}`);
    expect(r.out).toContain(`sprite agent(s) in ${outDir}: 2 written, 1 removed, 1 refused`);
    // The summary is true: the other two sprites are on disk, the stale one is gone, the user's file is intact.
    expect(fs.existsSync(at('hoggy.md'))).toBe(true);
    expect(fs.existsSync(at('staid.md'))).toBe(true);
    expect(fs.existsSync(at('old.md'))).toBe(false);
    expect(fs.readFileSync(at('chef.md'), 'utf8')).toBe(mine);
  });

  test('a clean run keeps its summary exactly as before', () => {
    const r = gen(base());
    expect(r.code).toBe(0);
    expect(r.out).toBe(`3 sprite agent(s) in ${outDir}: 3 written, 0 removed\n`);
  });

  test('--check keeps its order: refusals, then drift lines, then the out-of-date line, and prints no summary', () => {
    put(at('chef.md'), mine);
    const r = gen([...base(), '--check']);
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toEqual([
      `${at('chef.md')}: not generated by this script, left untouched`,
      `${at('hoggy.md')}: missing`,
      `${at('staid.md')}: missing`,
      'sprite agents are out of date: run ./install.sh --update',
    ]);
    expect(r.out).toBe('');
    expect(fs.existsSync(at('hoggy.md'))).toBe(false);
  });
});

describe('F6: a hook root holds no control character', () => {
  const chef = CREW[0];
  const bad = { CR: '/a\rb', LF: '/a\nb', TAB: '/a\tb', NUL: '/a\x00b', US: '/a\x1fb', ESC: '/a\x1bb', DEL: '/a\x7fb' };

  for (const [name, root] of Object.entries(bad)) {
    test(`renderAgent refuses a hook root with ${name}`, () => {
      expect(() => renderAgent(IMPLEMENTER, chef, { hookRoot: root })).toThrow(/hook root.*control characters/);
    });
  }

  test('a space and a non-ASCII letter in the root stay allowed', () => {
    expect(() => renderAgent(IMPLEMENTER, chef, { hookRoot: '/home/u/my farm/caf\u00e9' })).not.toThrow();
  });

  test('--hook-root naming a real directory with a carriage return is refused and writes nothing', () => {
    const root = path.join(tmp, 'a\rb');
    put(path.join(root, '.claude', 'hooks', 'block-git-writes.mjs'), '');
    const r = gen([...base(), '--hook-root', root]);
    expect(r.err).toContain('control characters');
    expect(r.code).toBe(1);
    expect(fs.existsSync(outDir)).toBe(false);
  });
});

describe('F11: the comments in sync.mjs describe what the code does', () => {
  test('a Markdown file that opens with the marker line, without frontmatter, counts as generated', () => {
    // The first-line form is not TOML only: any file that does not open with "---" is judged by its first line.
    put(path.join(tmp, 'plain.md'), `${MARKER} from a test.\n\nbody\n`);
    expect(isGenerated(path.join(tmp, 'plain.md'))).toBe(true);
    put(path.join(tmp, 'quoted.md'), `intro\n${MARKER} from a test.\n`);
    expect(isGenerated(path.join(tmp, 'quoted.md'))).toBe(false);
  });

  test('a case variant of an output that already exists is left alone, neither refused nor removed', () => {
    // It is refused only while the output path is free. Skipped on a filesystem that folds case.
    put(at('chef.md'), marked('.md'));
    // On a case-folding filesystem CHEF.md resolves to chef.md, so there is no second file to observe.
    if (fs.existsSync(at('CHEF.md'))) return;
    put(at('Chef.md'), marked('.md'));
    const r = syncDir(outDir, new Map([['chef.md', marked('.md')]]));
    expect(r.refused).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(at('Chef.md'))).toBe(true);
  });
});
