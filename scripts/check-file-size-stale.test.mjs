// scripts/check-file-size-stale.test.mjs
//
// --staged reports a stale ceiling on a STAGED path the way --all does (rule L90 in
// docs/memory/gates-and-tests.md): a helper moved out of a file shrank it below its
// ceiling, the pre-commit hook passed, and only the later --all run went red. Ceilings
// on paths the commit does not stage stay a matter for --all.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-file-size.mjs');
const BASELINE = 'scripts/file-size-baseline.json';
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
};

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const run = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stage(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof body === 'number' ? 'x'.repeat(body) : body);
  }
  git(dir, 'add', '-f', '--', ...Object.keys(files));
}

// A committed repo whose two big files sit exactly at their ceilings.
function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-gate-stale-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  stage(dir, { 'big.mjs': 22033, 'other.mjs': 30000, [BASELINE]: JSON.stringify({ 'big.mjs': 22033, 'other.mjs': 30000 }) });
  git(dir, 'commit', '-qm', 'seed');
  return dir;
}

describe('--staged reports a stale ceiling on a staged path', () => {
  test('a staged file shrunk below its ceiling fails like --all, with the rewrite hint', () => {
    const dir = seeded();
    stage(dir, { 'big.mjs': 21580 });
    const r = run(dir, '--staged');
    expect(r.code).toBe(1);
    expect(r.err).toContain(`[size-gate] stale ceilings in ${BASELINE}:`);
    expect(r.err).toContain('  big.mjs: ceiling 22033 bytes, now 21580 bytes');
    expect(r.err).toContain(`Lower them with: bun scripts/check-file-size.mjs --write-baseline, then stage ${BASELINE}`);
    expect(r.err).not.toContain('other.mjs');
  });

  test('a staged file shrunk under the limit while it keeps a ceiling fails too', () => {
    const dir = seeded();
    stage(dir, { 'big.mjs': 100 });
    const r = run(dir, '--staged');
    expect(r.code).toBe(1);
    expect(r.err).toContain('  big.mjs: ceiling 22033 bytes, now 100 bytes, within the limit');
  });

  test('a stale ceiling on a path that is not staged does not fail --staged', () => {
    const dir = seeded();
    fs.writeFileSync(path.join(dir, 'other.mjs'), 'x'.repeat(25000));
    git(dir, 'add', 'other.mjs');
    git(dir, 'commit', '-qm', 'shrink other without lowering');
    fs.writeFileSync(path.join(dir, 'big.mjs'), 'x'.repeat(21000));
    stage(dir, { 'note.txt': 'hello' });
    const r = run(dir, '--staged');
    expect([r.code, r.err]).toEqual([0, '']);
    expect(run(dir, '--all').code).toBe(1);
  });

  test('a staged file that grows back up to its ceiling passes', () => {
    const dir = seeded();
    stage(dir, { 'big.mjs': 21000 });
    git(dir, 'commit', '-qm', 'shrink without lowering');
    stage(dir, { 'big.mjs': 'y'.repeat(22033) });
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('big.mjs\n');
    const r = run(dir, '--staged');
    expect([r.code, r.err]).toEqual([0, '']);
  });

  test('a staged shrink passes once the lowered baseline is staged with it', () => {
    const dir = seeded();
    stage(dir, { 'big.mjs': 21580, [BASELINE]: JSON.stringify({ 'big.mjs': 21580, 'other.mjs': 30000 }) });
    const r = run(dir, '--staged');
    expect([r.code, r.err]).toEqual([0, '']);
  });
});
