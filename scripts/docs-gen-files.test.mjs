// A page built from several files (source.files): the split guide must hash
// the same as the README section it came from, so no Indonesian twin goes stale.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildModel } from './docs-gen.mjs';

const made = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-gen-files-'));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const page = (slug, source) => ({ category: 'start', slug, order: 1, title: slug, description: slug, source });
const map = (pages) => JSON.stringify({ pages });

const NOTES = '# Notes\n\nPlain notes, see [the tool](../scripts/tool.mjs).\n';

// The section as it sits in the README, with a cross-H3 anchor, a repo link,
// a repeated heading, and a link to the intro.
const SECTION = [
  '## Farm Guide',
  '',
  'Start at [the flags](#flags) and [the tool](scripts/tool.mjs).',
  '',
  '### Flags',
  '',
  'Flag text, back to [the top](#farm-guide), on to [later](#later), and the [intro](#vivera).',
  '',
  '---',
  '',
  '### Later',
  '',
  'See [notes](docs/notes.md) or go [up](#farm-guide).',
  '',
  '#### Flags',
  '',
  'Repeated heading.',
  '',
  '---',
  '',
].join('\n');

const README_BEFORE = `# Vivera\n\nIntro text.\n\n${SECTION}`;
const README_AFTER = '# Vivera\n\nIntro text, now with [the guide](docs/guide/farm-1.md).\n';

// The same section written the way docs-gen renders it, split at the "Later" H3.
const PART_1 = [
  '# Farm Guide',
  '',
  'Start at [the flags](#flags) and [the tool](../../scripts/tool.mjs).',
  '',
  '## Flags',
  '',
  'Flag text, back to [the top](#farm-guide), on to [later](farm-2.md#later), and the [intro](../../README.md#vivera).',
  '',
  '---',
  '',
].join('\n');
const PART_2 = [
  '## Later',
  '',
  'See [notes](../notes.md) or go [up](farm-1.md#farm-guide).',
  '',
  '### Flags',
  '',
  'Repeated heading.',
  '',
].join('\n');

const BASE = { 'scripts/tool.mjs': 'export {};\n', 'docs/notes.md': NOTES };

function before() {
  return repo({
    ...BASE,
    'README.md': README_BEFORE,
    'apps/docs/pages.json': map([
      page('intro', { file: 'README.md', heading: '' }),
      page('farm', { file: 'README.md', heading: 'Farm Guide' }),
      page('notes', { file: 'docs/notes.md' }),
    ]),
  });
}

function after(farmSource = { files: ['docs/guide/farm-1.md', 'docs/guide/farm-2.md'] }, extra = {}) {
  return repo({
    ...BASE,
    'README.md': README_AFTER,
    'docs/guide/farm-1.md': PART_1,
    'docs/guide/farm-2.md': PART_2,
    'apps/docs/pages.json': map([
      page('intro', { file: 'README.md', heading: '' }),
      page('farm', farmSource),
      page('notes', { file: 'docs/notes.md' }),
    ]),
    ...extra,
  });
}

const pageOf = (model, key) => model.pages.find((p) => p.key === key);

test('a section split into two files at an H3 renders and hashes the same as the section page', () => {
  const a = buildModel(before());
  const b = buildModel(after());
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  expect(pageOf(b, 'start-farm').body).toBe(pageOf(a, 'start-farm').body);
  expect(pageOf(b, 'start-farm').hash).toBe(pageOf(a, 'start-farm').hash);
  expect(pageOf(b, 'start-farm').linkFindings).toEqual([]);
});

test('an existing single-file page is unchanged next to a multi-file page', () => {
  const a = buildModel(before());
  const b = buildModel(after());
  expect(pageOf(b, 'start-notes').hash).toBe(pageOf(a, 'start-notes').hash);
});

test('a link to a later part of the same page stays an in-page anchor', () => {
  const b = buildModel(after());
  expect(pageOf(b, 'start-farm').body).toContain('[later](#later)');
});

test('source.file and source.files together is an error', () => {
  const m = buildModel(after({ file: 'docs/guide/farm-1.md', files: ['docs/guide/farm-2.md'] }));
  expect(m.errors.join('\n')).toContain('page start-farm: source.file and source.files cannot both be set');
});

test('an empty source.files list is an error', () => {
  const m = buildModel(after({ files: [] }));
  expect(m.errors.join('\n')).toContain('page start-farm: source.files must be a non-empty list of paths');
});

test('a missing file in source.files is an error', () => {
  const m = buildModel(after({ files: ['docs/guide/farm-1.md', 'docs/guide/gone.md'] }));
  expect(m.errors.join('\n')).toContain('page start-farm: source file docs/guide/gone.md does not exist');
});

test('a file used by two pages is an error', () => {
  const root = repo({
    ...BASE,
    'README.md': README_AFTER,
    'docs/guide/farm-1.md': PART_1,
    'docs/guide/farm-2.md': PART_2,
    'apps/docs/pages.json': map([
      page('intro', { file: 'README.md', heading: '' }),
      page('farm', { files: ['docs/guide/farm-1.md', 'docs/guide/farm-2.md'] }),
      page('again', { files: ['docs/guide/farm-2.md'] }),
      page('notes', { file: 'docs/notes.md' }),
    ]),
  });
  const m = buildModel(root);
  expect(m.errors.join('\n')).toContain('page start-again: docs/guide/farm-2.md is already mapped by page start-farm');
});
