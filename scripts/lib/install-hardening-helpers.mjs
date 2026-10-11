// scripts/lib/install-hardening-helpers.mjs
//
// Fixtures shared by the scripts/install-hardening-*.test.mjs suites: the sandbox wrapper that
// remembers what it made, small path and symlink helpers, a PATH shim writer, and a caller for one
// function of scripts/install/lib.sh. Moved here unchanged when install-hardening.test.mjs was split
// by area, so no suite carries its own copy.
//
// Cleanup is not registered here. A hook registered at import time would belong to whichever suite
// imported this module first, so each suite calls afterEach(closeSandboxes) itself.

import fs from 'node:fs';
import path from 'node:path';
import { assertSandbox, makeSandbox } from './install-sandbox.mjs';

export const MASTER = 'Super Ultra Code Plan Implementation.md';
export const STAMP = '20260101T000000Z';
export const PKG = '.agents/skills/super-ultra-code-plan';
export const AGENTS = '.agents/skills';
export const BUILTIN = '.gemini/antigravity-cli/builtin/skills';

const open = [];
export function closeSandboxes() {
  while (open.length) open.pop().cleanup();
}

export function sandbox({ tools = ['git', 'bun'], git = false } = {}) {
  const sb = makeSandbox({ tools, git });
  open.push(sb);
  return sb;
}

export const at = (sb, rel) => path.join(sb.home, rel);
export const exists = (sb, rel) => fs.existsSync(at(sb, rel));
export const mkdir = (sb, rel) => fs.mkdirSync(at(sb, rel), { recursive: true });
export const link = (sb, target, rel) => {
  mkdir(sb, path.dirname(rel));
  fs.symlinkSync(target, at(sb, rel));
};
export const isLink = (sb, rel) => fs.lstatSync(at(sb, rel), { throwIfNoEntry: false })?.isSymbolicLink() === true;
export const phases = (sb) => fs.readdirSync(path.join(sb.repo, 'skills')).filter((n) => n.startsWith('sucp-')).sort();
export const backupsUnder = (sb) => sb.snapshot(sb.root).filter((l) => l.split('|')[0].includes('.vivera-bak-'));
export const shim = (sb, name, body) => {
  const file = path.join(sb.bin, name);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
};
export const withCompareTools = (sb) => {
  for (const tool of ['cmp', 'diff']) fs.symlinkSync(Bun.which(tool), path.join(sb.bin, tool));
};

// Calls one function of lib.sh in a clean shell with the sandbox env (REPO_DIR set as install.sh would).
export function lib(sb, fn, ...args) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const script = 'REPO_DIR="$1"; shift; . "$REPO_DIR/scripts/install/lib.sh"; "$@"';
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), '-c', script, '_', sb.repo, fn, ...args], {
    cwd: sb.home,
  });
  return r.stdout.toString().trim();
}
