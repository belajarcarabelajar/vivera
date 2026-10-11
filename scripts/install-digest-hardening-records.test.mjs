// scripts/install-digest-hardening-records.test.mjs
//
// Part of the digest hardening suite (contract and background: install-digest-hardening-digest.test.mjs).
// This file pins what the installer may believe about what it did not place itself:
//   L3  the same unreadable-or-empty-entry rule on a FIRST install, over a directory the user already had
//       and no record names;
//   the marker record, which is judged only when it is unambiguous (a doubled or contradicted entry line
//       backs the copy up instead of refreshing it);
//   D1  update never prunes a symlinked SKILL.md from a marked directory.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  at,
  backups,
  cleanup,
  lexists,
  MARKER,
  PKG,
  repoFile,
  rootSkip,
  SKILLS,
  sandbox,
  STAMP,
} from './lib/install-digest-helpers.mjs';

afterEach(cleanup);

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
