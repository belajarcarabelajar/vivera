// scripts/sprite-model-router.test.mjs
//
// The mod in mods/sprite-model-router keeps its own copy of the crew roster,
// because a hooks module runs without a filesystem path back to this repo.
// A sprite added to agents/crew.json, or one whose role changed, would then be
// routed by a stale table: a new researcher stays on Opus, or worse, a sprite
// that became an implementer keeps running on the smaller model. This test
// fails on that drift. The mod's own behaviour is tested by hooks/route.spec.ts,
// which the third test runs; `claude plugin validate` runs when claude is on PATH.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROSTER, READ_ONLY_ROLES } from '../mods/sprite-model-router/hooks/route-core.ts';

const ROOT = join(import.meta.dir, '..');
const crew = JSON.parse(readFileSync(join(ROOT, 'agents/crew.json'), 'utf8'));

test('the mod roster matches agents/crew.json exactly', () => {
  const fromCrew = Object.fromEntries(crew.map((m) => [m.sprite, m.role]));
  expect(ROSTER).toEqual(fromCrew);
});

test('only roles whose tool list cannot edit files are routed down', () => {
  for (const role of READ_ONLY_ROLES) {
    const head = readFileSync(join(ROOT, `agents/roles/${role}.md`), 'utf8').split('\n---')[0];
    const tools = head.match(/^tools:\s*(.+)$/m)?.[1] ?? '';
    expect(tools, `${role} has no tools: line, so it gets every tool`).not.toBe('');
    expect(tools).not.toMatch(/\b(Edit|Write|MultiEdit|NotebookEdit)\b/);
  }
});

const claude = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();

test.skipIf(!claude)('the mod passes claude plugin validate', () => {
  const validate = spawnSync(claude, ['plugin', 'validate', join(ROOT, 'mods')], { encoding: 'utf8' });
  expect(validate.status, validate.stdout + validate.stderr).toBe(0);
}, 90_000);

test('the mod hook specs pass under bun test', () => {
  const run = spawnSync(process.execPath, ['test', 'mods/sprite-model-router/hooks/'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(run.stdout + run.stderr).toMatch(/\b0 fail\b/);
}, 90_000);
