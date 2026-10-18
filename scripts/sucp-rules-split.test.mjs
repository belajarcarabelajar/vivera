import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'sucp-rules');
const INDEX = path.join(SKILL_DIR, 'SKILL.md');
const REFS = path.join(SKILL_DIR, 'references');
const LIMIT = 20000;
const READING_HEADING = '## 📚 Load on demand';

function refNames() {
  return fs.existsSync(REFS) ? fs.readdirSync(REFS).sort() : [];
}

function readingSection(index) {
  const start = index.indexOf(`${READING_HEADING}\n`);
  if (start < 0) return '';
  const rest = index.slice(start + READING_HEADING.length + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// Text preservation (index prefix plus references equal the pre-split SKILL.md, except seven em
// dash punctuation edits) was proven once at the split and recorded as PR evidence. It is not
// pinned here because a pinned revision breaks on every later rules edit and on a shallow clone.
describe('sucp-rules split into an index and references', () => {
  test('the index and every reference file are under 20,000 bytes', () => {
    expect(fs.statSync(INDEX).size).toBeLessThan(LIMIT);
    const names = refNames();
    expect(names.length).toBeGreaterThan(0);
    const oversize = names
      .map((name) => ({ name, size: fs.statSync(path.join(REFS, name)).size }))
      .filter((f) => f.size >= LIMIT);
    expect(oversize).toEqual([]);
  });

  test('references/ holds only .md files', () => {
    const names = refNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !n.endsWith('.md'))).toEqual([]);
  });

  test('the Load on demand table names exactly the reference files, in name order', () => {
    const section = readingSection(fs.readFileSync(INDEX, 'utf8'));
    expect(section).toMatch(/always loaded/);
    const listed = [...section.matchAll(/^\| \[[^\]]*\]\(references\/([^)]+)\)/gm)].map((m) => m[1]);
    expect(listed).toEqual(refNames());
    for (const name of listed) expect(fs.existsSync(path.join(REFS, name))).toBe(true);
  });
});
