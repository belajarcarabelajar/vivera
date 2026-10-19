// scripts/install-ps1-hooks.test.mjs
//
// install.ps1 enables the committed git hooks the way install.sh does (install_hooks in
// scripts/install/targets.sh): core.hooksPath=.githooks in the checkout's own repo-local config. The script
// is RUN in a temp profile against a small fake checkout, like install-ps1-run.test.mjs, and skips cleanly
// without PowerShell. It proves the flow on Linux only; the hook itself is unverified on Windows.

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.INSTALL_PS1_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.env.PWSH ?? Bun.which('pwsh') ?? Bun.which('powershell');
const git = Bun.which('git');
if (!shell) console.log('install-ps1-hooks.test: no PowerShell (PWSH, pwsh, powershell); the hook tests are skipped');
if (!git) console.log('install-ps1-hooks.test: no git on PATH; the hook tests are skipped');

const MASTER = 'Super Ultra Code Plan Implementation.md';
const OK_LINE = '[OK] Enabled git hooks: core.hooksPath=.githooks';
const DRY_LINE = '[DRY-RUN] Would set repo-local git config: core.hooksPath=.githooks';
const NOT_OWN = '[SKIP] Not a git checkout of its own; skipping core.hooksPath (the hook is opt-in).';
const NO_GIT = '[SKIP] git hooks: git not found on PATH';
// The developer's own git config must not leak into what the tests read or write.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const bases = [];
afterAll(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function gitRun(args) {
  const r = Bun.spawnSync([git, ...args], { env: { ...process.env, ...GIT_ENV } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}
const gitInit = (dir) => expect(gitRun(['init', '-q', dir]).code).toBe(0);
// '' when unset: `git config --get` exits 1 and prints nothing for a missing key.
const hooksPath = (dir) => gitRun(['-C', dir, 'config', '--get', 'core.hooksPath']).out;

// The checkout goes at <base>/<sub>; with outerRepo the base itself is a git repo and the checkout has no .git.
function makeFixture({ ownRepo = true, outerRepo = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-ps1-hooks-'));
  bases.push(base);
  if (outerRepo) gitInit(base);
  const chk = path.join(base, 'chk');
  const home = path.join(base, 'h');
  put(path.join(chk, MASTER), 'master v1\n');
  put(path.join(chk, 'skills', 'sucp-a', 'SKILL.md'), 'skill sucp-a\n');
  put(path.join(chk, 'templates', 't.md'), 'template\n');
  put(path.join(chk, 'examples', 'e.md'), 'example\n');
  put(path.join(chk, 'mermaid.config.json'), '{}\n');
  put(path.join(chk, 'mermaid.dark.config.json'), '{"dark":true}\n');
  put(path.join(chk, '.claude', 'hooks', 'require-exit-code.mjs'), 'hook\n');
  put(path.join(chk, '.githooks', 'pre-commit'), '#!/usr/bin/env bash\nexit 0\n');
  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(chk, 'install.ps1'));
  const libDir = path.join(ROOT, 'scripts', 'install');
  for (const f of fs.readdirSync(libDir).filter((x) => /^windows-.*\.ps1$/.test(x))) {
    put(path.join(chk, 'scripts', 'install', f), fs.readFileSync(path.join(libDir, f), 'utf8'));
  }
  if (ownRepo) gitInit(chk);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(base, 'emptybin'), { recursive: true });
  return { base, chk, home, ps1: path.join(chk, 'install.ps1') };
}

function run(fx, args, env = {}) {
  const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fx.ps1, '-Only', 'claude', ...args], {
    cwd: fx.base,
    env: { ...process.env, ...GIT_ENV, USERPROFILE: fx.home, HOME: path.join(fx.base, 'pshome'), POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const lines = (out) => out.split('\n').map((l) => l.trimEnd());

describe.skipIf(!shell || !git)('install.ps1 enables the git hooks like install.sh', () => {
  test('a checkout with its own .git gets core.hooksPath=.githooks and the [OK] line with its revert', () => {
    const fx = makeFixture();
    expect(hooksPath(fx.chk)).toBe('');
    const r = run(fx, []);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(hooksPath(fx.chk)).toBe('.githooks');
    const out = lines(r.out);
    const at = out.indexOf(OK_LINE);
    expect(at).toBeGreaterThan(-1);
    expect(out[at + 1]).toBe(`     (revert: git -C "${fx.chk}" config --unset core.hooksPath)`);
  });

  test('-Update runs the step too', () => {
    const fx = makeFixture();
    const r = run(fx, ['-Update']);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(lines(r.out)).toContain(OK_LINE);
    expect(hooksPath(fx.chk)).toBe('.githooks');
  });

  test('-DryRun prints the [DRY-RUN] line and leaves core.hooksPath unset', () => {
    const fx = makeFixture();
    const r = run(fx, ['-DryRun']);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(lines(r.out)).toContain(DRY_LINE);
    expect(lines(r.out)).not.toContain(OK_LINE);
    expect(hooksPath(fx.chk)).toBe('');
    // Positive control: the same read sees a value once one is set, so '' above is not a blind read.
    expect(gitRun(['-C', fx.chk, 'config', 'core.hooksPath', 'probe']).code).toBe(0);
    expect(hooksPath(fx.chk)).toBe('probe');
  });

  test('-DryRun through a symlink to the checkout still counts it as its own', () => {
    const fx = makeFixture();
    const link = path.join(fx.base, 'link');
    fs.symlinkSync(fx.chk, link);
    const r = run({ ...fx, ps1: path.join(link, 'install.ps1') }, ['-DryRun']);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(lines(r.out)).toContain(DRY_LINE);
  });

  test('-Check and -Uninstall do not touch core.hooksPath', () => {
    const fx = makeFixture();
    for (const args of [['-Check'], ['-Uninstall']]) {
      const r = run(fx, args);
      expect({ args, hooks: r.out.includes('core.hooksPath') }).toEqual({ args, hooks: false });
    }
    expect(hooksPath(fx.chk)).toBe('');
  });

  test('a copy inside another git repo (no .git of its own) leaves the outer config alone and prints [SKIP]', () => {
    const fx = makeFixture({ ownRepo: false, outerRepo: true });
    const r = run(fx, []);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(lines(r.out)).toContain(NOT_OWN);
    expect(lines(r.out)).not.toContain(OK_LINE);
    expect(hooksPath(fx.base)).toBe('');
    expect(hooksPath(fx.chk)).toBe('');
    // Positive control on the outer repo: a set value is visible through the same read.
    expect(gitRun(['-C', fx.base, 'config', 'core.hooksPath', 'probe']).code).toBe(0);
    expect(hooksPath(fx.base)).toBe('probe');
  });

  test('without git on PATH it prints the git-not-found [SKIP] line and still exits 0', () => {
    const fx = makeFixture();
    const r = run(fx, [], { PATH: path.join(fx.base, 'emptybin') });
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(lines(r.out)).toContain(NO_GIT);
    expect(lines(r.out)).not.toContain(OK_LINE);
    expect(hooksPath(fx.chk)).toBe('');
  });
});
