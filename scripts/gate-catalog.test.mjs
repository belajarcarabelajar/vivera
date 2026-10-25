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

// Only names joined directly to the header mention count, so an options list
// later in the same parenthesis (options `A` and `B`) is not read as headers.
function headersInText(text) {
  const names = [];
  for (const m of text.matchAll(/\bheaders?\s+((?:`[^`]+`)(?:(?:\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)`[^`]+`)*)/gi)) {
    for (const n of m[1].matchAll(/`([^`]+)`/g)) names.push(n[1]);
  }
  return names;
}

function catalogRows(text) {
  const start = text.indexOf('| Gate | Header |');
  if (start < 0) return null;
  const lines = text.slice(start).split('\n');
  const end = lines.findIndex((l) => !l.startsWith('|'));
  const rows = lines.slice(2, end < 0 ? lines.length : end);
  return new Set(rows.map((r) => r.split('|')[2].trim().replace(/^`|`$/g, '')));
}

function namedHeaders() {
  const named = new Map();
  for (const file of markdownFiles(SKILLS)) {
    for (const h of headersInText(fs.readFileSync(file, 'utf8'))) {
      if (!named.has(h)) named.set(h, path.relative(ROOT, file));
    }
  }
  return named;
}

function catalogHeaders() {
  const rows = catalogRows(fs.readFileSync(CATALOG, 'utf8'));
  expect(rows).not.toBeNull();
  return rows;
}

test('a header mention collects every name joined by or, and, or commas', () => {
  expect(headersInText('ask (header `Design` or `Bogus`).')).toEqual(['Design', 'Bogus']);
  expect(headersInText('the headers `A` and `B` gate')).toEqual(['A', 'B']);
  expect(headersInText('headers `A`, `B`, and `C`.')).toEqual(['A', 'B', 'C']);
});

test('backticks after a header mention that are not joined names are not collected', () => {
  const line = 'ask (header `Overnight`, options `Start the run (Recommended)` and `Not yet`) now; '
    + 'also (header `Promote`, first option `Keep in the repository only`) and the `Design` or `Plan` gate.';
  expect(headersInText(line)).toEqual(['Overnight', 'Promote']);
});

test('catalog rows stop at the end of the first table', () => {
  const text = [
    '| Gate | Header |',
    '|---|---|',
    '| Design approval | `Design` |',
    '',
    'Later prose.',
    '',
    '| Other | Value |',
    '|---|---|',
    '| x | `Bogus` |',
  ].join('\n');
  expect([...catalogRows(text)]).toEqual(['Design']);
});

test('the catalog table is found and has rows', () => {
  expect(catalogHeaders().size).toBeGreaterThanOrEqual(10);
});

test('every gate header a skill names has a row in the gate catalog', () => {
  const catalog = catalogHeaders();
  const missing = [...namedHeaders()].filter(([h]) => !catalog.has(h)).map(([h, f]) => `${h} (${f})`);
  expect(missing).toEqual([]);
});
