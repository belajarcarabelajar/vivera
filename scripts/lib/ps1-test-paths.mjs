// scripts/lib/ps1-test-paths.mjs
//
// Path helpers for the install.ps1 suites, so their expectations hold on Windows as well as on Linux and
// macOS (platforms.yml run 40454770833 failed 9 tests on both Windows shells while the installer was right).

import crypto from 'node:crypto';
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

// Makes `paths` unreadable, in order, and returns the undo (reverse order). chmod 0 where POSIX modes apply;
// Windows ignores them, so there an Everyone deny ACE (icacls), which binds administrators too. Lock a file
// before its directory: Windows lets a child be opened under a denied directory (bypass traverse checking).
export function lockPath(...paths) {
  if (process.platform !== 'win32') {
    const modes = paths.map((p) => fs.statSync(p).mode & 0o7777);
    for (const p of paths) fs.chmodSync(p, 0);
    return () => paths.map((p, i) => [p, modes[i]]).reverse().forEach(([p, m]) => fs.chmodSync(p, m));
  }
  const icacls = (args) => {
    const r = Bun.spawnSync(['icacls', ...args]);
    if (r.exitCode !== 0) throw new Error(`icacls ${args.join(' ')} exited ${r.exitCode}: ${r.stdout}${r.stderr}`);
  };
  for (const p of paths) icacls([p, '/deny', '*S-1-1-0:(R)']);
  return () => [...paths].reverse().forEach((p) => icacls([p, '/remove:d', '*S-1-1-0']));
}

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

// The digest install.ps1 records for a placed directory: SHA-256 over sorted "<file sha256>  <rel path>" lines.
export function dirDigest(dir) {
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
