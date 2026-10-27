// scripts/lib/ps1-test-paths.mjs
//
// Path helpers for the install.ps1 suites, so their expectations hold on Windows as well as on Linux and
// macOS (platforms.yml run 40454770833 failed 9 tests on both Windows shells while the installer was right).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A temp dir in the long form the platform reports. On the Windows runner os.tmpdir() is the 8.3 form
// (C:\Users\RUNNER~1\...) while install.ps1 prints $PSScriptRoot and FullName in the long one; elsewhere
// realpath leaves the path as it is, or resolves a symlinked TMPDIR the same way the installer sees it.
export function longTmp(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
}

// `env` with PATH set to `dir`. Windows keeps the variable as Path and its names are case-insensitive, so a
// plain { PATH } override left the real Path in place and git was still found.
export function envWithPath(env, dir) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  out.PATH = dir;
  return out;
}

// A directory link: a junction on Windows (made without an admin right, the kind install.ps1 meets there) and
// a symlink elsewhere, so the link cases of the run suite run on every OS.
export function linkDir(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined);
}
