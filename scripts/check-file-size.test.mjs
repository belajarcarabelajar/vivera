import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LIMIT_BYTES, exitCodeFor, fileKind, judge, renderReport, staleCeilings, tightenBaseline, tokensOf,
} from './check-file-size.mjs';
import { GitError } from './lib/git.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-file-size.mjs');
const BASELINE = 'scripts/file-size-baseline.json';
// A host-wide git config (hooks, signing, attributes, ignores) must not leak into
// the fixtures, and the ceiling stops discovery from walking up into a parent repo.
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
};

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-gate-'));
  dirs.push(dir);
  return dir;
}

function repo() {
  const dir = tmpDir();
  git(dir, 'init', '-q');
  return dir;
}

function put(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof body === 'number' ? 'x'.repeat(body) : body);
  }
}

function stage(dir, files) {
  put(dir, files);
  git(dir, 'add', '-f', '--', ...Object.keys(files));
}

// Staged, because --staged and --all read the ceilings from the index.
function baseline(dir, obj) {
  stage(dir, { [BASELINE]: typeof obj === 'string' ? obj : JSON.stringify(obj) });
}

const lastLine = (s) => s.trimEnd().split('\n').pop();

describe('tokensOf', () => {
  test('rounds a partial token up at every boundary', () => {
    expect([0, 1, 4, 5, 8, 20000, 20001].map(tokensOf)).toEqual([0, 1, 1, 2, 2, 5000, 5001]);
  });

  test('the limit is 20000 bytes', () => {
    expect(LIMIT_BYTES).toBe(20000);
  });
});

describe('fileKind', () => {
  test('maps paths to the advice kind by name and extension', () => {
    const table = {
      'scripts/foo.test.mjs': 'test',
      'apps/x/a.test.ts': 'test',
      'scripts/foo.mjs': 'code',
      'a.js': 'code', 'a.cjs': 'code', 'a.ts': 'code', 'a.sh': 'code', 'a.py': 'code', 'a.rs': 'code',
      'skills/sucp-rules/SKILL.md': 'skill',
      'README.md': 'markdown',
      'docs/guide.md': 'markdown',
      'a.json': 'data', 'a.yaml': 'data', 'a.yml': 'data', 'a.tsv': 'data', 'a.csv': 'data',
      'LICENSE': 'other',
      'a.txt': 'other',
    };
    for (const [p, kind] of Object.entries(table)) expect([p, fileKind(p)]).toEqual([p, kind]);
  });
});

describe('judge', () => {
  test('a file of exactly the limit passes and one byte more fails', () => {
    const r = judge([{ path: 'a.txt', bytes: 20000 }, { path: 'b.txt', bytes: 20001 }], null);
    expect(r.checked).toBe(2);
    expect(r.violations.map((v) => v.path)).toEqual(['b.txt']);
  });

  test('a file under its ceiling passes and one above it fails with the ceiling', () => {
    const r = judge([{ path: 'a.md', bytes: 30000 }, { path: 'b.md', bytes: 30004 }], { 'a.md': 30000, 'b.md': 30000 });
    expect(r.violations).toEqual([{ path: 'b.md', bytes: 30004, ceiling: 30000 }]);
  });
});

describe('staleCeilings', () => {
  test('flags a gone path, a path back within the limit, and a shrunk path', () => {
    const entries = [
      { path: 'small.txt', bytes: 100 },
      { path: 'shrunk.txt', bytes: 25000 },
      { path: 'same.txt', bytes: 30000 },
    ];
    const stale = staleCeilings(entries, { 'gone.txt': 30000, 'small.txt': 30000, 'shrunk.txt': 30000, 'same.txt': 30000 });
    expect(stale.map((s) => [s.path, s.reason])).toEqual([
      ['gone.txt', 'gone'],
      ['shrunk.txt', 'shrunk'],
      ['small.txt', 'within-limit'],
    ]);
  });
});

describe('tightenBaseline', () => {
  test('seeds every file over the limit when there is no baseline', () => {
    const entries = [{ path: 'b.txt', bytes: 22000 }, { path: 'a.txt', bytes: 25000 }, { path: 'c.txt', bytes: 100 }];
    expect(tightenBaseline(entries, null)).toEqual({ 'a.txt': 25000, 'b.txt': 22000 });
  });

  test('never adds a path and never raises a ceiling', () => {
    const entries = [
      { path: 'grew.txt', bytes: 26000 },
      { path: 'shrunk.txt', bytes: 21000 },
      { path: 'new.txt', bytes: 30000 },
      { path: 'under.txt', bytes: 900 },
    ];
    const next = tightenBaseline(entries, { 'grew.txt': 25000, 'shrunk.txt': 22000, 'under.txt': 25000, 'gone.txt': 25000 });
    expect(next).toEqual({ 'grew.txt': 25000, 'shrunk.txt': 21000 });
  });
});

describe('renderReport', () => {
  test('matches the layout in the plan', () => {
    const text = renderReport([
      { path: 'scripts/foo.mjs', bytes: 24480, ceiling: null },
      { path: 'README.md', bytes: 197200, ceiling: 196864 },
    ]);
    expect(text).toBe([
      '[size-gate] blocked: 2 staged files are over 5000 tokens (tokens = bytes / 4, limit 20000 bytes)',
      '  scripts/foo.mjs   6120 tokens (24480 bytes), no ceiling',
      '  README.md        49300 tokens (197200 bytes), ceiling 49216 tokens, grew by 84 tokens',
      '',
      'How to split a code file (scripts/foo.mjs):',
      '  Move one cohesive group of functions (parsing, git I/O, rendering) into scripts/lib/<name>-<part>.mjs,',
      '  export it, and import it back. Keep argument parsing and main() in the original file, and re-export',
      '  anything callers import from the old path so tests and other scripts keep working.',
      '',
      'How to split a Markdown file (README.md):',
      '  Split at H2 headings into sibling files and keep a short index of links in the original.',
      '  For README.md, update the page map in apps/docs/pages.json and run: bun scripts/docs-gen.mjs --check --scope all',
      '',
      'After splitting:',
      "  1. git grep -n '<old path>' and update every reference (scripts/validate-skill.mjs pins skill paths,",
      '     scripts/ci-targeted.mjs and README.md name scripts).',
      '  2. Stage the new files and commit again.',
      "If the file is a lockfile, generated, or vendored: add '<path> -size-gate' to .gitattributes instead.",
      'If splitting is out of scope for this change: raise its ceiling in scripts/file-size-baseline.json in this',
      '  commit and name the follow-up in the PR body. The raise is visible in review.',
      'A renamed file counts as new: move its ceiling to the new path in the same commit.',
    ].join('\n'));
  });

  test('prints one advice block per kind, naming every path of that kind', () => {
    const text = renderReport([
      { path: 'a.test.mjs', bytes: 30000, ceiling: null },
      { path: 'b.test.mjs', bytes: 30000, ceiling: null },
      { path: 'skills/x/SKILL.md', bytes: 30000, ceiling: null },
    ]);
    expect(text.match(/How to split/g).length).toBe(2);
    expect(text).toContain('How to split a test file (a.test.mjs, b.test.mjs):');
    expect(text).toContain('How to split a skill file (skills/x/SKILL.md):');
    expect(text).toContain('<name>-<concern>.test.mjs');
  });

  test('tells a shell script to source the moved part', () => {
    expect(renderReport([{ path: 'scripts/x.sh', bytes: 30000, ceiling: null }])).toContain('source it');
  });
});

describe('CLI --staged', () => {
  test('blocks a staged new file over the limit, naming the path and the split advice', () => {
    const dir = repo();
    stage(dir, { 'scripts/big.mjs': 24480 });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('  scripts/big.mjs  6120 tokens (24480 bytes), no ceiling');
    expect(r.err).toContain('How to split a code file (scripts/big.mjs):');
    expect(lastLine(r.out)).toBe('checked 1 files, 1 over the limit');
  });

  test('passes a staged file of exactly 20000 bytes', () => {
    const dir = repo();
    stage(dir, { 'a.txt': 20000 });
    const r = run(dir);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(lastLine(r.out)).toBe('checked 1 files, 0 over the limit');
  });

  test('prints nothing when nothing is staged', () => {
    const dir = repo();
    put(dir, { 'big.txt': 30000 });
    expect(run(dir)).toEqual({ code: 0, out: '', err: '' });
  });

  test('judges the index, so a small staged copy passes while the working tree is big', () => {
    const dir = repo();
    stage(dir, { 'a.txt': 100 });
    put(dir, { 'a.txt': 30000 });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe('checked 1 files, 0 over the limit');
  });

  test('judges the index, so a big staged copy fails while the working tree is small', () => {
    const dir = repo();
    stage(dir, { 'a.txt': 30000 });
    put(dir, { 'a.txt': 100 });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('a.txt  7500 tokens (30000 bytes), no ceiling');
  });

  test('ignores a big file that is not staged', () => {
    const dir = repo();
    stage(dir, { 'small.txt': 10 });
    put(dir, { 'untracked.txt': 30000 });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe('checked 1 files, 0 over the limit');
  });

  test('skips a binary file', () => {
    const dir = repo();
    put(dir, { 'blob.bin': Buffer.alloc(30000) });
    git(dir, 'add', 'blob.bin');
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe('checked 0 files, 0 over the limit');
  });

  test('skips a file marked -size-gate in .gitattributes', () => {
    const dir = repo();
    stage(dir, { '.gitattributes': 'bun.lock -size-gate\n', 'bun.lock': 30000 });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe('checked 1 files, 0 over the limit');
  });

  test('skips a symlink', () => {
    const dir = repo();
    fs.symlinkSync('target-that-does-not-exist', path.join(dir, 'link'));
    git(dir, 'add', 'link');
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe('checked 0 files, 0 over the limit');
  });

  test('blocks a file that grew past its ceiling, naming the growth', () => {
    const dir = repo();
    baseline(dir, { 'big.txt': 24000 });
    stage(dir, { 'big.txt': 24400 });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('big.txt  6100 tokens (24400 bytes), ceiling 6000 tokens, grew by 100 tokens');
  });

  test('passes a file that shrank under its ceiling', () => {
    const dir = repo();
    baseline(dir, { 'big.txt': 24000 });
    stage(dir, { 'big.txt': 23000 });
    const r = run(dir);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(lastLine(r.out)).toBe('checked 2 files, 0 over the limit');
  });

  test('handles a path containing a space', () => {
    const dir = repo();
    stage(dir, { 'docs/my notes.md': 30000 });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('How to split a Markdown file (docs/my notes.md):');
  });

  test('handles a path containing a newline', () => {
    const dir = repo();
    stage(dir, { 'odd\nname.txt': 30000 });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('odd\nname.txt');
  });

  test('names a unicode path exactly, without octal quoting', () => {
    const dir = repo();
    stage(dir, { 'docs/catatan-ü-日本.md': 30000 });
    const r = run(dir, '--staged');
    expect(r.code).toBe(1);
    expect(r.err).toContain('  docs/catatan-ü-日本.md  7500 tokens (30000 bytes), no ceiling');
  });

  test('judges a renamed file as new, since its ceiling stays on the old path', () => {
    const dir = repo();
    baseline(dir, { 'big.txt': 25000 });
    stage(dir, { 'big.txt': 25000 });
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed');
    git(dir, 'mv', 'big.txt', 'moved.txt');
    const r = run(dir, '--staged');
    expect(r.code).toBe(1);
    expect(r.err).toContain('  moved.txt  6250 tokens (25000 bytes), no ceiling');
    expect(r.err).toContain('A renamed file counts as new: move its ceiling to the new path in the same commit.');
  });
});

describe('CLI --all', () => {
  test('reports stale ceilings and tells to rewrite the baseline', () => {
    const dir = repo();
    baseline(dir, { 'gone.txt': 30000, 'shrunk.txt': 30000 });
    stage(dir, { 'shrunk.txt': 25000 });
    const r = run(dir, '--all');
    expect(r.code).toBe(1);
    expect(r.err).toContain('gone.txt');
    expect(r.err).toContain('shrunk.txt');
    expect(r.err).toContain('bun scripts/check-file-size.mjs --write-baseline');
  });

  test('passes when every ceiling is current', () => {
    const dir = repo();
    baseline(dir, { 'big.txt': 25000 });
    stage(dir, { 'big.txt': 25000, 'small.txt': 10 });
    const r = run(dir, '--all');
    expect([r.code, r.err]).toEqual([0, '']);
    expect(lastLine(r.out)).toBe('checked 3 files, 0 over the limit');
  });

  test('skips a submodule entry and does not count it as checked', () => {
    const dir = repo();
    stage(dir, { 'small.txt': 10 });
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`);
    const r = run(dir, '--all');
    expect([r.code, r.err]).toEqual([0, '']);
    expect(lastLine(r.out)).toBe('checked 1 files, 0 over the limit');
  });
});

describe('CLI --write-baseline', () => {
  test('seeds the baseline with every text file over the limit, sorted', () => {
    const dir = repo();
    stage(dir, { 'b.txt': 22000, 'a.txt': 25000, 'c.txt': 100 });
    const r = run(dir, '--write-baseline');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, BASELINE), 'utf8')).toBe('{\n  "a.txt": 25000,\n  "b.txt": 22000\n}\n');
  });

  test('tightens an existing baseline without adding or raising', () => {
    const dir = repo();
    baseline(dir, { 'a.txt': 25000, 'b.txt': 22000, 'gone.txt': 30000 });
    stage(dir, { 'a.txt': 26000, 'b.txt': 21000, 'd.txt': 30000 });
    expect(run(dir, '--write-baseline').code).toBe(0);
    expect(fs.readFileSync(path.join(dir, BASELINE), 'utf8')).toBe('{\n  "a.txt": 25000,\n  "b.txt": 21000\n}\n');
  });
});

describe('CLI exit 2', () => {
  test('outside a git repository', () => {
    const r = run(tmpDir());
    expect(r.code).toBe(2);
    expect(r.err).toContain('not a git repository');
  });

  test('on an unknown flag', () => {
    const r = run(repo(), '--bogus');
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown argument: --bogus');
  });

  test('when a --root value starts with a dash', () => {
    const r = run(repo(), '--root', '--all');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--root needs a value');
  });

  test('on a baseline that is not valid JSON, naming the path', () => {
    const dir = repo();
    baseline(dir, '{nope');
    stage(dir, { 'a.txt': 10 });
    const r = run(dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('invalid baseline JSON');
    expect(r.err).toContain(path.join(dir, BASELINE));
  });
});

describe('exitCodeFor', () => {
  test('a GitError is exit 2', () => expect(exitCodeFor(new GitError('x'))).toBe(2));
  test('a system error such as EISDIR is exit 2', () => {
    expect(exitCodeFor(Object.assign(new Error('x'), { code: 'EISDIR' }))).toBe(2);
  });
  test('a TypeError is rethrown', () => {
    const bug = new TypeError('bug');
    expect(() => exitCodeFor(bug)).toThrow(bug);
  });
});

describe('CLI --root and --baseline', () => {
  test('judges the repository named by --root against the named baseline', () => {
    const dir = repo();
    put(dir, { 'ceilings.json': JSON.stringify({ 'big.txt': 26000 }) });
    stage(dir, { 'big.txt': 25000 });
    const r = run(tmpDir(), '--root', dir, '--baseline', path.join(dir, 'ceilings.json'));
    expect([r.code, r.err]).toEqual([0, '']);
    expect(lastLine(r.out)).toBe('checked 1 files, 0 over the limit');
  });
});

describe('repo exemptions', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const attr = (p) => git(REPO, 'check-attr', '--cached', 'size-gate', '--', p).trim().split(': ').pop();

  // Lockfiles, rendered diagrams, the demo scripts/make-graph-demo.py writes, the sprites
  // scripts/gen-sprite-agents.mjs writes, and the vendored graphify skill: fix them at the source.
  test.each([
    'bun.lock', 'apps/docs/Cargo.lock', 'diagrams/lifecycle.svg', 'examples/graph-viewer-demo.html',
    '.claude/agents/staid.md', '.opencode/skills/graphify/SKILL.md', '.opencode/plugins/graphify.js',
  ])('%s is exempt', (p) => {
    expect(attr(p)).toBe('unset');
  });

  test.each(['README.md', 'skills/sucp-rules/SKILL.md', 'scripts/ci-targeted.mjs'])('%s is still checked (control)', (p) => {
    expect(attr(p)).toBe('unspecified');
  });
});

describe('ceilings come from the index', () => {
  test('an unstaged ceiling raise does not let a grown file through', () => {
    const dir = repo();
    baseline(dir, { 'a.txt': 25000 });
    stage(dir, { 'a.txt': 26000 });
    put(dir, { [BASELINE]: JSON.stringify({ 'a.txt': 30000 }) });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('a.txt');
  });

  test('a staged ceiling raise lets the grown file through', () => {
    const dir = repo();
    baseline(dir, { 'a.txt': 30000 });
    stage(dir, { 'a.txt': 26000 });
    const r = run(dir);
    expect([r.code, r.err]).toEqual([0, '']);
  });

  test('an unstaged, broken baseline is ignored in favour of the staged one', () => {
    const dir = repo();
    baseline(dir, { 'a.txt': 25000 });
    stage(dir, { 'a.txt': 26000 });
    put(dir, { [BASELINE]: '{nope' });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('invalid baseline JSON');
  });
});
