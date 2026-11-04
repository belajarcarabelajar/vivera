import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as evalHooks from './eval-hooks.mjs';
import { RefusedError, generateFixtures, generateProblem, safeRelative } from './eval-hooks.mjs';

const made = [];
const tmp = (label) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `eval-hooks-${label}-`));
  made.push(d);
  return d;
};
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});


describe('generateProblem', () => {
  test('no generate field and a well-formed spec have no problem', () => {
    expect(generateProblem(undefined)).toBeNull();
    expect(generateProblem({ 'logs/big.log': { lines: 3, template: 'row {i}' } })).toBeNull();
  });

  test('a spec that is not a map of path to spec is a problem', () => {
    expect(generateProblem([])).toBe('generate must be a map of path to {lines, template}');
    expect(generateProblem('x')).toBe('generate must be a map of path to {lines, template}');
    expect(generateProblem(null)).toBe('generate must be a map of path to {lines, template}');
  });

  test('a path that escapes the fixture is a problem', () => {
    expect(generateProblem({ '../out.txt': { lines: 1, template: 'a' } })).toBe('generate path escapes the fixture: ../out.txt');
    expect(generateProblem({ '/etc/x': { lines: 1, template: 'a' } })).toBe('generate path escapes the fixture: /etc/x');
  });

  test('lines must be a positive integer and template a string', () => {
    expect(generateProblem({ 'a.txt': { lines: 0, template: 'a' } })).toBe('generate a.txt: lines must be a positive integer');
    expect(generateProblem({ 'a.txt': { lines: 1.5, template: 'a' } })).toBe('generate a.txt: lines must be a positive integer');
    expect(generateProblem({ 'a.txt': { lines: 2 } })).toBe('generate a.txt: template must be a string');
  });
});

describe('generateFixtures', () => {
  test('writes one line per index with {i} counted from 1, creating parent directories', () => {
    const dest = tmp('gen');
    generateFixtures(dest, { 'logs/big.log': { lines: 3, template: 'row {i} of {i}' } });
    expect(fs.readFileSync(path.join(dest, 'logs', 'big.log'), 'utf8')).toBe('row 1 of 1\nrow 2 of 2\nrow 3 of 3\n');
  });

  test('the same spec writes the same bytes on every run', () => {
    const spec = { 'a.txt': { lines: 500, template: 'line {i}: lorem ipsum' } };
    const a = tmp('gen-a');
    const b = tmp('gen-b');
    generateFixtures(a, spec);
    generateFixtures(b, spec);
    expect(fs.readFileSync(path.join(a, 'a.txt'))).toEqual(fs.readFileSync(path.join(b, 'a.txt')));
    expect(fs.statSync(path.join(a, 'a.txt')).size).toBe(10892);
  });

  test('no spec writes nothing', () => {
    const dest = tmp('gen-none');
    generateFixtures(dest, undefined);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  test('a path that escapes the fixture is refused and nothing lands outside it', () => {
    const parent = tmp('gen-escape');
    const dest = path.join(parent, 'project');
    fs.mkdirSync(dest);
    expect(() => generateFixtures(dest, { '../outside.txt': { lines: 1, template: 'x' } })).toThrow(RefusedError);
    expect(fs.existsSync(path.join(parent, 'outside.txt'))).toBe(false);
  });

  test('safeRelative keeps the overlay refusal message', () => {
    expect(() => safeRelative('../x')).toThrow('refused: overlay path escapes the fixture: ../x');
    expect(safeRelative('a/./b')).toBe(path.join('a', 'b'));
  });
});

// The runner end to end with a stub claude, as in scripts/eval-run.test.mjs.
const SCRIPT = path.join(import.meta.dir, '..', 'eval-run.mjs');
const STREAMS = path.join(import.meta.dir, '..', '..', 'evals', 'fixtures', 'streams');
const GATE = [{ type: 'fixture_unchanged' }, { type: 'final_options', min: 2 }];

function cli(scenario, ...args) {
  const root = fs.mkdtempSync('/tmp/eval-hooks-cli-');
  made.push(root);
  const scenDir = path.join(root, 'evals', 'scenarios');
  const fixDir = path.join(root, 'evals', 'fixtures', 'tiny');
  fs.mkdirSync(scenDir, { recursive: true });
  fs.mkdirSync(fixDir, { recursive: true });
  fs.writeFileSync(path.join(fixDir, 'math.mjs'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(scenDir, 'a.json'), JSON.stringify({ id: 'a', fixture: 'tiny', max_turns: 4, permission_mode: 'dontAsk', prompt: 'ask', assertions: GATE, ...scenario }));
  const log = path.join(root, 'stub.log');
  const stub = path.join(root, 'claude-stub.sh');
  fs.writeFileSync(stub, `#!/bin/sh\necho "SETTINGS $(ls .claude/settings.json 2>/dev/null)" >> "${log}"\ncat "${STREAMS}/ask.jsonl"\n`, { mode: 0o755 });
  const runs = path.join(root, 'runs');
  const env = { ...process.env, EVAL_CLAUDE_BIN: stub, EVAL_TMP_ROOT: runs };
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', scenDir, '--no-sandbox', '--repeat', '1', '--keep', '--out', path.join(root, 'o.json'), ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const kept = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  const project = kept.length ? path.join(runs, kept[0], '01', 'project') : null;
  const tracked = project ? spawnSync('git', ['ls-files'], { cwd: project, encoding: 'utf8' }).stdout.split('\n') : [];
  return { code: r.status, out: r.stdout, err: r.stderr, project, tracked, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

describe('eval-run cli', () => {
  test('with-hook is gone', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--list', '--with-hook', 'context'], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument: --with-hook');
    expect(r.stderr).not.toContain('[--with-hook');
    expect(typeof evalHooks.generateFixtures).toBe('function');
    expect(Object.keys(evalHooks)).not.toContain('installHooks');
    expect(Object.keys(evalHooks)).not.toContain('hookSet');
  });

  test('the fixture has no project settings', () => {
    const r = cli({});
    expect(r.code).toBe(0);
    expect(r.log).toBe('SETTINGS \n');
    expect(fs.existsSync(path.join(r.project, '.claude', 'hooks'))).toBe(false);
  });

  test('a scenario generate map writes its files into the committed fixture', () => {
    const r = cli({ generate: { 'logs/big.log': { lines: 2, template: 'row {i}' } } });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(r.project, 'logs', 'big.log'), 'utf8')).toBe('row 1\nrow 2\n');
    expect(r.tracked).toContain('logs/big.log');
  });

  test('a generate path that escapes the fixture exits 2 before any run', () => {
    const r = cli({ generate: { '../x.txt': { lines: 1, template: 'x' } } });
    expect(r.code).toBe(2);
    expect(r.err).toContain('a.json: generate path escapes the fixture: ../x.txt');
    expect(r.log).toBe('');
  });

  test('a generated .claude/settings.json is refused like an overlay one', () => {
    const r = cli({ generate: { '.claude/settings.json': { lines: 1, template: '{}' } } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/a\s+FAIL.*settings/);
    expect(r.log).toBe('');
  });
});
