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

test('the OpenCode plugin loads and exports the plugin shape', async () => {
  const plugin = (await import(join(MOD, 'opencode/telegram-ask.ts'))).default;
  expect(plugin.id).toBe('telegram-ask');
  expect(typeof plugin.setup).toBe('function');
});

// Comment lines state facts (and the pitfall), so code assertions judge only
// the code: a name that appears in a comment must not satisfy them.
function codeOf(rel) {
  return readFileSync(join(MOD, rel), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

test('the OpenCode plugin never wraps tool.execute, which hides the TUI dialog', () => {
  const code = codeOf('opencode/telegram-ask.ts');
  expect(code).not.toMatch(/tool\.transform/);
  expect(code).not.toMatch(/ctx\.tool/);
});

test('the OpenCode plugin and the bridge name the same socket file and override', () => {
  const pluginLines = codeOf('opencode/telegram-ask.ts').split('\n');
  const bridge = codeOf('bridge/main.ts');
  const at = pluginLines.findIndex((line) => line.includes('const SOCKET ='));
  const pluginSocket = pluginLines.slice(at, at + 2).join('\n');
  const bridgeSocket = bridge.split('\n').find((line) => line.includes('TELEGRAM_ASK_SOCKET'));
  expect(pluginSocket).toContain('vivera-telegram-ask.sock');
  expect(bridgeSocket).toContain('vivera-telegram-ask.sock');
  expect(pluginSocket).toContain('TELEGRAM_ASK_SOCKET');
  expect(bridgeSocket).toContain('TELEGRAM_ASK_SOCKET');
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
