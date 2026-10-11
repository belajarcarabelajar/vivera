// scripts/install-digest-hardening.test.mjs
//
// Data loss in copy mode, found by an adversarial review of the digest logic (scripts/install/lib.sh,
// scripts/install/digest.sh). A managed copy is identical (cmp or diff says equal), pristine (it still has
// the digest the marker recorded: merely outdated, refreshed with no backup) or modified (anything else:
// moved aside or kept). These tests pin the contract the review broke:
//   L1  no usable hash tool must fail closed (it used to answer "cksum:" for every path, so any edited
//       copy looked identical to its source and link mode or --uninstall deleted the edit);
//   L2  the directory digest must see every entry (empty directories, symlinks, an exec bit) and must
//       fail closed on what it cannot vouch for (FIFO, unreadable file), and a digest never overrides
//       cmp or diff (it used to launder what it could not see);
//   L3  the same on a FIRST install, over a directory the user already had and no record names;
//   D1  update never prunes a symlinked SKILL.md from a marked directory.
// A file literally named .DS_Store is Finder litter BY DESIGN and stays out of the digest and out of the
// comparison. Every run uses the sandbox from scripts/lib/install-sandbox.mjs; the bash function under
// test is also called straight (digest()) in a clean shell with the sandbox PATH.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { assertSandbox, makeSandbox } from './lib/install-sandbox.mjs';

const SKILLS = '.agents/skills';
const PKG = `${SKILLS}/super-ultra-code-plan`;
const STAMP = '20260101T000000Z';
const MARKER = '.vivera-managed';
const AS_ROOT = process.getuid?.() === 0;
const rootSkip = AS_ROOT ? test.skip : test;

const open = [];
const restore = [];
afterEach(() => {
  while (restore.length) restore.pop()();
  while (open.length) open.pop().cleanup();
});

const SHA256SUM = Bun.which('sha256sum');
const CKSUM = Bun.which('cksum');

function writeShim(sb, name, body) {
  const file = path.join(sb.bin, name);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// Leaves exactly one hash tool on the sandbox PATH (or none, or a broken one).
//   sha256sum  the real one          shasum   a shim that takes `-a 256` and runs sha256sum
//   cksum      the real one          none     no sha256sum, shasum or cksum at all
//   broken     sha256sum that exits 1 for any input
//   fails-on-alpha  sha256sum that works except on data holding the word alpha (the file a.txt of tree()),
//                   so the probe on empty input and the hash of the final listing pass and one per-file hash fails
function setHash(sb, kind) {
  for (const name of ['sha256sum', 'shasum', 'cksum']) fs.rmSync(path.join(sb.bin, name), { force: true });
  if (kind === 'sha256sum') fs.symlinkSync(SHA256SUM, path.join(sb.bin, 'sha256sum'));
  else if (kind === 'cksum') fs.symlinkSync(CKSUM, path.join(sb.bin, 'cksum'));
  else if (kind === 'shasum') writeShim(sb, 'shasum', `shift 2\nexec ${SHA256SUM} "$@"`);
  else if (kind === 'broken') writeShim(sb, 'sha256sum', 'exit 1');
  else if (kind === 'fails-on-alpha') {
    writeShim(
      sb,
      'sha256sum',
      `data="$(cat; echo x)"\ndata="\${data%x}"\nif [[ "$data" == *alpha* ]]; then echo boom >&2; exit 1; fi\nprintf '%s' "$data" | ${SHA256SUM}`,
    );
  } else if (kind !== 'none') throw new Error(`unknown hash kind ${kind}`);
}

function sandbox({ hash = 'sha256sum' } = {}) {
  const sb = makeSandbox({ tools: ['git', 'bun'] });
  open.push(sb);
  for (const t of ['cmp', 'diff']) fs.symlinkSync(Bun.which(t), path.join(sb.bin, t));
  setHash(sb, hash);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const read = (sb, rel) => fs.readFileSync(at(sb, rel), 'utf8');
const repoFile = (sb, rel) => path.join(sb.repo, rel);
const firstTemplate = (sb) => fs.readdirSync(repoFile(sb, 'templates')).sort()[0];
const lexists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
// A backup is one entry named ...vivera-bak-...; a backed-up directory counts once, not file by file.
const backups = (sb) => sb.snapshot(sb.root).filter((l) => l.split('|')[0].split('/').pop().includes('.vivera-bak-'));
const mkfifo = (p) => expect(Bun.spawnSync([Bun.which('mkfifo'), p]).exitCode).toBe(0);
// A newer checkout: one template file of the source changes.
const outdate = (sb) => fs.appendFileSync(path.join(repoFile(sb, 'templates'), firstTemplate(sb)), '\nnew line\n');

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

describe('L2: a difference the digest could not see is moved aside or kept, never refreshed away', () => {
  const additions = {
    'an empty directory': { make: (dir) => fs.mkdirSync(`${dir}/USERITEM`), probe: 'USERITEM' },
    'nested empty directories': { make: (dir) => fs.mkdirSync(`${dir}/a/b/c`, { recursive: true }), probe: 'a/b/c' },
    'a dangling symlink': { make: (dir) => fs.symlinkSync('/nonexistent/target', `${dir}/dangling`), probe: 'dangling' },
    'a symlink loop': { make: (dir) => fs.symlinkSync('.', `${dir}/loop`), probe: 'loop' },
    'a FIFO': { make: (dir) => mkfifo(`${dir}/fifo`), probe: 'fifo' },
  };
  if (!AS_ROOT) {
    additions['an unreadable file'] = {
      make: (dir) => {
        fs.writeFileSync(`${dir}/secret.md`, 'mine');
        fs.chmodSync(`${dir}/secret.md`, 0o000);
      },
      probe: 'secret.md',
    };
  }

  for (const [what, { make, probe }] of Object.entries(additions)) {
    test(`L2: ${what} in a managed templates dir survives a refresh from a newer checkout (backed up)`, () => {
      const sb = sandbox();
      expect(sb.run(['--copy']).status).toBe(0);
      make(at(sb, `${PKG}/templates`));
      outdate(sb);
      const r = sb.run(['--update', '--copy']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('[BACKUP]');
      expect(lexists(at(sb, `${PKG}/templates.vivera-bak-${STAMP}/${probe}`))).toBe(true);
      expect(lexists(at(sb, `${PKG}/templates/${probe}`))).toBe(false);
    });

    test(`L2: ${what} in a managed templates dir survives link mode (backed up, then relinked)`, () => {
      const sb = sandbox();
      expect(sb.run(['--copy']).status).toBe(0);
      make(at(sb, `${PKG}/templates`));
      const r = sb.run([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('[BACKUP]');
      expect(lexists(at(sb, `${PKG}/templates.vivera-bak-${STAMP}/${probe}`))).toBe(true);
      expect(fs.lstatSync(at(sb, `${PKG}/templates`)).isSymbolicLink()).toBe(true);
    });

    test(`L2: ${what} in a managed templates dir is kept by --uninstall`, () => {
      const sb = sandbox();
      expect(sb.run(['--copy']).status).toBe(0);
      make(at(sb, `${PKG}/templates`));
      const r = sb.run(['--uninstall']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`[KEEP] ${at(sb, `${PKG}/templates`)}`);
      expect(lexists(at(sb, `${PKG}/templates/${probe}`))).toBe(true);
    });
  }

  test('L2: the exact repro: mkdir USERITEM in templates, update from a newer source, nothing is "Refreshed" away', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.mkdirSync(at(sb, `${PKG}/templates/USERITEM`));
    outdate(sb);
    const r = sb.run(['--update', '--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(`[OK] Refreshed: ${at(sb, `${PKG}/templates`)}`);
    expect(fs.statSync(at(sb, `${PKG}/templates.vivera-bak-${STAMP}/USERITEM`)).isDirectory()).toBe(true);
  });

  test('L2: a user symlink whose target has the source content is still the user\'s: link mode backs it up', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const name = firstTemplate(sb);
    const mine = path.join(sb.root, 'mine.md');
    fs.copyFileSync(path.join(repoFile(sb, 'templates'), name), mine);
    fs.rmSync(at(sb, `${PKG}/templates/${name}`));
    fs.symlinkSync(mine, at(sb, `${PKG}/templates/${name}`));
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[BACKUP]');
    expect(fs.lstatSync(at(sb, `${PKG}/templates.vivera-bak-${STAMP}/${name}`)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(mine, 'utf8')).toBe(fs.readFileSync(path.join(repoFile(sb, 'templates'), name), 'utf8'));
  });

  test('L2: a .DS_Store DIRECTORY holding a user file is not Finder litter: link mode backs it up', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.mkdirSync(at(sb, `${PKG}/templates/.DS_Store`));
    fs.writeFileSync(at(sb, `${PKG}/templates/.DS_Store/mine.md`), 'mine');
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[BACKUP]');
    expect(read(sb, `${PKG}/templates.vivera-bak-${STAMP}/.DS_Store/mine.md`)).toBe('mine');
  });

  test('L2: a .DS_Store FILE, at any depth, is still Finder litter: no backup, nothing refreshed', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.writeFileSync(at(sb, `${PKG}/templates/.DS_Store`), 'finder');
    for (const sub of fs.readdirSync(at(sb, `${PKG}/templates`), { withFileTypes: true })) {
      if (sub.isDirectory()) fs.writeFileSync(at(sb, `${PKG}/templates/${sub.name}/.DS_Store`), 'finder');
    }
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('[BACKUP]');
    expect(r.stdout).not.toContain('Refreshed');
    expect(backups(sb)).toEqual([]);
    // And a newer checkout still refreshes the dir without a backup: the litter is not an edit.
    outdate(sb);
    const again = sb.run(['--copy']);
    expect(again.stdout).toContain('Refreshed');
    expect(backups(sb)).toEqual([]);
  });

  test('L2: a diff without -x (BusyBox) still finds an unchanged copy current, and a .DS_Store file does not change that', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.writeFileSync(at(sb, `${PKG}/templates/.DS_Store`), 'finder');
    writeShim(sb, 'diff', `for a in "$@"; do\n  case "$a" in -x | -x*) echo "diff: unrecognized option: x" >&2; exit 2 ;; esac\ndone\nexec ${Bun.which('diff')} "$@"`);
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('[BACKUP]');
    expect(r.stdout).not.toContain('Refreshed');
    expect(sb.run(['--check', '--copy']).stdout).toContain('check: CURRENT');
  });

  test('L2: a diff that cannot compare (exit 2) never makes a copy identical', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(at(sb, `${PKG}/templates/${firstTemplate(sb)}`), '\nmy edit\n');
    writeShim(sb, 'diff', 'echo "diff: trouble" >&2\nexit 2');
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[BACKUP]');
    expect(read(sb, `${PKG}/templates.vivera-bak-${STAMP}/${firstTemplate(sb)}`).endsWith('my edit\n')).toBe(true);
  });
});

describe('L2: the exec bit of a file in a copied directory is part of what the installer placed', () => {
  test('L2: chmod +x on a template, then a refresh from a newer checkout, backs the dir up', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const name = firstTemplate(sb);
    fs.chmodSync(at(sb, `${PKG}/templates/${name}`), 0o755);
    outdate(sb);
    const r = sb.run(['--update', '--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[BACKUP]');
    expect(fs.statSync(at(sb, `${PKG}/templates.vivera-bak-${STAMP}/${name}`)).mode & 0o100).toBe(0o100);
  });
});

describe('L3: a user directory with no record, equal to the source but for something unreadable, is not adopted', () => {
  rootSkip('L3: first --copy over such a templates dir backs it up, and --uninstall then gives it back', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.cpSync(repoFile(sb, 'templates'), at(sb, `${PKG}/templates`), { recursive: true });
    fs.writeFileSync(at(sb, `${PKG}/templates/secret.md`), 'mine');
    fs.chmodSync(at(sb, `${PKG}/templates/secret.md`), 0o000);
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[BACKUP]');
    expect(lexists(at(sb, `${PKG}/templates.vivera-bak-${STAMP}/secret.md`))).toBe(true);
    expect(lexists(at(sb, `${PKG}/templates/secret.md`))).toBe(false);
    const u = sb.run(['--uninstall']);
    expect(u.status).toBe(0);
    expect(lexists(at(sb, `${PKG}/templates/secret.md`))).toBe(true);
  });

  test('L3: first --copy over such a templates dir that holds an empty directory backs it up too', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.cpSync(repoFile(sb, 'templates'), at(sb, `${PKG}/templates`), { recursive: true });
    fs.mkdirSync(at(sb, `${PKG}/templates/USERITEM`));
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(lexists(at(sb, `${PKG}/templates.vivera-bak-${STAMP}/USERITEM`))).toBe(true);
    expect(sb.run(['--uninstall']).status).toBe(0);
    expect(lexists(at(sb, `${PKG}/templates/USERITEM`))).toBe(true);
  });

  test('L3: a pre-existing templates dir that is exactly the source is still adopted (identical content is ours)', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.cpSync(repoFile(sb, 'templates'), at(sb, `${PKG}/templates`), { recursive: true });
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(lexists(at(sb, `${PKG}/templates.vivera-bak-${STAMP}`))).toBe(false);
  });
});

describe('the marker record is judged only when it is unambiguous', () => {
  // A second line for the same entry, after the real one or before it (so neither "first line wins" nor
  // "last line wins" can pass).
  function ambiguous(sb, extra, before) {
    const marker = at(sb, `${PKG}/${MARKER}`);
    const lines = fs.readFileSync(marker, 'utf8').trimEnd().split('\n');
    const line = lines.find((l) => l.startsWith('entry mermaid.config.json '));
    expect(line).toBeTruthy();
    lines.splice(before ? lines.indexOf(line) : lines.length, 0, extra(line));
    fs.writeFileSync(marker, `${lines.join('\n')}\n`);
  }

  for (const [what, extra, before] of [
    ['a second line with another digest after it', () => `entry mermaid.config.json sha256:${'0'.repeat(64)}`, false],
    ['a second line with another digest before it', () => `entry mermaid.config.json sha256:${'0'.repeat(64)}`, true],
    ['the same line twice', (line) => line, false],
  ]) {
    test(`recorded_digest: ${what} for one entry makes it ambiguous, so an outdated copy is backed up, not refreshed`, () => {
      const sb = sandbox();
      expect(sb.run(['--copy']).status).toBe(0);
      ambiguous(sb, extra, before);
      fs.appendFileSync(repoFile(sb, 'mermaid.config.json'), '\n');
      const r = sb.run(['--copy']);
      expect(r.status).toBe(0);
      expect(lexists(at(sb, `${PKG}/mermaid.config.json.vivera-bak-${STAMP}`))).toBe(true);
    });
  }

  test('recorded_digest: a single line is still believed, so an outdated pristine copy is refreshed with no backup', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(repoFile(sb, 'mermaid.config.json'), '\n');
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Refreshed');
    expect(backups(sb)).toEqual([]);
  });
});

describe('D1: update prunes a stale phase dir only when what it removes is the installer\'s own', () => {
  const stale = (sb, name) => {
    const dir = at(sb, `${SKILLS}/${name}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(`${dir}/${MARKER}`, `source=${sb.repo}\n`);
    return dir;
  };

  test('D1: a symlinked SKILL.md in a marked dir is kept with "(not a plain file)", and its target is untouched', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const dir = stale(sb, 'sucp-linked');
    const mine = path.join(sb.root, 'my-skill.md');
    fs.writeFileSync(mine, 'my own skill\n');
    fs.symlinkSync(mine, `${dir}/SKILL.md`);
    const r = sb.run(['--update', '--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${dir} (not a plain file)`);
    expect(r.stdout).not.toContain(`[PRUNED] ${dir}`);
    expect(fs.lstatSync(`${dir}/SKILL.md`).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(mine, 'utf8')).toBe('my own skill\n');
    expect(fs.existsSync(`${dir}/${MARKER}`)).toBe(true);
  });

  test('D1: a dangling symlinked SKILL.md in a marked dir is kept too', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const dir = stale(sb, 'sucp-dangling');
    fs.symlinkSync('/nonexistent/skill.md', `${dir}/SKILL.md`);
    const r = sb.run(['--update', '--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${dir} (not a plain file)`);
    expect(fs.lstatSync(`${dir}/SKILL.md`).isSymbolicLink()).toBe(true);
  });

  test('D1: a link-mode leftover (no marker, a link into this checkout) is still pruned', () => {
    const sb = sandbox();
    expect(sb.run([]).status).toBe(0);
    const dir = at(sb, `${SKILLS}/sucp-gone`);
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(sb.repo, 'skills/sucp-gone/SKILL.md'), `${dir}/SKILL.md`);
    const r = sb.run(['--update']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[PRUNED] ${dir}`);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
