// scripts/install-hardening-modes.test.mjs
//
// Hardening findings about what check, update and uninstall report and need, and about a placement
// that fails after the user's file was moved aside, one describe per finding
// (H from an independent review of the installer, C from round 2):
//   H4  --check also reports stale phase dirs and never says CURRENT when it checked nothing
//   H6  uninstall leaves the Antigravity builtin skills dir; update says when a dir stays
//   H7  --check and --uninstall need no bun and no git
//   H9  a failed link or copy after a move puts the user's file back
//   C9d a directory copy that fails half way puts the user's directory back
// Split out of the former install-hardening.test.mjs by area; the other areas are in
// install-hardening-ownership.test.mjs and install-hardening-environment.test.mjs, and the shared
// fixtures are in scripts/lib/install-hardening-helpers.mjs.
// Every run uses the sandbox from scripts/lib/install-sandbox.mjs.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENTS,
  BUILTIN,
  MASTER,
  PKG,
  at,
  backupsUnder,
  closeSandboxes,
  exists,
  mkdir,
  sandbox,
  shim,
  withCompareTools,
} from './lib/install-hardening-helpers.mjs';

afterEach(closeSandboxes);

describe('H4: check finds stale phase dirs and refuses to call an empty check CURRENT', () => {
  test('H4: a leftover dangling sucp-gone is reported, pruned by --update, and then check is CURRENT', () => {
    const sb = sandbox();
    expect(sb.run([]).status).toBe(0);
    const dir = at(sb, `${AGENTS}/sucp-gone`);
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(sb.repo, 'skills/sucp-gone/SKILL.md'), `${dir}/SKILL.md`);
    const stale = sb.run(['--check']);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain(`[stale] ${dir} (a skill this checkout no longer has; --update prunes it)`);
    expect(stale.stdout).toContain('check: 1 problem(s)');

    const upd = sb.run(['--update']);
    expect(upd.status).toBe(0);
    expect(upd.stdout).toContain(`[PRUNED] ${dir}`);
    const after = sb.run(['--check']);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('check: CURRENT');
  });

  test('H4: nothing selected, or only targets without skills, is exit 2 and never CURRENT', () => {
    // Changed in T17: with bun on PATH a codex check also looks at its sprite dir, so that case runs with
    // no bun (the sprite line is then a skip that counts for nothing).
    const cases = [
      { args: ['--check', '--only', 'codex'], tools: [] },
      { args: ['--check', '--only', 'claude', '--skip', 'claude'], tools: ['git', 'bun'] },
    ];
    for (const { args, tools } of cases) {
      const sb = sandbox({ tools });
      const r = sb.run(args);
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
      expect(r.stdout).toContain('check: nothing to check (no selected target has skills)');
      expect(r.stdout).not.toContain('CURRENT');
    }
  });
});

describe('H6: directories the installer did not make stay, and update says when one stays', () => {
  test('H6: uninstall removes an emptied skills dir it made but not the Antigravity builtin one', () => {
    const sb = sandbox();
    mkdir(sb, BUILTIN);
    expect(sb.run([]).status).toBe(0);
    expect(sb.run(['--uninstall']).status).toBe(0);
    expect(exists(sb, BUILTIN)).toBe(true);
    expect(exists(sb, '.gemini/config/skills')).toBe(false);
  });

  test('H6: update names the dir that stays, and prints the plain line only when the dir is gone', () => {
    const sb = sandbox();
    expect(sb.run([]).status).toBe(0);
    const keeps = at(sb, `${AGENTS}/sucp-x`);
    const gone = at(sb, `${AGENTS}/sucp-gone`);
    for (const dir of [keeps, gone]) {
      fs.mkdirSync(dir);
      fs.symlinkSync(path.join(sb.repo, `skills/${path.basename(dir)}/SKILL.md`), `${dir}/SKILL.md`);
    }
    fs.writeFileSync(`${keeps}/notes.txt`, 'keep me');
    const r = sb.run(['--update']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[PRUNED] link removed from ${keeps}; the directory stays because it holds other files`);
    expect(r.stdout).toContain(`[PRUNED] ${gone}\n`);
    expect(fs.readFileSync(`${keeps}/notes.txt`, 'utf8')).toBe('keep me');
  });
});

describe('H7: check and uninstall need no bun and no git', () => {
  test('H7: both succeed with neither tool on PATH at the default tier, and update still needs them', () => {
    const sb = sandbox();
    expect(sb.run([]).status).toBe(0);
    fs.rmSync(path.join(sb.bin, 'git'));
    fs.rmSync(path.join(sb.bin, 'bun'));
    const check = sb.run(['--check']);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('check: CURRENT');
    const update = sb.run(['--update']);
    expect(update.status).toBe(1);
    expect(update.stderr).toContain('Missing prerequisite');
    const uninstall = sb.run(['--uninstall']);
    expect(uninstall.status).toBe(0);
    expect(exists(sb, `.config/ai/${MASTER}`)).toBe(false);
  });

  test('H7: the usage text says which modes ask for no tool and what exit 2 means', () => {
    const sb = sandbox();
    const r = sb.run(['-h']);
    expect(r.stdout).toContain('needs no bun and no git');
    expect(r.stdout).toContain('nothing to check');
  });
});

describe('H9: a failed placement after a move puts the user file back', () => {
  test('H9: a link that cannot be made restores the moved file and exits 1', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.writeFileSync(at(sb, `${PKG}/SKILL.md`), 'mine');
    shim(sb, 'ln', 'exit 1');
    const r = sb.run(['--only', 'agents']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[FAIL] could not place ${at(sb, `${PKG}/SKILL.md`)}; your file was put back`);
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`), 'utf8')).toBe('mine');
    expect(backupsUnder(sb)).toEqual([]);
  });

  test('H9: a copy that cannot be made restores the moved file and exits 1', () => {
    const sb = sandbox();
    withCompareTools(sb);
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.writeFileSync(at(sb, `${PKG}/SKILL.md`), 'mine');
    shim(sb, 'cp', 'exit 1');
    const r = sb.run(['--copy', '--only', 'agents']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('your file was put back');
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`), 'utf8')).toBe('mine');
    expect(backupsUnder(sb)).toEqual([]);
  });
});

describe('C9d: a directory copy that fails half way restores the whole user directory', () => {
  test('C9d: the partial copy is removed, mine.md is back, and no backup is left', () => {
    const sb = sandbox();
    withCompareTools(sb);
    mkdir(sb, `${PKG}/templates`);
    fs.writeFileSync(at(sb, `${PKG}/templates/mine.md`), 'my own template');
    const realCp = Bun.which('cp');
    shim(
      sb,
      'cp',
      `for last; do :; done\ncase "$last" in\n  */templates | */templates.vivera-tmp-*) mkdir -p "$last"; echo half > "$last/partial"; exit 1 ;;\nesac\nexec ${realCp} "$@"`,
    );
    const r = sb.run(['--copy', '--only', 'agents', '--tier', 'minimal']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('your file was put back');
    expect(fs.readFileSync(at(sb, `${PKG}/templates/mine.md`), 'utf8')).toBe('my own template');
    expect(exists(sb, `${PKG}/templates/partial`)).toBe(false);
    expect(fs.readdirSync(at(sb, `${PKG}/templates`))).toEqual(['mine.md']);
    expect(backupsUnder(sb)).toEqual([]);
  });
});
