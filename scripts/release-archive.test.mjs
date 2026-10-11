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

const build = (args, repo, extraEnv = {}) =>
  run('bash', [BUILD, ...args], { env: baseEnv({ ...(repo ? { VIVERA_REPO_DIR: repo } : {}), ...extraEnv }) });

// The same build under umask 077, so a mode taken from the process umask would show.
const buildUnderUmask077 = (args, repo, extraEnv = {}) =>
  run('bash', ['-c', 'umask 077; exec bash "$0" "$@"', BUILD, ...args], { env: baseEnv({ VIVERA_REPO_DIR: repo, ...extraEnv }) });

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

  // The last five match the old regex but are not valid git ref names (or are not ASCII).
  const badTags = ['0.1.0', 'v1', 'v1.0.0;rm', 'v1.0.0 x', '', 'v1.0.0..', 'v1.0.0.lock', 'v1.0.0-.', 'v1.0.0-rc..1', 'v1.0.0-é'];
  for (const bad of badTags) {
    test(`the tag ${JSON.stringify(bad)} exits 2 with usage and writes nothing`, () => {
      const out = path.join(scratch, `out-badtag-${fs.readdirSync(scratch).length}`);
      const r = build([bad, out], repo);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/usage/i);
      expect(fs.existsSync(out)).toBe(false);
    });
  }

  test('a non-ASCII tag is refused whatever the locale says a letter is', () => {
    for (const locale of ['en_US.UTF-8', 'C.UTF-8']) {
      const out = path.join(scratch, `out-locale-${locale}`);
      const r = build(['v1.0.0-é', out], repo, { LC_ALL: locale });
      expect(r.status).toBe(2);
      expect(fs.existsSync(out)).toBe(false);
    }
  });

  test('a four-part tag that is a valid ref name is accepted', () => {
    const out = path.join(scratch, 'out-four');
    expect(build(['v1.0.0.1', out], repo).status).toBe(0);
  });

  test('the file modes in the archive do not depend on umask or on tar.umask in the user\'s git config', () => {
    const reference = path.join(scratch, 'out-umask-ref');
    expect(build(['v0.1.0', reference], repo).status).toBe(0);
    const want = sha256(tarball(reference));

    const viaEnv = path.join(scratch, 'out-umask-env');
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'tar.umask', GIT_CONFIG_VALUE_0: 'user' };
    expect(buildUnderUmask077(['v0.1.0', viaEnv], repo, env).status).toBe(0);
    expect(sha256(tarball(viaEnv))).toBe(want);

    const hostile = path.join(scratch, 'hostile.gitconfig');
    fs.writeFileSync(hostile, '[tar]\n\tumask = user\n');
    const viaFile = path.join(scratch, 'out-umask-file');
    expect(buildUnderUmask077(['v0.1.0', viaFile], repo, { GIT_CONFIG_GLOBAL: hostile }).status).toBe(0);
    expect(sha256(tarball(viaFile))).toBe(want);
  });

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
  const { build: buildJob, publish: publishJob } = wf.jobs;
  const stepNamed = (job, name) => job.steps.find((s) => s.name === name);
  const allSteps = [...buildJob.steps, ...publishJob.steps];
  const indexOfStep = (job, name) => job.steps.findIndex((s) => s.name === name);

  const DEFAULT_BRANCH_STEP = 'Check that the release is made from the default branch';
  const TAG_STEP = 'Check that the tag and the release do not exist yet';

  const collectKeyPaths = (node, key, trail = []) => {
    if (node === null || typeof node !== 'object') return [];
    const found = [];
    for (const [k, v] of Object.entries(node)) {
      if (k === key) found.push([...trail, k].join('.'));
      found.push(...collectKeyPaths(v, key, [...trail, Array.isArray(node) ? '#' : k]));
    }
    return found;
  };

  // Runs one step's `run` script the way a GitHub runner does (bash -eo pipefail) with fake `gh` and
  // `git` on PATH. A fake is the body of a /bin/sh script; every call is appended to the calls file.
  function runStep(step, { env = {}, fakes = {}, files = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(scratch, 'step-'));
    const bin = path.join(dir, 'bin');
    const work = path.join(dir, 'work');
    fs.mkdirSync(bin);
    fs.mkdirSync(work);
    const calls = path.join(dir, 'calls.log');
    for (const [name, body] of Object.entries(fakes)) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$@" >> "$CALLS"\n${body}\n`, { mode: 0o755 });
    }
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), content);
    }
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
      encoding: 'utf8',
      cwd: work,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: scratch, CALLS: calls, ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
  }

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

  test('there are two jobs, build then publish, both on ubuntu-latest', () => {
    expect(Object.keys(wf.jobs)).toEqual(['build', 'publish']);
    expect(buildJob['runs-on']).toBe('ubuntu-latest');
    expect(publishJob['runs-on']).toBe('ubuntu-latest');
  });

  test('build can only read; contents: write is on the publish job and nowhere else', () => {
    expect(wf.permissions).toBeUndefined();
    expect(buildJob.permissions).toEqual({ contents: 'read' });
    expect(publishJob.permissions).toEqual({ contents: 'write' });
    expect(collectKeyPaths(wf, 'permissions')).toEqual(['jobs.build.permissions', 'jobs.publish.permissions']);
  });

  test('publish waits for build and runs only when dry_run is false', () => {
    expect(publishJob.needs).toBe('build');
    expect(String(publishJob.if)).toContain('inputs.dry_run == false');
    expect(buildJob.if).toBeUndefined();
  });

  test('build checks out without keeping credentials and without full history', () => {
    const checkout = stepNamed(buildJob, 'Checkout repository');
    expect(checkout.uses).toBe('actions/checkout@v7');
    expect(checkout.with['persist-credentials']).toBe(false);
    expect('fetch-depth' in checkout.with).toBe(false);
  });

  test('build does not call gh or hold a token', () => {
    for (const s of buildJob.steps) {
      expect(s.run ?? '').not.toContain('gh ');
      expect(JSON.stringify(s.env ?? {})).not.toContain('github.token');
    }
  });

  test('the build step passes the tag through env', () => {
    const step = stepNamed(buildJob, 'Build the archive');
    expect(step.run).toContain('scripts/release/build-archive.sh "$TAG" dist');
    expect(step.env.TAG).toBe('${{ inputs.tag }}');
  });

  test('if-no-files-found sits under with on the upload step and at no step level', () => {
    for (const s of allSteps) expect('if-no-files-found' in s).toBe(false);
    expect(stepNamed(buildJob, 'Upload the archive').with['if-no-files-found']).toBe('error');
  });

  test('publish downloads the artifact build uploaded, into dist', () => {
    const upload = stepNamed(buildJob, 'Upload the archive');
    const download = stepNamed(publishJob, 'Download the archive');
    expect(download.uses).toBe('actions/download-artifact@v7');
    expect(download.with.name).toBe(upload.with.name);
    expect(download.with.path).toBe('dist');
  });

  test('every action is pinned to a major tag', () => {
    const uses = allSteps.filter((s) => s.uses).map((s) => s.uses);
    expect(uses.length).toBe(4);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@v\d+$/);
  });

  test('no run script interpolates an input, and every step that needs the tag reads it from env', () => {
    for (const s of allSteps) {
      if (s.run) expect(s.run).not.toMatch(/\$\{\{\s*(github\.event\.)?inputs\./);
      if (s.run?.includes('$TAG')) expect(s.env.TAG).toBe('${{ inputs.tag }}');
    }
  });

  describe('the publish guards', () => {
    const guard = stepNamed(publishJob, DEFAULT_BRANCH_STEP);
    const tagCheck = stepNamed(publishJob, TAG_STEP);
    const publish = stepNamed(publishJob, 'Publish the release');

    test('they exist, take the default branch from the event through env, and come before the release is made', () => {
      expect(guard).toBeDefined();
      expect(tagCheck).toBeDefined();
      expect(publish).toBeDefined();
      expect(guard.env.DEFAULT_BRANCH).toBe('${{ github.event.repository.default_branch }}');
      expect(guard.run).toContain('[ "$GITHUB_REF" != "refs/heads/${DEFAULT_BRANCH}" ]');
      expect(guard.run).toContain('exit 1');
      const at = (name) => indexOfStep(publishJob, name);
      expect(at(DEFAULT_BRANCH_STEP)).toBeLessThan(at(TAG_STEP));
      expect(at(TAG_STEP)).toBeLessThan(at('Publish the release'));
      expect(at('Download the archive')).toBeLessThan(at('Publish the release'));
    });

    test('a real release is refused from any ref but the default branch', () => {
      const ok = runStep(guard, { env: { GITHUB_REF: 'refs/heads/main', DEFAULT_BRANCH: 'main' } });
      expect(ok.status).toBe(0);
      for (const ref of ['refs/heads/feature', 'refs/heads/main-2', 'refs/tags/v1.0.0', 'refs/pull/5/merge']) {
        const r = runStep(guard, { env: { GITHUB_REF: ref, DEFAULT_BRANCH: 'main' } });
        expect(r.status).toBe(1);
        expect(r.out).toContain('main');
      }
      expect(runStep(guard, { env: { GITHUB_REF: 'refs/heads/main', DEFAULT_BRANCH: '' } }).status).toBe(1);
    });

    test('a tag that exists is refused, one lookup that fails is refused, and a free tag passes', () => {
      const fakes = { git: 'exit "${FAKE_LS_REMOTE:-2}"', gh: 'exit "${FAKE_RELEASE_VIEW:-1}"' };
      const check = (env) => runStep(tagCheck, { fakes, env: { TAG: 'v1.0.0', GH_TOKEN: 'x', ...env } });

      const free = check({});
      expect(free.status).toBe(0);
      expect(free.calls).toContain('ls-remote --exit-code --tags origin refs/tags/v1.0.0');
      expect(free.calls).toContain('release view v1.0.0');

      const taken = check({ FAKE_LS_REMOTE: '0' });
      expect(taken.status).toBe(1);
      expect(taken.out).toContain('v1.0.0');
      expect(taken.out).toMatch(/already exists/);

      const unknown = check({ FAKE_LS_REMOTE: '128' });
      expect(unknown.status).toBe(1);
      expect(unknown.out).toMatch(/could not/i);

      const released = check({ FAKE_RELEASE_VIEW: '0' });
      expect(released.status).toBe(1);
      expect(released.out).toMatch(/already exists/);
    });

    test('the release is created at the built commit, and only a hyphenated tag is a prerelease that is not Latest', () => {
      expect(publish.run).toContain('--target "$GITHUB_SHA"');
      expect(publish.env.GH_TOKEN).toBe('${{ github.token }}');
      const files = { 'dist/vivera-x.tar.gz': 'a', 'dist/vivera-x.tar.gz.sha256': 'b' };
      const create = (tag) => runStep(publish, { fakes: { gh: 'exit 0' }, files, env: { TAG: tag, GITHUB_SHA: 'abc123', GH_TOKEN: 'x' } });

      const stable = create('v1.2.3');
      expect(stable.status).toBe(0);
      expect(stable.calls).toContain('release create v1.2.3 dist/vivera-x.tar.gz dist/vivera-x.tar.gz.sha256');
      expect(stable.calls).toContain('--title v1.2.3 --generate-notes --target abc123');
      expect(stable.calls).not.toContain('--prerelease');
      expect(stable.calls).not.toContain('--latest');

      const rc = create('v1.2.3-rc.1');
      expect(rc.status).toBe(0);
      expect(rc.calls).toContain('--prerelease');
      expect(rc.calls).toContain('--latest=false');
      expect(rc.calls).toContain('--target abc123');
    });

    test('the downloaded archive is checked against its .sha256 before it is published', () => {
      const verify = stepNamed(publishJob, 'Verify the downloaded archive');
      expect(verify).toBeDefined();
      expect(indexOfStep(publishJob, 'Verify the downloaded archive')).toBeLessThan(indexOfStep(publishJob, 'Publish the release'));
      const good = 'vivera-v1.0.0.tar.gz';
      const sum = run('sha256sum', ['/dev/stdin'], { input: 'payload' }).stdout.split(/\s+/)[0];
      const ok = runStep(verify, { env: { TAG: 'v1.0.0' }, files: { [`dist/${good}`]: 'payload', [`dist/${good}.sha256`]: `${sum}  ${good}\n` } });
      expect(ok.status).toBe(0);
      const bad = runStep(verify, { env: { TAG: 'v1.0.0' }, files: { [`dist/${good}`]: 'changed', [`dist/${good}.sha256`]: `${sum}  ${good}\n` } });
      expect(bad.status).not.toBe(0);
    });

    test('the publish job checks the repository out so git ls-remote can authenticate', () => {
      const checkout = stepNamed(publishJob, 'Checkout repository');
      expect(checkout.uses).toBe('actions/checkout@v7');
      expect(indexOfStep(publishJob, 'Checkout repository')).toBeLessThan(indexOfStep(publishJob, TAG_STEP));
    });
  });

  test('the header states the policy, the two jobs and how to revert', () => {
    const header = text.split('\non:')[0];
    expect(header).toMatch(/automatic trigger/i);
    expect(header).toMatch(/dry_run/);
    expect(header).toMatch(/default branch/i);
    expect(header).toMatch(/git rm \.github\/workflows\/release\.yml/);
  });
});
