// scripts/install-ps1-run.test.mjs
//
// Behaviour tests for install.ps1 and scripts/install/windows-*.ps1: the script is RUN in a temp profile
// (USERPROFILE) against a small fake checkout, and the files it leaves are checked. They need PowerShell
// (the PWSH env var, else pwsh or powershell on PATH) and skip cleanly without it. On Linux they prove the
// flow, StrictMode and every guard that does not depend on Windows, NOT Windows semantics (NTFS junctions,
// Windows PowerShell 5.1, OneDrive reparse points). INSTALL_PS1_ROOT points the suite at another copy of the
// tree, which is how a mutant is tried without editing the real files.

import { afterAll, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.INSTALL_PS1_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.env.PWSH ?? Bun.which('pwsh') ?? Bun.which('powershell');
const win = process.platform === 'win32';
const root = !win && process.getuid?.() === 0;
if (!shell) console.log('install-ps1-run.test: no PowerShell (PWSH, pwsh, powershell); the behaviour tests are skipped');

const MASTER = 'Super Ultra Code Plan Implementation.md';
const KEEP = '[KEEP]';
const bases = [];
afterAll(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function makeFixture({ homeName = 'h', extraSkill = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-ps1-'));
  bases.push(base);
  const chk = path.join(base, 'chk');
  const home = path.join(base, homeName);
  put(path.join(chk, MASTER), 'master v1\n');
  for (const n of extraSkill ? ['sucp-a', 'sucp-b', 'sucp-gone'] : ['sucp-a', 'sucp-b']) put(path.join(chk, 'skills', n, 'SKILL.md'), `skill ${n}\n`);
  put(path.join(chk, 'templates', 't.md'), 'template\n');
  put(path.join(chk, 'templates', 'sub', 'n.md'), 'nested\n');
  put(path.join(chk, 'examples', 'e.md'), 'example\n');
  put(path.join(chk, 'mermaid.config.json'), '{}\n');
  put(path.join(chk, 'mermaid.dark.config.json'), '{"dark":true}\n');
  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(chk, 'install.ps1'));
  const libDir = path.join(ROOT, 'scripts', 'install');
  for (const f of fs.existsSync(libDir) ? fs.readdirSync(libDir).filter((x) => /^windows-.*\.ps1$/.test(x)) : []) {
    put(path.join(chk, 'scripts', 'install', f), fs.readFileSync(path.join(libDir, f), 'utf8'));
  }
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(base, 'emptybin'), { recursive: true });
  return { base, chk, home, ps1: path.join(chk, 'install.ps1'), pkg: path.join(home, '.claude', 'skills', 'super-ultra-code-plan'), skills: path.join(home, '.claude', 'skills') };
}

function run(fx, args, env = {}) {
  const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fx.ps1, ...args], {
    cwd: fx.base,
    env: { ...process.env, USERPROFILE: fx.home, HOME: path.join(fx.base, 'pshome'), POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', DOTNET_CLI_TELEMETRY_OPTOUT: '1', VIVERA_NOW: '20260101T000000Z', ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const clean = (r, code = 0) => expect({ code: r.code, err: r.err }).toEqual({ code, err: '' });
const read = (p) => fs.readFileSync(p, 'utf8');
const ONLY = ['-Only', 'claude'];
const baks = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.vivera-bak-'));
function dirDigest(dir) {
  const lines = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else lines.push(`${sha(fs.readFileSync(path.join(d, e.name)))}  ${rel}${e.name}`);
    }
  };
  walk(dir, '');
  return `ps-sha256:${sha(lines.sort().map((l) => `${l}\n`).join(''))}`;
}

describe.skipIf(!shell)('install.ps1 run: parse, help, usage', () => {
  test('every script file parses with no syntax error', () => {
    const files = [path.join(ROOT, 'install.ps1')];
    const libDir = path.join(ROOT, 'scripts', 'install');
    if (fs.existsSync(libDir)) for (const f of fs.readdirSync(libDir).filter((x) => /^windows-.*\.ps1$/.test(x))) files.push(path.join(libDir, f));
    const script = '$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PS1_FILE, [ref]$t, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count';
    // A temp HOME, so PowerShell leaves no cache or telemetry id in the real one.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-ps1-'));
    bases.push(tmpHome);
    for (const f of files) {
      const env = { ...process.env, PS1_FILE: f, HOME: tmpHome, POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
      const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-Command', script], { env });
      expect({ f, status: r.exitCode, out: r.stdout.toString() }).toEqual({ f, status: 0, out: '' });
    }
  });

  test('-Help prints the usage and the target ids, exit 0, and needs no checkout files', () => {
    const fx = makeFixture();
    const r = run(fx, ['-Help']);
    clean(r);
    expect(r.out).toContain('Usage');
    expect(r.out).toContain('Targets, in install order: ai-config, agents');
  });

  test('usage errors exit 2: two modes, an unknown id, an empty list', () => {
    const fx = makeFixture();
    for (const args of [['-Check', '-Update'], ['-Only', 'nope'], ['-Skip', 'claude,nope'], ['-Only', '']]) {
      const r = run(fx, args);
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
    }
  });
});

describe.skipIf(!shell)('install.ps1 run: F3, -Only and -Skip take a list in any form', () => {
  test('-Only claude,opencode typed at a prompt binds an array and still selects both', () => {
    const fx = makeFixture();
    const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-Command', `& '${fx.ps1}' -Only claude,opencode -DryRun`], {
      cwd: fx.base,
      env: { ...process.env, USERPROFILE: fx.home, HOME: path.join(fx.base, 'pshome') },
    });
    expect({ code: r.exitCode, err: r.stderr.toString() }).toEqual({ code: 0, err: '' });
    expect(r.stdout.toString()).toContain('Would copy');
    expect(r.stdout.toString()).toContain('.config/opencode/skills');
  });

  test('-File ... -Only "claude,opencode" (one string) selects both, and -Skip wins over -Only', () => {
    const fx = makeFixture();
    const r = run(fx, ['-Only', 'claude,opencode', '-Skip', 'claude', '-DryRun']);
    clean(r);
    expect(r.out).toContain('.config/opencode/skills');
    expect(r.out).not.toContain('.claude/skills');
  });
});

describe.skipIf(!shell)('install.ps1 run: install, backups, markers', () => {
  test('a fresh install copies the package and marks each directory with source and digests of what it placed', () => {
    const fx = makeFixture();
    const r = run(fx, ONLY);
    clean(r);
    expect(r.out).toContain('[OK] Copied');
    expect(read(path.join(fx.pkg, 'SKILL.md'))).toBe('master v1\n');
    expect(read(path.join(fx.pkg, 'templates', 'sub', 'n.md'))).toBe('nested\n');
    expect(read(path.join(fx.skills, 'sucp-a', 'SKILL.md'))).toBe('skill sucp-a\n');
    const marker = read(path.join(fx.pkg, '.vivera-managed')).split('\n');
    expect(marker[0]).toBe(`source=${fx.chk}`);
    expect(marker).toContain(`entry SKILL.md ps-sha256:${sha('master v1\n')}`);
    expect(marker).toContain(`entry templates ${dirDigest(path.join(fx.chk, 'templates'))}`);
    expect(read(path.join(fx.skills, 'sucp-a', '.vivera-managed'))).toContain(`entry SKILL.md ps-sha256:${sha('skill sucp-a\n')}`);
  });

  test('a second install changes nothing and says it is current', () => {
    const fx = makeFixture();
    clean(run(fx, ONLY));
    const r = run(fx, ONLY);
    clean(r);
    expect(r.out).toContain('[OK] Already current: claude');
    expect(baks(fx.pkg)).toEqual([]);
  });

  test('M1: a file of the user at the destination is moved aside to a backup with its content, then replaced', () => {
    const fx = makeFixture();
    put(path.join(fx.pkg, 'SKILL.md'), 'my own skill\n');
    const r = run(fx, ONLY);
    clean(r);
    expect(r.out).toContain('[BACKUP]');
    expect(read(path.join(fx.pkg, 'SKILL.md.vivera-bak-20260101T000000Z'))).toBe('my own skill\n');
    expect(read(path.join(fx.pkg, 'SKILL.md'))).toBe('master v1\n');
  });

  test('M1: a managed copy the user edited is backed up too, and a second backup gets -1', () => {
    const fx = makeFixture();
    clean(run(fx, ONLY));
    put(path.join(fx.pkg, 'SKILL.md'), 'edited once\n');
    clean(run(fx, ONLY));
    put(path.join(fx.pkg, 'SKILL.md'), 'edited twice\n');
    clean(run(fx, ONLY));
    expect(read(path.join(fx.pkg, 'SKILL.md.vivera-bak-20260101T000000Z'))).toBe('edited once\n');
    expect(read(path.join(fx.pkg, 'SKILL.md.vivera-bak-20260101T000000Z-1'))).toBe('edited twice\n');
  });

  test('a user directory at a directory destination is moved aside whole, never merged', () => {
    const fx = makeFixture();
    put(path.join(fx.pkg, 'templates', 'mine.txt'), 'mine\n');
    clean(run(fx, ONLY));
    expect(read(path.join(fx.pkg, 'templates.vivera-bak-20260101T000000Z', 'mine.txt'))).toBe('mine\n');
    expect(fs.existsSync(path.join(fx.pkg, 'templates', 'mine.txt'))).toBe(false);
    expect(read(path.join(fx.pkg, 'templates', 'sub', 'n.md'))).toBe('nested\n');
  });

  test.skipIf(win || root)('M3: when the copy fails the user file is put back and nothing is left half done', () => {
    const fx = makeFixture();
    put(path.join(fx.pkg, 'templates', 'mine.txt'), 'mine\n');
    fs.chmodSync(path.join(fx.chk, 'templates', 't.md'), 0);
    const r = run(fx, ONLY);
    expect(r.code).toBe(1);
    expect(r.err).toContain('your file was put back');
    expect(read(path.join(fx.pkg, 'templates', 'mine.txt'))).toBe('mine\n');
    expect(baks(fx.pkg)).toEqual([]);
    expect(fs.readdirSync(path.join(fx.pkg, 'templates'))).toEqual(['mine.txt']);
  });

  test('M8: the backup stamp is UTC, not local time (a +14 h zone, no VIVERA_NOW)', () => {
    const fx = makeFixture();
    put(path.join(fx.pkg, 'SKILL.md'), 'mine\n');
    const r = run(fx, ONLY, { VIVERA_NOW: '', TZ: 'Etc/GMT-14' });
    clean(r);
    const name = baks(fx.pkg).find((n) => n.startsWith('SKILL.md.'));
    const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
    const stamp = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    expect(Math.abs(Date.now() - stamp)).toBeLessThan(120_000);
  });

  test('a path with [ and ] in the profile name still gets its backup (F5)', () => {
    const fx = makeFixture({ homeName: 'h[1]' });
    put(path.join(fx.pkg, 'SKILL.md'), 'mine\n');
    put(path.join(fx.pkg, 'templates', 'mine.txt'), 'mine\n');
    const r = run(fx, ONLY);
    clean(r);
    expect(read(path.join(fx.pkg, 'SKILL.md.vivera-bak-20260101T000000Z'))).toBe('mine\n');
    expect(read(path.join(fx.pkg, 'templates.vivera-bak-20260101T000000Z', 'mine.txt'))).toBe('mine\n');
    clean(run(fx, [...ONLY, '-Uninstall']));
    expect(read(path.join(fx.pkg, 'SKILL.md'))).toBe('mine\n');
    expect(read(path.join(fx.pkg, 'templates', 'mine.txt'))).toBe('mine\n');
  });
});

describe.skipIf(!shell)('install.ps1 run: -DryRun says it was a dry run and writes nothing (F6)', () => {
  test('-DryRun and -Update -DryRun end with a dry-run line, not "planted" or "match this checkout"', () => {
    const fx = makeFixture();
    for (const args of [[...ONLY, '-DryRun'], [...ONLY, '-Update', '-DryRun']]) {
      const r = run(fx, args);
      clean(r);
      expect(r.out).toContain('dry run: nothing was written');
      expect(r.out).not.toContain('farm planted');
      expect(r.out).not.toContain('the copies match this checkout');
    }
    expect(fs.existsSync(path.join(fx.home, '.claude', 'skills'))).toBe(false);
  });

  test('-WhatIf is a dry run too: it says so, claims no copy, and writes nothing', () => {
    const fx = makeFixture();
    const r = run(fx, [...ONLY, '-WhatIf']);
    clean(r);
    expect(r.out).toContain('dry run: nothing was written');
    expect(r.out).not.toContain('Copied skill package');
    expect(fs.existsSync(path.join(fx.home, '.claude', 'skills'))).toBe(false);
  });

  test('a real install and a real -Update still end with the success lines', () => {
    const fx = makeFixture();
    expect(run(fx, ONLY).out).toContain('Vivera farm planted');
    expect(run(fx, [...ONLY, '-Update']).out).toContain('Vivera updated: the copies match this checkout');
  });
});

describe.skipIf(!shell)('install.ps1 run: -Check', () => {
  test('missing is exit 1, current is exit 0, a nothing-to-check selection is exit 2', () => {
    const fx = makeFixture();
    const missing = run(fx, [...ONLY, '-Check']);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('[missing]');
    clean(run(fx, ONLY));
    const cur = run(fx, [...ONLY, '-Check']);
    clean(cur);
    expect(cur.out).toContain('check: CURRENT');
    expect(run(fx, ['-Only', 'codex', '-Check']).code).toBe(2);
  });

  test('M7: an unmarked file is [foreign], a marked copy that differs is [stale]', () => {
    const fx = makeFixture();
    put(path.join(fx.pkg, 'SKILL.md'), 'mine\n');
    const foreign = run(fx, [...ONLY, '-Check']);
    expect(foreign.out).toContain(`[foreign] ${path.join(fx.pkg, 'SKILL.md')}`);
    clean(run(fx, ONLY));
    put(path.join(fx.pkg, 'SKILL.md'), 'edited\n');
    expect(run(fx, [...ONLY, '-Check']).out).toContain(`[stale] ${path.join(fx.pkg, 'SKILL.md')}`);
  });
});

describe.skipIf(!shell)('install.ps1 run: -Uninstall', () => {
  test('M4: a copy that still equals its source goes, one the user edited stays, and so does its marker', () => {
    const fx = makeFixture();
    clean(run(fx, ONLY));
    put(path.join(fx.pkg, 'SKILL.md'), 'edited\n');
    const r = run(fx, [...ONLY, '-Uninstall']);
    clean(r);
    expect(r.out).toContain(`${KEEP} ${path.join(fx.pkg, 'SKILL.md')} (modified copy)`);
    expect(read(path.join(fx.pkg, 'SKILL.md'))).toBe('edited\n');
    expect(fs.existsSync(path.join(fx.pkg, '.vivera-managed'))).toBe(true);
    expect(fs.existsSync(path.join(fx.pkg, 'templates'))).toBe(false);
    expect(fs.existsSync(path.join(fx.skills, 'sucp-a'))).toBe(false);
    expect(r.out).toContain('[REMOVED]');
  });

  test('a full uninstall of an untouched install leaves no copy, no marker, and no empty skills directory', () => {
    const fx = makeFixture();
    clean(run(fx, ONLY));
    const r = run(fx, [...ONLY, '-Uninstall']);
    clean(r);
    expect(fs.existsSync(fx.skills)).toBe(false);
    expect(fs.existsSync(path.join(fx.home, '.claude'))).toBe(true);
  });

  test('the newest backup is put back where the copy was', () => {
    const fx = makeFixture();
    put(path.join(fx.pkg, 'SKILL.md'), 'original\n');
    clean(run(fx, ONLY));
    const r = run(fx, [...ONLY, '-Uninstall']);
    clean(r);
    expect(r.out).toContain('[RESTORED]');
    expect(read(path.join(fx.pkg, 'SKILL.md'))).toBe('original\n');
  });

  test('M5: a directory that still holds a file of the user is never removed', () => {
    const fx = makeFixture();
    clean(run(fx, ONLY));
    put(path.join(fx.pkg, 'notes.txt'), 'keep me\n');
    const r = run(fx, [...ONLY, '-Uninstall']);
    clean(r);
    expect(read(path.join(fx.pkg, 'notes.txt'))).toBe('keep me\n');
  });

  test('M7: a file that equals the source but has no marker is not a copy of ours and stays', () => {
    const fx = makeFixture();
    put(path.join(fx.pkg, 'SKILL.md'), 'master v1\n');
    const r = run(fx, [...ONLY, '-Uninstall']);
    clean(r);
    expect(r.out).toContain(`${KEEP} ${path.join(fx.pkg, 'SKILL.md')} (not a vivera copy)`);
    expect(read(path.join(fx.pkg, 'SKILL.md'))).toBe('master v1\n');
  });
});

describe.skipIf(!shell || win)('install.ps1 run: links (Linux symlinks stand for junctions)', () => {
  test('M6: a skills directory that links into this checkout is the source: nothing is moved, written, or removed there', () => {
    const fx = makeFixture();
    fs.symlinkSync(path.join(fx.chk, 'skills'), fx.skills);
    for (const args of [ONLY, [...ONLY, '-Update'], [...ONLY, '-Uninstall']]) {
      const r = run(fx, args);
      clean(r);
    }
    expect(read(path.join(fx.chk, 'skills', 'sucp-a', 'SKILL.md'))).toBe('skill sucp-a\n');
    expect(fs.readdirSync(path.join(fx.chk, 'skills')).sort()).toEqual(['sucp-a', 'sucp-b']);
    expect(run(fx, ONLY).out).toContain('is inside this checkout; left alone');
  });

  test('F1: a real file behind a linked skills directory (a dotfiles repo) is left alone by install, check and uninstall', () => {
    const fx = makeFixture();
    const dots = path.join(fx.base, 'dotfiles', 'skills');
    put(path.join(dots, 'sucp-a', 'SKILL.md'), 'dotfiles copy\n');
    put(path.join(dots, 'super-ultra-code-plan', 'SKILL.md'), 'dotfiles orchestrator\n');
    fs.symlinkSync(dots, fx.skills);
    const inst = run(fx, ONLY);
    clean(inst);
    expect(inst.out).toContain('reached through a symlinked directory; left alone');
    expect(read(path.join(dots, 'sucp-a', 'SKILL.md'))).toBe('dotfiles copy\n');
    expect(read(path.join(dots, 'super-ultra-code-plan', 'SKILL.md'))).toBe('dotfiles orchestrator\n');
    expect(fs.readdirSync(path.join(dots, 'sucp-a')).filter((n) => n.includes('vivera-bak'))).toEqual([]);
    const chk = run(fx, [...ONLY, '-Check']);
    expect(chk.code).toBe(1);
    expect(chk.out).toContain('(behind a symlinked directory; left alone)');
    const un = run(fx, [...ONLY, '-Uninstall']);
    clean(un);
    expect(un.out).toContain(`${KEEP} ${path.join(fx.skills, 'sucp-a', 'SKILL.md')} (behind a symlinked directory)`);
    expect(read(path.join(dots, 'sucp-a', 'SKILL.md'))).toBe('dotfiles copy\n');
    expect(read(path.join(dots, 'super-ultra-code-plan', 'SKILL.md'))).toBe('dotfiles orchestrator\n');
    expect(fs.lstatSync(fx.skills).isSymbolicLink()).toBe(true);
  });

  test('a link AT the destination is moved aside like any foreign entry; its target is not touched', () => {
    const fx = makeFixture();
    const elsewhere = path.join(fx.base, 'elsewhere.md');
    put(elsewhere, 'elsewhere\n');
    fs.mkdirSync(fx.pkg, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(fx.pkg, 'SKILL.md'));
    clean(run(fx, ONLY));
    expect(fs.lstatSync(path.join(fx.pkg, 'SKILL.md.vivera-bak-20260101T000000Z')).isSymbolicLink()).toBe(true);
    expect(read(elsewhere)).toBe('elsewhere\n');
    expect(read(path.join(fx.pkg, 'SKILL.md'))).toBe('master v1\n');
  });
});

describe.skipIf(!shell)('install.ps1 run: F2, -Update prunes a phase skill the checkout no longer has, but never an edited one', () => {
  const setup = () => {
    const fx = makeFixture({ extraSkill: true });
    clean(run(fx, ONLY));
    fs.rmSync(path.join(fx.chk, 'skills', 'sucp-gone'), { recursive: true });
    return { fx, gone: path.join(fx.skills, 'sucp-gone') };
  };

  test('an untouched copy (digest equals the record) is pruned with its marker and its directory', () => {
    const { fx, gone } = setup();
    const r = run(fx, [...ONLY, '-Update']);
    clean(r);
    expect(r.out).toContain(`[PRUNED] ${gone}`);
    expect(fs.existsSync(gone)).toBe(false);
  });

  test('an edited copy is kept with a KEEP line and its content intact', () => {
    const { fx, gone } = setup();
    put(path.join(gone, 'SKILL.md'), 'my edit\n');
    const r = run(fx, [...ONLY, '-Update']);
    clean(r);
    expect(r.out).toContain(`${KEEP} ${gone} (modified copy of a skill this checkout no longer has)`);
    expect(read(path.join(gone, 'SKILL.md'))).toBe('my edit\n');
  });

  test('a record made with another algorithm tag (the bash sha256:) is never trusted: kept', () => {
    const { fx, gone } = setup();
    put(path.join(gone, '.vivera-managed'), `source=${fx.chk}\nentry SKILL.md sha256:${sha('skill sucp-gone\n')}\n`);
    const r = run(fx, [...ONLY, '-Update']);
    clean(r);
    expect(r.out).toContain(`${KEEP} ${gone} (modified copy of a skill this checkout no longer has)`);
    expect(read(path.join(gone, 'SKILL.md'))).toBe('skill sucp-gone\n');
  });

  test('a marker with no record at all keeps the copy, and -DryRun prunes nothing', () => {
    const { fx, gone } = setup();
    const dry = run(fx, [...ONLY, '-Update', '-DryRun']);
    clean(dry);
    expect(dry.out).toContain(`[DRY-RUN] Would prune ${gone}`);
    expect(fs.existsSync(path.join(gone, 'SKILL.md'))).toBe(true);
    put(path.join(gone, '.vivera-managed'), `source=${fx.chk}\n`);
    expect(run(fx, [...ONLY, '-Update']).out).toContain(`${KEEP} ${gone}`);
    expect(fs.existsSync(path.join(gone, 'SKILL.md'))).toBe(true);
  });
});
