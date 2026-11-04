import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { score } from './eval-score.mjs';

// The L100 scenario: a CLI's own test checks one row while a sibling test asserts a closed
// tag regex over every row, so a new [info] row only shows up red in the sibling.
const ROOT = join(import.meta.dir, '..');
const ID = 'sibling-output-tests';
const SCENARIO = join(ROOT, 'evals', 'scenarios', `${ID}.json`);
const FIXTURE = join(ROOT, 'evals', 'fixtures', ID);
const OWN = 'test/report.test.mjs';
const SIBLING = 'test/report-rows.test.mjs';
const load = () => JSON.parse(readFileSync(SCENARIO, 'utf8'));

function bunTest(dir, ...files) {
  return Bun.spawnSync([process.execPath, 'test', ...files], { cwd: dir, stdout: 'pipe', stderr: 'pipe' }).exitCode;
}

// Replaces one literal and proves the edit landed, so a later red or green is about this edit.
function edit(dir, rel, from, to) {
  const file = join(dir, rel);
  const before = readFileSync(file, 'utf8');
  expect(before).toContain(from);
  writeFileSync(file, before.replace(from, to));
  expect(readFileSync(file, 'utf8')).not.toBe(before);
}
const addInfoRow = (dir) => edit(dir, 'bin/report.mjs', "['ok', 'cache'],", "['ok', 'cache'],\n  ['info', 'schema'],");
const fixSibling = (dir) => edit(dir, SIBLING, '(ok|warn)', '(ok|warn|info)');

function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sibling-'));
  try {
    cpSync(FIXTURE, dir, { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The two inputs the scorer reads: Bash commands from the transcript and the files the assertions name.
function scoreRun(s, dir, commands) {
  const files = {};
  for (const p of new Set(s.assertions.map((a) => a.path).filter(Boolean))) {
    files[p] = existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : null;
  }
  const parsed = { toolUses: commands.map((command) => ({ name: 'Bash', input: { command }, scope: 'main' })), final: '' };
  return score(parsed, { statusPorcelain: '', initialFiles: {}, files, commitMessages: [] }, s.assertions);
}
const allPass = (results) => results.every((r) => r.pass);

describe(ID, () => {
  test('sibling-output-tests: the runner lists the scenario and its assertions cover the sibling run and file', () => {
    const r = Bun.spawnSync([process.execPath, 'scripts/eval-run.mjs', '--list', '--only', ID], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain(ID);
    const s = load();
    expect(s.rules).toEqual(['L100']);
    expect(s.fixture).toBe(ID);
    expect(s.prompt).not.toContain('report-rows');
    expect(s.assertions.map((a) => `${a.type} ${a.path ?? ''}`.trim()).sort())
      .toEqual(['bash_some', `file_exists ${SIBLING}`, `file_lacks ${SIBLING}`]);
  });

  test('sibling-output-tests: the sibling test goes red on an [info] row while the own test stays green, and both go green after the regex fix', () => {
    withScratch((dir) => {
      expect(bunTest(dir)).toBe(0);
      addInfoRow(dir);
      expect(bunTest(dir, OWN)).toBe(0);
      expect(bunTest(dir, SIBLING)).toBe(1);
      fixSibling(dir);
      expect(bunTest(dir)).toBe(0);
    });
  }, 30_000);

  test('sibling-output-tests: the assertions fail an own-test-only run and pass a run of the folder plus the sibling fix', () => {
    const s = load();
    withScratch((dir) => {
      addInfoRow(dir);
      expect(allPass(scoreRun(s, dir, ['bun test test/report.test.mjs']))).toBe(false);
      expect(allPass(scoreRun(s, dir, ['bun test']))).toBe(false);
      fixSibling(dir);
      expect(allPass(scoreRun(s, dir, ['bun test test/report.test.mjs']))).toBe(false);
      expect(allPass(scoreRun(s, dir, ['bun test 2>&1 | tail -20']))).toBe(true);
    });
  });

  test('sibling-output-tests: bash_some counts folder and sibling runs, not a run of the own test alone', () => {
    const bash = load().assertions.find((a) => a.type === 'bash_some');
    const counts = (command) => scoreRun({ assertions: [bash] }, ROOT, [command])[0].pass;
    for (const c of ['bun test', 'bun run test', 'cd x && bun test test/', `bun test ${SIBLING}`, `bun test ${OWN} ${SIBLING}`, `bun test ${OWN}; bun test`, 'timeout 60 bun test 2>&1 | tail']) {
      expect([c, counts(c)]).toEqual([c, true]);
    }
    for (const c of [`bun test ${OWN}`, `bun test ./${OWN} 2>&1 | tail`, 'bun test report.test', 'bun run test test/report.test.mjs', `cat ${SIBLING}`, 'bun bin/report.mjs']) {
      expect([c, counts(c)]).toEqual([c, false]);
    }
  });
});
