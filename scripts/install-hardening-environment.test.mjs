// scripts/install-hardening-environment.test.mjs
//
// Hardening findings about the environment the installer runs in: the tools on PATH, HOME and
// argument values, the git checkout, line endings, and Windows shells, one describe per finding
// (H from an independent review of the installer, C from round 2):
//   H3  an optional tool is never run; a required tool's --version cannot abort the run
//   H5  tabs and newlines in HOME, the checkout path and --only/--skip values
//   H8  the git hooks are written only into a checkout of its own
//   C1  .gitattributes keeps the installer scripts LF
//   C2  an unset HOME, and Git Bash / MSYS / Cygwin where ln -s copies
// Split out of the former install-hardening.test.mjs by area; the other areas are in
// install-hardening-ownership.test.mjs and install-hardening-modes.test.mjs, and the shared
// fixtures are in scripts/lib/install-hardening-helpers.mjs.
// Every run uses the sandbox from scripts/lib/install-sandbox.mjs.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  MASTER,
  PKG,
  at,
  closeSandboxes,
  exists,
  isLink,
  sandbox,
  shim,
  withCompareTools,
} from './lib/install-hardening-helpers.mjs';

afterEach(closeSandboxes);

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

const WORKTREE = path.resolve(import.meta.dir, '..');

describe('C1: the installer scripts and the tier table stay LF on a Windows clone', () => {
  test('C1: .gitattributes pins *.sh and tiers.tsv to eol=lf', () => {
    const lines = fs.readFileSync(path.join(WORKTREE, '.gitattributes'), 'utf8').split('\n');
    expect(lines).toContain('*.sh text eol=lf');
    expect(lines).toContain('scripts/install/tiers.tsv text eol=lf');
  });

  test('C1: git itself reports eol: lf for an installer script, the table and install.sh', () => {
    const files = ['scripts/install/lib.sh', 'scripts/install/tiers.tsv', 'install.sh'];
    const r = Bun.spawnSync(['git', '-C', WORKTREE, 'check-attr', 'eol', '--', ...files], {
      env: { PATH: process.env.PATH, HOME: WORKTREE, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim().split('\n')).toEqual(files.map((f) => `${f}: eol: lf`));
  });
});

describe('C2: HOME and Windows shells', () => {
  // install.sh run with exactly the given environment, no HOME unless the test gives one.
  function bare(sb, env) {
    const pairs = Object.entries({ PATH: sb.bin, ...env }).map(([k, v]) => `${k}=${v}`);
    const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, path.join(sb.bin, 'bash'), path.join(sb.repo, 'install.sh')], { cwd: sb.root });
    return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }

  test('C2: an unset HOME exits 2 naming HOME, before any banner', () => {
    const sb = sandbox();
    const r = bare(sb, {});
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('install.sh: HOME is not set');
    expect(r.stderr).not.toContain('unbound variable');
    expect(r.stdout).toBe('');
  });

  test('C2: an empty HOME exits 2 the same way', () => {
    const sb = sandbox();
    const r = bare(sb, { HOME: '' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('install.sh: HOME is not set');
    expect(r.stdout).toBe('');
  });

  const NOTE = '[NOTE] Windows shell: symlinks are not reliable here, using --copy';

  for (const name of ['MINGW64_NT-10.0-19045', 'MSYS_NT-10.0-19045', 'CYGWIN_NT-10.0-19045']) {
    test(`C2: uname ${name} makes copy the default: one note, no symlink under HOME, markers written`, () => {
      const sb = sandbox();
      withCompareTools(sb);
      shim(sb, 'uname', `echo ${name}`);
      const r = sb.run(['--only', 'agents', '--tier', 'minimal']);
      expect(r.status).toBe(0);
      expect(r.stdout.split(NOTE).length - 1).toBe(1);
      expect(sb.snapshot().filter((l) => l.split('|')[1] === 'l')).toEqual([]);
      expect(exists(sb, `${PKG}/.vivera-managed`)).toBe(true);
      expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`), 'utf8')).toBe(fs.readFileSync(path.join(sb.repo, MASTER), 'utf8'));

      const check = sb.run(['--check', '--only', 'agents']);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('check: CURRENT');
    });
  }

  test('C2: on Linux nothing changes: links, and no note', () => {
    const sb = sandbox();
    const r = sb.run(['--only', 'agents', '--tier', 'minimal']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Windows shell');
    expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(true);
  });

  test('C2: an explicit --copy on a Windows shell does not repeat the note', () => {
    const sb = sandbox();
    withCompareTools(sb);
    shim(sb, 'uname', 'echo MINGW64_NT-10.0-19045');
    const r = sb.run(['--only', 'agents', '--tier', 'minimal', '--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Windows shell');
  });
});
