// scripts/bootstrap-validation.test.mjs
//
// scripts/bootstrap.sh, what is refused before anything is written: a release that cannot be trusted
// (tampered, missing or wrong checksum, no SHA-256 tool), the only accepted tag shape (the same one
// scripts/release/build-archive.sh accepts, checked as a parity test), the usage errors, a checksum
// file that is not about this archive, and what a truncated download of the script itself does. The
// fixtures (the release built from the committed tree, the sandbox, the runners) are in
// scripts/lib/bootstrap-fixtures.mjs.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARCHIVE,
  BOOT,
  BUILD,
  EMPTY_SHA256,
  MINIMAL,
  TAG,
  boot,
  buildRelease,
  cleanupFixture,
  closeSandboxes,
  expectInstalled,
  expectUntouched,
  flipByte,
  setup,
  sha256Hex,
} from './lib/bootstrap-fixtures.mjs';

beforeAll(buildRelease);
afterAll(cleanupFixture);
afterEach(closeSandboxes);

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

  // A tag is capped at 100 characters (the file names derived from it stay far under the 255-byte limit),
  // the same cap as build-archive.sh. At the cap it passes; one more, or 300, is refused.
  const atCap = `v1.0.0-${'a'.repeat(93)}`;
  const overCap = `v1.0.0-${'a'.repeat(94)}`;
  const longTag = `v1.0.0-${'a'.repeat(293)}`;
  test('the length fixtures are 100, 101 and 300 characters', () => {
    expect([atCap.length, overCap.length, longTag.length]).toEqual([100, 101, 300]);
  });

  // From 'v1.0.0..' to 'v1.0.0-é', five match a plain [0-9A-Za-z.] pattern but are not valid git ref names,
  // or are not ASCII; the last two are over the length cap.
  const badRefs = ['main', 'v1', 'v1.0.0;rm -rf x', '0.1.0', '', 'a1b2c3d4e5f6', 'v1.0.0/../x', 'v1.0.0..', 'v1.0.0.lock', 'v1.0.0-.', 'v1.0.0-rc..1', 'v1.0.0-é', overCap, longTag];
  for (const ref of badRefs) {
    test(`--ref ${ref.length > 40 ? `(a ${ref.length}-character tag)` : JSON.stringify(ref)} exits 2 with the usage text and attempts nothing`, () => {
      const { sb, dest } = setup();
      const r = boot(sb, ['--ref', ref, '--dest', dest], { base: never });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage:');
      expect(r.stderr).not.toContain('[FAIL]');
      expect(r.stderr).not.toContain('nonexistent');
      expectUntouched(sb, dest);
    });
  }

  test('a non-ASCII tag is refused whatever the locale says a letter is', () => {
    const { sb, dest } = setup();
    for (const locale of ['en_US.UTF-8', 'C.UTF-8']) {
      const r = boot(sb, ['--ref', 'v1.0.0-é', '--dest', dest], { base: never, env: { LC_ALL: locale } });
      expect(r.status).toBe(2);
    }
    expectUntouched(sb, dest);
  });

  test('bootstrap.sh and build-archive.sh accept and refuse the same tags', () => {
    const { sb, dest } = setup();
    const accepted = ['v1.0.0', 'v1.0.0-rc.1', 'v1.0.0.1', 'v1.0.0-.1', 'v10.20.30', 'v1.2.3-rc.1.2', atCap];
    const buildEnv = { PATH: process.env.PATH, HOME: sb.home, GIT_CONFIG_GLOBAL: '/dev/null', VIVERA_REPO_DIR: path.join(sb.root, 'no-such-repo') };
    for (const tag of [...accepted, ...badRefs.filter((r) => r !== '' && r !== 'a1b2c3d4e5f6')]) {
      const built = Bun.spawnSync(['bash', BUILD, tag, path.join(sb.root, 'parity-out')], { env: buildEnv });
      const booted = boot(sb, ['--ref', tag, '--dest', dest], { base: never });
      // Exit 2 is the usage refusal; any other status means the tag got past the check.
      expect({ tag, build: built.exitCode === 2, bootstrap: booted.status === 2 }).toEqual({ tag, build: !accepted.includes(tag), bootstrap: !accepted.includes(tag) });
    }
  });

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

describe('bootstrap: the checksum file must be about this archive', () => {
  test('a .sha256 that names another file, even with a digest that file really has, exits 1 before extraction', () => {
    const { sb, base, dest, served: dir } = setup();
    fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), `${EMPTY_SHA256}  /dev/null\n`);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test("the archive's real digest under another file name exits 1", () => {
    const { sb, base, dest, served: dir } = setup();
    const real = sha256Hex(fs.readFileSync(path.join(dir, ARCHIVE)));
    fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), `${real}  other-${ARCHIVE}\n`);
    const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[FAIL]');
    expectUntouched(sb, dest);
  });

  test('a file with no digest, or a short one, exits 1', () => {
    const { sb, base, dest, served: dir } = setup();
    for (const body of ['', '\n', `abc123  ${ARCHIVE}\n`, `${ARCHIVE}\n`]) {
      fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), body);
      const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
      expect({ body, status: r.status }).toEqual({ body, status: 1 });
    }
    expectUntouched(sb, dest);
  });

  test('control: the right name with a zero digest exits 1', () => {
    const { sb, base, dest, served: dir } = setup();
    fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), `${'0'.repeat(64)}  ${ARCHIVE}\n`);
    expect(boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base }).status).toBe(1);
    expectUntouched(sb, dest);
  });

  test('control: the right name and digest installs, also with the binary-mode marker and an upper-case digest', () => {
    for (const style of ['plain', 'binary', 'upper']) {
      const { sb, base, dest, served: dir } = setup();
      const real = sha256Hex(fs.readFileSync(path.join(dir, ARCHIVE)));
      const line = { plain: `${real}  ${ARCHIVE}\n`, binary: `${real} *${ARCHIVE}\n`, upper: `${real.toUpperCase()}  ${ARCHIVE}\n` }[style];
      fs.writeFileSync(path.join(dir, `${ARCHIVE}.sha256`), line);
      const r = boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base });
      expect({ style, status: r.status, err: r.stderr.includes('[FAIL]') }).toEqual({ style, status: 0, err: false });
      expectInstalled(sb, dest);
    }
  });
});

describe('bootstrap: what a truncated download does', () => {
  const text = fs.readFileSync(BOOT, 'utf8');

  test('the header says what is true: nothing executes, but the shell may exit 0 having done nothing', () => {
    const header = text.split('\n').filter((l) => l.startsWith('#')).join('\n');
    expect(header).not.toMatch(/ends in a syntax error/);
    expect(header).toMatch(/nothing executes/i);
    expect(header).toMatch(/may exit 0/);
  });

  test('cut at every line boundary before the final call, no prefix fetches, extracts or installs anything', () => {
    const lines = text.split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines.at(-2)).toBe('main "$@"');
    const { sb, base, dest } = setup();
    const statuses = new Set();
    for (let n = 1; n < lines.length - 2; n++) {
      const prefix = `${lines.slice(0, n).join('\n')}\n`;
      statuses.add(boot(sb, ['--ref', TAG, '--dest', dest, ...MINIMAL], { base, stdin: prefix }).status);
    }
    // A silent exit 0 is real (the first cut is one), which is why the header must not promise a syntax error.
    expect(statuses.has(0)).toBe(true);
    expectUntouched(sb, dest);
  });
});
