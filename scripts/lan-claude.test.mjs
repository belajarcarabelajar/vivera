// scripts/lan-claude.test.mjs
//
// mods/lan-claude is a daemon with Bun specs named *.spec.ts (so `claude plugin test` never picks up a
// bun:test import). They sit under mods/, not scripts/, so `bun run test` would never see them, and the
// planner only treats a path under mods/<name>/ as covered when scripts/<name>.test.mjs exists. This file
// runs the specs and checks the facts a clone on another machine depends on.

import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const MOD = join(ROOT, 'mods/lan-claude');
const TESTS = join(MOD, 'test');

// Built from fragments so this file never contains a denylisted string itself. The list is the owner's
// machine, key file, network, bot, and real project and session names; none belongs in a public tree.
const DENY = new RegExp(
  [['/home/', 'belajarcarabelajar'], ['batch-', 'didline'], ['Proyek/', 'lan-claude'], ['wans', 'daily'], ['snipset', '-03'], ['belajarcarabelajar', '-4b']]
    .map((parts) => parts.join(''))
    .join('|') + '|192[.]168[.]1[.]|[Ww]ans ?[Dd]aily',
);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('specs are named *.spec.ts so claude plugin test skips them', () => {
  const names = readdirSync(TESTS);
  expect(names.filter((n) => n.endsWith('.test.ts'))).toEqual([]);
  const specs = names.filter((n) => n.endsWith('.spec.ts'));
  for (const n of ['config', 'launcher', 'lan', 'permissions', 'dialog', 'folders', 'markdown', 'sessions', 'telegram', 'tmux', 'voice-job']) {
    expect(specs).toContain(`${n}.spec.ts`);
  }
});

test('the systemd unit runs the server from a vivera clone in the home directory', () => {
  const unit = readFileSync(join(MOD, 'deploy/lan-claude.service'), 'utf8');
  expect(unit).toMatch(/^WorkingDirectory=%h\/vivera\/mods\/lan-claude$/m);
  expect(unit).toMatch(/^ExecStart=%h\/\.bun\/bin\/bun src\/server\.ts$/m);
});

test('no file of the mod names the owner machine, network, bot or real session', () => {
  const hits = [];
  for (const file of walk(MOD)) {
    if (file.endsWith('bun.lock')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (DENY.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}`);
    });
  }
  expect(hits).toEqual([]);
});

test('the mod specs pass without installed dependencies', () => {
  const specs = readdirSync(TESTS)
    .filter((n) => n.endsWith('.spec.ts'))
    .sort()
    .map((n) => `./test/${n}`);
  const run = spawnSync(process.execPath, ['test', ...specs], { cwd: MOD, encoding: 'utf8', timeout: 200_000 });
  const out = run.stdout + run.stderr;
  expect(run.status, out).toBe(0);
  expect(out).toMatch(/\b0 fail\b/);
  const passed = Number(/\b(\d+) pass\b/.exec(out)?.[1] ?? 0);
  expect(passed).toBeGreaterThanOrEqual(54);
}, 240_000);
