// scripts/telegram-ask.test.mjs
//
// mods/telegram-ask keeps its Bun tests (bridge, command hooks, OpenCode plugin)
// next to the code as *.spec.ts, outside scripts/, so `bun run test` would never
// see them; this file runs them. The *.spec.ts name also keeps them out of
// `claude plugin test`, which runs every *.test.ts under a mod and refuses a
// bun:test import.

import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const MOD = join(ROOT, 'mods/telegram-ask');

test('bridge, hook and plugin tests are named *.spec.ts so claude plugin test skips them', () => {
  const names = readdirSync(join(MOD, 'bridge'));
  expect(names.filter((n) => n.endsWith('.test.ts'))).toEqual([]);
  expect(names.filter((n) => n.endsWith('.spec.ts')).sort()).toEqual(['audit-fixes.spec.ts', 'format.spec.ts', 'markdown.spec.ts', 'notify.spec.ts', 'server-updates.spec.ts', 'server.spec.ts']);
  const plugin = readdirSync(join(MOD, 'opencode'));
  expect(plugin.filter((n) => n.endsWith('.test.ts'))).toEqual([]);
  expect(plugin.filter((n) => n.endsWith('.spec.ts'))).toEqual(['telegram-ask.spec.ts']);
  const hooks = readdirSync(join(MOD, 'hooks'));
  expect(hooks.filter((n) => n.endsWith('.test.ts'))).toEqual([]);
  expect(hooks.filter((n) => n.endsWith('.spec.ts'))).toEqual(['ask.spec.ts']);
});

test('the mod has no JavaScript hooks module, which Code Mode refuses', () => {
  const hooks = JSON.parse(readFileSync(join(MOD, 'hooks/hooks.json'), 'utf8'));
  expect(hooks.modules).toBeUndefined();
  expect(readdirSync(join(MOD, 'hooks'))).not.toContain('register.ts');
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

test('the bridge, hook and OpenCode plugin tests pass', () => {
  const run = spawnSync(process.execPath, ['test', './mods/telegram-ask/bridge/', './mods/telegram-ask/hooks/', './mods/telegram-ask/opencode/'], { cwd: ROOT, encoding: 'utf8', timeout: 100_000 });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(run.stdout + run.stderr).toMatch(/\b0 fail\b/);
}, 120_000);

const claude = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();

test.skipIf(!claude)('the mods pass claude plugin validate', () => {
  const validate = spawnSync(claude, ['plugin', 'validate', join(ROOT, 'mods')], { encoding: 'utf8' });
  expect(validate.status, validate.stdout + validate.stderr).toBe(0);
}, 90_000);
