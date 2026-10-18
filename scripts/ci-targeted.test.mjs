import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL_CI, mermaidBlocks, planChecks, runSuites, scriptsOnlyChange } from './ci-targeted.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'ci-targeted.mjs');

const SOURCES = {
  'scripts/core.mjs': 'export const core = 1;\n',
  'scripts/mid.mjs': "import { core } from './core.mjs';\nexport const mid = core;\n",
  'scripts/top.mjs': "const { mid } = await import('./mid.mjs');\n",
  'scripts/core.test.mjs': "import { core } from './core.mjs';\n",
  'scripts/top.test.mjs': "const CLI = path.join(ROOT, 'scripts', 'top.mjs');\nspawnSync('bun', [CLI]);\n",
  'scripts/unrelated.mjs': 'export const x = 1;\n',
  'scripts/unrelated.test.mjs': "import { x } from './unrelated.mjs';\n",
  'scripts/orphan.mjs': 'export const lonely = true;\n',
  'scripts/skills-reader.test.mjs': "const dir = path.join(ROOT, 'skills');\n",
  'scripts/validate-skill.mjs': "import { lib } from './validate-lib.mjs';\n",
  'scripts/validate-lib.mjs': 'export const lib = 1;\n',
  'scripts/validate-skill.test.mjs': "spawnSync('bun', ['scripts/validate-skill.mjs']);\n",
  'scripts/gen-sprite-agents.mjs': "import { crew } from './sprite-agents/crew.mjs';\n",
  'scripts/sprite-agents/crew.mjs': 'export const crew = [];\n',
  'scripts/gen-sprite-agents.test.mjs': "Bun.spawnSync(['bun', 'scripts/gen-sprite-agents.mjs', '--check']);\n",
  'scripts/lib/leaf.mjs': 'export const leaf = 1;\n',
  'scripts/lib/scan.test.mjs': "const FILES = readdirSync(new URL('./', import.meta.url));\n",
};
const INDEX = { sources: SOURCES };

const names = (plan) => plan.suites.map((s) => s.name);
const testFiles = (plan) => {
  const suite = plan.suites.find((s) => s.name === 'tests');
  return suite ? suite.cmd.slice(4) : [];
};

describe('planChecks', () => {
  test('a changed module selects its own test and those of its transitive importers', () => {
    const plan = planChecks(['scripts/core.mjs'], INDEX);
    expect(plan.full).toBe(false);
    expect(testFiles(plan)).toEqual(['./scripts/core.test.mjs', './scripts/top.test.mjs']);
    expect(names(plan)).toEqual(['file-size', 'tests', 'copy-rules']);
  });

  test('the selected tests run as one bun test invocation with the ci timeout', () => {
    const plan = planChecks(['scripts/core.mjs'], INDEX);
    expect(plan.suites.find((s) => s.name === 'tests').cmd.slice(0, 4)).toEqual(['bun', 'test', '--timeout', '30000']);
  });

  test('a module named only in another module comment does not pull in that module tests', () => {
    const sources = {
      ...SOURCES,
      'scripts/talker.mjs': "// see scripts/core.mjs for the format\n/**\n * Like './core.mjs'.\n */\nexport const t = 1;\n",
      'scripts/talker.sh': '#!/usr/bin/env bash\n# mirrors scripts/core.mjs\necho hi\n',
      'scripts/talker.test.mjs': "import { t } from './talker.mjs';\nspawnSync('bash', ['scripts/talker.sh']);\n",
    };
    expect(testFiles(planChecks(['scripts/core.mjs'], { sources }))).toEqual(['./scripts/core.test.mjs', './scripts/top.test.mjs']);
  });

  test('a module that names a script inside a longer message string is not its dependent', () => {
    const sources = {
      ...SOURCES,
      'scripts/needle.mjs': "const NEEDLES = ['bun scripts/core.mjs --flag', 'core.mjs claim'];\n"
        + "foo(1);\nexport const CONTRACTS = {\n  'a.md': [\n    'core.mjs',\n  ],\n};\n",
      'scripts/needle.test.mjs': "import './needle.mjs';\n",
    };
    expect(testFiles(planChecks(['scripts/core.mjs'], { sources }))).not.toContain('./scripts/needle.test.mjs');
  });

  test('a module that spawns a script by a path literal is its dependent', () => {
    const sources = {
      ...SOURCES,
      'scripts/runner.mjs': "spawnSync('bun', [path.join(HERE, 'core.mjs')]);\n",
      'scripts/runner.test.mjs': "import './runner.mjs';\n",
      'scripts/templ.mjs': 'const p = `${ROOT}/scripts/core.mjs`;\n',
      'scripts/templ.test.mjs': "import './templ.mjs';\n",
      'scripts/wrap.sh': '# runs the core\nbun "$REPO_DIR/scripts/core.mjs" --quiet\n',
      'scripts/wrap.test.mjs': "spawnSync('bash', [path.join(ROOT, 'scripts', 'wrap.sh')]);\n",
    };
    const tests = testFiles(planChecks(['scripts/core.mjs'], { sources }));
    for (const t of ['runner', 'templ', 'wrap']) expect(tests).toContain(`./scripts/${t}.test.mjs`);
  });

  test('a test that names a module only in a comment is still selected', () => {
    const sources = { ...SOURCES, 'scripts/notes.test.mjs': '// exercises scripts/unrelated.mjs through the CLI\n' };
    expect(testFiles(planChecks(['scripts/unrelated.mjs'], { sources }))).toEqual(['./scripts/notes.test.mjs', './scripts/unrelated.test.mjs']);
  });

  test('a changed test file selects itself', () => {
    expect(testFiles(planChecks(['scripts/unrelated.test.mjs'], INDEX))).toEqual(['./scripts/unrelated.test.mjs']);
  });

  test('a test that scans its own directory is selected for a change next to it', () => {
    const plan = planChecks(['scripts/lib/leaf.mjs'], INDEX);
    expect(plan.full).toBe(false);
    expect(testFiles(plan)).toEqual(['./scripts/lib/scan.test.mjs']);
  });

  test('a skills file selects validate-skill and the tests that reference skills/', () => {
    const plan = planChecks(['skills/demo/SKILL.md'], INDEX);
    expect(plan.full).toBe(false);
    expect(names(plan)).toEqual(['validate-skill', 'file-size', 'tests', 'copy-rules']);
    expect(testFiles(plan)).toEqual(['./scripts/skills-reader.test.mjs']);
  });

  test('a module the validator imports selects validate-skill', () => {
    const plan = planChecks(['scripts/validate-lib.mjs'], INDEX);
    expect(names(plan)).toContain('validate-skill');
    expect(testFiles(plan)).toEqual(['./scripts/validate-skill.test.mjs']);
  });

  test('a module the agent generator imports selects both agent checks', () => {
    const plan = planChecks(['scripts/sprite-agents/crew.mjs'], INDEX);
    expect(plan.full).toBe(false);
    expect(names(plan)).toEqual(['validate-agents', 'gen-sprite-agents', 'file-size', 'tests', 'copy-rules']);
    expect(testFiles(plan)).toEqual(['./scripts/gen-sprite-agents.test.mjs']);
  });

  test('a root file a check reads by path literal selects that check, a prose mention does not', () => {
    const reads = { ...SOURCES, 'scripts/validate-lib.mjs': "const MEM = path.join(ROOT, 'MEMORY.md');\n" };
    const prose = { ...SOURCES, 'scripts/validate-lib.mjs': "const HINT = 'see MEMORY.md for the rules';\nconst NEEDLES = ['MEMORY.md'];\n" };
    expect(names(planChecks(['MEMORY.md'], { sources: reads }))).toEqual(['validate-skill', 'file-size', 'copy-rules']);
    expect(names(planChecks(['MEMORY.md'], { sources: prose }))).toEqual(['file-size', 'copy-rules']);
  });

  test('a CLAUDE.md change selects the tests that name it instead of the full list', () => {
    const sources = { ...SOURCES, 'scripts/claude-md.test.mjs': "writeFileSync(join(root, 'CLAUDE.md'), text);\n" };
    const plan = planChecks(['CLAUDE.md'], { sources });
    expect(plan.full).toBe(false);
    expect(names(plan)).toEqual(['file-size', 'tests', 'copy-rules']);
    expect(testFiles(plan)).toEqual(['./scripts/claude-md.test.mjs']);
  });

  test('an agents file selects validate-agents and gen-sprite-agents --check', () => {
    const plan = planChecks(['agents/chef.md'], INDEX);
    const gen = plan.suites.find((s) => s.name === 'gen-sprite-agents');
    expect(names(plan)).toEqual(['validate-agents', 'gen-sprite-agents', 'file-size', 'copy-rules']);
    expect(gen.cmd).toEqual(['bun', 'scripts/gen-sprite-agents.mjs', '--check']);
  });

  test('a claude-agents file selects validate-agents and gen-sprite-agents, not the full list', () => {
    const plan = planChecks(['.claude/agents/staid.md'], INDEX);
    expect(plan.full).toBe(false);
    expect(names(plan)).toEqual(['validate-agents', 'gen-sprite-agents', 'file-size', 'copy-rules']);
    expect(plan.suites.find((s) => s.name === 'gen-sprite-agents').cmd).toEqual(['bun', 'scripts/gen-sprite-agents.mjs', '--check']);
    expect(plan.skipped.map((s) => s.name)).toEqual(['render-diagrams', 'validate-skill', 'tests', 'sync-snippets']);
  });

  test('a claude-agents file keeps the test that reads it', () => {
    const sources = { ...SOURCES, 'scripts/claude-agents-reader.test.mjs': "assertFileContains('.claude/agents/staid.md', NEEDLE);\n" };
    const plan = planChecks(['.claude/agents/staid.md'], { sources });
    expect(plan.full).toBe(false);
    expect(names(plan)).toEqual(['validate-agents', 'gen-sprite-agents', 'file-size', 'tests', 'copy-rules']);
    expect(testFiles(plan)).toEqual(['./scripts/claude-agents-reader.test.mjs']);
  });

  test('a path outside every category still forces full beside a claude-agents file', () => {
    const lone = planChecks(['some/unknown/file.xyz'], INDEX);
    expect(lone.full).toBe(true);
    expect(lone.suites[0].reasons).toEqual(['some/unknown/file.xyz: unrecognized path']);
    const mixed = planChecks(['.claude/agents/staid.md', 'some/unknown/file.xyz'], INDEX);
    expect(mixed.full).toBe(true);
    expect(mixed.suites[0].reasons).toEqual(['some/unknown/file.xyz: unrecognized path']);
    expect(planChecks(['.claude/settings.json'], INDEX).full).toBe(true);
  });

  test('a snippets change selects the sync-snippets check', () => {
    const plan = planChecks(['snippets/demo.md'], INDEX);
    const sync = plan.suites.find((s) => s.name === 'sync-snippets');
    expect(sync.cmd).toEqual(['bun', 'scripts/sync-snippets.mjs', '--check']);
    expect(names(planChecks(['snippets.manifest.json'], INDEX))).toContain('sync-snippets');
  });

  test('a docs markdown file selects only the docs-gen, file-size, and copy checks', () => {
    const plan = planChecks(['docs/guide.md'], INDEX);
    expect(plan.full).toBe(false);
    expect(names(plan)).toEqual(['file-size', 'docs-gen', 'copy-rules']);
    expect(plan.suites.at(-1).cmd).toEqual(['bun', 'scripts/check-copy-rules.mjs', '--diff', 'origin/main']);
    expect(plan.skipped.map((s) => s.name)).toEqual([
      'render-diagrams', 'validate-skill', 'validate-agents', 'gen-sprite-agents', 'tests', 'sync-snippets',
    ]);
  });

  test('a markdown file whose mermaid block changed selects render-diagrams', () => {
    const plan = planChecks(['docs/guide.md'], { sources: SOURCES, mermaidChanged: ['docs/guide.md'] });
    expect(names(plan)).toEqual(['render-diagrams', 'file-size', 'docs-gen', 'copy-rules']);
  });

  test('a diagram source selects render-diagrams', () => {
    expect(names(planChecks(['docs/diagrams-src/lifecycle.mmd'], INDEX))).toContain('render-diagrams');
    expect(names(planChecks(['mermaid.dark.config.json'], INDEX))).toContain('render-diagrams');
  });

  test('copy-rules and file-size use the given base, targeted or full', () => {
    for (const p of ['docs/guide.md', 'bun.lock']) {
      const cmd = (n) => planChecks([p], INDEX, { base: 'u/d' }).suites.find((s) => s.name === n).cmd.slice(2);
      expect([cmd('copy-rules'), cmd('file-size')]).toEqual([['--diff', 'u/d'], ['--all', '--base', 'u/d']]);
    }
  });

  test('bun.lock forces the full ci list', () => {
    const plan = planChecks(['bun.lock'], INDEX);
    expect(plan.full).toBe(true);
    expect(names(plan)).toEqual([...FULL_CI.map((s) => s.name), 'copy-rules']);
    expect(plan.suites[0].reasons.join('\n')).toContain('bun.lock');
    expect(plan.skipped).toEqual([]);
  });

  test('package.json, a tsconfig, a git hook, and the installer force full', () => {
    for (const p of ['package.json', 'tsconfig.base.json', '.githooks/pre-commit', 'install.sh', 'install.ps1', 'scripts/install/lib.sh']) {
      expect({ p, full: planChecks([p], INDEX).full }).toEqual({ p, full: true });
    }
  });

  test('an unrecognized top-level path forces full', () => {
    const plan = planChecks(['Dockerfile'], INDEX);
    expect(plan.full).toBe(true);
    expect(plan.suites[0].reasons.join('\n')).toContain('Dockerfile');
  });

  test('a path under apps/ is recognized and does not force full', () => {
    const plan = planChecks(['apps/other/src/main.rs'], INDEX);
    expect(plan.full).toBe(false);
    expect(names(plan)).toEqual(['file-size', 'copy-rules']);
  });

  test('a module that no test reaches forces full', () => {
    const plan = planChecks(['scripts/orphan.mjs'], INDEX);
    expect(plan.full).toBe(true);
    expect(plan.suites[0].reasons.join('\n')).toContain('scripts/orphan.mjs');
  });

  test('graphify-out is ignored', () => {
    const plan = planChecks(['graphify-out/graph.json'], INDEX);
    expect(plan.full).toBe(false);
    expect(names(plan)).toEqual(['file-size', 'copy-rules']);
  });

  test('the full list matches the ci script in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(FULL_CI.map((s) => s.cmd.join(' ')).join(' && ')).toBe(pkg.scripts.ci);
  });

  test('file-size runs before the tests and the snippet check', () => {
    const n = names(planChecks(['bun.lock'], INDEX));
    expect(n.slice(n.indexOf('gen-sprite-agents'), -1)).toEqual(['gen-sprite-agents', 'file-size', 'tests', 'sync-snippets']);
  });

  test('a docs-only change still runs file-size over the index', () => {
    const plan = planChecks(['docs/x.md'], { sources: {} });
    const suite = plan.suites.find((s) => s.name === 'file-size');
    expect({ full: plan.full, reasons: suite?.reasons }).toEqual({ full: false, reasons: ['always: a few git calls over the index'] });
    expect(plan.skipped.map((s) => s.name)).not.toContain('file-size');
  });

  test('a scripts-only change still runs file-size', () => {
    const sources = { 'scripts/a.mjs': 'export const a = 1;\n', 'scripts/a.test.mjs': "import './a.mjs';\n" };
    const plan = planChecks(['scripts/a.mjs'], { sources });
    expect({ full: plan.full, names: names(plan) }).toEqual({ full: false, names: ['file-size', 'tests', 'copy-rules'] });
  });
});

describe('docs-gen check', () => {
  const DOCS_GEN_CMD = ['bun', 'scripts/docs-gen.mjs', '--check', '--scope', 'en'];
  const docsGen = (plan) => plan.suites.filter((s) => s.name === 'docs-gen');

  for (const p of ['README.md', 'docs/x.md', 'apps/docs/src/main.rs']) {
    test(`a ${p} change adds the docs-gen check and stays targeted`, () => {
      const plan = planChecks([p], INDEX);
      const [suite] = docsGen(plan);
      expect({ full: plan.full, cmd: suite?.cmd }).toEqual({ full: false, cmd: DOCS_GEN_CMD });
      expect(suite.reasons.join('\n')).toContain(p);
    });
  }

  test('several docs paths add a single docs-gen check with one reason each', () => {
    const plan = planChecks(['README.md', 'apps/docs/pages.json', 'docs/x.md'], INDEX);
    expect(docsGen(plan)).toHaveLength(1);
    expect(docsGen(plan)[0].reasons).toHaveLength(3);
  });

  test('a scripts change alone does not add the docs-gen check', () => {
    const sources = { ...SOURCES, 'scripts/foo.mjs': 'export const foo = 1;\n', 'scripts/foo.test.mjs': "import './foo.mjs';\n" };
    const plan = planChecks(['scripts/foo.mjs'], { sources });
    expect({ full: plan.full, docsGen: docsGen(plan).length }).toEqual({ full: false, docsGen: 0 });
  });

  test('a docs/code-plan change alone does not add the docs-gen check', () => {
    const plan = planChecks(['docs/code-plan/x.md'], INDEX);
    expect({ full: plan.full, docsGen: docsGen(plan).length }).toEqual({ full: false, docsGen: 0 });
  });
});

describe('mermaidBlocks', () => {
  test('extracts fenced mermaid blocks and ignores other fences', () => {
    const md = 'x\n```mermaid\ngraph TD\nA-->B\n```\n```js\nconst a = 1;\n```\n';
    expect(mermaidBlocks(md)).toEqual(['graph TD\nA-->B\n']);
  });
});

describe('runSuites', () => {
  const quiet = () => {};

  test('all suites passing is exit 0', () => {
    const { code, results } = runSuites([{ name: 'a', cmd: ['true'] }], { root: ROOT, spawn: () => 0, log: quiet });
    expect(code).toBe(0);
    expect(results[0].status).toBe('PASS');
  });

  test('a suite that cannot start is a failure, never a pass', () => {
    const spawn = () => { throw new Error('ENOENT'); };
    const { code, results } = runSuites([{ name: 'a', cmd: ['missing'] }], { root: ROOT, spawn, log: quiet });
    expect(code).toBe(1);
    expect(results[0].status).toBe('FAIL');
  });

  test('a failing suite does not stop the next one, and the run exits 1', () => {
    const seen = [];
    const spawn = (cmd) => { seen.push(cmd[0]); return cmd[0] === 'bad' ? 3 : 0; };
    const { code } = runSuites([{ name: 'a', cmd: ['bad'] }, { name: 'b', cmd: ['good'] }], { root: ROOT, spawn, log: quiet });
    expect(seen).toEqual(['bad', 'good']);
    expect(code).toBe(1);
  });
});

describe('CLI', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const cli = (...args) => spawnSync('bun', [CLI, ...args], { env, encoding: 'utf8' });

  test('--rencana in a repo with a fake origin prints the chosen suites and exits 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-targeted-'));
    try {
      write(dir, 'scripts/a.mjs', 'export const a = 1;\n');
      write(dir, 'scripts/a.test.mjs', "import { a } from './a.mjs';\n");
      write(dir, 'skills/demo/SKILL.md', '# demo\n');
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'init');
      git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      write(dir, 'scripts/a.mjs', 'export const a = 2;\n');
      write(dir, 'skills/demo/extra.md', '# extra\n');

      const r = cli('--rencana', '--root', dir);
      expect({ code: r.status, stderr: r.stderr }).toEqual({ code: 0, stderr: '' });
      expect(r.stdout).toContain('scripts/a.mjs');
      expect(r.stdout).toContain('skills/demo/extra.md');
      expect(r.stdout).toContain('bun scripts/validate-skill.mjs');
      expect(r.stdout).toContain('bun test --timeout 30000 ./scripts/a.test.mjs');
      expect(r.stdout).toContain('bun scripts/check-copy-rules.mjs --diff origin/main');
      expect(r.stdout).toContain('sync-snippets');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown flag exits 2', () => {
    const r = cli('--nope');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
  });

  test('a base that does not resolve exits 2', () => {
    const r = cli('--plan', '--root', ROOT, '--base', 'no-such-ref-for-ci-targeted');
    expect(r.status).toBe(2);
  });

  test('a missing --root exits 2 and names the path', () => {
    const r = cli('--plan', '--root', '/nonexistent/x');
    expect([r.status, r.stderr.includes('/nonexistent/x')]).toEqual([2, true]);
  });
});

describe('package.json limited to scripts', () => {
  const pkg = (scripts, extra = {}) => JSON.stringify({ name: 'x', dependencies: { a: '1' }, ...extra, scripts }, null, 2);

  test('scriptsOnlyChange is true when only the scripts field differs', () => {
    expect(scriptsOnlyChange(pkg({ ci: 'a' }), pkg({ ci: 'a', 'ci:targeted': 'b' }))).toBe(true);
  });

  test('scriptsOnlyChange is false when anything outside scripts differs, or a side does not parse', () => {
    expect(scriptsOnlyChange(pkg({ ci: 'a' }), pkg({ ci: 'a' }, { dependencies: { a: '2' } }))).toBe(false);
    expect(scriptsOnlyChange(pkg({ ci: 'a' }), '{ broken')).toBe(false);
    expect(scriptsOnlyChange('', pkg({ ci: 'a' }))).toBe(false);
  });

  test('a scripts-only package.json change is targeted, selecting the tests that read package.json', () => {
    const sources = { 'scripts/pkg.test.mjs': "readFileSync('package.json')", 'scripts/other.test.mjs': 'nothing' };
    const plan = planChecks(['package.json'], { sources, packageScriptsOnly: ['package.json'] });
    expect(plan.full).toBe(false);
    expect(plan.suites.find((s) => s.name === 'tests').cmd).toContain('./scripts/pkg.test.mjs');
    expect(plan.suites.find((s) => s.name === 'tests').cmd).not.toContain('./scripts/other.test.mjs');
  });

  test('any other package.json change still selects the full ci', () => {
    expect(planChecks(['package.json'], { sources: {} }).full).toBe(true);
  });
});

describe('untracked local file', () => {
  const BAK = 'plan.issues.json.bak-20261012-other-session';

  test('an untracked non-code file outside the recognized paths is ignored, not a full ci reason', () => {
    const plan = planChecks([BAK, 'docs/note.md'], { sources: {}, untracked: [BAK] });
    expect(plan.full).toBe(false);
    expect(plan.ignored.map((i) => i.path)).toEqual([BAK]);
  });

  test('the same file tracked still forces the full ci', () => {
    expect(planChecks([BAK], { sources: {} }).full).toBe(true);
  });

  test('an untracked code file at an unknown path still forces the full ci', () => {
    expect(planChecks(['tools/new.mjs'], { sources: {}, untracked: ['tools/new.mjs'] }).full).toBe(true);
  });
});
