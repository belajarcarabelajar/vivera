import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RefusedError, generateFixtures, generateProblem, hookSet, installHooks, safeRelative } from './eval-hooks.mjs';
import { installEntries } from '../context-hooks-install.mjs';

const made = [];
const tmp = (label) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `eval-hooks-${label}-`));
  made.push(d);
  return d;
};
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

class Usage extends Error {}

// Stub sources in the repository layout: hooks import the shared library one level up.
function stubSource() {
  const src = tmp('src');
  fs.mkdirSync(path.join(src, 'lib'));
  fs.mkdirSync(path.join(src, 'hooks'));
  fs.writeFileSync(path.join(src, 'lib', 'hook-io.mjs'), "export const tag = 'stub-io';\n");
  for (const f of ['output-cap.mjs', 'output-replace.mjs', 'session-journal.mjs']) {
    fs.writeFileSync(path.join(src, 'hooks', f), `import { tag } from '../lib/hook-io.mjs';\nconsole.log([tag, '${f}', process.argv[2] ?? '', process.env.VIVERA_HOOK_STATE_DIR, process.env.VIVERA_HOOK_SCRATCH_DIR].join('|'));\n`);
  }
  return src;
}

const ENV = 'VIVERA_HOOK_STATE_DIR="$CLAUDE_PROJECT_DIR/../hook-state" VIVERA_HOOK_SCRATCH_DIR="$CLAUDE_PROJECT_DIR/../hook-scratch"';
const cmd = (file, mode) => `${ENV} "$HOME/.bun/bin/bun" "$CLAUDE_PROJECT_DIR/.claude/hooks/hooks/${file}"${mode ? ` ${mode}` : ''}`;
const entry = (matcher, file, mode) => ({ matcher, hooks: [{ type: 'command', command: cmd(file, mode), timeout: 10 }] });

describe('hookSet', () => {
  test('accepts the context set', () => {
    expect(hookSet('context', Usage)).toBe('context');
  });

  test('an unknown set is a usage error naming the allowed sets', () => {
    expect(() => hookSet('graphify', Usage)).toThrow(Usage);
    expect(() => hookSet('graphify', Usage)).toThrow(/--with-hook must be one of: context/);
  });
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

describe('installHooks', () => {
  test('copies the hook library and the three hooks, keeping the hooks/ and lib/ layout', () => {
    const dest = tmp('inst');
    installHooks(dest, 'context', { sourceDir: stubSource() });
    const base = path.join(dest, '.claude', 'hooks');
    expect(fs.readdirSync(path.join(base, 'hooks')).sort()).toEqual(['output-cap.mjs', 'output-replace.mjs', 'session-journal.mjs']);
    expect(fs.readdirSync(path.join(base, 'lib'))).toEqual(['hook-io.mjs']);
  });

  test('writes project settings with the five context entries', () => {
    const dest = tmp('inst-settings');
    installHooks(dest, 'context', { sourceDir: stubSource() });
    const settings = JSON.parse(fs.readFileSync(path.join(dest, '.claude', 'settings.json'), 'utf8'));
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [entry('^Read$', 'output-cap.mjs')],
        PostToolUse: [entry('^(Bash|mcp__.*)$', 'output-replace.mjs'), entry('^(Edit|Write|NotebookEdit)$', 'session-journal.mjs', 'record')],
        PostToolUseFailure: [entry('^Bash$', 'session-journal.mjs', 'record')],
        SessionStart: [entry('compact', 'session-journal.mjs', 'inject')],
      },
    });
  });

  test('installs the same entries as the context hooks installer, apart from the command prefix', () => {
    const dest = tmp('inst-parity');
    installHooks(dest, 'context', { sourceDir: stubSource() });
    const evalHooks = JSON.parse(fs.readFileSync(path.join(dest, '.claude', 'settings.json'), 'utf8')).hooks;
    const installed = installEntries({}, '/repo/scripts/hooks', '/bin/bun').hooks;
    // Keep only the hook file and its mode argument, the part both commands share.
    const strip = (hooks) => Object.fromEntries(Object.entries(hooks).map(([event, list]) => [event, list.map((e) => ({
      ...e,
      hooks: e.hooks.map((h) => ({ ...h, command: h.command.replace(/^.*\/hooks\/([\w.-]+)"/, '$1') })),
    }))]));
    expect(strip(evalHooks)).toEqual(strip(installed));
    expect(strip(evalHooks).SessionStart[0].hooks[0].command).toBe('session-journal.mjs inject');
  });

  test('a settings command runs the copied hook, its relative import resolves, and state sits beside the project', () => {
    const run = tmp('inst-run');
    const dest = path.join(run, 'project');
    fs.mkdirSync(dest);
    installHooks(dest, 'context', { sourceDir: stubSource() });
    const settings = JSON.parse(fs.readFileSync(path.join(dest, '.claude', 'settings.json'), 'utf8'));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    const r = spawnSync('bash', ['-c', command], { env: { PATH: process.env.PATH, HOME: os.homedir(), CLAUDE_PROJECT_DIR: dest }, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe(`stub-io|session-journal.mjs|inject|${dest}/../hook-state|${dest}/../hook-scratch`);
  });

  test('an unknown set is refused and writes nothing', () => {
    const dest = tmp('inst-unknown');
    expect(() => installHooks(dest, 'graphify', { sourceDir: stubSource() })).toThrow(/unknown hook set: graphify/);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  test('a missing hook source fails before any settings are written', () => {
    const dest = tmp('inst-missing');
    const src = stubSource();
    fs.rmSync(path.join(src, 'hooks', 'output-replace.mjs'));
    expect(() => installHooks(dest, 'context', { sourceDir: src })).toThrow(/output-replace\.mjs/);
    expect(fs.existsSync(path.join(dest, '.claude', 'settings.json'))).toBe(false);
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
  const env = { ...process.env, EVAL_CLAUDE_BIN: stub, EVAL_TMP_ROOT: runs, EVAL_HOOKS_SRC: stubSource() };
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', scenDir, '--no-sandbox', '--repeat', '1', '--keep', '--out', path.join(root, 'o.json'), ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const kept = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
  const project = kept.length ? path.join(runs, kept[0], '01', 'project') : null;
  const tracked = project ? spawnSync('git', ['ls-files'], { cwd: project, encoding: 'utf8' }).stdout.split('\n') : [];
  return { code: r.status, out: r.stdout, err: r.stderr, project, tracked, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

describe('eval-run cli', () => {
  test('--with-hook with an unknown set exits 2 before any run', () => {
    const r = cli({}, '--with-hook', 'graphify');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--with-hook must be one of: context');
    expect(r.err).toContain('[--with-hook context]');
    expect(r.log).toBe('');
  });

  test('--with-hook context installs the hooks and settings before claude runs, committed with the fixture', () => {
    const r = cli({}, '--with-hook', 'context');
    expect(r.code).toBe(0);
    expect(r.log).toBe('SETTINGS .claude/settings.json\n');
    expect(r.tracked).toContain('.claude/settings.json');
    expect(r.tracked).toContain('.claude/hooks/hooks/output-cap.mjs');
    expect(r.tracked).toContain('.claude/hooks/lib/hook-io.mjs');
  });

  test('without --with-hook the fixture has no project settings', () => {
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
