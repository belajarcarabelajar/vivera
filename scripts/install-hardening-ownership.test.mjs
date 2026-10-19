// scripts/install-hardening-ownership.test.mjs
//
// Hardening findings about which destinations the installer may touch and which links it owns,
// one describe per finding (H from an independent review of the installer, C from round 2):
//   H1  a destination that is a file of this checkout itself (a harness dir symlinked into the repo)
//   H2  who owns a link: this repo and the legacy ai-skills items, nothing else
//   H10 a real file reached through a directory symlink into another tree is never moved
//   C9a who owns a link, the cases that were not asserted
// Split out of the former install-hardening.test.mjs by area; the other areas are in
// install-hardening-modes.test.mjs and install-hardening-environment.test.mjs, and the shared
// fixtures are in scripts/lib/install-hardening-helpers.mjs.
// Every run uses the sandbox from scripts/lib/install-sandbox.mjs.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENTS,
  MASTER,
  PKG,
  STAMP,
  at,
  backupsUnder,
  closeSandboxes,
  isLink,
  lib,
  link,
  mkdir,
  phases,
  sandbox,
  withCompareTools,
} from './lib/install-hardening-helpers.mjs';

afterEach(closeSandboxes);

describe('H1: a destination inside this checkout is never touched', () => {
  // Install, update, check and uninstall in turn: each run exits 0, leaves the repo copy byte for byte
  // as it was, and creates no backup anywhere. The second argument says what `check` may report.
  function runEveryMode(sb) {
    for (const args of [[], ['--update'], ['--check'], ['--uninstall']]) {
      const before = sb.snapshot(sb.repo);
      const r = sb.run(args);
      expect({ args, status: r.status, stderr: r.stderr.includes('[FAIL]') }).toEqual({ args, status: 0, stderr: false });
      expect({ args, same: JSON.stringify(sb.snapshot(sb.repo)) === JSON.stringify(before) }).toEqual({ args, same: true });
      expect(backupsUnder(sb)).toEqual([]);
    }
  }

  test("H1a: the user's layout (a symlinked ~/.claude/skills and per-skill dir links for OpenCode) is left alone", () => {
    const sb = sandbox();
    mkdir(sb, '.claude');
    fs.symlinkSync(path.join(sb.repo, 'skills'), at(sb, '.claude/skills'));
    mkdir(sb, '.config/opencode/skills');
    for (const name of phases(sb)) {
      fs.symlinkSync(path.join(sb.repo, 'skills', name), at(sb, `.config/opencode/skills/${name}`));
    }
    // Control: the fixture really is the dangerous layout, the destination is the repo's own file.
    const first = phases(sb)[0];
    expect(fs.realpathSync(at(sb, `.claude/skills/${first}/SKILL.md`))).toBe(
      fs.realpathSync(path.join(sb.repo, 'skills', first, 'SKILL.md')),
    );
    runEveryMode(sb);
    // The repo's own files are still real files, not loops or moved aside.
    expect(fs.lstatSync(path.join(sb.repo, 'skills', first, 'SKILL.md')).isFile()).toBe(true);
  });

  test('H1a: check names the inside-checkout paths [ok] when they are the expected files', () => {
    const sb = sandbox();
    mkdir(sb, '.claude');
    fs.symlinkSync(path.join(sb.repo, 'skills'), at(sb, '.claude/skills'));
    expect(sb.run([]).status).toBe(0);
    const r = sb.run(['--check']);
    expect(r.status).toBe(0);
    const inside = r.stdout.split('\n').filter((l) => l.includes('(inside this checkout)'));
    expect(inside.length).toBeGreaterThan(5);
    expect(inside.every((l) => l.startsWith('[ok] '))).toBe(true);
  });

  test("H1b: ~/.config/ai as a symlink to the checkout leaves the master file alone", () => {
    const sb = sandbox();
    mkdir(sb, '.config');
    fs.symlinkSync(sb.repo, at(sb, '.config/ai'));
    runEveryMode(sb);
    expect(fs.lstatSync(path.join(sb.repo, MASTER)).isFile()).toBe(true);
  });

  test('H1b: the same layout in copy mode writes no marker into the checkout', () => {
    const sb = sandbox();
    withCompareTools(sb);
    mkdir(sb, '.config');
    fs.symlinkSync(sb.repo, at(sb, '.config/ai'));
    const before = sb.snapshot(sb.repo);
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('is inside this checkout; left alone');
    expect(sb.snapshot(sb.repo)).toEqual(before);
    expect(backupsUnder(sb)).toEqual([]);
  });

  test('H1c: a package dir that is a symlink into the checkout keeps its tracked links through uninstall', () => {
    const sb = sandbox();
    mkdir(sb, AGENTS);
    fs.symlinkSync(path.join(sb.repo, 'skills/super-ultra-code-plan'), at(sb, PKG));
    const names = ['SKILL.md', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json', 'require-exit-code.mjs'];
    const targets = names.map((n) => fs.readlinkSync(path.join(sb.repo, 'skills/super-ultra-code-plan', n)));
    runEveryMode(sb);
    // Uninstall says it kept them, on its own and not only by doing nothing.
    const again = sb.run(['--uninstall']);
    expect(again.stdout).toContain(`[KEEP] ${at(sb, `${PKG}/SKILL.md`)} (inside this checkout)`);
    names.forEach((n, i) => {
      const file = path.join(sb.repo, 'skills/super-ultra-code-plan', n);
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(file)).toBe(targets[i]);
    });
  });
});

describe('H2: only this repo and the legacy ai-skills items count as ours', () => {
  const LEGACY = [MASTER, 'skills/sucp-plan', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json'];
  const classify = (sb, dest) => lib(sb, 'classify_dest', dest, path.join(sb.repo, MASTER));

  test('H2: every legacy form of the old repo is ours-stale, dangling or live', () => {
    const sb = sandbox();
    for (const [i, form] of LEGACY.entries()) {
      fs.mkdirSync(at(sb, 'l'), { recursive: true });
      const dangling = at(sb, `l/dangling-${i}`);
      fs.symlinkSync(`/x/ai-skills/${form}`, dangling);
      expect({ form, state: classify(sb, dangling) }).toEqual({ form, state: 'ours-stale' });

      const real = path.join(sb.root, 'legacy', 'ai-skills', form);
      fs.mkdirSync(form.includes('.') ? path.dirname(real) : real, { recursive: true });
      if (form.includes('.')) fs.writeFileSync(real, 'x');
      const live = at(sb, `l/live-${i}`);
      fs.symlinkSync(real, live);
      expect({ form, state: classify(sb, live) }).toEqual({ form, state: 'ours-stale' });
    }
  });

  test('H2: a link elsewhere, dangling or live, is foreign, even into a dir named ai-skills', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, 'l'), { recursive: true });
    fs.mkdirSync(path.join(sb.root, 'ai-skills'));
    fs.mkdirSync(path.join(sb.root, 'my-ai-skills'));
    fs.writeFileSync(path.join(sb.root, 'ai-skills/notes.md'), 'x');
    fs.writeFileSync(path.join(sb.root, 'my-ai-skills/notes.md'), 'x');
    const cases = {
      gone: '/mnt/gone/x',
      'live-in-ai-skills': path.join(sb.root, 'ai-skills/notes.md'),
      'live-in-my-ai-skills': path.join(sb.root, 'my-ai-skills/notes.md'),
      'dangling-ai-skills-other-item': '/x/ai-skills/notes.md',
    };
    for (const [name, target] of Object.entries(cases)) {
      fs.symlinkSync(target, at(sb, `l/${name}`));
      expect({ name, state: classify(sb, at(sb, `l/${name}`)) }).toEqual({ name, state: 'foreign' });
    }
    // A dangling link into this checkout is still ours.
    fs.symlinkSync(path.join(sb.repo, 'gone/old.md'), at(sb, 'l/in-repo'));
    expect(classify(sb, at(sb, 'l/in-repo'))).toBe('ours-stale');
  });

  test('H2: a dangling link to an unmounted path is moved aside as a link, not silently replaced', () => {
    const sb = sandbox();
    link(sb, '/mnt/gone/x', `${PKG}/SKILL.md`);
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[BACKUP]');
    const bak = `${PKG}/SKILL.md.vivera-bak-${STAMP}`;
    expect(isLink(sb, bak)).toBe(true);
    expect(fs.readlinkSync(at(sb, bak))).toBe('/mnt/gone/x');
  });

  test('H2: legacy links on this machine are still repointed with no backup', () => {
    const sb = sandbox();
    link(sb, `/x/ai-skills/${MASTER}`, `.config/ai/${MASTER}`);
    link(sb, '/x/ai-skills/skills/super-ultra-code-plan/SKILL.md', `${PKG}/SKILL.md`);
    link(sb, '/x/ai-skills/templates', `${PKG}/templates`);
    const r = sb.run(['--update']);
    expect(r.status).toBe(0);
    expect(backupsUnder(sb)).toEqual([]);
    expect(fs.readlinkSync(at(sb, `${PKG}/templates`))).toBe(path.join(sb.repo, 'templates'));
  });

  test('H2: uninstall leaves a dangling link to somewhere else alone and says KEEP', () => {
    const sb = sandbox();
    const dest = `.config/ai/${MASTER}`;
    link(sb, '/mnt/gone/x', dest);
    const r = sb.run(['--uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${at(sb, dest)} (not a vivera link)`);
    expect(fs.readlinkSync(at(sb, dest))).toBe('/mnt/gone/x');
  });
});

describe('H10: a real file reached through a directory symlink into another tree is never moved', () => {
  const VIA = 'is reached through a symlinked directory; left alone';

  // Install, update, check and uninstall in turn. `tree` is the other tree: its snapshot must not change
  // for the files that were already there, and no backup may appear anywhere in it.
  function runEveryMode(sb, tree, files) {
    const out = {};
    for (const args of [[], ['--update'], ['--check'], ['--uninstall']]) {
      const r = sb.run(args);
      out[args[0] ?? 'install'] = r;
      for (const [file, content] of Object.entries(files)) {
        expect({ args, file, content: fs.readFileSync(path.join(tree, file), 'utf8') }).toEqual({ args, file, content });
        expect(fs.lstatSync(path.join(tree, file)).isFile()).toBe(true);
      }
      expect(sb.snapshot(tree).filter((l) => l.split('|')[0].includes('.vivera-bak-'))).toEqual([]);
    }
    return out;
  }

  test('H10-1: a file of another checkout behind ~/.claude/skills/sucp-rules is left alone by every mode', () => {
    const sb = sandbox();
    const other = path.join(sb.root, 'other');
    fs.mkdirSync(path.join(other, 'skills/sucp-rules'), { recursive: true });
    fs.writeFileSync(path.join(other, 'skills/sucp-rules/SKILL.md'), 'the other checkout');
    mkdir(sb, '.claude/skills');
    fs.symlinkSync(path.join(other, 'skills/sucp-rules'), at(sb, '.claude/skills/sucp-rules'));
    // Control: the destination is a real file that lives in another tree.
    const dest = at(sb, '.claude/skills/sucp-rules/SKILL.md');
    expect(fs.realpathSync(dest).startsWith(fs.realpathSync(other))).toBe(true);
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);

    const before = sb.snapshot(other);
    const runs = runEveryMode(sb, other, { 'skills/sucp-rules/SKILL.md': 'the other checkout' });
    expect(sb.snapshot(other)).toEqual(before);
    for (const mode of ['install', '--update', '--uninstall']) expect({ mode, status: runs[mode].status }).toEqual({ mode, status: 0 });
    expect(runs.install.stdout).toContain(`[SKIP] ${dest} ${VIA}`);
    expect(runs['--check'].status).toBe(1);
    expect(runs['--check'].stdout).toContain(`[foreign] ${dest} (behind a symlinked directory; left alone)`);
    expect(runs['--uninstall'].stdout).toContain(`[KEEP] ${dest} (behind a symlinked directory)`);
  });

  test('H10-2: a real package file in a symlinked dotfiles dir stays, while the missing links are placed beside it', () => {
    const sb = sandbox();
    const dotfiles = path.join(sb.root, 'dotfiles');
    fs.mkdirSync(path.join(dotfiles, 'super-ultra-code-plan'), { recursive: true });
    fs.writeFileSync(path.join(dotfiles, 'super-ultra-code-plan/SKILL.md'), 'my own copy');
    mkdir(sb, '.claude');
    fs.symlinkSync(dotfiles, at(sb, '.claude/skills'));
    const dest = at(sb, '.claude/skills/super-ultra-code-plan/SKILL.md');

    const install = sb.run([]);
    expect(install.status).toBe(0);
    expect(install.stdout).toContain(`[SKIP] ${dest} ${VIA}`);
    // The other entries of the package were absent there and are placed as links inside the dotfiles dir.
    expect(fs.lstatSync(path.join(dotfiles, 'super-ultra-code-plan/templates')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dotfiles, 'super-ultra-code-plan/SKILL.md'), 'utf8')).toBe('my own copy');

    const runs = runEveryMode(sb, dotfiles, { 'super-ultra-code-plan/SKILL.md': 'my own copy' });
    for (const mode of ['install', '--update', '--uninstall']) expect({ mode, status: runs[mode].status }).toEqual({ mode, status: 0 });
    expect(runs['--check'].status).toBe(1);
    expect(runs['--check'].stdout).toContain(`[foreign] ${dest} (behind a symlinked directory; left alone)`);
    expect(runs['--uninstall'].stdout).toContain(`[KEEP] ${dest} (behind a symlinked directory)`);
    // Uninstall removed the links it had placed there, and only those.
    expect(fs.existsSync(path.join(dotfiles, 'super-ultra-code-plan/templates'))).toBe(false);
  });

  test('H10-3: a HOME that is itself reached through a symlink installs normally', () => {
    const sb = sandbox();
    const homeLink = path.join(sb.root, 'homelink');
    fs.symlinkSync(sb.home, homeLink);
    const env = { env: { HOME: homeLink } };
    const install = sb.run([], env);
    expect(install.status).toBe(0);
    expect(install.stdout).not.toContain('symlinked directory');
    expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(true);
    const check = sb.run(['--check'], env);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('check: CURRENT');
  });

  test("H10-4: the user's real layout (~/.claude/skills pointing at ~/.config/opencode/skills, sucp-* dir links) is still left alone", () => {
    const sb = sandbox();
    mkdir(sb, '.config/opencode/skills');
    for (const name of phases(sb)) {
      fs.symlinkSync(path.join(sb.repo, 'skills', name), at(sb, `.config/opencode/skills/${name}`));
    }
    mkdir(sb, '.claude');
    fs.symlinkSync(at(sb, '.config/opencode/skills'), at(sb, '.claude/skills'));
    for (const args of [[], ['--update'], ['--check'], ['--uninstall']]) {
      const before = sb.snapshot(sb.repo);
      const r = sb.run(args);
      expect({ args, status: r.status }).toEqual({ args, status: 0 });
      expect(sb.snapshot(sb.repo)).toEqual(before);
      expect(backupsUnder(sb)).toEqual([]);
    }
  });
});

describe('C9a: a link that is not this repo and not a legacy ai-skills item is foreign', () => {
  const classify = (sb, dest) => lib(sb, 'classify_dest', dest, path.join(sb.repo, MASTER));

  test('C9a: a sibling directory that shares the repo path as a prefix is foreign, live or dangling', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, 'l'), { recursive: true });
    fs.mkdirSync(`${sb.repo}-old`);
    fs.writeFileSync(`${sb.repo}-old/x.md`, 'x');
    fs.symlinkSync(`${sb.repo}-old/x.md`, at(sb, 'l/live'));
    fs.symlinkSync(`${sb.repo}-old/gone.md`, at(sb, 'l/dangling'));
    expect(classify(sb, at(sb, 'l/live'))).toBe('foreign');
    expect(classify(sb, at(sb, 'l/dangling'))).toBe('foreign');
  });

  test('C9a: the legacy item names with no ai-skills parent are foreign', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, 'l'), { recursive: true });
    const names = ['/x/templates', '/x/examples', '/x/skills/y', `/x/${MASTER}`];
    for (const [i, target] of names.entries()) {
      fs.symlinkSync(target, at(sb, `l/n${i}`));
      expect({ target, state: classify(sb, at(sb, `l/n${i}`)) }).toEqual({ target, state: 'foreign' });
    }
  });

  test('C9a: an install moves each of them aside as a link instead of repointing it', () => {
    const sb = sandbox();
    fs.mkdirSync(`${sb.repo}-old`);
    const planted = {
      [`${PKG}/templates`]: '/x/templates',
      [`${PKG}/examples`]: '/x/examples',
      [`${AGENTS}/sucp-plan/SKILL.md`]: '/x/skills/y',
      [`.config/ai/${MASTER}`]: `/x/${MASTER}`,
      [`${PKG}/mermaid.config.json`]: `${sb.repo}-old/x.md`,
    };
    for (const [rel, target] of Object.entries(planted)) link(sb, target, rel);
    const r = sb.run(['--tier', 'minimal', '--only', 'agents,ai-config']);
    expect(r.status).toBe(0);
    for (const [rel, target] of Object.entries(planted)) {
      expect({ rel, backup: fs.readlinkSync(at(sb, `${rel}.vivera-bak-${STAMP}`)) }).toEqual({ rel, backup: target });
      expect(fs.readlinkSync(at(sb, rel)).startsWith(sb.repo)).toBe(true);
    }
    expect(r.stdout.split('[BACKUP]').length - 1).toBe(Object.keys(planted).length);
    expect(r.stdout).not.toContain('Repointed');
  });
});
