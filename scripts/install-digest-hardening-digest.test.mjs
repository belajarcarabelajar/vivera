// scripts/install-digest-hardening-digest.test.mjs
//
// Data loss in copy mode, found by an adversarial review of the digest logic (scripts/install/lib.sh,
// scripts/install/digest.sh). A managed copy is identical (cmp or diff says equal), pristine (it still has
// the digest the marker recorded: merely outdated, refreshed with no backup) or modified (anything else:
// moved aside or kept). These tests pin the contract the review broke. They are split by area into three
// files; this one holds the digest itself, which the bash function entry_digest answers and which the tests
// also call straight (digest()) in a clean shell with the sandbox PATH:
//   L2  the directory digest must see every entry (empty directories, symlinks, an exec bit) and must
//       fail closed on what it cannot vouch for (FIFO, unreadable file);
//   L1  no usable hash tool must fail closed (it used to answer "cksum:" for every path, so any edited
//       copy looked identical to its source and link mode or --uninstall deleted the edit), and the
//       sha256sum, shasum and cksum matrix.
// The other two files: install-digest-hardening-refresh.test.mjs (a difference the digest could not see is
// moved aside or kept, and a digest never overrides cmp or diff) and install-digest-hardening-records.test.mjs
// (L3 first installs over an unrecorded directory, an ambiguous marker record, D1 update pruning).
// A file literally named .DS_Store is Finder litter BY DESIGN and stays out of the digest and out of the
// comparison. Every run uses the sandbox from scripts/lib/install-sandbox.mjs, extended by
// scripts/lib/install-digest-helpers.mjs.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  at,
  backups,
  cleanup,
  lexists,
  MARKER,
  mkfifo,
  PKG,
  read,
  repoFile,
  restore,
  rootSkip,
  sandbox,
  setHash,
  STAMP,
} from './lib/install-digest-helpers.mjs';
import { assertSandbox } from './lib/install-sandbox.mjs';

afterEach(cleanup);

// entry_digest from lib.sh, called in a clean shell whose PATH is the sandbox bin.
function digest(sb, target) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const r = Bun.spawnSync(
    ['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), '-c', 'set -euo pipefail; REPO_DIR="$1"; . "$REPO_DIR/scripts/install/lib.sh"; entry_digest "$2"', 'x', sb.repo, target],
    { cwd: sb.home, timeout: 30_000 },
  );
  return { status: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
}

// A small tree under the sandbox root, with the same shape wherever it is made.
function tree(sb, name) {
  const dir = path.join(sb.root, name);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(dir, 'sub/b.txt'), 'beta\n');
  return dir;
}

describe('L2: the directory digest lists every entry, and fails closed on what it cannot vouch for', () => {
  test('digest: a tree has a sha256 digest, and the same tree elsewhere has the same one', () => {
    const sb = sandbox();
    const a = digest(sb, tree(sb, 'one'));
    expect(a.out).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest(sb, tree(sb, 'two')).out).toBe(a.out);
  });

  const additions = {
    'an empty directory': (dir) => fs.mkdirSync(`${dir}/USERITEM`),
    'nested empty directories': (dir) => fs.mkdirSync(`${dir}/x/y/z`, { recursive: true }),
    'a dangling symlink': (dir) => fs.symlinkSync('/nonexistent/target', `${dir}/dangling`),
    'a symlink loop': (dir) => fs.symlinkSync('.', `${dir}/loop`),
    'a symlink to a file': (dir) => fs.symlinkSync('a.txt', `${dir}/alias`),
    'an executable bit': (dir) => fs.chmodSync(`${dir}/a.txt`, 0o755),
    'a changed byte': (dir) => fs.writeFileSync(`${dir}/a.txt`, 'alphA\n'),
    'a renamed file': (dir) => fs.renameSync(`${dir}/a.txt`, `${dir}/c.txt`),
    'a file named like a directory of the tree': (dir) => fs.writeFileSync(`${dir}/sub.txt`, ''),
  };
  for (const [what, change] of Object.entries(additions)) {
    test(`digest: ${what} changes the digest`, () => {
      const sb = sandbox();
      const dir = tree(sb, 'one');
      const before = digest(sb, dir).out;
      change(dir);
      const after = digest(sb, dir);
      expect(after.status).toBe(0);
      expect(after.out).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(after.out).not.toBe(before);
    });
  }

  test('digest: a symlink is told by its target, so retargeting it changes the digest', () => {
    const sb = sandbox();
    const one = tree(sb, 'one');
    const two = tree(sb, 'two');
    fs.symlinkSync('a.txt', `${one}/alias`);
    fs.symlinkSync('sub/b.txt', `${two}/alias`);
    expect(digest(sb, one).out).not.toBe(digest(sb, two).out);
  });

  test('digest: a .DS_Store FILE is Finder litter and does not change the digest, a .DS_Store directory does', () => {
    const sb = sandbox();
    const dir = tree(sb, 'one');
    const before = digest(sb, dir).out;
    fs.writeFileSync(`${dir}/.DS_Store`, 'finder');
    fs.writeFileSync(`${dir}/sub/.DS_Store`, 'finder');
    expect(digest(sb, dir).out).toBe(before);
    fs.rmSync(`${dir}/.DS_Store`);
    fs.mkdirSync(`${dir}/.DS_Store`);
    fs.writeFileSync(`${dir}/.DS_Store/mine.md`, 'mine');
    const withDir = digest(sb, dir).out;
    expect(withDir).toMatch(/^sha256:/);
    expect(withDir).not.toBe(before);
  });

  test('digest: a FIFO in the tree makes the digest empty (nothing vouches for it)', () => {
    const sb = sandbox();
    const dir = tree(sb, 'one');
    mkfifo(`${dir}/fifo`);
    const r = digest(sb, dir);
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  rootSkip('digest: an unreadable file in the tree makes the digest empty', () => {
    const sb = sandbox();
    const dir = tree(sb, 'one');
    fs.writeFileSync(`${dir}/secret.md`, 'mine');
    fs.chmodSync(`${dir}/secret.md`, 0o000);
    expect(digest(sb, dir).out).toBe('');
  });

  rootSkip('digest: an unreadable directory in the tree makes the digest empty', () => {
    const sb = sandbox();
    const dir = tree(sb, 'one');
    fs.mkdirSync(`${dir}/locked`);
    fs.writeFileSync(`${dir}/locked/x`, 'mine');
    fs.chmodSync(`${dir}/locked`, 0o000);
    restore.push(() => fs.chmodSync(`${dir}/locked`, 0o755));
    expect(digest(sb, dir).out).toBe('');
  });

  rootSkip('digest: an unreadable single file has an empty digest, not the digest of nothing', () => {
    const sb = sandbox();
    const file = path.join(sb.root, 'one.txt');
    fs.writeFileSync(file, 'mine');
    expect(digest(sb, file).out).toMatch(/^sha256:/);
    fs.chmodSync(file, 0o000);
    expect(digest(sb, file).out).toBe('');
  });

  test('digest: a file name holding a newline makes the digest empty (a line-based listing could not tell it)', () => {
    const sb = sandbox();
    const dir = tree(sb, 'one');
    fs.writeFileSync(`${dir}/odd\nname`, 'x');
    expect(digest(sb, dir).out).toBe('');
  });

  test('digest: a hash command that fails on one file makes the digest empty, for a tree and for a file', () => {
    const sb = sandbox({ hash: 'fails-on-alpha' });
    const dir = tree(sb, 'one');
    expect(digest(sb, dir).out).toBe('');
    expect(digest(sb, `${dir}/a.txt`).out).toBe('');
  });

  test('digest: something that is neither a file nor a directory has no digest', () => {
    const sb = sandbox();
    expect(digest(sb, path.join(sb.root, 'absent')).out).toBe('');
    const dir = tree(sb, 'one');
    fs.symlinkSync('a.txt', `${dir}/alias`);
    expect(digest(sb, `${dir}/alias`).out).toBe('');
  });
});

describe('L1: the hash tool matrix, and no usable hash tool at all', () => {
  test('digest: sha256sum alone and shasum alone give the same sha256 digest, for a tree and for a file', () => {
    const viaSha256sum = sandbox({ hash: 'sha256sum' });
    const viaShasum = sandbox({ hash: 'shasum' });
    const a = digest(viaSha256sum, tree(viaSha256sum, 'one'));
    const b = digest(viaShasum, tree(viaShasum, 'one'));
    expect(a.out).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.out).toBe(a.out);
    expect(digest(viaShasum, `${tree(viaShasum, 'two')}/a.txt`).out).toBe(digest(viaSha256sum, `${tree(viaSha256sum, 'two')}/a.txt`).out);
  });

  test('digest: cksum alone gives a cksum digest that still tells two trees apart', () => {
    const sb = sandbox({ hash: 'cksum' });
    const dir = tree(sb, 'one');
    const before = digest(sb, dir).out;
    expect(before).toMatch(/^cksum:\d+-\d+$/);
    fs.writeFileSync(`${dir}/a.txt`, 'alphA\n');
    const after = digest(sb, dir).out;
    expect(after).toMatch(/^cksum:\d+-\d+$/);
    expect(after).not.toBe(before);
    expect(digest(sb, `${dir}/a.txt`).out).toMatch(/^cksum:/);
  });

  for (const kind of ['none', 'broken']) {
    test(`digest: with ${kind === 'none' ? 'no hash tool on PATH' : 'a sha256sum that cannot run'} the digest is empty for a tree and for a file`, () => {
      const sb = sandbox({ hash: kind });
      const dir = tree(sb, 'one');
      expect(digest(sb, dir)).toMatchObject({ status: 0, out: '' });
      expect(digest(sb, `${dir}/a.txt`)).toMatchObject({ status: 0, out: '' });
    });
  }

  function editedCopy(hash) {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(at(sb, `${PKG}/SKILL.md`), '\nmy edit\n');
    const edited = read(sb, `${PKG}/SKILL.md`);
    setHash(sb, hash);
    return { sb, edited };
  }

  for (const hash of ['none', 'broken']) {
    test(`L1: link mode over an edited copy backs the edit up when there is no usable hash tool (${hash})`, () => {
      const { sb, edited } = editedCopy(hash);
      const r = sb.run([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('[BACKUP]');
      expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)).toBe(edited);
      expect(fs.lstatSync(at(sb, `${PKG}/SKILL.md`)).isSymbolicLink()).toBe(true);
    });

    test(`L1: --uninstall keeps an edited copy when there is no usable hash tool (${hash})`, () => {
      const { sb, edited } = editedCopy(hash);
      const r = sb.run(['--uninstall']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`[KEEP] ${at(sb, `${PKG}/SKILL.md`)}`);
      expect(read(sb, `${PKG}/SKILL.md`)).toBe(edited);
    });
  }

  test('L1: --copy over an edited copy backs the edit up and places the new file when there is no hash tool', () => {
    const { sb, edited } = editedCopy('none');
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)).toBe(edited);
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`)).equals(fs.readFileSync(repoFile(sb, 'Super Ultra Code Plan Implementation.md')))).toBe(true);
  });

  test('L1: --copy with no hash tool installs, writes no record it cannot back, and a later run with a tool backs the copy up', () => {
    const sb = sandbox({ hash: 'none' });
    expect(sb.run(['--copy']).status).toBe(0);
    const marker = read(sb, `${PKG}/${MARKER}`);
    expect(marker).toContain(`source=${sb.repo}`);
    expect(marker).not.toMatch(/^entry .* cksum:$/m);
    expect(marker).not.toMatch(/^entry /m);
    fs.appendFileSync(at(sb, `${PKG}/SKILL.md`), '\nmy edit\n');
    setHash(sb, 'sha256sum');
    const r = sb.run(['--uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${at(sb, `${PKG}/SKILL.md`)}`);
    expect(read(sb, `${PKG}/SKILL.md`).endsWith('my edit\n')).toBe(true);
  });

  for (const hash of ['sha256sum', 'shasum', 'cksum']) {
    test(`L1: with ${hash} alone an edited copy is backed up and an outdated pristine one is refreshed with no backup`, () => {
      const sb = sandbox({ hash });
      expect(sb.run(['--copy']).status).toBe(0);
      const algo = hash === 'cksum' ? 'cksum' : 'sha256';
      expect(read(sb, `${PKG}/${MARKER}`)).toMatch(new RegExp(`^entry SKILL\\.md ${algo}:\\S+$`, 'm'));
      fs.appendFileSync(at(sb, `${PKG}/SKILL.md`), '\nmy edit\n');
      fs.appendFileSync(repoFile(sb, 'mermaid.config.json'), '\n');
      const r = sb.run(['--copy']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Refreshed');
      expect(backups(sb).length).toBe(1);
      expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`).endsWith('my edit\n')).toBe(true);
      expect(lexists(at(sb, `${PKG}/mermaid.config.json.vivera-bak-${STAMP}`))).toBe(false);
    });
  }
});
