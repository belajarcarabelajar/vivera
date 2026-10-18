import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORCHESTRATOR = 'Super Ultra Code Plan Implementation.md';

function mdUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdUnder(rel));
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

function corpus() {
  const files = [...mdUnder('skills'), ...mdUnder('templates'), 'README.md', ORCHESTRATOR];
  return files.map((rel) => ({ rel, lines: fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n') }));
}

function hits(re, allow = () => false) {
  const found = [];
  for (const { rel, lines } of corpus()) {
    lines.forEach((line, i) => {
      if (re.test(line) && !allow(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return found;
}

describe('rule files do not contradict each other', () => {
  test('the orchestrator file is part of the corpus', () => {
    expect(corpus().some((f) => f.rel === ORCHESTRATOR)).toBe(true);
  });

  test('no text recommends staging with git add .', () => {
    expect(hits(/git add \. &&|Stage, commit, and push atomically/)).toEqual([]);
  });

  // `pkill -f` and `pgrep -f` match the calling shell's own command line (exit 143/144),
  // so a mention is allowed only when a negation comes before it on the same line.
  test('no rule recommends pkill -f or pgrep -f to stop processes', () => {
    const negatedBefore = (line) => {
      const at = line.search(/p(kill|grep) -f/);
      return /\b(NOT|[Nn]ever|[Dd]o not|forbid\w*)\b/.test(line.slice(0, at));
    };
    expect(hits(/p(kill|grep) -f/, negatedBefore)).toEqual([]);
  });

  test('no fixed fan-out floor wording survives', () => {
    expect(hits(/fan-out floor|10 or more|Ten narrow subagents|10\+ narrow subagents|the 10 floor/i)).toEqual([]);
  });
});
