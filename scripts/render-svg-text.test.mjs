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
