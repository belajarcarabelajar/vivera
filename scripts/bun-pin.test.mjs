// scripts/bun-pin.test.mjs
//
// Every bun version the repository pins or documents must equal the packageManager pin in
// package.json, so a bump that misses one file fails here instead of in hosted CI or a stale guide.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const EXPECTED = '1.4.4';

const IMAGE = /oven\/bun:(\d+\.\d+\.\d+)-debian/g;
const ACTION = /bun-version:\s*'(\d+\.\d+\.\d+)'/g;
// Only `bun@<v>` counts in prose: "Bun 1.4.2" in the guides records the bun of a dated verification run,
// which a pin bump does not rerun.
const PROSE = /bun@(\d+\.\d+\.\d+)/g;

const SOURCES = [
  ['Dockerfile', [IMAGE]],
  ['.github/workflows/ci.yml', [ACTION]],
  ['.github/workflows/platforms.yml', [ACTION]],
  ['docs/guide/getting-started-quick-start-1.md', [IMAGE, PROSE]],
  ['docs/guide/getting-started-repository-structure-1.md', [IMAGE]],
  ['apps/docs/content/id/getting-started-quick-start.md', [IMAGE, PROSE]],
  ['apps/docs/content/id/getting-started-repository-structure.md', [IMAGE]],
];

const pinsIn = (rel, patterns) => {
  const text = read(rel);
  return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));
};

const packageManager = JSON.parse(read('package.json')).packageManager;

describe('bun pin', () => {
  test(`package.json packageManager pins bun@${EXPECTED}`, () => {
    expect(packageManager).toBe(`bun@${EXPECTED}`);
  });

  for (const [rel, patterns] of SOURCES) {
    test(`${rel} pins the same bun version as packageManager`, () => {
      const pins = pinsIn(rel, patterns);
      // An empty match list would pass the equality check below while the pin moved to a new spelling.
      expect(pins.length).toBeGreaterThan(0);
      const fromPackage = packageManager.replace(/^bun@/, '');
      expect({ file: rel, pins }).toEqual({ file: rel, pins: pins.map(() => fromPackage) });
      expect(pins.every((v) => v === EXPECTED)).toBe(true);
    });
  }
});
