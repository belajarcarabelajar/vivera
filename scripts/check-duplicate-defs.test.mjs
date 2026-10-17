import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDiff, definitionsIn, main, normalizeName } from './check-duplicate-defs.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-duplicate-defs.mjs');
const HINT = 'reuse it, or add dup-defs: allow <reason>';

// Hooks and signing are disabled per call so a global git config cannot make the
// fixture depend on this host.
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const dirs = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-defs-'));
  dirs.push(dir);
  return dir;
}

function put(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

// `base` is committed on main, `branch` is committed on a feature branch, and
// `untracked` is written last and never added. `add -f` keeps a host-wide ignore
// file from hiding the node_modules, dist, and build fixtures.
function makeRepo({ base = {}, branch = {}, untracked = {} }) {
  const dir = tmpDir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  put(dir, { 'README.md': 'fixture\n', ...base });
  git(dir, 'add', '-f', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  put(dir, branch);
  git(dir, 'add', '-f', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'branch');
  put(dir, untracked);
  return dir;
}

function cli(cwd, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

const where = (r) => r.violations.map((v) => v.where);

test('normalizeName lower-cases and drops underscores and hyphens', () => {
  expect(normalizeName('Format_Price-Now')).toBe('formatpricenow');
  expect(normalizeName('formatPrice')).toBe(normalizeName('format_price'));
});

test('definitionsIn finds every top-level JS and TS declaration form with its 1-based line', () => {
  const text = [
    'function plain() {}',
    'async function asyncOne() {}',
    'function* gen() {}',
    'export function exported() {}',
    'export default function defaulted() {}',
    'export async function exportedAsync() {}',
    'class Widget {}',
    'export class Gadget {}',
    'export default class Gizmo {}',
    'const arrow = (a, b) => a + b;',
    'const asyncArrow = async (a) => a;',
    'const bare = a => a;',
    'export const exportedArrow = async a => a;',
    'const wrapped = (',
    '  a,',
    '  b',
    ') => a;',
  ].join('\n');
  expect(definitionsIn('x.ts', text)).toEqual([
    { name: 'plain', line: 1 },
    { name: 'asyncOne', line: 2 },
    { name: 'gen', line: 3 },
    { name: 'exported', line: 4 },
    { name: 'defaulted', line: 5 },
    { name: 'exportedAsync', line: 6 },
    { name: 'Widget', line: 7 },
    { name: 'Gadget', line: 8 },
    { name: 'Gizmo', line: 9 },
    { name: 'arrow', line: 10 },
    { name: 'asyncArrow', line: 11 },
    { name: 'bare', line: 12 },
    { name: 'exportedArrow', line: 13 },
    { name: 'wrapped', line: 14 },
  ]);
});

test('definitionsIn ignores indented code, plain constants, calls that take an arrow, and anonymous defaults', () => {
  const text = [
    '  function nested() {}',
    '\tconst inner = () => 1;',
    'const count = 5;',
    'const wrapped = register(() => 1);',
    'export default function () {}',
    'export default class {}',
    'const note = "function fake() {}";',
  ].join('\n');
  expect(definitionsIn('x.js', text)).toEqual([]);
});

test('definitionsIn reads Python def, async def, and class at column 0 only', () => {
  const text = [
    'def format_price(cents):',
    '    return cents',
    'async def fetch_all():',
    '    pass',
    'class Repo:',
    '    def method(self):',
    '        pass',
  ].join('\n');
  expect(definitionsIn('p.py', text)).toEqual([
    { name: 'format_price', line: 1 },
    { name: 'fetch_all', line: 3 },
    { name: 'Repo', line: 5 },
  ]);
});

test('definitionsIn ignores a Go method with a receiver and keeps the plain func', () => {
  const text = [
    'func (s *Store) fetchRows() {}',
    'func plainHelper(x int) int {',
    '\treturn x',
    '}',
    'func (Store) other() {}',
  ].join('\n');
  expect(definitionsIn('s.go', text)).toEqual([{ name: 'plainHelper', line: 2 }]);
});

test('definitionsIn reads Rust fn with pub, pub(crate), and async, at column 0 only', () => {
  const text = [
    'fn plain() {}',
    'pub fn public_one() {}',
    'pub(crate) fn crate_one() {}',
    'pub async fn async_one() {}',
    'async fn private_async() {}',
    '    fn nested() {}',
  ].join('\n');
  expect(definitionsIn('r.rs', text)).toEqual([
    { name: 'plain', line: 1 },
    { name: 'public_one', line: 2 },
    { name: 'crate_one', line: 3 },
    { name: 'async_one', line: 4 },
    { name: 'private_async', line: 5 },
  ]);
});

test('definitionsIn reads .js .mjs .cjs .jsx .ts .tsx and nothing else', () => {
  for (const ext of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']) {
    expect(definitionsIn(`a${ext}`, 'function shared() {}\n')).toEqual([{ name: 'shared', line: 1 }]);
  }
  expect(definitionsIn('notes.md', 'function shared() {}\n')).toEqual([]);
});

test('a definition added in one file that already exists in another is a hit', () => {
  const dir = makeRepo({
    base: { 'lib/price.mjs': 'export function formatPrice(cents) {\n  return String(cents);\n}\n' },
    branch: { 'src/cart.mjs': 'const unrelated = 1;\nexport function formatPrice(n) {\n  return String(n);\n}\n' },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(where(r)).toEqual(['src/cart.mjs:2']);
  expect(r.violations[0].message).toBe(`possible duplicate of formatPrice (lib/price.mjs:1); ${HINT}`);
});

test('camelCase and snake_case spellings of one name match', () => {
  const dir = makeRepo({
    base: { 'lib/pricing.mjs': 'export function format_price(cents) {\n  return cents;\n}\n' },
    branch: { 'src/cart.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(where(r)).toEqual(['src/cart.mjs:1']);
  expect(r.violations[0].message).toBe(`possible duplicate of format_price (lib/pricing.mjs:1); ${HINT}`);
});

test('two definitions in the same file are not a hit', () => {
  const dir = makeRepo({
    base: { 'src/price.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
    branch: { 'src/price.mjs': 'export function formatPrice(n) {\n  return n;\n}\nexport function format_price(n) {\n  return n;\n}\n' },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(1);
});

test('a generic name is scanned but never compared, and only the exact name is generic', () => {
  const body = 'function main() {}\nfunction run() {}\nfunction renderTable() {}\n';
  const dir = makeRepo({
    base: { 'lib/a.mjs': body },
    branch: { 'src/b.mjs': body },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(where(r)).toEqual(['src/b.mjs:3']);
  expect(r.definitions).toBe(3);
});

const testFileShapes = {
  'lib/price.test.mjs': 'function formatPrice() {}\n',
  'lib/price.spec.ts': 'function formatPrice() {}\n',
  'lib/price_test.go': 'func formatPrice() {}\n',
  'lib/test_price.py': 'def format_price():\n    pass\n',
  'tests/price.mjs': 'function formatPrice() {}\n',
  'pkg/__tests__/price.mjs': 'function formatPrice() {}\n',
};

test('a test file on the existing side is never a duplicate source', () => {
  const dir = makeRepo({
    base: testFileShapes,
    branch: { 'src/cart.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(1);
});

test('a test file on the added side is not scanned', () => {
  const dir = makeRepo({
    base: { 'lib/price.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
    branch: testFileShapes,
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(0);
  expect(r.files).toBe(0);
});

const vendoredShapes = {
  'node_modules/pkg/index.js': 'function formatPrice() {}\n',
  'vendor/x/price.mjs': 'function formatPrice() {}\n',
  'dist/price.js': 'function formatPrice() {}\n',
  'build/price.js': 'function formatPrice() {}\n',
  'target/price.mjs': 'function formatPrice() {}\n',
  'graphify-out/price.js': 'function formatPrice() {}\n',
};

test('node_modules, vendor, dist, build, target, and graphify-out are skipped on the existing side', () => {
  const dir = makeRepo({
    base: vendoredShapes,
    branch: { 'src/cart.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
  });
  expect(checkDiff({ base: 'main', cwd: dir }).violations).toEqual([]);
});

test('node_modules, vendor, dist, build, target, and graphify-out are skipped on the added side', () => {
  const dir = makeRepo({
    base: { 'lib/price.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
    branch: vendoredShapes,
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.files).toBe(0);
});

test('only added lines count: a duplicate pair already on the base is not a hit', () => {
  const pair = 'export function formatPrice(n) {\n  return n;\n}\n';
  const dir = makeRepo({
    base: { 'a/price.mjs': pair, 'b/price.mjs': pair },
    branch: { 'b/price.mjs': `${pair}export function weightOf(kg) {\n  return kg;\n}\n` },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(1);
  expect(r.files).toBe(1);
});

test('a waiver with a reason, on the line above or on the same line, passes the definition', () => {
  const dir = makeRepo({
    base: {
      'lib/price.mjs': 'export function formatPrice(n) {\n  return n;\n}\n',
      'lib/tax.mjs': 'export function taxFor(n) {\n  return n;\n}\n',
    },
    branch: {
      'src/a.mjs': '// dup-defs: allow cart rounds half up, price.mjs rounds down\nexport function formatPrice(n) {\n  return n;\n}\n',
      'src/b.mjs': 'export function taxFor(n) { return n; } // dup-defs: allow different jurisdiction\n',
    },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(2);
});

test('a waiver with no reason is a violation of its own', () => {
  const dir = makeRepo({
    base: {
      'lib/price.mjs': 'export function formatPrice(n) {\n  return n;\n}\n',
      'lib/tax.mjs': 'export function taxFor(n) {\n  return n;\n}\n',
    },
    branch: {
      'src/a.mjs': '// dup-defs: allow\nexport function formatPrice(n) {\n  return n;\n}\n',
      'src/b.mjs': 'export function taxFor(n) { return n; } /* dup-defs: allow */\n',
    },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(where(r)).toEqual(['src/a.mjs:2', 'src/b.mjs:1']);
  expect(r.violations.map((v) => v.rule)).toEqual(['waiver without reason', 'waiver without reason']);
  expect(r.violations[0].message).toBe('dup-defs: allow needs a reason after it');
  expect(cli(dir, '--diff', 'main').status).toBe(1);
});

test('a Go method with a receiver is not compared, a plain func of the same name is', () => {
  const dir = makeRepo({
    base: { 'tax/tax.go': 'func taxFor(rate int) int {\n\treturn rate\n}\n' },
    branch: {
      'cart/cart.go': 'func (c *Cart) taxFor(rate int) int {\n\treturn rate\n}\n',
      'ship/ship.go': 'func taxFor(rate int) int {\n\treturn rate\n}\n',
    },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(where(r)).toEqual(['ship/ship.go:1']);
  expect(r.definitions).toBe(1);
});

test('an untracked new file is read in full', () => {
  const dir = makeRepo({
    base: { 'lib/price.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
    untracked: { 'src/cart.mjs': 'const unrelated = 1;\nexport function formatPrice(n) {\n  return n;\n}\n' },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(where(r)).toEqual(['src/cart.mjs:2']);
  expect(r.files).toBe(1);
});

test('a file deleted from the working tree but still in the index is skipped, not a crash', () => {
  // The padding keeps git from reading old.mjs and cart.mjs as one renamed file,
  // which would leave cart.mjs with no added lines.
  const padding = Array.from({ length: 8 }, (_, i) => `// legacy note ${i} about the first implementation\n`).join('');
  const dir = makeRepo({
    base: { 'lib/old.mjs': `${padding}export function formatPrice(n) {\n  return n;\n}\n` },
    branch: { 'src/cart.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
  });
  fs.rmSync(path.join(dir, 'lib/old.mjs'));
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(1);
});

test('two new definitions in different files are reported once, not twice', () => {
  const body = 'export function shippingQuote(w) {\n  return w;\n}\n';
  const dir = makeRepo({ branch: { 'src/a.mjs': body, 'src/b.mjs': body } });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(where(r)).toEqual(['src/a.mjs:1']);
  expect(r.violations[0].message).toBe(`possible duplicate of shippingQuote (src/b.mjs:1); ${HINT}`);
  expect(r.definitions).toBe(2);
});

test('names made only of underscores are never a hit', () => {
  const dir = makeRepo({
    base: { 'lib/a.mjs': 'function _() {}\n' },
    branch: { 'src/b.mjs': 'function __() {}\n' },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(1);
});

test('a tracked symlink named like a source file but pointing at a directory is skipped, not a crash', () => {
  const dir = makeRepo({ branch: { 'src/cart.mjs': 'export function totalWeight(kg) {\n  return kg;\n}\n' } });
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.symlinkSync('assets', path.join(dir, 'link.mjs'));
  git(dir, 'add', '-f', 'link.mjs');
  git(dir, 'commit', '-q', '-m', 'symlink');
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.files).toBe(1);
});

test('a both-new pair is reported on the path that sorts first, whichever file is untracked', () => {
  const body = 'export function shippingQuote(w) {\n  return w;\n}\n';
  const message = (other) => `possible duplicate of shippingQuote (${other}:1); ${HINT}`;
  const untrackedLast = makeRepo({ branch: { 'src/a.mjs': body }, untracked: { 'src/b.mjs': body } });
  const first = checkDiff({ base: 'main', cwd: untrackedLast });
  expect(where(first)).toEqual(['src/a.mjs:1']);
  expect(first.violations[0].message).toBe(message('src/b.mjs'));
  const untrackedFirst = makeRepo({ branch: { 'src/b.mjs': body }, untracked: { 'src/a.mjs': body } });
  const second = checkDiff({ base: 'main', cwd: untrackedFirst });
  expect(where(second)).toEqual(['src/a.mjs:1']);
  expect(second.violations[0].message).toBe(message('src/b.mjs'));
});

test('CLI exits 0 on a clean branch and prints the scanned line last', () => {
  const dir = makeRepo({
    base: { 'lib/price.mjs': 'export function formatPrice(n) {\n  return n;\n}\n' },
    branch: { 'src/cart.mjs': 'export function totalWeight(kg) {\n  return kg;\n}\n' },
  });
  const r = cli(dir, '--diff', 'main');
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('scanned 1 added definitions in 1 files\n');
});

test('CLI prints a visible zero when the branch adds no source definitions', () => {
  const dir = makeRepo({ branch: { 'notes.md': 'function nothing() {}\n' } });
  const r = cli(dir, '--diff', 'main');
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('scanned 0 added definitions in 0 files\n');
});

test('CLI exits 1 on a hit, one line per hit, then the scanned line', () => {
  const dir = makeRepo({
    base: { 'lib/price.mjs': 'export function formatPrice(cents) {\n  return String(cents);\n}\n' },
    branch: { 'src/cart.mjs': 'const unrelated = 1;\nexport function formatPrice(n) {\n  return String(n);\n}\n' },
  });
  const r = cli(dir, '--diff', 'main');
  expect(r.status).toBe(1);
  expect(r.stdout).toBe(`src/cart.mjs:2: possible duplicate of formatPrice (lib/price.mjs:1); ${HINT}\nscanned 1 added definitions in 1 files\n`);
});

test('a diff.mnemonicPrefix git config does not hide an added duplicate', () => {
  const dir = makeRepo({
    base: { 'lib/price.mjs': 'export function formatPrice(cents) {\n  return String(cents);\n}\n' },
    branch: { 'src/cart.mjs': 'const unrelated = 1;\nexport function formatPrice(n) {\n  return String(n);\n}\n' },
  });
  git(dir, 'config', 'diff.mnemonicPrefix', 'true');
  const r = cli(dir, '--diff', 'main');
  expect(r.status).toBe(1);
  expect(r.stdout).toBe(`src/cart.mjs:2: possible duplicate of formatPrice (lib/price.mjs:1); ${HINT}\nscanned 1 added definitions in 1 files\n`);
});

test('CLI exits 2 on a usage error, with a usage line', () => {
  const dir = makeRepo({});
  for (const args of [[], ['--diff'], ['--diff', '--output=x'], ['--nope'], ['--diff', 'main', 'extra']]) {
    const r = cli(dir, ...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: check-duplicate-defs\.mjs --diff <base>/);
  }
  expect(main(['--diff'])).toBe(2);
});

test('CLI exits 2 outside a git repository', () => {
  const r = cli(tmpDir(), '--diff', 'main');
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/not inside a git repository/);
});

test('an unresolvable base throws with the message git printed', () => {
  const dir = makeRepo({});
  expect(() => checkDiff({ base: 'no-such-ref-for-test', cwd: dir })).toThrow(/fatal:.*no-such-ref-for-test/);
  expect(() => checkDiff({ base: '--output=x', cwd: dir })).toThrow(/invalid --diff base/);
  const r = cli(dir, '--diff', 'no-such-ref-for-test');
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/fatal:/);
});

test('calibration: parseArgs is skipped as a per-script convention', () => {
  const body = 'export function parseArgs(argv) {\n  return argv;\n}\n';
  const dir = makeRepo({ base: { 'lib/export.mjs': body }, branch: { 'src/sync.mjs': body } });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(1);
});

test('calibration: usage is skipped as a per-script convention', () => {
  const body = 'function usage() {\n  console.error("usage: tool");\n}\n';
  const dir = makeRepo({ base: { 'lib/graph.mjs': body }, branch: { 'src/batch.mjs': body } });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(1);
});

test('calibration: a name shared across language families is not a hit', () => {
  const dir = makeRepo({
    base: {
      'lib/graph.py': 'def build_graph(files):\n    return files\n',
      'lib/route.rs': 'fn route_table() {}\n',
    },
    branch: {
      'src/graph.mjs': 'export function buildGraph(files) {\n  return files;\n}\n',
      'src/route.go': 'func routeTable() {}\n',
    },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(r.violations).toEqual([]);
  expect(r.definitions).toBe(2);
});

test('calibration: the same name in two files of one family is still a hit', () => {
  const dir = makeRepo({
    base: { 'lib/price.ts': 'export function formatPrice(cents: number) {\n  return String(cents);\n}\n' },
    branch: { 'src/cart.mjs': 'export function formatPrice(n) {\n  return String(n);\n}\n' },
  });
  const r = checkDiff({ base: 'main', cwd: dir });
  expect(where(r)).toEqual(['src/cart.mjs:1']);
});
