// scripts/docs-gen-id.test.mjs
//
// Continuation parts of an Indonesian twin page (`<name>.2.md`, `<name>.3.md`).
// The single-file twin checks (missing, stale, no EN page, em dash) are covered
// end to end in docs-gen.test.mjs; these tests call idFindings directly.
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ID_DIR, idFindings, partOf } from './lib/docs-gen-id.mjs';

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const MODEL = { pages: [{ name: 'tooling-zeta.md', hash: 'aaaaaaaaaaaa' }] };
const BASE = '---\ntitle: Zeta\nsource_hash: "aaaaaaaaaaaa"\n---\n\n# Zeta\n';

function idDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-gen-id-'));
  roots.push(root);
  const dir = path.join(root, ID_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return root;
}

describe('partOf', () => {
  test('reads a continuation name and nothing else', () => {
    expect(partOf('tooling-zeta.2.md')).toEqual({ base: 'tooling-zeta.md', n: 2 });
    expect(partOf('tooling-zeta.12.md')).toEqual({ base: 'tooling-zeta.md', n: 12 });
    expect(partOf('tooling-zeta.md')).toBeNull();
    expect(partOf('tooling-zeta-2.md')).toBeNull();
    expect(partOf('tooling-zeta.x.md')).toBeNull();
    expect(partOf('.2.md')).toBeNull();
  });
});

describe('idFindings with continuation parts', () => {
  test('a base page with contiguous parts is clean', () => {
    const root = idDir({ 'tooling-zeta.md': BASE, 'tooling-zeta.2.md': '## Dua\n', 'tooling-zeta.3.md': '## Tiga\n' });
    expect(idFindings(MODEL, root)).toEqual([]);
  });

  test('a part is not reported as an ID page without an EN page', () => {
    const root = idDir({ 'tooling-zeta.md': BASE, 'tooling-zeta.2.md': '## Dua\n' });
    expect(idFindings(MODEL, root).join('\n')).not.toContain('has no EN page');
  });

  test('a part alone does not count as the ID page', () => {
    const root = idDir({ 'tooling-zeta.2.md': '## Dua\n' });
    const findings = idFindings(MODEL, root);
    expect(findings).toContain(`${ID_DIR}/tooling-zeta.md: missing ID page`);
    expect(findings).toContain(`${ID_DIR}/tooling-zeta.2.md: continuation part has no base page tooling-zeta.md`);
  });

  test('a gap in the part numbers names the first missing part', () => {
    const root = idDir({ 'tooling-zeta.md': BASE, 'tooling-zeta.3.md': '## Tiga\n', 'tooling-zeta.4.md': '## Empat\n' });
    expect(idFindings(MODEL, root)).toEqual([
      `${ID_DIR}/tooling-zeta.3.md: is part 3, but part 2 of tooling-zeta.md is missing`,
    ]);
  });

  test('a part with frontmatter is reported', () => {
    const root = idDir({ 'tooling-zeta.md': BASE, 'tooling-zeta.2.md': BASE });
    expect(idFindings(MODEL, root)).toContain(
      `${ID_DIR}/tooling-zeta.2.md: continuation part has frontmatter; it belongs to the base page`,
    );
  });

  test('an em dash in a part is reported with the part and line', () => {
    const root = idDir({ 'tooling-zeta.md': BASE, 'tooling-zeta.2.md': '## Dua\n\nsatu — dua\n' });
    expect(idFindings(MODEL, root)).toEqual([`${ID_DIR}/tooling-zeta.2.md:3: em dash (U+2014)`]);
  });

  test('a stale base is still reported when it has parts', () => {
    const root = idDir({ 'tooling-zeta.md': BASE.replace('aaaaaaaaaaaa', 'bbbbbbbbbbbb'), 'tooling-zeta.2.md': '## Dua\n' });
    expect(idFindings(MODEL, root)).toEqual([
      `${ID_DIR}/tooling-zeta.md: stale ID page (source_hash bbbbbbbbbbbb, EN aaaaaaaaaaaa)`,
    ]);
  });
});
