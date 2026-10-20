// scripts/memory-index.test.mjs
//
// MEMORY.md is an index of the rule handbook: each topic row links one file under
// docs/memory/ and lists the rule IDs that file holds. These tests keep the index
// and the topic files in step, and keep each topic file under the size gate.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMIT_BYTES } from './check-file-size.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE_ROW = /^\| (L\d+) \|/gm;
const num = (id) => Number(id.slice(1));

// memory: the MEMORY.md text; topics: { 'docs/memory/<file>.md': text }. Returns the problems found.
function checkMemoryIndex({ memory, topics }) {
  const problems = [];
  for (const [, id] of memory.matchAll(RULE_ROW)) problems.push(`rule row ${id} is still in MEMORY.md`);
  const listed = new Map();
  for (const line of memory.split('\n')) {
    const link = line.match(/^\|.*\]\((docs\/memory\/[\w-]+\.md)\)/);
    if (!link) continue;
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    for (const id of cells[cells.length - 1].match(/L\d+/g) ?? []) {
      if (listed.has(id)) problems.push(`${id} is listed twice in the index`);
      else listed.set(id, link[1]);
    }
  }
  const held = new Map();
  for (const [file, text] of Object.entries(topics)) {
    const bytes = Buffer.byteLength(text);
    if (bytes >= LIMIT_BYTES) problems.push(`${file} is ${bytes} bytes, at or over LIMIT_BYTES (${LIMIT_BYTES})`);
    for (const [, id] of text.matchAll(RULE_ROW)) {
      if (held.has(id)) problems.push(`${id} is held by ${held.get(id)} and ${file}`);
      else held.set(id, file);
    }
  }
  for (const [id, file] of listed) {
    if (held.get(id) !== file) problems.push(`${id} is listed under ${file}, which does not hold it`);
  }
  for (const id of held.keys()) if (!listed.has(id)) problems.push(`${id} is missing from the index`);
  const max = Math.max(0, ...[...held.keys(), ...listed.keys()].map(num));
  for (let n = 1; n <= max; n++) {
    if (!held.has(`L${n}`) && !listed.has(`L${n}`)) problems.push(`L${n} is a gap: IDs run from L1 to L${max}`);
  }
  return problems;
}

const row = (id) => `| ${id} | WHEN x → DO y, NOT z | s |`;
const topic = (...ids) => ['# T', '', '| # | Rule | Origin session |', '|---|---|---|', ...ids.map(row), ''].join('\n');
const index = (rows) => ['# MEMORY.md', '', '| Topic | File | Rules |', '|---|---|---|',
  ...rows.map(([file, ids]) => `| ${file} | [docs/memory/${file}.md](docs/memory/${file}.md) | ${ids} |`), ''].join('\n');
const valid = () => ({
  memory: index([['a', 'L1, L2'], ['b', 'L3']]),
  topics: { 'docs/memory/a.md': topic('L1', 'L2'), 'docs/memory/b.md': topic('L3') },
});

describe('checkMemoryIndex fixtures', () => {
  test('an index that matches its topic files has no problems', () => {
    expect(checkMemoryIndex(valid())).toEqual([]);
  });

  test('an ID a topic file holds but the index does not list is missing', () => {
    const f = valid();
    f.memory = index([['a', 'L1'], ['b', 'L3']]);
    expect(checkMemoryIndex(f)).toEqual(['L2 is missing from the index']);
  });

  test('an ID listed twice in the index is reported', () => {
    const f = valid();
    f.memory = index([['a', 'L1, L2'], ['b', 'L3, L2']]);
    expect(checkMemoryIndex(f)).toEqual(['L2 is listed twice in the index']);
  });

  test('an ID listed under a file that does not hold it is reported', () => {
    const f = valid();
    f.memory = index([['a', 'L1'], ['b', 'L2, L3']]);
    expect(checkMemoryIndex(f)).toEqual(['L2 is listed under docs/memory/b.md, which does not hold it']);
  });

  test('an ID held by two topic files is reported', () => {
    const f = valid();
    f.topics['docs/memory/b.md'] = topic('L2', 'L3');
    expect(checkMemoryIndex(f)).toEqual(['L2 is held by docs/memory/a.md and docs/memory/b.md']);
  });

  test('a gap between L1 and the highest ID is reported', () => {
    const f = {
      memory: index([['a', 'L1, L2'], ['b', 'L4']]),
      topics: { 'docs/memory/a.md': topic('L1', 'L2'), 'docs/memory/b.md': topic('L4') },
    };
    expect(checkMemoryIndex(f)).toEqual(['L3 is a gap: IDs run from L1 to L4']);
  });

  test('a rule row left in MEMORY.md is reported', () => {
    const f = valid();
    f.memory += `${row('L9')}\n`;
    expect(checkMemoryIndex(f)).toContain('rule row L9 is still in MEMORY.md');
  });

  // Padded by bytes: the arrow in a rule row is three bytes but one string unit.
  const sized = (bytes) => topic('L3') + 'x'.repeat(bytes - Buffer.byteLength(topic('L3')));

  test('a topic file at the size limit is reported', () => {
    const f = valid();
    f.topics['docs/memory/b.md'] = sized(20000);
    expect(checkMemoryIndex(f)).toEqual(['docs/memory/b.md is 20000 bytes, at or over LIMIT_BYTES (20000)']);
  });

  test('a topic file one byte under the size limit passes', () => {
    const f = valid();
    f.topics['docs/memory/b.md'] = sized(19999);
    expect(checkMemoryIndex(f)).toEqual([]);
  });
});

describe('the real handbook', () => {
  test('MEMORY.md indexes every rule in docs/memory/ and no rule row is left in it', () => {
    const dir = path.join(ROOT, 'docs', 'memory');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
    const topics = Object.fromEntries(files.map((f) => [`docs/memory/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')]));
    expect(checkMemoryIndex({ memory: fs.readFileSync(path.join(ROOT, 'MEMORY.md'), 'utf8'), topics })).toEqual([]);
    expect(files).toEqual(['gates-and-tests.md', 'git-and-delivery.md', 'other-repositories.md', 'plans-and-approvals.md', 'subagents.md', 'tools-and-environment.md']);
  });
});
