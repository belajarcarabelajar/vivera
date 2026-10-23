// scripts/telegram-ask.test.mjs
//
// mods/telegram-ask has two halves with two test runners. The bridge daemon's
// tests are Bun tests named *.spec.ts, because `claude plugin test` runs every
// *.test.ts under the mod and refuses a bun:test import. The race hook's tests
// run only under `claude plugin test`. Neither sits under scripts/, so
// `bun run test` would never see them; this file runs both.

import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const MOD = join(ROOT, 'mods/telegram-ask');

test('bridge tests are named *.spec.ts so claude plugin test skips them', () => {
  const names = readdirSync(join(MOD, 'bridge'));
  expect(names.filter((n) => n.endsWith('.test.ts'))).toEqual([]);
  expect(names.filter((n) => n.endsWith('.spec.ts')).sort()).toEqual(['format.spec.ts', 'server-updates.spec.ts', 'server.spec.ts']);
});

test('the systemd unit runs the bridge from the main checkout', () => {
  const unit = readFileSync(join(MOD, 'deploy/telegram-ask-bridge.service'), 'utf8');
  expect(unit).toMatch(/^ExecStart=%h\/\.bun\/bin\/bun %h\/vivera\/mods\/telegram-ask\/bridge\/main\.ts$/m);
});

test('the bridge tests pass', () => {
  const run = spawnSync(process.execPath, ['test', './mods/telegram-ask/bridge/'], { cwd: ROOT, encoding: 'utf8', timeout: 100_000 });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(run.stdout + run.stderr).toMatch(/\b0 fail\b/);
}, 120_000);

const claude = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();

test.skipIf(!claude)('the mod passes claude plugin validate and claude plugin test', () => {
  const validate = spawnSync(claude, ['plugin', 'validate', join(ROOT, 'mods')], { encoding: 'utf8' });
  expect(validate.status, validate.stdout + validate.stderr).toBe(0);
  const run = spawnSync(claude, ['plugin', 'test', MOD], { encoding: 'utf8', timeout: 60_000 });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(run.stdout + run.stderr).toMatch(/\b0 fail\b/);
}, 90_000);
