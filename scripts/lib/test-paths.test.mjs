import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

// Each shape below once returned [] for an absent file, while bun exits 0 when another named file exists.
describe('missingTestPaths never reads these shapes as present', () => {
  const gone = ['./missing.test.mjs'];

  test('a separator inside quotes does not split the command', () => {
    const root = checkout();
    expect(missingTestPaths('bun test -t "a|b" ./missing.test.mjs', root)).toEqual(gone);
    expect(missingTestPaths("bun test -t 'a;b' ./missing.test.mjs", root)).toEqual(gone);
    expect(missingTestPaths('bun test -t "a && b" ./missing.test.mjs', root)).toEqual(gone);
  });

  test('the script of sh, bash or zsh -c is read', () => {
    const root = checkout();
    expect(missingTestPaths('bash -c "bun test ./missing.test.mjs"', root)).toEqual(gone);
    expect(missingTestPaths('sh -c "timeout 5 bun test ./missing.test.mjs"', root)).toEqual(gone);
    expect(missingTestPaths("timeout 9 /bin/zsh -lc 'bun test ./present.test.mjs ./missing.test.mjs'", root)).toEqual(gone);
  });

  test('parentheses and redirections around the arguments are not part of a path', () => {
    const root = checkout();
    expect(missingTestPaths('(bun test ./missing.test.mjs)', root)).toEqual(gone);
    expect(missingTestPaths('bun test ./missing.test.mjs>/dev/null', root)).toEqual(gone);
    expect(missingTestPaths('bun test ./missing.test.mjs 2>&1 | tail -5', root)).toEqual(gone);
    expect(missingTestPaths('bun test ./present.test.mjs &>/dev/null ./missing.test.mjs', root)).toEqual(gone);
  });

  test('bun is matched by its basename and its own flags before test are skipped', () => {
    const root = checkout();
    expect(missingTestPaths('/usr/bin/bun test ./missing.test.mjs', root)).toEqual(gone);
    expect(missingTestPaths('bun --bun test ./missing.test.mjs', root)).toEqual(gone);
  });

  test('a literal cd moves the base for the commands after it, and a subshell cd does not leak', () => {
    const root = checkout();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'inner.test.mjs'), '');
    expect(missingTestPaths('cd sub && bun test ./present.test.mjs ./inner.test.mjs', root)).toEqual(['./present.test.mjs']);
    expect(missingTestPaths('(cd sub && bun test ./inner.test.mjs) && bun test ./inner.test.mjs', root)).toEqual(['./inner.test.mjs']);
  });
});

describe('missingTestPaths file names and home', () => {
  test('every test file name bun runs counts: .test. _test. .spec. _spec. over the js and ts extensions', () => {
    const names = ['a_test.ts', 'b.spec.jsx', 'c_spec.cjs', 'd.test.mts', 'e.test.cts', 'f.spec.mjs', 'g.test.js', 'h_test.tsx'];
    expect(missingTestPaths(`bun test ./present.test.mjs ${names.join(' ')} helper.ts`, checkout())).toEqual(names);
  });

  test('a leading ~/ is the home directory', () => {
    const root = checkout();
    // Bun reads HOME once at start, so the call runs in a child whose HOME is the temp checkout.
    const lib = path.join(import.meta.dir, 'test-paths.mjs');
    const code = `const { missingTestPaths } = await import(${JSON.stringify(lib)});
console.log(JSON.stringify(missingTestPaths('bun test ~/present.test.mjs ~/scripts/lib/gone.test.mjs', '/')));`;
    const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, HOME: root }, encoding: 'utf8' });
    expect(JSON.parse(r.stdout)).toEqual(['~/scripts/lib/gone.test.mjs']);
  });

  test('variables and globs are read literally, so they read as missing', () => {
    expect(missingTestPaths('bun test $ROOT/present.test.mjs ./*.test.mjs', checkout())).toEqual(['$ROOT/present.test.mjs', './*.test.mjs']);
  });
});
