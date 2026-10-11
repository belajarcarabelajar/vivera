// scripts/lib/install-digest-helpers.mjs
//
// Fixtures shared by the three scripts/install-digest-hardening-*.test.mjs files: a sandbox whose PATH holds
// exactly one hash tool (or none, or a broken one) plus cmp and diff, the path and listing helpers, and the
// cleanup every test needs. They sit on top of scripts/lib/install-sandbox.mjs and add nothing to it that
// another install suite would want. Needs bun:test, so it is only for test files.
//
// A test file registers the cleanup itself, because a hook registered from an imported module does not
// belong to the importing file's tests:
//   import { afterEach } from 'bun:test';
//   import { cleanup } from './lib/install-digest-helpers.mjs';
//   afterEach(cleanup);

import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './install-sandbox.mjs';

export const SKILLS = '.agents/skills';
export const PKG = `${SKILLS}/super-ultra-code-plan`;
export const STAMP = '20260101T000000Z';
export const MARKER = '.vivera-managed';
export const AS_ROOT = process.getuid?.() === 0;
export const rootSkip = AS_ROOT ? test.skip : test;

const open = [];
export const restore = [];
export function cleanup() {
  while (restore.length) restore.pop()();
  while (open.length) open.pop().cleanup();
}

const SHA256SUM = Bun.which('sha256sum');
const CKSUM = Bun.which('cksum');

export function writeShim(sb, name, body) {
  const file = path.join(sb.bin, name);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// Leaves exactly one hash tool on the sandbox PATH (or none, or a broken one).
//   sha256sum  the real one          shasum   a shim that takes `-a 256` and runs sha256sum
//   cksum      the real one          none     no sha256sum, shasum or cksum at all
//   broken     sha256sum that exits 1 for any input
//   fails-on-alpha  sha256sum that works except on data holding the word alpha (the file a.txt of tree()),
//                   so the probe on empty input and the hash of the final listing pass and one per-file hash fails
export function setHash(sb, kind) {
  for (const name of ['sha256sum', 'shasum', 'cksum']) fs.rmSync(path.join(sb.bin, name), { force: true });
  if (kind === 'sha256sum') fs.symlinkSync(SHA256SUM, path.join(sb.bin, 'sha256sum'));
  else if (kind === 'cksum') fs.symlinkSync(CKSUM, path.join(sb.bin, 'cksum'));
  else if (kind === 'shasum') writeShim(sb, 'shasum', `shift 2\nexec ${SHA256SUM} "$@"`);
  else if (kind === 'broken') writeShim(sb, 'sha256sum', 'exit 1');
  else if (kind === 'fails-on-alpha') {
    writeShim(
      sb,
      'sha256sum',
      `data="$(cat; echo x)"\ndata="\${data%x}"\nif [[ "$data" == *alpha* ]]; then echo boom >&2; exit 1; fi\nprintf '%s' "$data" | ${SHA256SUM}`,
    );
  } else if (kind !== 'none') throw new Error(`unknown hash kind ${kind}`);
}

export function sandbox({ hash = 'sha256sum' } = {}) {
  const sb = makeSandbox({ tools: ['git', 'bun'] });
  open.push(sb);
  for (const t of ['cmp', 'diff']) fs.symlinkSync(Bun.which(t), path.join(sb.bin, t));
  setHash(sb, hash);
  return sb;
}

export const at = (sb, rel) => path.join(sb.home, rel);
export const read = (sb, rel) => fs.readFileSync(at(sb, rel), 'utf8');
export const repoFile = (sb, rel) => path.join(sb.repo, rel);
export const firstTemplate = (sb) => fs.readdirSync(repoFile(sb, 'templates')).sort()[0];
export const lexists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
// A backup is one entry named ...vivera-bak-...; a backed-up directory counts once, not file by file.
export const backups = (sb) => sb.snapshot(sb.root).filter((l) => l.split('|')[0].split('/').pop().includes('.vivera-bak-'));
export const mkfifo = (p) => expect(Bun.spawnSync([Bun.which('mkfifo'), p]).exitCode).toBe(0);
// A newer checkout: one template file of the source changes.
export const outdate = (sb) => fs.appendFileSync(path.join(repoFile(sb, 'templates'), firstTemplate(sb)), '\nnew line\n');
