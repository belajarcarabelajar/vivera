// scripts/docs-drift.test.mjs
//
// Drives scripts/docs-drift.mjs through main() with a fetch stub and a temp git
// repository, so no test touches the network or the real history.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DOCS_INPUTS, main } from './docs-drift.mjs';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const BASE = 'https://docs.example.test';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };

function git(cwd, ...args) {
  const env = { ...process.env, ...GIT_ENV };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const r = Bun.spawnSync(['git', '-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

let dir;
let repo;
let empty;
const sha = {};

function commit(name, files, subject) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', subject);
  sha[name] = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', name);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'docs-drift-'));
  repo = path.join(dir, 'repo');
  empty = path.join(dir, 'not-a-repo');
  mkdirSync(repo);
  mkdirSync(empty);
  git(repo, 'init', '-q', '-b', 'main');
  commit('base', { 'README.md': '# r\n', 'docs/guide/a.md': 'a\n', 'other.txt': '1\n' }, 'base: first commit');
  commit('unrelated', { 'other.txt': '2\n' }, 'chore: touch an unrelated file');
  commit('guide', { 'docs/guide/a.md': 'a2\n' }, 'guide: edit page a');
  commit('rust', { 'apps/docs/src/main.rs': 'fn main() {}\n' }, 'docs site: rust change');
  commit('links', { 'scripts/lib/docs-gen-links.mjs': 'export {};\n' }, 'docs-gen: links change');
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function stampFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status });
  };
  return { fetch, calls };
}

async function run(args, { fetch, root = repo } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, { fetch, root, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n') };
}

const stamp = (commit) => ({ commit, built_at: '2026-11-15T00:00:00Z' });

describe('default mode: live stamp against a ref', () => {
  test('in sync when no docs-input commit follows the live commit', async () => {
    const { fetch, calls } = stampFetch(stamp(sha.guide));
    const r = await run(['--ref', 'guide', '--url', BASE], { fetch });
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toHaveLength(1);
    expect(r.out).toContain('in sync');
    expect(r.out).toContain('guide');
    expect(calls).toEqual([`${BASE}/docs/version.json`]);
  });

  test('a later commit touching docs/guide is drift, listed with its short sha and subject', async () => {
    const { fetch } = stampFetch(stamp(sha.base));
    const r = await run(['--ref', 'guide', '--url', BASE], { fetch });
    expect(r.code).toBe(1);
    expect(r.out).toContain(sha.guide.slice(0, 7));
    expect(r.out).toContain('guide: edit page a');
    expect(r.out).not.toContain('chore: touch an unrelated file');
  });

  test('a later commit touching only an unrelated file is still in sync', async () => {
    const { fetch } = stampFetch(stamp(sha.base));
    const r = await run(['--ref', 'unrelated', '--url', BASE], { fetch });
    expect(r.code).toBe(0);
    expect(r.out).toContain('in sync');
  });

  test('deep ** and single * patterns reach git: apps/docs/src and scripts/lib/docs-gen-links.mjs', async () => {
    const { fetch } = stampFetch(stamp(sha.guide));
    const r = await run(['--ref', 'links', '--url', BASE], { fetch });
    expect(r.code).toBe(1);
    expect(r.out).toContain('docs site: rust change');
    expect(r.out).toContain('docs-gen: links change');
    expect(r.out).not.toContain('guide: edit page a');
  });

  test('stamp 404 means the live site has no stamp: exit 1', async () => {
    const { fetch } = stampFetch('Not Found', { status: 404 });
    const r = await run(['--ref', 'guide', '--url', BASE], { fetch });
    expect(r.code).toBe(1);
    expect(r.all).toContain('no stamp');
  });

  test('a 200 answer that is not a stamp (HTML, bad sha) is malformed: exit 1', async () => {
    for (const body of ['<!doctype html><p>docs</p>', { commit: 'abc', built_at: 'x' }, { commit: `${sha.base.slice(0, 39)};` }]) {
      const r = await run(['--ref', 'guide', '--url', BASE], { fetch: stampFetch(body).fetch });
      expect(r.code).toBe(1);
      expect(r.all).toContain('no stamp');
    }
  });

  test('fetch that throws is a network error: exit 2', async () => {
    const fetch = async () => { throw new TypeError('getaddrinfo ENOTFOUND docs.example.test'); };
    const r = await run(['--ref', 'guide', '--url', BASE], { fetch });
    expect(r.code).toBe(2);
    expect(r.all).toContain('ENOTFOUND');
  });

  test('a server error answer is a network error, not a missing stamp: exit 2', async () => {
    const r = await run(['--ref', 'guide', '--url', BASE], { fetch: stampFetch('oops', { status: 503 }).fetch });
    expect(r.code).toBe(2);
    expect(r.all).toContain('503');
  });

  test('a live commit unknown to the local repo: exit 2 and a hint to git fetch', async () => {
    const r = await run(['--ref', 'guide', '--url', BASE], { fetch: stampFetch(stamp('f'.repeat(40))).fetch });
    expect(r.code).toBe(2);
    expect(r.all).toContain('git fetch');
  });

  test('a ref that does not resolve: exit 2', async () => {
    const r = await run(['--ref', 'no-such-ref', '--url', BASE], { fetch: stampFetch(stamp(sha.base)).fetch });
    expect(r.code).toBe(2);
    expect(r.all).toContain('no-such-ref');
  });
});

describe('--expect mode needs no git history', () => {
  test('stamp equal to the expected sha: exit 0', async () => {
    const r = await run(['--expect', sha.links, '--url', BASE], { fetch: stampFetch(stamp(sha.links)).fetch, root: empty });
    expect(r.code).toBe(0);
  });

  test('stamp different from the expected sha: exit 1', async () => {
    const r = await run(['--expect', sha.links, '--url', BASE], { fetch: stampFetch(stamp(sha.base)).fetch, root: empty });
    expect(r.code).toBe(1);
    expect(r.all).toContain(sha.base.slice(0, 7));
  });

  test('no stamp while a sha is expected: exit 1', async () => {
    const r = await run(['--expect', sha.links, '--url', BASE], { fetch: stampFetch('Not Found', { status: 404 }).fetch, root: empty });
    expect(r.code).toBe(1);
  });
});

describe('usage errors exit 2 before any fetch', () => {
  for (const args of [['--bogus'], ['--ref'], ['--url', 'not a url'], ['--expect', 'xyz'], ['--ref', '--url'], ['extra']]) {
    test(`args ${JSON.stringify(args)}`, async () => {
      const { fetch, calls } = stampFetch(stamp(sha.base));
      const r = await run(args, { fetch });
      expect(r.code).toBe(2);
      expect(r.err).toContain('usage');
      expect(calls).toEqual([]);
    });
  }
});

describe('DOCS_INPUTS', () => {
  test('is sorted and unique', () => {
    expect(DOCS_INPUTS).toEqual([...new Set(DOCS_INPUTS)].sort());
  });

  // Matching here uses Bun.Glob, not the script's git pathspecs, so the two
  // can disagree and the git-level tests above cover the other side.
  const matched = (p) => DOCS_INPUTS.some((pattern) => new Bun.Glob(pattern).match(p));

  test('covers every source file named in the real apps/docs/pages.json', () => {
    const map = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps/docs/pages.json'), 'utf8'));
    const sources = [];
    for (const page of map.pages) {
      if (typeof page.source?.file === 'string') sources.push(page.source.file);
      if (Array.isArray(page.source?.files)) sources.push(...page.source.files);
    }
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.filter((s) => !matched(s))).toEqual([]);
  });

  test('covers diagrams, the Rust site, and the docs-gen libraries', () => {
    for (const p of ['diagrams/x.svg', 'apps/docs/src/main.rs', 'scripts/lib/docs-gen-links.mjs', 'scripts/docs-gen.mjs', 'scripts/lib/docs-include.mjs']) {
      expect([p, matched(p)]).toEqual([p, true]);
    }
    expect(matched('scripts/ci-targeted.mjs')).toBe(false);
  });

  test('every literal entry names a real file, except the workflow another task adds', () => {
    const missing = DOCS_INPUTS.filter((p) => !p.includes('*') && p !== '.github/workflows/docs-deploy.yml' && !existsSync(path.join(REPO_ROOT, p)));
    expect(missing).toEqual([]);
  });
});
