// scripts/bootstrap-install.test.mjs
//
// scripts/bootstrap.sh, the install side: a good release lands in <dest>/<ref> with links that point
// there, the destination rules (an existing tree, --dest, VIVERA_HOME), the cleanup after a failed
// extraction or an archive with no install.sh (only what the run created is removed), the resume hint
// for an existing tree, and the .gitattributes line that keeps the git hooks LF in the archive. The
// fixtures (the release built from the committed tree, the sandbox, the runners) are in
// scripts/lib/bootstrap-fixtures.mjs; the refusals are in bootstrap-validation.test.mjs and the
// network behaviour in bootstrap-network.test.mjs.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARCHIVE,
  BOOT,
  MINIMAL,
  ROOT,
  TAG,
  TOOLS,
  boot,
  buildRelease,
  cleanupFixture,
  closeSandboxes,
  expectInstalled,
  expectUntouched,
  fixture,
  headCommit,
  setup,
  sha256Hex,
  tmpLeft,
} from './lib/bootstrap-fixtures.mjs';

beforeAll(buildRelease);
afterAll(cleanupFixture);
afterEach(closeSandboxes);

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

  // wget cannot read file://, so with no curl a file:// base is refused up front, by name, instead of
  // as a generic "could not download". The shim records a call, so "before any request" is checked.
  // (This replaces a test in which a shim wget copied file:// URLs: it passed because the shim could
  // do what the real wget cannot, and the real wget path is covered through the https origins below.)
  test('a file:// base with no curl exits 1 saying file:// needs curl, and wget is never run', () => {
    const { sb, base, dest } = setup(['git', 'bun', 'tar', 'gzip']);
    const calls = path.join(sb.root, 'wget.calls');
    fs.writeFileSync(path.join(sb.bin, 'wget'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 3\n`, { mode: 0o755 });
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expect(r.stderr).toContain('file:// needs curl');
    expect(fs.existsSync(calls)).toBe(false);
    expectUntouched(sb, dest);
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

  // `--dest ""` used to fall back to the default directory and install there, which is not what the
  // caller wrote; an empty value is a usage error like an empty --ref.
  test('--dest "" exits 2 with the usage text and installs nothing, not even in the default directory', () => {
    const { sb, base } = setup();
    const r = boot(sb, ['--ref', TAG, '--dest', '', ...MINIMAL], { base });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage:');
    expect(r.stderr).toContain('--dest');
    expect(r.stderr).not.toContain('[FAIL]');
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
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

describe('bootstrap: a failed extraction removes only what this run created', () => {
  // A truncated archive with a checksum that matches it: the checksum passes, tar fails part way.
  function truncatedRelease(dir) {
    const archive = path.join(dir, ARCHIVE);
    const bytes = fs.readFileSync(archive);
    const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
    fs.writeFileSync(archive, cut);
    fs.writeFileSync(`${archive}.sha256`, `${sha256Hex(cut)}  ${ARCHIVE}\n`);
  }

  test('an empty <dest>/<ref> the user made beforehand is still there, and empty, afterwards', () => {
    const { sb, base, dest, served: dir } = setup();
    truncatedRelease(dir);
    fs.mkdirSync(path.join(dest, TAG), { recursive: true });
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not extract');
    expect(fs.existsSync(path.join(dest, TAG))).toBe(true);
    expect(fs.readdirSync(path.join(dest, TAG))).toEqual([]);
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });

  test('control: a <dest>/<ref> this run created is removed', () => {
    const { sb, base, dest, served: dir } = setup();
    truncatedRelease(dir);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not extract');
    expect(fs.existsSync(path.join(dest, TAG))).toBe(false);
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });
});

describe('bootstrap: an archive with no top-level install.sh removes only what this run created', () => {
  // A well-formed archive (so extraction succeeds and the checksum matches) that has no install.sh.
  function releaseWithoutInstaller(sb, dir) {
    const stage = path.join(sb.root, 'stage');
    fs.mkdirSync(path.join(stage, `vivera-${TAG}`), { recursive: true });
    fs.writeFileSync(path.join(stage, `vivera-${TAG}`, 'README.md'), 'no installer here\n');
    const archive = path.join(dir, ARCHIVE);
    expect(Bun.spawnSync(['tar', '-czf', archive, '-C', stage, `vivera-${TAG}`]).exitCode).toBe(0);
    fs.writeFileSync(`${archive}.sha256`, `${sha256Hex(fs.readFileSync(archive))}  ${ARCHIVE}\n`);
  }

  test('a <dest>/<ref> this run created is removed, so the next run does not say "already exists"', () => {
    const { sb, base, dest, served: dir } = setup();
    releaseWithoutInstaller(sb, dir);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no install.sh');
    expect(fs.existsSync(path.join(dest, TAG))).toBe(false);
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
    // With the good release back in place, the same command now installs.
    fs.copyFileSync(path.join(fixture, 'dl', TAG, ARCHIVE), path.join(dir, ARCHIVE));
    fs.copyFileSync(path.join(fixture, 'dl', TAG, `${ARCHIVE}.sha256`), path.join(dir, `${ARCHIVE}.sha256`));
    const again = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(again.stderr).not.toContain('already exists');
    expect(again.status).toBe(0);
    expectInstalled(sb, dest);
  });

  test('an empty <dest>/<ref> the user made beforehand is still there, and empty, afterwards', () => {
    const { sb, base, dest, served: dir } = setup();
    releaseWithoutInstaller(sb, dir);
    fs.mkdirSync(path.join(dest, TAG), { recursive: true });
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no install.sh');
    expect(fs.readdirSync(path.join(dest, TAG))).toEqual([]);
    expect(sb.snapshot()).toEqual([]);
    expect(tmpLeft(sb)).toEqual([]);
  });
});

describe('bootstrap: .gitattributes keeps the git hooks LF', () => {
  // .githooks/pre-commit is a bash script with no .sh suffix, so *.sh does not cover it; a Windows
  // autocrlf clone would give it CRLF and break its shebang. Read-only: nothing here writes.
  test('.gitattributes lists .githooks/* as text with eol=lf, and git resolves the hook to eol=lf', () => {
    expect(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split('\n')).toContain('.githooks/* text eol=lf');
    const r = Bun.spawnSync(['git', '-C', ROOT, 'check-attr', 'text', 'eol', '--', '.githooks/pre-commit'], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(r.stdout.toString()).toContain('.githooks/pre-commit: eol: lf');
    expect(r.stdout.toString()).toContain('.githooks/pre-commit: text: set');
  });
});

describe('bootstrap: an existing tree says how to resume', () => {
  test('a directory holding an install.sh is offered a resume command with the install.sh arguments', () => {
    const { sb, base, dest } = setup();
    const target = path.join(dest, TAG);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'install.sh'), '#!/bin/sh\n');
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(r.stderr).toContain(`cd ${target} && ./install.sh --tier minimal --only agents`);
    expect(fs.readdirSync(target)).toEqual(['install.sh']);
  });

  test('a directory without an install.sh is only refused, with no resume command', () => {
    const { sb, base, dest } = setup();
    const target = path.join(dest, TAG);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'mine');
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(r.stderr).not.toContain('./install.sh');
  });
});
