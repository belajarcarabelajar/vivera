import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findDocReferences, checkDocReferences } from './doc-references.mjs';

const TICK = '`';
const FENCE = TICK.repeat(3);

function fixture(docText) {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-references-'));
  mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { 'plan:check': 'bun scripts/plan.mjs', 'plan:run': 'x', test: 'bun test' } }),
  );
  writeFileSync(
    path.join(root, 'scripts', 'plan.mjs'),
    "import { parse } from './lib/args.mjs';\nconst dry = argv.includes('--dry-run');\n",
  );
  writeFileSync(path.join(root, 'scripts', 'lib', 'args.mjs'), "export const parse = (a) => a.includes('--json');\n");
  writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), docText);
  return { root, files: ['skills/demo/SKILL.md'] };
}

const run = (docText) => checkDocReferences(fixture(docText));

test('a missing script is a finding', () => {
  const { findings, checked } = run(`Run ${TICK}bun scripts/gone.mjs${TICK} first.\n`);
  expect(checked).toBe(1);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ file: 'skills/demo/SKILL.md', line: 1 });
  expect(findings[0].message).toContain('scripts/gone.mjs');
});

test('a flag present only in an imported lib passes', () => {
  const { findings, checked } = run(`${TICK}bun scripts/plan.mjs --json${TICK}\n`);
  expect(findings).toEqual([]);
  expect(checked).toBe(1);
});

test('an unknown flag is a finding naming the flag', () => {
  const { findings } = run(`x\n${TICK}bun scripts/plan.mjs --dry-run --bogus | head${TICK}\n`);
  expect(findings).toHaveLength(1);
  expect(findings[0].line).toBe(2);
  expect(findings[0].message).toContain('--bogus');
});

test('flags after a shell separator belong to the next command', () => {
  const refs = findDocReferences(`${TICK}bun scripts/plan.mjs --json && ls --all${TICK}`, 'a.md');
  expect(refs).toEqual([{ file: 'a.md', line: 1, kind: 'script', ref: 'scripts/plan.mjs', flags: ['--json'] }]);
});

test('a known npm prefix with a missing name is a finding', () => {
  const { findings, checked } = run(`Use ${TICK}bun run plan:sinc -- --x${TICK}.\n`);
  expect(checked).toBe(1);
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toContain('plan:sinc');
});

test('a known npm name passes after stripping trailing args', () => {
  const { findings, checked } = run(`${TICK}bun run plan:check -- --plan x${TICK}\n`);
  expect(checked).toBe(1);
  expect(findings).toEqual([]);
});

test('an unprefixed generic name and an unknown prefix are skipped', () => {
  const { findings, checked } = run(`${TICK}bun run lint${TICK} and ${TICK}bun run check:terarah${TICK}\n`);
  expect(checked).toBe(0);
  expect(findings).toEqual([]);
});

test('a placeholder such as <plan.md> is skipped', () => {
  const { findings, checked } = run(`${TICK}bun scripts/<plan.md>${TICK} and ${TICK}skills/<name>/SKILL.md${TICK}\n`);
  expect(checked).toBe(0);
  expect(findings).toEqual([]);
});

test('a docs/code-plan path is skipped', () => {
  const { findings, checked } = run(`See ${TICK}docs/code-plan/2026-01-01-x/plan.md${TICK}.\n`);
  expect(checked).toBe(0);
  expect(findings).toEqual([]);
});

test('a json fence is skipped while a bash fence is read', () => {
  const doc = [
    `${FENCE}json`,
    '{"cmd": "bun scripts/gone.mjs"}',
    FENCE,
    `${FENCE}bash`,
    'bun scripts/also-gone.mjs',
    FENCE,
  ].join('\n');
  const { findings, checked } = run(doc);
  expect(checked).toBe(1);
  expect(findings).toHaveLength(1);
  expect(findings[0].line).toBe(5);
  expect(findings[0].message).toContain('scripts/also-gone.mjs');
});

test('a backticked missing path is a finding', () => {
  const { findings, checked } = run(`Read ${TICK}templates/nope.md${TICK} and ${TICK}skills/demo${TICK}.\n`);
  expect(checked).toBe(2);
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toContain('templates/nope.md');
});

test('a fully valid line produces no findings', () => {
  const line = `Run ${TICK}bun scripts/plan.mjs --dry-run --json${TICK}, then ${TICK}bun run plan:run${TICK}, see ${TICK}skills/demo/SKILL.md${TICK}.\n`;
  const { findings, checked } = run(line);
  expect(findings).toEqual([]);
  expect(checked).toBe(3);
});
