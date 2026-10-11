// scripts/bootstrap.test.mjs
//
// scripts/bootstrap.sh: download a pinned release archive and its checksum, verify, extract, run the
// extracted install.sh. The release is built here from the COMMITTED tree (git archive HEAD, through
// scripts/release/build-archive.sh) and served with file:// URLs, so nothing touches the network and
// the checkout's work in progress never enters the archive. Every run uses the install sandbox: a temp
// HOME, a private TMPDIR, and a PATH made only of the tools a test names.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSandbox, makeSandbox } from './lib/install-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOT = path.join(ROOT, 'scripts', 'bootstrap.sh');
const BUILD = path.join(ROOT, 'scripts', 'release', 'build-archive.sh');
const TAG = 'v0.1.0-rc.1';
const ARCHIVE = `vivera-${TAG}.tar.gz`;
const TOOLS = ['git', 'bun', 'curl', 'tar', 'gzip'];
const MINIMAL = ['--', '--tier', 'minimal', '--only', 'agents'];

let fixture;
let released; // <fixture>/dl/<TAG>: the files a release serves
let headCommit = '';

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-bootstrap-'));
  released = path.join(fixture, 'dl', TAG);
  const env = { PATH: process.env.PATH, HOME: fixture, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', VIVERA_REPO_DIR: ROOT };
  const r = Bun.spawnSync(['bash', BUILD, TAG, released], { env });
  if (r.exitCode !== 0) throw new Error(`build-archive.sh failed: ${r.stderr.toString()}`);
  headCommit = Bun.spawnSync(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'], { env }).stdout.toString().trim();
});

afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

// A sandbox plus its own copy of the release, so a test may damage the copy.
function setup(tools = TOOLS) {
  const sb = makeSandbox({ tools });
  open.push(sb);
  const dl = path.join(sb.root, 'dl');
  fs.cpSync(path.join(fixture, 'dl'), dl, { recursive: true, verbatimSymlinks: true });
  return { sb, base: `file://${dl}`, dest: path.join(sb.root, 'dest'), served: path.join(dl, TAG) };
}

// Runs bootstrap.sh as `bash <file> args`, or as `bash -s -- args` with the text on stdin.
function boot(sb, args, { base, stdin, env = {} } = {}) {
  const runEnv = { ...sb.env, ...(base ? { VIVERA_BASE_URL: base } : {}), ...env };
  assertSandbox(runEnv);
  const pairs = Object.entries(runEnv).map(([k, v]) => `${k}=${v}`);
  const bash = path.join(sb.bin, 'bash');
  const argv = stdin === undefined ? [bash, BOOT, ...args] : [bash, '-s', '--', ...args];
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, ...argv], {
    cwd: sb.home,
    timeout: 60_000,
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  });
  return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const tmpLeft = (sb) => fs.readdirSync(path.join(sb.root, 'tmp'));
const flipByte = (file) => {
  const bytes = fs.readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(file, bytes);
};

// What a refused download must leave behind: nothing in HOME, nothing at the destination, no work dir.
function expectUntouched(sb, dest) {
  expect(sb.snapshot()).toEqual([]);
  expect(fs.existsSync(dest)).toBe(false);
  expect(tmpLeft(sb)).toEqual([]);
}

function expectInstalled(sb, dest) {
  const tree = path.join(dest, TAG);
  const skill = path.join(sb.home, '.agents/skills/super-ultra-code-plan/SKILL.md');
  expect(fs.lstatSync(skill).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(skill).startsWith(`${tree}/`)).toBe(true);
  expect(fs.existsSync(skill)).toBe(true);
  expect(fs.existsSync(path.join(tree, '.git'))).toBe(false);
  expect(fs.existsSync(path.join(tree, 'install.sh'))).toBe(true);
}

describe('bootstrap: a good release', () => {
  test('installs from the archive of the committed tree into <dest>/<ref>, with links that point there', () => {
    expect(headCommit).toMatch(/^[0-9a-f]{7,}$/);
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.stderr).not.toContain('[FAIL]');
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
    expect(r.stdout).toContain(path.join(dest, TAG));
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('prints the extraction path before the installer output', () => {
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(0);
    expect(r.stdout.indexOf(path.join(dest, TAG))).toBeGreaterThanOrEqual(0);
    expect(r.stdout.indexOf(path.join(dest, TAG))).toBeLessThan(r.stdout.indexOf('Sowing Vivera'));
  });

  test('works as a pipe: the script text on stdin to bash -s', () => {
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base, stdin: fs.readFileSync(BOOT, 'utf8') });
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('VIVERA_HOME picks the destination when --dest is not given, and --dest wins over it', () => {
    const { sb, base, dest } = setup();
    const viaEnv = path.join(sb.root, 'via-env');
    expect(boot(sb, ['--ref', TAG, ...MINIMAL], { base, env: { VIVERA_HOME: viaEnv } }).status).toBe(0);
    expect(fs.existsSync(path.join(viaEnv, TAG, 'install.sh'))).toBe(true);
    expect(boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base, env: { VIVERA_HOME: path.join(sb.root, 'ignored') } }).status).toBe(0);
    expect(fs.existsSync(path.join(dest, TAG, 'install.sh'))).toBe(true);
    expect(fs.existsSync(path.join(sb.root, 'ignored'))).toBe(false);
  });

  test('passes the arguments after -- to install.sh: --dry-run prints [DRY-RUN] and writes nothing to HOME', () => {
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, '--', '--tier', 'minimal', '--only', 'agents', '--dry-run'], { base });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[DRY-RUN]');
    expect(sb.snapshot()).toEqual([]);
    expect(fs.existsSync(path.join(dest, TAG, 'install.sh'))).toBe(true);
  });

  test("exits with install.sh's status", () => {
    const { sb, base, dest } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', dest, '--', '--tier', 'bogus'], { base });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Invalid tier');
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('uses wget when curl is absent (wget stands in as a shim, since wget cannot read file:// itself)', () => {
    const { sb, base, dest } = setup(['git', 'bun', 'tar', 'gzip']);
    fs.writeFileSync(
      path.join(sb.bin, 'wget'),
      '#!/bin/sh\n[ "$1" = "-qO" ] || exit 2\ncase "$3" in file://*) cp "${3#file://}" "$2" ;; *) exit 3 ;; esac\n',
      { mode: 0o755 },
    );
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.stderr).not.toContain('[FAIL]');
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
  });

  test('falls back to shasum -a 256 when sha256sum is absent', () => {
    const { sb, base, dest } = setup([...TOOLS, 'shasum']);
    fs.rmSync(path.join(sb.bin, 'sha256sum'));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.stderr).not.toContain('[FAIL]');
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
  });
});

describe('bootstrap: a release that cannot be trusted is refused before anything is written', () => {
  test('a tampered archive exits 1 with [FAIL]', () => {
    const { sb, base, dest, served } = setup();
    flipByte(path.join(served, ARCHIVE));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('a missing .sha256 exits 1 with [FAIL]', () => {
    const { sb, base, dest, served } = setup();
    fs.rmSync(path.join(served, `${ARCHIVE}.sha256`));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('a wrong hash in the .sha256 exits 1 with [FAIL]', () => {
    const { sb, base, dest, served } = setup();
    fs.writeFileSync(path.join(served, `${ARCHIVE}.sha256`), `${'0'.repeat(64)}  ${ARCHIVE}\n`);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('a missing archive exits 1 with [FAIL]', () => {
    const { sb, base, dest, served } = setup();
    fs.rmSync(path.join(served, ARCHIVE));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('no SHA-256 tool on PATH exits 1 with [FAIL]', () => {
    const { sb, base, dest } = setup();
    fs.rmSync(path.join(sb.bin, 'sha256sum'));
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expect(r.stderr).toMatch(/sha256sum|shasum/);
    expectUntouched(sb, dest);
  });
});

describe('bootstrap: only a release tag is accepted', () => {
  const never = 'file:///nonexistent';

  for (const ref of ['main', 'v1', 'v1.0.0;rm -rf x', '0.1.0', '', 'a1b2c3d4e5f6', 'v1.0.0/../x']) {
    test(`--ref ${JSON.stringify(ref)} exits 2 with the usage text and attempts nothing`, () => {
      const { sb, dest } = setup();
      const r = boot(sb, ['--ref', ref, '--dest', dest], { base: never });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage:');
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.stderr).not.toContain('nonexistent');
      expectUntouched(sb, dest);
    });
  }

  test('a missing --ref exits 2 with the usage text', () => {
    const { sb, dest } = setup();
    for (const args of [[], ['--dest', dest], ['--ref']]) {
      const r = boot(sb, args, { base: never });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage:');
    }
    expectUntouched(sb, dest);
  });

  test('an unknown option exits 2, and install.sh flags are only accepted after --', () => {
    const { sb, dest } = setup();
    for (const args of [['--bogus'], ['--ref', TAG, '--tier', 'minimal']]) {
      const r = boot(sb, args, { base: never });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage:');
    }
    expectUntouched(sb, dest);
  });

  test('-h prints the usage text and exits 0', () => {
    const { sb } = setup();
    const r = boot(sb, ['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });
});

describe('bootstrap: other refusals', () => {
  test('neither curl nor wget exits 1 and says so', () => {
    const { sb, base, dest } = setup(['git', 'bun', 'tar', 'gzip']);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/curl or wget/);
    expectUntouched(sb, dest);
  });

  test('an existing non-empty <dest>/<ref> exits 1 and is left as it was', () => {
    const { sb, base, dest } = setup();
    const keep = path.join(dest, TAG, 'keep.txt');
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.writeFileSync(keep, 'mine');
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(fs.readdirSync(path.join(dest, TAG))).toEqual(['keep.txt']);
    expect(fs.readFileSync(keep, 'utf8')).toBe('mine');
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('an existing empty <dest>/<ref> is filled', () => {
    const { sb, base, dest } = setup();
    fs.mkdirSync(path.join(dest, TAG), { recursive: true });
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(0);
    expectInstalled(sb, dest);
  });

  test('a relative --dest is made absolute so the installed links do not depend on the working directory', () => {
    const { sb, base } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', 'rel-dest', ...MINIMAL], { base });
    expect(r.status).toBe(0);
    const skill = path.join(sb.home, '.agents/skills/super-ultra-code-plan/SKILL.md');
    expect(path.isAbsolute(fs.readlinkSync(skill))).toBe(true);
    // The script's working directory is HOME, and bash reports it by its physical path.
    expect(fs.readlinkSync(skill).startsWith(`${path.join(fs.realpathSync(sb.home), 'rel-dest', TAG)}/`)).toBe(true);
  });
});
