import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { missingTestPaths } from './test-paths.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// A temp checkout holding present.test.mjs and scripts/lib/ok.test.ts; every other test file is absent.
function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-paths-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'present.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'ok.test.ts'), '');
  return root;
}

describe('missingTestPaths', () => {
  test('names the absent file of a bun test run under timeout and skips the present one', () => {
    const root = checkout();
    expect(missingTestPaths('timeout 120 bun test --timeout 30000 ./present.test.mjs ./gone.test.mjs', root)).toEqual(['./gone.test.mjs']);
  });

  test('reads every bun test across &&, || and ; segments', () => {
    const root = checkout();
    const cmd = 'bun test a.test.mjs && bun test ./present.test.mjs; timeout 60 bun test b.test.ts scripts/lib/ok.test.ts || bun test c.repro.test.mjs d.test.tsx e.test.js';
    expect(missingTestPaths(cmd, root)).toEqual(['a.test.mjs', 'b.test.ts', 'c.repro.test.mjs', 'd.test.tsx', 'e.test.js']);
  });

  test('flags and their values are not paths', () => {
    const root = checkout();
    expect(missingTestPaths("bun test -t 'gone.test.mjs' --timeout 30000 --timeout=5 ./present.test.mjs", root)).toEqual([]);
  });

  test('a quoted path is read without its quotes', () => {
    expect(missingTestPaths('bun test "./gone.test.mjs"', checkout())).toEqual(['./gone.test.mjs']);
  });

  test('an absolute path is checked as is, not under cwd', () => {
    const root = checkout();
    const present = path.join(root, 'present.test.mjs');
    expect(missingTestPaths(`bun test ${present} /no/such/dir/zz.test.mjs`, os.tmpdir())).toEqual(['/no/such/dir/zz.test.mjs']);
  });

  test('a command without bun test, or bun run test, names nothing', () => {
    const root = checkout();
    expect(missingTestPaths('node gone.test.mjs; ls x.test.js; bun run test y.test.mjs; test -f marker', root)).toEqual([]);
  });

  test('a directory or name filter is not a test file argument', () => {
    expect(missingTestPaths('bun test ./scripts/missing-dir eval-repeat', checkout())).toEqual([]);
  });

  test('an empty or non-string command names nothing', () => {
    expect(missingTestPaths('', checkout())).toEqual([]);
    expect(missingTestPaths(undefined, checkout())).toEqual([]);
  });
});
