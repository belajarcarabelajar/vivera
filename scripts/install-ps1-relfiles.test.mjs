// scripts/install-ps1-relfiles.test.mjs
//
// Get-RelFiles (scripts/install/windows-core.ps1) names every file under a root relative to it; Copy-Entry,
// the directory digest and Test-SameDir build on those names. It used to cut each FullName by the length of
// the root string as given, so a root written in another form than the one Get-ChildItem returns produced
// wrong names: on the Windows runner the checkout sits under an 8.3 short TEMP (C:\Users\RUNNER~1) while
// FullName is long (runneradmin), and `templates\t.md` became `templates\es\t.md` (platforms.yml run
// 40440396551). A root with /./, a doubled separator or a trailing separator shows the same defect on Linux.
// The function is dot-sourced on its own: windows-core.ps1 has no top-level statements.

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.INSTALL_PS1_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'scripts', 'install', 'windows-core.ps1');
const shell = process.env.PWSH ?? Bun.which('pwsh') ?? Bun.which('powershell');
const win = process.platform === 'win32';
const sep = path.sep;
const quote = (s) => `'${s.replace(/'/g, "''")}'`;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-relfiles-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
const tpl = path.join(base, 'templates');
fs.mkdirSync(path.join(tpl, 'sub'), { recursive: true });
fs.writeFileSync(path.join(tpl, 't.md'), 'template\n');
fs.writeFileSync(path.join(tpl, 'sub', 'n.md'), 'nested\n');

// Runs a PowerShell snippet after dot-sourcing windows-core.ps1; `prelude` runs before the dot-source.
function ps(body, prelude = '') {
  const script = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; ${prelude}; . ${quote(CORE)}; ${body}`;
  const r = Bun.spawnSync([shell, '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, NO_COLOR: '1', POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' },
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
const relFiles = (root) => ps(`(@(Get-RelFiles ${quote(root)}) | Sort-Object) -join '|'`);
const WANT = { code: 0, out: [`sub${sep}n.md`, 't.md'].join('|'), err: '' };

// Windows only: the long form of a path (realpath expands 8.3 names) and its 8.3 short form, read through
// Scripting.FileSystemObject rather than cmd, whose quoting leaked into the path on the runner.
function windowsForms(p) {
  const long = fs.realpathSync.native(p);
  const short = ps(`(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${quote(long)}).ShortPath`).out;
  return [...new Set([long, short].filter(Boolean))];
}

describe.skipIf(!shell)('Get-RelFiles names files relative to the root, whatever form the root string has', () => {
  test('a canonical root', () => {
    expect(relFiles(tpl)).toEqual(WANT);
  });

  test('a root with a ./ segment', () => {
    // Written by hand: path.join would fold the ./ away and test the canonical root again.
    expect(relFiles(`${base}${sep}.${sep}templates`)).toEqual(WANT);
  });

  test('a root with a doubled separator', () => {
    expect(relFiles(`${base}${sep}${sep}templates`)).toEqual(WANT);
  });

  test('a root with a trailing separator', () => {
    expect(relFiles(`${tpl}${sep}`)).toEqual(WANT);
  });

  // The runner's own case: TEMP there is 8.3 (C:\Users\RUNNER~1) and FullName is long, or the other way round.
  // Both forms of the same root must give the same names. Skipped off Windows, where 8.3 names do not exist.
  for (const form of win && shell ? windowsForms(tpl) : []) {
    test(`a root in its ${form.includes('~') ? '8.3 short' : 'long'} form (Windows): ${form}`, () => {
      expect(relFiles(form)).toEqual(WANT);
    });
  }

  test('a file whose FullName is outside the root prefix is an error naming both paths, not a wrong name', () => {
    // Get-ChildItem is shadowed by a function, the one boundary this test replaces: it returns a file the
    // real provider would never report under this root.
    const outside = path.join(os.tmpdir(), 'elsewhere', 'x.md');
    const prelude = `function Get-ChildItem { [pscustomobject]@{ FullName = ${quote(outside)} } }`;
    const r = ps(`Get-RelFiles ${quote(tpl)}`, prelude);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(outside);
    expect(r.err).toContain(tpl);
  });
});
