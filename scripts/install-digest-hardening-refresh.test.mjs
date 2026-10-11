// scripts/install-digest-hardening-refresh.test.mjs
//
// Part of the digest hardening suite (contract and background: install-digest-hardening-digest.test.mjs).
// This file pins what a refresh, link mode and --uninstall do with a difference the directory digest could
// not see in a managed templates dir: an empty directory, a symlink, a FIFO, an unreadable file, an exec
// bit. Such a difference is moved aside or kept, never refreshed away, and a digest never overrides cmp or
// diff (it used to launder what it could not see). A file literally named .DS_Store stays Finder litter.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  AS_ROOT,
  at,
  backups,
  cleanup,
  firstTemplate,
  lexists,
  mkfifo,
  outdate,
  PKG,
  read,
  repoFile,
  sandbox,
  STAMP,
  writeShim,
} from './lib/install-digest-helpers.mjs';

afterEach(cleanup);

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
