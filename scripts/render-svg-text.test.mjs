import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'render-diagrams.sh');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');
const HEROES = ['diagrams/lifecycle.svg', 'diagrams/lifecycle-dark.svg'].map((p) => path.join(ROOT, p));

// A fixed PATH keeps the grep shim in ~/.local/bin out, so this measures the
// grep a stock Linux or CI image would run.
const CLEAN_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };

const functionLine = SCRIPT.match(/^svg_text\(\) \{.*\}$/m)?.[0];

const runSvgText = (file) =>
  spawnSync('/usr/bin/bash', ['-c', `${functionLine}; svg_text "$1"`, 'bash', file], {
    encoding: 'utf8',
    env: CLEAN_ENV,
  });

const lines = (r) => r.stdout.split('\n').filter(Boolean);

const gnuPcre = spawnSync('/usr/bin/grep', ['-P', 'x', '/dev/null'], { encoding: 'utf8' }).status;
const hasPcre = gnuPcre === 0 || gnuPcre === 1;

describe('svg_text in render-diagrams.sh', () => {
  test('the script no longer needs GNU grep -P', () => {
    expect(SCRIPT).not.toContain('grep -oP');
  });

  test('the function line can be extracted', () => {
    expect(functionLine).toBeDefined();
  });

  for (const hero of HEROES) {
    test(`yields all 49 text nodes of ${path.basename(hero)}, nested <br /> included`, () => {
      const r = runSvgText(hero);
      expect(r.status).toBe(0);
      expect(lines(r).length).toBe(49);
    });

    test.skipIf(!hasPcre)(`matches grep -oP output on ${path.basename(hero)}`, () => {
      const reference = spawnSync(
        '/usr/bin/bash',
        ['-c', `/usr/bin/grep -oP '<p>.*?</p>' "$1" | LC_ALL=C sort`, 'bash', hero],
        { encoding: 'utf8', env: CLEAN_ENV },
      );
      expect(reference.status).toBe(0);
      expect(runSvgText(hero).stdout).toBe(reference.stdout);
    });
  }

  test('two nodes on one line, one with a nested <br />, give exactly two lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-svgtext-'));
    try {
      const file = path.join(dir, 'one-line.svg');
      fs.writeFileSync(file, '<svg><foreignObject><p>c</p><p>a<br />b</p></foreignObject></svg>\n');
      expect(lines(runSvgText(file))).toEqual(['<p>a<br />b</p>', '<p>c</p>']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing file gives empty output and exit 0', () => {
    const r = runSvgText(path.join(ROOT, 'diagrams', 'vivera-no-such-file.svg'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

// ---- Hardening round 2: a grep that cannot read the text nodes must not look like "unchanged" ------
//
// A grep without -E support prints nothing for both the staged and the committed SVG, and two empty
// lists are equal, so a changed hero would have been kept. An empty result for a file that is not empty
// is treated as a change instead.
describe('svg_unchanged in render-diagrams.sh', () => {
  const unchangedFn = SCRIPT.match(/^svg_unchanged\(\) \{\n[\s\S]*?\n\}$/m)?.[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivera-svgcmp-'));
  const file = (name, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  };
  // A grep that prints nothing, as one without -E would, found first on PATH.
  const shimDir = path.join(dir, 'shim');
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, 'grep'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });

  const unchanged = (a, b, { shim = false } = {}) =>
    spawnSync('/usr/bin/bash', ['-c', `${functionLine}\n${unchangedFn}\nsvg_unchanged "$1" "$2"`, 'bash', a, b], {
      encoding: 'utf8',
      env: { PATH: `${shim ? `${shimDir}:` : ''}/usr/bin:/bin`, LC_ALL: 'C' },
    }).status;

  const nodes = '<p>one</p><p>two<br />three</p>';
  const a = file('a.svg', `<svg><path d="M0 0L1 1"/><foreignObject>${nodes}</foreignObject></svg>`);
  const sameTextOtherPaths = file('b.svg', `<svg><path d="M0 0L9 9"/><foreignObject>${nodes}</foreignObject></svg>`);
  const otherText = file('c.svg', '<svg><foreignObject><p>one</p><p>changed</p></foreignObject></svg>');

  test('the function is in the script, and the publish loop calls it', () => {
    expect(unchangedFn).toBeDefined();
    expect(SCRIPT).toContain('svg_unchanged "$staged" "$dest"');
  });

  test('the same text nodes with other path data are unchanged', () => {
    expect(unchanged(a, sameTextOtherPaths)).toBe(0);
  });

  test('other text nodes are changed', () => {
    expect(unchanged(a, otherText)).toBe(1);
  });

  test('a grep that prints nothing makes two non-empty files changed, not unchanged', () => {
    expect(unchanged(a, sameTextOtherPaths, { shim: true })).toBe(1);
    expect(unchanged(a, a, { shim: true })).toBe(1);
  });

  test('a non-empty file with no text nodes at all is never unchanged', () => {
    const plain = file('plain.svg', '<svg><path d="M0 0"/></svg>');
    expect(unchanged(plain, plain)).toBe(1);
  });

  test('two empty files are equal, and an empty one against a real one is changed', () => {
    const empty = file('empty.svg', '');
    expect(unchanged(empty, file('empty2.svg', ''))).toBe(0);
    expect(unchanged(empty, a)).toBe(1);
  });

  test('cleanup', () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
