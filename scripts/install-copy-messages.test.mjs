// scripts/install-copy-messages.test.mjs
//
// The [FAIL] line of a copy that could not be placed names the step that failed (copy_entry and
// place_copy in scripts/install/place.sh): `cp failed` when the copy into the temporary name failed,
// `mv failed` when only the final rename of that temporary copy into place failed. It used to say
// `cp failed` for both, so a full disk and a refused rename looked the same.
//
//   M1 a rename that fails after a good copy says `mv failed`, and the user's file is put back
//   M2 the same rename failure with nothing at the destination says `mv failed`
//   M3 the same rename failure on a managed copy that is being refreshed says `mv failed`
//   M4 a copy that fails still says `cp failed` (with nothing at the destination, and with a user's file)
//
// Every run uses the sandbox from scripts/lib/install-sandbox.mjs, never the real HOME.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const MASTER = 'Super Ultra Code Plan Implementation.md';
const PKG = '.agents/skills/super-ultra-code-plan';
const DEST = `${PKG}/SKILL.md`;
const ARGS = ['--copy', '--only', 'agents'];

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

// Copy mode compares content with cmp and diff, which the sandbox PATH does not carry by default.
function sandbox() {
  const sb = makeSandbox({ tools: ['git', 'bun', 'cmp', 'diff'] });
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const names = (sb) => sb.snapshot(sb.root).map((l) => l.split('|')[0]);
const leftovers = (sb) => names(sb).filter((n) => n.includes('.vivera-tmp-'));
const backups = (sb) => names(sb).filter((n) => n.includes('.vivera-bak-'));

// Replaces a tool on the sandbox PATH by a script. The real tool is read before the symlink goes.
const realTool = (sb, name) => fs.readlinkSync(path.join(sb.bin, name));
function shim(sb, name, body) {
  const file = path.join(sb.bin, name);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// mv that refuses only the rename of a temporary copy (<dest>.vivera-tmp-<pid>) into place. The move
// aside of a user's file and the put-back of it use the real mv.
function failTmpRename(sb) {
  const real = JSON.stringify(realTool(sb, 'mv'));
  shim(sb, 'mv', `case "$1" in\n  *.vivera-tmp-*) exit 1 ;;\nesac\nexec ${real} "$@"`);
}

// cp that logs each call and then does the real copy, so a test can see that cp ran and succeeded.
function logCp(sb) {
  const real = JSON.stringify(realTool(sb, 'cp'));
  const log = path.join(sb.root, 'cp.log');
  shim(sb, 'cp', `printf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${real} "$@"`);
  return log;
}

// cp that fails when it is asked to write a temporary copy.
function failTmpCopy(sb) {
  shim(sb, 'cp', 'for last; do :; done\ncase "$last" in\n  *.vivera-tmp-*) exit 1 ;;\nesac\nexec ' + JSON.stringify(realTool(sb, 'cp')) + ' "$@"');
}

describe('M1: a rename that fails after a good copy says mv failed and puts the user file back', () => {
  test('M1: cp succeeded, the rename of the temporary copy failed', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.writeFileSync(at(sb, DEST), 'mine');
    const log = logCp(sb);
    failTmpRename(sb);
    const r = sb.run(ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[FAIL] could not place ${at(sb, DEST)}: mv failed; your file was put back`);
    expect(r.stderr).not.toContain('cp failed');
    // Control: the copy into the temporary name did run, and it succeeded.
    expect(fs.readFileSync(log, 'utf8')).toContain(`${DEST}.vivera-tmp-`);
    expect(fs.readFileSync(at(sb, DEST), 'utf8')).toBe('mine');
    expect(backups(sb)).toEqual([]);
    expect(leftovers(sb)).toEqual([]);
  });
});

describe('M2: a rename that fails with nothing at the destination says mv failed', () => {
  test('M2: a fresh HOME, cp succeeded, the rename failed', () => {
    const sb = sandbox();
    const log = logCp(sb);
    failTmpRename(sb);
    const r = sb.run(ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[FAIL] could not place ${at(sb, DEST)}: mv failed`);
    expect(r.stderr).not.toContain('cp failed');
    expect(fs.readFileSync(log, 'utf8')).toContain(`${DEST}.vivera-tmp-`);
    expect(fs.existsSync(at(sb, DEST))).toBe(false);
    expect(leftovers(sb)).toEqual([]);
  });
});

describe('M3: a rename that fails while a managed copy is refreshed says mv failed', () => {
  test('M3: the master file changed after the first install, the refresh cannot rename', () => {
    const sb = sandbox();
    expect(sb.run(ARGS).status).toBe(0);
    fs.appendFileSync(path.join(sb.repo, MASTER), '\na newer line\n');
    failTmpRename(sb);
    const r = sb.run(ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[FAIL] could not place ${at(sb, DEST)}: mv failed`);
    expect(r.stderr).not.toContain('cp failed');
    // A refresh is not a user's file: nothing was moved aside.
    expect(r.stdout).not.toContain('[BACKUP]');
    expect(backups(sb)).toEqual([]);
    expect(leftovers(sb)).toEqual([]);
  });
});

describe('M4: a copy that fails still says cp failed', () => {
  test('M4: nothing at the destination', () => {
    const sb = sandbox();
    failTmpCopy(sb);
    const r = sb.run(ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[FAIL] could not place ${at(sb, DEST)}: cp failed`);
    expect(r.stderr).not.toContain('mv failed');
    expect(fs.existsSync(at(sb, DEST))).toBe(false);
    expect(leftovers(sb)).toEqual([]);
  });

  test('M4: a user file at the destination is put back and the line still says cp failed', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.writeFileSync(at(sb, DEST), 'mine');
    failTmpCopy(sb);
    const r = sb.run(ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[FAIL] could not place ${at(sb, DEST)}: cp failed; your file was put back`);
    expect(r.stderr).not.toContain('mv failed');
    expect(fs.readFileSync(at(sb, DEST), 'utf8')).toBe('mine');
    expect(backups(sb)).toEqual([]);
    expect(leftovers(sb)).toEqual([]);
  });
});
