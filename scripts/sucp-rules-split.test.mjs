import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'sucp-rules');
const INDEX = path.join(SKILL_DIR, 'SKILL.md');
const REFS = path.join(SKILL_DIR, 'references');
// The last commit before the split; the moved text is checked against this revision.
const BASE = '1aca06a';
const LIMIT = 20000;
const READING_HEADING = '## 📚 Required reading';

function preSplit() {
  const r = spawnSync('git', ['show', `${BASE}:skills/sucp-rules/SKILL.md`], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git show ${BASE} failed: ${r.stderr}`);
  return r.stdout;
}

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

function isSubsequence(needles, haystack) {
  let j = 0;
  for (const line of haystack) {
    if (j < needles.length && line === needles[j]) j += 1;
  }
  return { ok: j === needles.length, missing: needles[j] };
}

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

  test('every non-blank pre-split line survives in the same relative order', () => {
    const original = preSplit().split('\n').filter((l) => l.trim() !== '');
    const parts = [INDEX, ...refNames().map((n) => path.join(REFS, n))];
    const combined = parts.flatMap((p) => fs.readFileSync(p, 'utf8').split('\n'));
    const result = isSubsequence(original, combined);
    expect(result.missing).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  test('the index prefix plus the references rebuild the pre-split file byte for byte', () => {
    const index = fs.readFileSync(INDEX, 'utf8');
    const cut = index.indexOf(`${READING_HEADING}\n`);
    expect(cut).toBeGreaterThan(0);
    const rebuilt = index.slice(0, cut)
      + refNames().map((n) => fs.readFileSync(path.join(REFS, n), 'utf8')).join('');
    expect(rebuilt === preSplit()).toBe(true);
  });

  test('the Required reading list names exactly the reference files, in name order', () => {
    const section = readingSection(fs.readFileSync(INDEX, 'utf8'));
    expect(section).toMatch(/MUST be read in full, in order, before acting/);
    const listed = [...section.matchAll(/^\d+\. \[[^\]]*\]\(references\/([^)]+)\)/gm)].map((m) => m[1]);
    expect(listed).toEqual(refNames());
    for (const name of listed) expect(fs.existsSync(path.join(REFS, name))).toBe(true);
  });
});
