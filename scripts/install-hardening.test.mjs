// scripts/install-hardening.test.mjs
//
// Findings of an independent review of the installer, one describe per finding:
//   H1 a destination that is a file of this checkout itself (a harness dir symlinked into the repo)
//   H2 who owns a link: this repo and the legacy ai-skills items, nothing else
//   H3 an optional tool is never run; a required tool's --version cannot abort the run
//   H4 --check also reports stale phase dirs and never says CURRENT when it checked nothing
//   H5 tabs and newlines in HOME, the checkout path and --only/--skip values
//   H6 uninstall leaves the Antigravity builtin skills dir; update says when a dir stays
//   H7 --check and --uninstall need no bun and no git
//   H8 the git hooks are written only into a checkout of its own
//   H9 a failed link or copy after a move puts the user's file back
// Every run uses the sandbox from scripts/lib/install-sandbox.mjs.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { assertSandbox, makeSandbox } from './lib/install-sandbox.mjs';

const MASTER = 'Super Ultra Code Plan Implementation.md';
const STAMP = '20260101T000000Z';
const PKG = '.agents/skills/super-ultra-code-plan';
const AGENTS = '.agents/skills';
const BUILTIN = '.gemini/antigravity-cli/builtin/skills';

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox({ tools = ['git', 'bun'], git = false } = {}) {
  const sb = makeSandbox({ tools, git });
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const exists = (sb, rel) => fs.existsSync(at(sb, rel));
const mkdir = (sb, rel) => fs.mkdirSync(at(sb, rel), { recursive: true });
const link = (sb, target, rel) => {
  mkdir(sb, path.dirname(rel));
  fs.symlinkSync(target, at(sb, rel));
};
const isLink = (sb, rel) => fs.lstatSync(at(sb, rel), { throwIfNoEntry: false })?.isSymbolicLink() === true;
const phases = (sb) => fs.readdirSync(path.join(sb.repo, 'skills')).filter((n) => n.startsWith('sucp-')).sort();
const backupsUnder = (sb) => sb.snapshot(sb.root).filter((l) => l.split('|')[0].includes('.vivera-bak-'));
const shim = (sb, name, body) => {
  const file = path.join(sb.bin, name);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
};
const withCompareTools = (sb) => {
  for (const tool of ['cmp', 'diff']) fs.symlinkSync(Bun.which(tool), path.join(sb.bin, tool));
};

// Calls one function of lib.sh in a clean shell with the sandbox env (REPO_DIR set as install.sh would).
function lib(sb, fn, ...args) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const script = 'REPO_DIR="$1"; shift; . "$REPO_DIR/scripts/install/lib.sh"; "$@"';
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), '-c', script, '_', sb.repo, fn, ...args], {
    cwd: sb.home,
  });
  return r.stdout.toString().trim();
}

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
    const names = ['SKILL.md', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json'];
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

describe('H3: an optional tool is never run', () => {
  test('H3: an optional context-mode that would sleep is neither run nor waited for', () => {
    const sb = sandbox();
    shim(sb, 'context-mode', 'touch "$HOME/ran-context-mode"\nsleep 12');
    const t0 = Date.now();
    const r = sb.run([]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.status).toBe(0);
    expect(exists(sb, 'ran-context-mode')).toBe(false);
    expect(r.stdout).toContain('[OK] Optional tool found: context-mode');
  });

  test('H3: an opencode that would create its own dir when run leaves a bare HOME untouched under --check', () => {
    const sb = sandbox();
    shim(sb, 'opencode', 'mkdir -p "$HOME/.config/opencode"');
    const r = sb.run(['--check']);
    expect(r.status).toBe(1);
    expect(sb.snapshot()).toEqual([]);
  });

  test('H3: a missing optional tool still only warns', () => {
    const sb = sandbox();
    const r = sb.run([]);
    expect(r.stderr).toContain("optional tool 'tgrep' not found");
  });

  test('H3: a required git whose --version fails does not abort the run', () => {
    const sb = sandbox();
    shim(sb, 'git', 'exit 2');
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Prerequisite verified: git');
    expect(r.stdout).toContain('installed (no version flag)');
  });
});

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
    for (const args of [['--check', '--only', 'codex'], ['--check', '--only', 'claude', '--skip', 'claude']]) {
      const sb = sandbox();
      const r = sb.run(args);
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
      expect(r.stdout).toContain('check: nothing to check (no selected target has skills)');
      expect(r.stdout).not.toContain('CURRENT');
    }
  });
});

describe('H5: tabs and newlines are refused before anything happens', () => {
  test('H5: a HOME with a newline or a tab exits 2 before any output', () => {
    for (const name of ['ho\nme', 'ho\tme']) {
      const sb = sandbox();
      const r = sb.run(['--dry-run'], { env: { HOME: path.join(sb.root, name) } });
      expect({ name, status: r.status }).toEqual({ name, status: 2 });
      expect(r.stderr).toContain('newline or a tab');
      expect(r.stdout).toBe('');
    }
  });

  test('H5: an --only or --skip value with a newline or a tab exits 2', () => {
    for (const args of [['--only', 'claude\nbogus'], ['--skip', 'agents\tclaude'], ['--only=claude\nbogus']]) {
      const sb = sandbox();
      const r = sb.run(args);
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
      expect(r.stderr).toContain('newline or a tab');
      expect(r.stdout).toBe('');
      expect(sb.snapshot()).toEqual([]);
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

describe('H8: hooks go only into a checkout of its own', () => {
  const gitEnv = (sb) => ({
    HOME: sb.home,
    PATH: path.dirname(Bun.which('git')),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  });
  const hooksPath = (sb, dir) =>
    Bun.spawnSync([path.join(sb.bin, 'git'), '-C', dir, 'config', '--get', 'core.hooksPath'], { env: gitEnv(sb) });

  test('H8: a copy inside another git repo leaves that repo config alone and says why', () => {
    const sb = sandbox();
    shim(sb, 'graphify', 'exit 0');
    expect(Bun.spawnSync([Bun.which('git'), 'init', '-q'], { cwd: sb.root, env: gitEnv(sb) }).exitCode).toBe(0);
    expect(fs.existsSync(path.join(sb.repo, '.git'))).toBe(false);
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[SKIP] Not a git checkout of its own; skipping core.hooksPath');
    expect(hooksPath(sb, sb.root).exitCode).toBe(1);
  });

  test('H8: control: a checkout with its own .git still gets core.hooksPath', () => {
    const sb = sandbox({ git: true });
    shim(sb, 'graphify', 'exit 0');
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[OK] Enabled git hooks: core.hooksPath=.githooks');
    expect(hooksPath(sb, sb.repo).stdout.toString().trim()).toBe('.githooks');
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
