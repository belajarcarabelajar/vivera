import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'sucp-rules');
const INDEX = path.join(SKILL_DIR, 'SKILL.md');
const REFS = path.join(SKILL_DIR, 'references');
const CORE_LIMIT = 20000;
const LOAD_HEADING = '## 📚 Load on demand';

function refNames() {
  return fs.readdirSync(REFS).filter((n) => n.endsWith('.md')).sort();
}

function loadSection(index) {
  const start = index.indexOf(`${LOAD_HEADING}\n`);
  if (start < 0) return '';
  const rest = index.slice(start + LOAD_HEADING.length + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// The owner decided on 2026-10-19 (plan pipeline-efficiency, S5) that SKILL.md is an
// always-loaded core and the references are read when their trigger applies.
describe('sucp-rules core plus on-demand references', () => {
  test('the core stays under 20,000 bytes', () => {
    expect(fs.statSync(INDEX).size).toBeLessThan(CORE_LIMIT);
  });

  test('the load table names every reference exactly once and no unknown file', () => {
    const section = loadSection(fs.readFileSync(INDEX, 'utf8'));
    expect(section).not.toBe('');
    const rows = [...section.matchAll(/^\|[^\n]*\(references\/([^)]+)\)[^\n]*$/gm)].map((m) => m[1]);
    const counts = {};
    for (const name of rows) counts[name] = (counts[name] ?? 0) + 1;
    expect(Object.keys(counts).sort()).toEqual(refNames());
    expect(Object.values(counts).every((n) => n === 1)).toBe(true);
  });

  test('no file still says every reference must be read before acting', () => {
    const files = [INDEX, ...refNames().map((n) => path.join(REFS, n))];
    const hits = files.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return text.includes('MUST be read in full') || text.includes('has not loaded this skill');
    });
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  test('the core holds the Git Ownership bullet and the Confirmation Protocol heading', () => {
    const lines = fs.readFileSync(INDEX, 'utf8').split('\n');
    expect(lines.some((l) => l.startsWith('- **Git Ownership Is Parent-Only (Non-Negotiable).**'))).toBe(true);
    expect(lines).toContain('### ⏸️ Confirmation Protocol');
  });
});
