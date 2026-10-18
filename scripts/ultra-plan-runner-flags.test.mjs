import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RUNNER = path.join(import.meta.dirname, 'ultra-plan-runner.mjs');

test('--skip-mirror-gate is accepted and prints one deprecation line', () => {
  const r = spawnSync('bun', [RUNNER, '--skip-mirror-gate'], { encoding: 'utf8' });
  const lines = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.includes('--skip-mirror-gate is no longer needed'));
  expect(lines.length).toBe(1);
});
