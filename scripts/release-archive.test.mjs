import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'scripts', 'release', 'build-archive.sh');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-release-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// Nothing here may touch the real HOME, the user's git config, or the network.
const baseEnv = (extra = {}) => ({
  PATH: process.env.PATH,
  HOME: scratch,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: path.dirname(scratch),
  ...extra,
});

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', env: baseEnv(), ...opts });

const build = (args, repo) =>
  run('bash', [BUILD, ...args], { env: baseEnv(repo ? { VIVERA_REPO_DIR: repo } : {}) });

// Two tracked files and one file git is told to ignore. info/exclude keeps the
// ignore rule out of the tracked set, so the tree holds exactly two files.
function makeRepo(name) {
  const repo = path.join(scratch, name);
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'beta\n');
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'secret\n');
  const g = (...args) => {
    const r = run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args]);
    expect(r.status).toBe(0);
  };
  g('init', '-q', '-b', 'main');
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'ignored.txt\n');
  g('add', 'a.txt', 'sub/b.txt');
  g('commit', '-q', '-m', 'fixture');
  return repo;
}

const repo = makeRepo('fixture-repo');
const tarball = (out, tag = 'v0.1.0') => path.join(out, `vivera-${tag}.tar.gz`);
const sha256 = (file) => run('sha256sum', [file]).stdout.split(/\s+/)[0];

describe('build-archive.sh', () => {
  test('is executable', () => {
    expect(fs.statSync(BUILD).mode & 0o111).not.toBe(0);
  });

  test('writes the tarball and a .sha256, and prints both paths', () => {
    const out = path.join(scratch, 'out-basic');
    const r = build(['v0.1.0', out], repo);
    expect(r.status).toBe(0);
    expect(fs.existsSync(tarball(out))).toBe(true);
    expect(fs.existsSync(`${tarball(out)}.sha256`)).toBe(true);
    expect(r.stdout).toContain(tarball(out));
    expect(r.stdout).toContain(`${tarball(out)}.sha256`);
  });

  test('every entry sits under vivera-<tag>/ and the ignored file is absent', () => {
    const out = path.join(scratch, 'out-list');
    expect(build(['v0.1.0', out], repo).status).toBe(0);
    const entries = run('tar', ['-tzf', tarball(out)]).stdout.split('\n').filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.startsWith('vivera-v0.1.0/'))).toBe(true);
    expect(entries).toContain('vivera-v0.1.0/a.txt');
    expect(entries).toContain('vivera-v0.1.0/sub/b.txt');
    expect(entries.some((e) => e.includes('ignored.txt'))).toBe(false);
  });

  test('the .sha256 is in sha256sum format with the bare file name and verifies', () => {
    const out = path.join(scratch, 'out-sum');
    expect(build(['v0.1.0', out], repo).status).toBe(0);
    const line = fs.readFileSync(`${tarball(out)}.sha256`, 'utf8');
    expect(line).toBe(`${sha256(tarball(out))}  vivera-v0.1.0.tar.gz\n`);
    const check = run('sha256sum', ['-c', 'vivera-v0.1.0.tar.gz.sha256'], { cwd: out });
    expect(check.status).toBe(0);
  });

  test('two runs a second apart give the same hash', () => {
    const a = path.join(scratch, 'out-det-a');
    const b = path.join(scratch, 'out-det-b');
    expect(build(['v0.1.0', a], repo).status).toBe(0);
    Bun.sleepSync(1100);
    expect(build(['v0.1.0', b], repo).status).toBe(0);
    expect(sha256(tarball(a))).toBe(sha256(tarball(b)));
  });

  test('the gzip header carries no timestamp and no file name', () => {
    const out = path.join(scratch, 'out-hdr');
    expect(build(['v0.1.0', out], repo).status).toBe(0);
    const head = fs.readFileSync(tarball(out)).subarray(0, 10);
    expect(head[3] & 0x08).toBe(0);
    expect([...head.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
  });

  test('a tampered copy fails sha256sum -c', () => {
    const out = path.join(scratch, 'out-tamper');
    expect(build(['v0.1.0', out], repo).status).toBe(0);
    const bad = path.join(scratch, 'out-tamper-bad');
    fs.mkdirSync(bad);
    const bytes = fs.readFileSync(tarball(out));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(tarball(bad), bytes);
    fs.copyFileSync(`${tarball(out)}.sha256`, `${tarball(bad)}.sha256`);
    const check = run('sha256sum', ['-c', 'vivera-v0.1.0.tar.gz.sha256'], { cwd: bad });
    expect(check.status).not.toBe(0);
  });

  test('a prerelease tag is accepted', () => {
    const out = path.join(scratch, 'out-pre');
    expect(build(['v1.2.3-rc.1', out], repo).status).toBe(0);
    expect(fs.existsSync(tarball(out, 'v1.2.3-rc.1'))).toBe(true);
  });

  for (const bad of ['0.1.0', 'v1', 'v1.0.0;rm', 'v1.0.0 x', '']) {
    test(`the tag "${bad}" exits 2 with usage and writes nothing`, () => {
      const out = path.join(scratch, `out-badtag-${fs.readdirSync(scratch).length}`);
      const r = build([bad, out], repo);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/usage/i);
      expect(fs.existsSync(out)).toBe(false);
    });
  }

  test('a missing outdir argument exits 2', () => {
    const r = build(['v0.1.0'], repo);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });

  test('a directory that is not a git repository fails and leaves no tarball', () => {
    const notGit = path.join(scratch, 'not-git');
    fs.mkdirSync(notGit);
    const out = path.join(scratch, 'out-nogit');
    const r = build(['v0.1.0', out], notGit);
    expect(r.status).not.toBe(0);
    const left = fs.existsSync(out) ? fs.readdirSync(out) : [];
    expect(left.filter((f) => f.includes('tar.gz'))).toEqual([]);
  });

  test('an unknown ref fails and leaves no tarball', () => {
    const out = path.join(scratch, 'out-badref');
    const r = build(['v0.1.0', out, 'no-such-ref'], repo);
    expect(r.status).not.toBe(0);
    const left = fs.existsSync(out) ? fs.readdirSync(out) : [];
    expect(left.filter((f) => f.includes('tar.gz'))).toEqual([]);
  });
});

describe('release.yml', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const wf = parse(text);
  const steps = wf.jobs.release.steps;
  const stepNamed = (name) => steps.find((s) => s.name === name);

  const collectKeyPaths = (node, key, trail = []) => {
    if (node === null || typeof node !== 'object') return [];
    const found = [];
    for (const [k, v] of Object.entries(node)) {
      if (k === key) found.push([...trail, k].join('.'));
      found.push(...collectKeyPaths(v, key, [...trail, Array.isArray(node) ? '#' : k]));
    }
    return found;
  };

  test('the only trigger is workflow_dispatch', () => {
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
  });

  test('tag is a required input and dry_run defaults to true', () => {
    const { inputs } = wf.on.workflow_dispatch;
    expect(inputs.tag.required).toBe(true);
    expect(inputs.tag.type).toBe('string');
    expect(typeof inputs.tag.description).toBe('string');
    expect(inputs.dry_run.type).toBe('boolean');
    expect(inputs.dry_run.default).toBe(true);
  });

  test('there is one job, release, on ubuntu-latest', () => {
    expect(Object.keys(wf.jobs)).toEqual(['release']);
    expect(wf.jobs.release['runs-on']).toBe('ubuntu-latest');
  });

  test('contents: write is set on the job and nowhere else', () => {
    expect(wf.permissions).toBeUndefined();
    expect(wf.jobs.release.permissions).toEqual({ contents: 'write' });
    expect(collectKeyPaths(wf, 'permissions')).toEqual(['jobs.release.permissions']);
  });

  test('the publish step is guarded by dry_run and passes the tag through env', () => {
    const publish = stepNamed('Publish the release');
    expect(publish).toBeDefined();
    expect(String(publish.if)).toContain('dry_run');
    expect(publish.run).toContain('gh release create');
    expect(publish.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(publish.env.TAG).toBe('${{ inputs.tag }}');
  });

  test('the release tag points at the commit the archive was built from', () => {
    // Without --target, gh creates a missing tag at the default branch head, which differs
    // from the dispatched commit whenever the workflow is run from another ref.
    const publish = stepNamed('Publish the release');
    expect(publish.run).toContain('--target "$GITHUB_SHA"');
  });

  test('no run script interpolates an input', () => {
    for (const s of steps) {
      if (s.run) expect(s.run).not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\./);
    }
  });

  test('if-no-files-found sits under with on the upload step and at no step level', () => {
    for (const s of steps) expect('if-no-files-found' in s).toBe(false);
    const upload = stepNamed('Upload the archive');
    expect(upload.with['if-no-files-found']).toBe('error');
  });

  test('the build step passes the tag through env', () => {
    const buildStep = stepNamed('Build the archive');
    expect(buildStep.run).toContain('scripts/release/build-archive.sh "$TAG" dist');
    expect(buildStep.env.TAG).toBe('${{ inputs.tag }}');
  });

  test('checkout fetches full history', () => {
    const checkout = stepNamed('Checkout repository');
    expect(checkout.uses).toBe('actions/checkout@v7');
    expect(checkout.with['fetch-depth']).toBe(0);
  });

  test('every action is pinned to a major tag', () => {
    const uses = steps.filter((s) => s.uses).map((s) => s.uses);
    expect(uses.length).toBe(2);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@v\d+$/);
  });

  test('the header states the policy and how to revert', () => {
    const header = text.split('\non:')[0];
    expect(header).toMatch(/automatic trigger/i);
    expect(header).toMatch(/dry_run/);
    expect(header).toMatch(/git rm \.github\/workflows\/release\.yml/);
  });
});
