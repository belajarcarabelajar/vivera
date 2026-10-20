import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RUNNER = path.join(import.meta.dirname, 'ultra-plan-runner.mjs');

// The size gate's default limit is 20000 bytes; sizes below are chosen against it.
const PLAN = `---
schema: ultra-plan/v1
plan_id: 2026-10-20-size-warn-demo
status: Approved
version: 1
runner_contract: true
tasks:
  - id: T1
    depends_on: []
    impacts: ["demo - test -f ./plan.md"]
    files: { create: [], modify: [src/near.mjs, src/half.mjs], test: [] }
    idempotency_key: "T1:near"
    verify_exit: 0
    run:
      - cmd: "test -f ./plan.md"
        expect_exit: 0
  - id: T2
    depends_on: [T1]
    impacts: ["demo - test -f ./plan.md"]
    files: { create: [], modify: [src/capped.mjs, src/missing.mjs, src/grown.mjs, src/big.mjs], test: [] }
    idempotency_key: "T2:capped"
    verify_exit: 0
    run:
      - cmd: "test -f ./plan.md"
        expect_exit: 0
---
# Size warn demo

### Task T1: near the limit
### Task T2: at its ceiling

\`\`\`mermaid
flowchart TD
    T1["T1: near"] --> T2["T2: capped"]
\`\`\`
`;

let dir;
let result;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'runner-size-warn-'));
  mkdirSync(path.join(dir, 'src'));
  mkdirSync(path.join(dir, 'scripts'));
  writeFileSync(path.join(dir, 'src/near.mjs'), 'x'.repeat(19000));
  writeFileSync(path.join(dir, 'src/half.mjs'), 'x'.repeat(10000));
  writeFileSync(path.join(dir, 'src/capped.mjs'), 'x'.repeat(25000));
  writeFileSync(path.join(dir, 'src/grown.mjs'), 'x'.repeat(26000));
  writeFileSync(path.join(dir, 'src/big.mjs'), 'x'.repeat(21000));
  writeFileSync(path.join(dir, 'scripts/file-size-baseline.json'), '{\n  "src/capped.mjs": 25000,\n  "src/grown.mjs": 25000\n}\n');
  writeFileSync(path.join(dir, 'plan.md'), PLAN);
  const r = spawnSync(process.execPath, [RUNNER, 'plan.md'], { cwd: dir, encoding: 'utf8' });
  result = { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const warnLines = () => result.out.split('\n').filter((l) => l.includes('WARN:'));
const warnFor = (p) => warnLines().filter((l) => l.includes(p));

test('validation still passes with exit 0 when files are near the size gate', () => {
  expect(result.out).toContain('Validation: OK');
  expect(result.code).toBe(0);
});

test('a modified file at 95% of the default limit gets one WARN line naming task, bytes, limit and L79', () => {
  const lines = warnFor('src/near.mjs');
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('T1');
  expect(lines[0]).toContain('19000');
  expect(lines[0]).toContain('20000');
  expect(lines[0]).toContain('MEMORY.md L79');
});

test('a modified file at 50% of the default limit gets no WARN line', () => {
  expect(warnFor('src/half.mjs')).toEqual([]);
});

test('a modified file at its recorded ceiling is warned as at its ceiling', () => {
  const lines = warnFor('src/capped.mjs');
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('T2');
  expect(lines[0]).toContain('25000');
  expect(lines[0]).toMatch(/ceiling/);
  expect(lines[0]).toContain('MEMORY.md L79');
});

test('a modified file past its ceiling says over instead of a percentage', () => {
  const lines = warnFor('src/grown.mjs');
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('26000 bytes, over its ceiling 25000 bytes');
  expect(lines[0]).not.toContain('%');
});

test('a modified file past the default limit with no ceiling says over the default limit', () => {
  const lines = warnFor('src/big.mjs');
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('21000 bytes, over the default limit 20000 bytes');
  expect(lines[0]).not.toContain('%');
});

test('a modified path that does not exist yet gets no WARN line', () => {
  expect(warnFor('src/missing.mjs')).toEqual([]);
});

test('size WARN lines print before Validation: OK', () => {
  const okAt = result.out.indexOf('Validation: OK');
  expect(result.out.indexOf('src/near.mjs')).toBeGreaterThan(-1);
  expect(result.out.indexOf('src/near.mjs')).toBeLessThan(okAt);
  expect(result.out.indexOf('src/capped.mjs')).toBeGreaterThan(-1);
  expect(result.out.indexOf('src/capped.mjs')).toBeLessThan(okAt);
});
