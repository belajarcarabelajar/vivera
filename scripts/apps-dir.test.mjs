import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChecks } from './ci-targeted.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-apps-dir-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const write = (dir, rel, body, mode) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, mode === undefined ? undefined : { mode });
};
const withStub = (stubDir) => `${stubDir}${path.delimiter}${process.env.PATH}`;

describe('apps dir: ci-targeted', () => {
  // No sources at all, so only the path itself can keep the plan targeted.
  const INDEX = { sources: {} };
  for (const p of ['apps/docs/src/main.rs', 'apps/docs/pages.json']) {
    test(`a committed ${p} is recognized and does not force the full ci`, () => {
      const plan = planChecks([p], INDEX);
      const reasons = plan.full ? plan.suites[0].reasons : [];
      expect({ path: p, full: plan.full, reasons }).toEqual({ path: p, full: false, reasons: [] });
    });
  }
});

describe('apps dir: walkers', () => {
  const MERMAID_PAGE = '# Page\n\n```mermaid\nflowchart LR\n  A --> B\n```\n';
  // A directory whose name only contains "dist" is not build output and is still walked.
  const WALKED = ['apps/docs/walk-fixture-keep.md', 'walk-fixture/distill/page.md'];
  const NOT_WALKED = ['target/top.md', 'apps/docs/target/debug/build.md', 'apps/docs/dist/index.md', 'walk-fixture/deep/dist/page.md'];

  // A batch call (an .md output) fails, so the shared renderer falls back to one call per block,
  // and each of those writes an SVG. Nothing launches a browser.
  const STUB_MMDC = `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) echo 0.0.0-stub; exit 0 ;;
    -o|--output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$out" in ""|*.md) exit 1 ;; esac
printf '<svg xmlns="http://www.w3.org/2000/svg"><p>stub</p></svg>' > "$out"
`;
  const stubMmdcDir = (name) => {
    const dir = path.join(scratch, name);
    write(dir, 'mmdc', STUB_MMDC, 0o755);
    return dir;
  };

  test('the validate-skill Markdown walker skips target and dist directories at any depth', () => {
    const tree = path.join(scratch, 'validate-tree');
    fs.cpSync(ROOT, tree, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => {
        const rel = path.relative(ROOT, src);
        if (['.git', 'node_modules', 'graphify-out', '.mermaid-tmp'].includes(rel)) return false;
        // Build output a later task may leave in the worktree is large and is not what this test reads.
        return !['target', 'dist'].includes(path.basename(src));
      },
    });
    for (const rel of [...WALKED, ...NOT_WALKED]) write(tree, rel, MERMAID_PAGE);
    // The copy has no node_modules, so yaml resolves from the real tree and bun never fetches it.
    const env = { ...process.env, PATH: withStub(stubMmdcDir('validate-stub')), NODE_PATH: path.join(ROOT, 'node_modules') };
    delete env.PLAN_ISSUES_CONFIG;
    delete env.VIVERA_TIER;
    const r = spawnSync('bun', ['--no-install', path.join(tree, 'scripts', 'validate-skill.mjs')], {
      cwd: tree, encoding: 'utf8', timeout: 120_000, env,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // Every collected block is reported by path, as a render error or as missing accTitle, so a
    // fixture path in the output is a file the walker visited.
    const visited = [...WALKED, ...NOT_WALKED].filter((rel) => out.includes(` in ${rel} [block 1]`)).sort();
    expect(visited).toEqual([...WALKED].sort());
  }, 180_000);

  test('render-diagrams.sh skips target and dist directories at any depth', () => {
    const tree = path.join(scratch, 'render-tree');
    for (const rel of [
      'scripts/render-diagrams.sh', 'scripts/mermaid-batch.mjs', 'scripts/validate-lib.mjs',
      'mermaid.config.json', 'mermaid.dark.config.json', 'puppeteer-config.json', 'docs/diagrams-src/lifecycle.mmd',
    ]) {
      write(tree, rel, read(rel));
    }
    for (const rel of [...WALKED, ...NOT_WALKED]) write(tree, rel, MERMAID_PAGE);
    const r = spawnSync('bash', [path.join(tree, 'scripts', 'render-diagrams.sh')], {
      cwd: tree, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PATH: withStub(stubMmdcDir('render-stub')) },
    });
    expect({ status: r.status, stderr: r.status === 0 ? '' : r.stderr }).toEqual({ status: 0, stderr: '' });
    // One SVG per block, named after the Markdown file it came from, plus the two hero renders.
    expect(fs.readdirSync(path.join(tree, 'diagrams')).sort()).toEqual([
      'apps-docs-walk-fixture-keep-block1.svg', 'lifecycle-dark.svg', 'lifecycle.svg', 'walk-fixture-distill-page-block1.svg',
    ]);
  }, 180_000);
});

describe('apps dir: ignore files', () => {
  const lines = (rel) => read(rel).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  // .dockerignore writes a rooted directory without a trailing slash, as it already does for docs/code-plan.
  const dockerLines = () => lines('.dockerignore').map((l) => l.replace(/\/+$/, ''));

  test('.gitignore names the docs site build output and generated content', () => {
    const want = ['apps/docs/target/', 'apps/docs/dist/', 'apps/docs/content/en/', 'apps/docs/static/generated/'];
    const have = lines('.gitignore');
    expect(want.filter((e) => !have.includes(e))).toEqual([]);
  });

  test('.dockerignore names the same entries rooted at the build context', () => {
    const want = ['apps/docs/target', 'apps/docs/dist', 'apps/docs/content/en', 'apps/docs/static/generated'];
    const have = dockerLines();
    expect(want.filter((e) => !have.includes(e))).toEqual([]);
  });

  test('.dockerignore keeps the whole apps directory out of the image', () => {
    expect(dockerLines()).toContain('apps');
  });
});

describe('apps dir: release archive', () => {
  // Same isolation as release-archive.test.mjs: no real HOME, no user git config, no parent repository.
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(scratch),
  };

  test('an archive of HEAD built with the committed .gitattributes carries no apps/ path', () => {
    const repo = path.join(scratch, 'archive-repo');
    write(repo, '.gitattributes', read('.gitattributes'));
    write(repo, 'keep.txt', 'kept\n');
    write(repo, 'apps/docs/src/main.rs', 'fn main() {}\n');
    write(repo, 'apps/docs/pages.json', '{ "pages": [] }\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) {
      const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
        encoding: 'utf8', env,
      });
      expect({ args, status: r.status, stderr: r.status === 0 ? '' : r.stderr }).toEqual({ args, status: 0, stderr: '' });
    }

    const out = path.join(scratch, 'archive-out');
    const b = spawnSync('bash', [path.join(ROOT, 'scripts', 'release', 'build-archive.sh'), 'v0.1.0', out], {
      encoding: 'utf8', env: { ...env, VIVERA_REPO_DIR: repo },
    });
    expect({ status: b.status, stderr: b.stderr }).toEqual({ status: 0, stderr: '' });
    const entries = spawnSync('tar', ['-tzf', path.join(out, 'vivera-v0.1.0.tar.gz')], { encoding: 'utf8' })
      .stdout.split('\n').filter(Boolean);
    expect(entries).toContain('vivera-v0.1.0/keep.txt');
    expect(entries.filter((e) => e.startsWith('vivera-v0.1.0/apps/'))).toEqual([]);
  });
});
