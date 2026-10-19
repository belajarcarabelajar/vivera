// README.md is an index; its sections live in docs/guide/ (plan 2026-10-18-split-readme).
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fenceMask } from './docs-gen.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const GUIDE = 'docs/guide';
const README_LIMIT = 20000;
const GUIDE_LIMIT = 19000;

const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const guideFiles = existsSync(path.join(ROOT, GUIDE))
  ? readdirSync(path.join(ROOT, GUIDE)).filter((n) => n.endsWith('.md')).sort().map((n) => `${GUIDE}/${n}`)
  : [];
const pages = JSON.parse(readFileSync(path.join(ROOT, 'apps/docs/pages.json'), 'utf8')).pages;
const mapped = new Set(pages.flatMap((p) => p.source.files ?? [p.source.file]));

test('README.md is under the size limit', () => {
  expect(Buffer.byteLength(readme)).toBeLessThan(README_LIMIT);
});

test('the guide has files', () => {
  expect(guideFiles.length).toBeGreaterThan(0);
});

test('every guide file is under 19,000 bytes', () => {
  const over = guideFiles.filter((f) => statSync(path.join(ROOT, f)).size >= GUIDE_LIMIT);
  expect(over).toEqual([]);
});

test('README links every guide file', () => {
  const missing = guideFiles.filter((f) => !readme.includes(`](${f})`));
  expect(missing).toEqual([]);
});

test('every guide file is mapped to a docs page', () => {
  expect(guideFiles.filter((f) => !mapped.has(f))).toEqual([]);
});

test('README keeps no H2 section and maps only its preamble', () => {
  const lines = readme.split('\n');
  const mask = fenceMask(lines);
  expect(lines.filter((l, i) => !mask[i] && /^## /.test(l))).toEqual([]);
  expect(pages.filter((p) => p.source.file === 'README.md').map((p) => p.source.heading)).toEqual(['']);
});

test('the execution model guide says Proportional Fan-Out and keeps the old anchor', () => {
  const text = readFileSync(path.join(ROOT, GUIDE, 'pipeline-execution-model.md'), 'utf8');
  expect(text).toContain('<a id="execution-model-subagent-first-high-fan-out"></a>');
  expect(text).toContain('\n# Execution Model: Subagent-First, Proportional Fan-Out\n');
  expect(text).not.toContain('High Fan-Out');
});
