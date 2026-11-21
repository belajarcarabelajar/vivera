// scripts/ultra-plan-runner-size-warn-root.test.mjs
//
// The plan-time size warning resolves a task's files.modify against its files_root,
// the way the runner resolves files, and reads that root's size baseline.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sizeGateWarnings } from './lib/plan-size-warn.mjs';

let cwd;
let other;

beforeAll(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'size-warn-cwd-'));
  other = mkdtempSync(path.join(tmpdir(), 'size-warn-root-'));
  mkdirSync(path.join(other, 'src'));
  mkdirSync(path.join(other, 'scripts'));
  writeFileSync(path.join(other, 'src/near.mjs'), 'x'.repeat(19000));
  writeFileSync(path.join(other, 'src/capped.mjs'), 'x'.repeat(25000));
  writeFileSync(path.join(other, 'scripts/file-size-baseline.json'), '{\n  "src/capped.mjs": 25000\n}\n');
  mkdirSync(path.join(cwd, 'src'));
  writeFileSync(path.join(cwd, 'src/near.mjs'), 'x'.repeat(10));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

const plan = (filesRoot) => ({ tasks: [{ id: 'T1', ...(filesRoot ? { files_root: filesRoot } : {}), files: { create: [], modify: ['src/near.mjs', 'src/capped.mjs'], test: [] } }] });

test('a task with files_root is measured in that root, against that root baseline', () => {
  const out = sizeGateWarnings(plan(other), cwd);
  expect(out.length).toBe(2);
  expect(out[0]).toContain('task T1 modifies src/near.mjs: 19000 bytes, 95% of the default limit 20000 bytes');
  expect(out[1]).toContain('task T1 modifies src/capped.mjs: 25000 bytes, 100% of its ceiling 25000 bytes in scripts/file-size-baseline.json');
});

test('without files_root the runner cwd is measured, as before', () => {
  expect(sizeGateWarnings(plan(null), cwd)).toEqual([]);
});
