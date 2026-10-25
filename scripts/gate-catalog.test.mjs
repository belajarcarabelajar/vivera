import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A skill that asks a gate names its header (header `Design`). The gate
// catalog in sucp-rules reference 07 is the one place that fixes the options
// and the basis of each gate, so a header named in a skill with no catalog
// row is a gate the agent has to invent the options for.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, 'skills');
const CATALOG = path.join(SKILLS, 'sucp-rules', 'references', '07-completion-confirmation.md');

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

function namedHeaders() {
  const named = new Map();
  for (const file of markdownFiles(SKILLS)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/header `([^`]+)`/g)) {
      if (!named.has(m[1])) named.set(m[1], path.relative(ROOT, file));
    }
  }
  return named;
}

function catalogHeaders() {
  const text = fs.readFileSync(CATALOG, 'utf8');
  const start = text.indexOf('| Gate | Header |');
  expect(start).toBeGreaterThanOrEqual(0);
  const rows = text.slice(start).split('\n').filter((l) => l.startsWith('|')).slice(2);
  return new Set(rows.map((r) => r.split('|')[2].trim().replace(/^`|`$/g, '')));
}

test('the catalog table is found and has rows', () => {
  expect(catalogHeaders().size).toBeGreaterThanOrEqual(10);
});

test('every gate header a skill names has a row in the gate catalog', () => {
  const catalog = catalogHeaders();
  const missing = [...namedHeaders()].filter(([h]) => !catalog.has(h)).map(([h, f]) => `${h} (${f})`);
  expect(missing).toEqual([]);
});
