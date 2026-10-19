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
const check = (paths) => planChecks(paths, INDEX);
const EVAL_BASE = 'docs/code-plan/evals/baseline.json';

const names = (plan) => plan.suites.map((s) => s.name);
const suite = (plan, n) => plan.suites.find((s) => s.name === n);
const targeted = (plan) => expect(plan.full).toBe(false);
const testFiles = (plan) => {
  const t = suite(plan, 'tests');
  return t ? t.cmd.slice(4) : [];
};

describe('planChecks', () => {
  test('a changed module selects its own test and those of its transitive importers', () => {
    const plan = check(['scripts/core.mjs']);
    targeted(plan);
    expect(testFiles(plan)).toEqual(['./scripts/core.test.mjs', './scripts/top.test.mjs']);
    expect(names(plan)).toEqual(['file-size', 'tests', 'copy-rules']);
    expect(plan.suites[1].cmd.slice(0, 4)).toEqual(['bun', 'test', '--timeout', '30000']);
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

  test('a test that names a module only in a comment, or a changed test, is selected', () => {
    const sources = { ...SOURCES, 'scripts/notes.test.mjs': '// exercises scripts/unrelated.mjs through the CLI\n' };
    expect(testFiles(planChecks(['scripts/unrelated.mjs'], { sources }))).toEqual(['./scripts/notes.test.mjs', './scripts/unrelated.test.mjs']);
    expect(testFiles(check(['scripts/unrelated.test.mjs']))).toEqual(['./scripts/unrelated.test.mjs']);
  });

  test('a test that scans its own directory is selected for a change next to it', () => {
    const plan = check(['scripts/lib/leaf.mjs']);
    targeted(plan);
    expect(testFiles(plan)).toEqual(['./scripts/lib/scan.test.mjs']);
  });

  test('a skills file selects validate-skill, the eval last, and the tests that read skills/', () => {
    const plan = check(['skills/demo/SKILL.md']);
    targeted(plan);
    expect(names(plan)).toEqual(['validate-skill', 'file-size', 'tests', 'copy-rules', 'eval']);
    expect(plan.suites.at(-1)).toEqual({ name: 'eval', cmd: ['bun', 'scripts/eval-run.mjs', '--baseline', EVAL_BASE],
      requires: EVAL_BASE, reasons: ['skills/demo/SKILL.md: skill or agent rules changed'] });
    expect(testFiles(plan)).toEqual(['./scripts/skills-reader.test.mjs']);
  });

  test('a module the validator imports selects validate-skill', () => {
    const plan = check(['scripts/validate-lib.mjs']);
    expect(names(plan)).toContain('validate-skill');
    expect(testFiles(plan)).toEqual(['./scripts/validate-skill.test.mjs']);
  });

  test('a module the agent generator imports selects both agent checks', () => {
    const plan = check(['scripts/sprite-agents/crew.mjs']);
    targeted(plan);
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
    targeted(plan);
    expect(names(plan)).toEqual(['file-size', 'tests', 'copy-rules']);
    expect(testFiles(plan)).toEqual(['./scripts/claude-md.test.mjs']);
  });

  test('an agents file selects validate-agents, gen-sprite-agents --check, and the eval', () => {
    const plan = check(['agents/chef.md']);
    const gen = suite(plan, 'gen-sprite-agents');
    expect(names(plan)).toEqual(['validate-agents', 'gen-sprite-agents', 'file-size', 'copy-rules', 'eval']);
    expect(gen.cmd).toEqual(['bun', 'scripts/gen-sprite-agents.mjs', '--check']);
  });

  test('a claude-agents file selects validate-agents and gen-sprite-agents, not the full list', () => {
    const plan = check(['.claude/agents/staid.md']);
    targeted(plan);
    expect(names(plan)).toEqual(['validate-agents', 'gen-sprite-agents', 'file-size', 'copy-rules', 'eval']);
    expect(suite(plan, 'gen-sprite-agents').cmd).toEqual(['bun', 'scripts/gen-sprite-agents.mjs', '--check']);
    expect(plan.skipped.map((s) => s.name)).toEqual(['render-diagrams', 'validate-skill', 'tests', 'sync-snippets']);
  });

  test('a claude-agents file keeps the test that reads it', () => {
    const sources = { ...SOURCES, 'scripts/claude-agents-reader.test.mjs': "assertFileContains('.claude/agents/staid.md', NEEDLE);\n" };
    const plan = planChecks(['.claude/agents/staid.md'], { sources });
    targeted(plan);
    expect(names(plan)).toEqual(['validate-agents', 'gen-sprite-agents', 'file-size', 'tests', 'copy-rules', 'eval']);
    expect(testFiles(plan)).toEqual(['./scripts/claude-agents-reader.test.mjs']);
  });

  test('a path outside every category still forces full beside a claude-agents file', () => {
    const lone = check(['some/unknown/file.xyz']);
    expect(lone.full).toBe(true);
    expect(lone.suites[0].reasons).toEqual(['some/unknown/file.xyz: unrecognized path']);
    const mixed = check(['.claude/agents/staid.md', 'some/unknown/file.xyz']);
    expect(mixed.full).toBe(true);
    expect(mixed.suites[0].reasons).toEqual(['some/unknown/file.xyz: unrecognized path']);
    expect(check(['.claude/settings.json']).full).toBe(true);
  });

  test('a snippets change selects the sync-snippets check', () => {
    const plan = check(['snippets/demo.md']);
    const sync = suite(plan, 'sync-snippets');
    expect(sync.cmd).toEqual(['bun', 'scripts/sync-snippets.mjs', '--check']);
    expect(names(check(['snippets.manifest.json']))).toContain('sync-snippets');
  });

  test('a docs markdown file selects only the docs-gen, file-size, and copy checks', () => {
    const plan = check(['docs/guide.md']);
    targeted(plan);
    expect(names(plan)).toEqual(['file-size', 'docs-gen', 'docs-warn', 'copy-rules']);
    expect(plan.suites.at(-1).cmd).toEqual(['bun', 'scripts/check-copy-rules.mjs', '--diff', 'origin/main']);
    expect(plan.skipped.map((s) => s.name)).toEqual([
      'render-diagrams', 'validate-skill', 'validate-agents', 'gen-sprite-agents', 'tests', 'sync-snippets',
    ]);
  });

  test('a markdown file whose mermaid block changed selects render-diagrams', () => {
    const plan = planChecks(['docs/guide.md'], { sources: SOURCES, mermaidChanged: ['docs/guide.md'] });
    expect(names(plan)).toEqual(['render-diagrams', 'file-size', 'docs-gen', 'docs-warn', 'copy-rules']);
  });

  test('a diagram source selects render-diagrams', () => {
    expect(names(check(['docs/diagrams-src/lifecycle.mmd']))).toContain('render-diagrams');
    expect(names(check(['mermaid.dark.config.json']))).toContain('render-diagrams');
  });

  test('the copy, size, and both docs checks run with their flags, targeted or full', () => {
    for (const p of ['docs/guide.md', 'bun.lock']) {
      const cmd = (n) => planChecks([p], INDEX, { base: 'u/d' }).suites.find((s) => s.name === n)?.cmd.slice(2);
      expect(['copy-rules', 'file-size', 'docs-gen', 'docs-warn'].map(cmd))
        .toEqual([['--diff', 'u/d'], ['--all', '--base', 'u/d'], ['--check', '--scope', 'en'], ['--warn']]);
    }
  });

  test('bun.lock forces the full ci list', () => {
    const plan = check(['bun.lock']);
    expect(plan.full).toBe(true);
    expect(names(plan)).toEqual([...FULL_CI.map((s) => s.name), 'docs-gen', 'docs-warn', 'copy-rules']);
    expect(plan.suites[0].reasons.join('\n')).toContain('bun.lock');
    expect(plan.skipped).toEqual([]);
  });

  test('package.json, a tsconfig, a git hook, and the installer force full', () => {
    for (const p of ['package.json', 'tsconfig.base.json', '.githooks/pre-commit', 'install.sh', 'install.ps1', 'scripts/install/lib.sh']) {
      expect({ p, full: check([p]).full }).toEqual({ p, full: true });
    }
  });

  test('an unrecognized top-level path or a module no test reaches forces full', () => {
    for (const p of ['Dockerfile', 'scripts/orphan.mjs']) {
      const plan = check([p]);
      expect([plan.full, plan.suites[0].reasons.join('\n').includes(p)]).toEqual([true, true]);
    }
  });

  test('an apps/ path and graphify-out do not force full', () => {
    for (const p of ['apps/other/src/main.rs', 'graphify-out/graph.json']) {
      const plan = check([p]);
      expect([plan.full, names(plan)]).toEqual([false, ['file-size', 'copy-rules']]);
    }
  });

  test('the full list matches the ci script in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(FULL_CI.map((s) => s.cmd.join(' ')).join(' && ')).toBe(pkg.scripts.ci);
  });

  test('file-size runs before the tests and the snippet check', () => {
    const n = names(check(['bun.lock']));
    expect(n.slice(n.indexOf('gen-sprite-agents'), -3)).toEqual(['gen-sprite-agents', 'file-size', 'tests', 'sync-snippets']);
  });

  test('evals scenarios and fixtures select their tests and the eval; evals/README.md is a doc', () => {
    const sources = { 'scripts/eval-scenarios.test.mjs': "join(ROOT, 'evals', 'scenarios')" };
    const plan = planChecks(['evals/scenarios/x.json', 'evals/fixtures/base/package.json'], { sources });
    expect([plan.full, testFiles(plan), names(plan).at(-1)]).toEqual([false, ['./scripts/eval-scenarios.test.mjs'], 'eval']);
    expect(names(planChecks(['evals/README.md'], { sources }))).toEqual(['file-size', 'copy-rules']);
  });

  test('--full adds the eval only when skills/ or agents/ changed', () => {
    const run = (p) => planChecks([p], INDEX, { full: true });
    expect([run('agents/a.md').full, names(run('agents/a.md')).at(-1), names(run('docs/x.md')).at(-1)]).toEqual([true, 'eval', 'copy-rules']);
  });

  test('a docs-only or scripts-only change still runs file-size over the index', () => {
    const plan = planChecks(['docs/x.md'], { sources: {} });
    expect({ full: plan.full, reasons: suite(plan, 'file-size')?.reasons }).toEqual({ full: false, reasons: ['always: a few git calls over the index'] });
    expect(plan.skipped.map((s) => s.name)).not.toContain('file-size');
    const sources = { 'scripts/a.mjs': 'export const a = 1;\n', 'scripts/a.test.mjs': "import './a.mjs';\n" };
    expect(names(planChecks(['scripts/a.mjs'], { sources }))).toEqual(['file-size', 'tests', 'copy-rules']);
  });
});

describe('docs-gen check', () => {
  const docsGen = (plan) => plan.suites.filter((s) => s.name === 'docs-gen');

  for (const p of ['README.md', 'docs/x.md', 'apps/docs/src/main.rs']) {
    test(`a ${p} change adds the docs-gen check and stays targeted`, () => {
      const plan = check([p]);
      const [suite] = docsGen(plan);
      expect([plan.full, suite.reasons.join('\n').includes(p)]).toEqual([false, true]);
    });
  }

  test('several docs paths add a single docs-gen check with one reason each', () => {
    const plan = check(['README.md', 'apps/docs/pages.json', 'docs/x.md']);
    expect(docsGen(plan)).toHaveLength(1);
    expect(docsGen(plan)[0].reasons).toHaveLength(3);
  });

  test('a scripts or docs/code-plan change alone does not add the docs-gen check', () => {
    for (const p of ['scripts/core.mjs', 'docs/code-plan/x.md']) {
      const plan = check([p]);
      expect({ full: plan.full, docsGen: docsGen(plan).length }).toEqual({ full: false, docsGen: 0 });
    }
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

  test('an eval without its baseline reports SKIP and why', () => {
    const out = [];
    const run = (requires, log = quiet) => runSuites([{ name: 'eval', cmd: ['x'], requires }], { root: ROOT, spawn: () => 1, log });
    const { code, results } = run('no/base.json', (l) => out.push(l));
    expect([code, results[0].status, out.join('\n').includes('no/base.json is absent')]).toEqual([0, 'SKIP', true]);
    expect(run('package.json').code).toBe(1);
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

  test('--rencana in a repo with a fake origin prints the chosen suites, eval included, exits 0', () => {
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
      for (const t of [
        'scripts/a.mjs',
        'skills/demo/extra.md',
        'bun scripts/validate-skill.mjs',
        'bun test --timeout 30000 ./scripts/a.test.mjs',
        'bun scripts/check-copy-rules.mjs --diff origin/main',
        'sync-snippets',
        `eval: bun scripts/eval-run.mjs --baseline ${EVAL_BASE}\n    - skills/demo/extra.md: skill or agent`,
      ]) expect(r.stdout).toContain(t);
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

  test('scriptsOnlyChange is true only when scripts alone differs and both sides parse', () => {
    expect(scriptsOnlyChange(pkg({ ci: 'a' }), pkg({ ci: 'a', 'ci:targeted': 'b' }))).toBe(true);
    expect(scriptsOnlyChange(pkg({ ci: 'a' }), pkg({ ci: 'a' }, { dependencies: { a: '2' } }))).toBe(false);
    expect(scriptsOnlyChange(pkg({ ci: 'a' }), '{ broken')).toBe(false);
    expect(scriptsOnlyChange('', pkg({ ci: 'a' }))).toBe(false);
  });

  test('a scripts-only package.json change selects the tests that read it; any other is full', () => {
    const sources = { 'scripts/pkg.test.mjs': "readFileSync('package.json')", 'scripts/other.test.mjs': 'nothing' };
    const plan = planChecks(['package.json'], { sources, packageScriptsOnly: ['package.json'] });
    targeted(plan);
    expect(suite(plan, 'tests').cmd).toContain('./scripts/pkg.test.mjs');
    expect(suite(plan, 'tests').cmd).not.toContain('./scripts/other.test.mjs');
    expect(planChecks(['package.json'], { sources: {} }).full).toBe(true);
  });
});

describe('untracked local file', () => {
  const BAK = 'plan.issues.json.bak-20261012-other-session';

  test('an untracked non-code file outside the recognized paths is ignored, not a full ci reason', () => {
    const plan = planChecks([BAK, 'docs/note.md'], { sources: {}, untracked: [BAK] });
    targeted(plan);
    expect(plan.ignored.map((i) => i.path)).toEqual([BAK]);
  });

  test('the same file tracked, or an untracked code file at an unknown path, still forces the full ci', () => {
    expect(planChecks([BAK], { sources: {} }).full).toBe(true);
    expect(planChecks(['tools/new.mjs'], { sources: {}, untracked: ['tools/new.mjs'] }).full).toBe(true);
  });
});
