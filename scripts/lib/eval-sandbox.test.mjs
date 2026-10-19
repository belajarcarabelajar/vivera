import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bwrapArgs } from './eval-sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'eval-run.mjs');
const ASK = path.join(HERE, '..', '..', 'evals', 'fixtures', 'streams', 'ask.jsonl');
const roots = [];
afterEach(() => {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// One gate scenario through the real runner with a claude stub. The fake bwrap logs
// its options and runs the command after `--` unisolated: the real one hides /tmp,
// where the stub lives.
function runWith(bwrap, ...args) {
  const root = fs.mkdtempSync('/tmp/eval-sandbox-');
  roots.push(root);
  const log = path.join(root, 'log');
  fs.mkdirSync(path.join(root, 'evals', 'scenarios'), { recursive: true });
  fs.mkdirSync(path.join(root, 'evals', 'fixtures', 'tiny'), { recursive: true });
  fs.writeFileSync(path.join(root, 'evals', 'fixtures', 'tiny', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'evals', 'scenarios', 'gate-a.json'), JSON.stringify({ id: 'gate-a', prompt: 'ask', fixture: 'tiny',
    max_turns: 4, permission_mode: 'dontAsk', assertions: [{ type: 'fixture_unchanged' }, { type: 'final_options', min: 2 }] }));
  const cfg = path.join(root, 'host-config');
  fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, '.credentials.json'), 'fake-credentials');
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{}');
  const showCfg = 'echo "CFG $CLAUDE_CONFIG_DIR $(stat -c %a "$CLAUDE_CONFIG_DIR/.credentials.json") $(cat "$CLAUDE_CONFIG_DIR/.credentials.json")"';
  fs.writeFileSync(path.join(root, 'claude'), `#!/bin/sh\necho "RUN $(pwd)" >> "${log}"\n{ ${showCfg}; echo "FILES $(ls -A "$CLAUDE_CONFIG_DIR")"; echo "BUNCACHE $BUN_INSTALL_CACHE_DIR"; } >> "${log}" 2>&1\ncat "${ASK}"\n`, { mode: 0o755 });
  const fake = path.join(root, 'bwrap');
  fs.writeFileSync(fake, `#!/bin/sh\necho "BWRAP $*" >> "${log}"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', path.join(root, 'evals', 'scenarios'), '--out', path.join(root, 'o.json'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, EVAL_CLAUDE_BIN: path.join(root, 'claude'), EVAL_TMP_ROOT: path.join(root, 'runs'), EVAL_BWRAP: bwrap === 'fake' ? fake : bwrap, CLAUDE_CONFIG_DIR: cfg },
  });
  return { code: r.status, err: r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

describe('eval-run sandbox', () => {
  test('the claude command runs inside bwrap, which binds the run dir writable', () => {
    const r = runWith('fake');
    const runDir = path.dirname(path.dirname(r.log.match(/^RUN (.*)$/m)[1]));
    expect(r.code).toBe(0);
    expect(r.log).toMatch(new RegExp(`^BWRAP --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp .* --bind ${runDir} ${runDir} --unshare-pid`, 'm'));
  });

  test('a sandboxed run gets its own config dir holding only a 600 copy of the credentials', () => {
    const r = runWith('fake');
    const runDir = path.dirname(path.dirname(r.log.match(/^RUN (.*)$/m)[1]));
    expect(r.log).toContain(`CFG ${runDir}/claude-config 600 fake-credentials\nFILES .credentials.json\n`);
    expect(r.log).toContain(`--tmpfs /tmp --tmpfs ${process.env.HOME} `);
  });

  test('a sandboxed run points the bun install cache into the run dir, since ~/.bun is read-only', () => {
    const r = runWith('fake');
    const runDir = path.dirname(path.dirname(r.log.match(/^RUN (.*)$/m)[1]));
    expect(r.log).toContain(`BUNCACHE ${runDir}/bun-cache\n`);
  });

  test('--no-sandbox runs claude without bwrap', () => {
    const r = runWith('fake', '--no-sandbox');
    expect([r.code, r.log.includes('RUN'), r.log.includes('BWRAP')]).toEqual([0, true, false]);
  });

  test('without bwrap the runner warns and runs unsandboxed', () => {
    const r = runWith('/nonexistent/bwrap');
    expect([r.code, r.err.includes('bwrap not found'), r.log.includes('RUN')]).toEqual([0, true, true]);
  });
});

const HOME = '/home/u';
const RUN = '/tmp/vivera-eval/run-1';

describe('bwrapArgs', () => {
  const BINDS = [`${HOME}/.bun`, `${HOME}/.local/share/claude/versions`];
  const all = () => bwrapArgs({ runDir: RUN, home: HOME, roBinds: BINDS, exists: () => true });

  test('mounts the host read-only with a private /tmp and an empty home', () => {
    expect(all().slice(0, 11)).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', HOME]);
  });

  test('binds only the listed paths read-only and the run dir writable, nothing of ~/.claude', () => {
    const text = all().join(' ');
    expect(text).toContain(`--ro-bind ${HOME}/.bun ${HOME}/.bun --ro-bind ${BINDS[1]} ${BINDS[1]} --bind ${RUN} ${RUN}`);
    expect(all().filter((a) => a === '--bind')).toHaveLength(1);
    expect(text).not.toContain('.claude');
  });

  test('skips a read-only bind whose source is missing', () => {
    const args = bwrapArgs({ runDir: RUN, home: HOME, roBinds: BINDS, exists: (p) => !p.endsWith('.bun') });
    expect([args.includes(`${HOME}/.bun`), args.includes(BINDS[1])]).toEqual([false, true]);
  });

  test('isolates the pid namespace, dies with the runner, shares the network, and ends with the command separator', () => {
    const args = all();
    expect(args.slice(-3)).toEqual(['--unshare-pid', '--die-with-parent', '--']);
    expect(args.some((a) => a.startsWith('--unshare-net') || a === '--unshare-all')).toBe(false);
  });
});

test('with a baseline only a regression or a skip fails the run; without one any failure does', async () => {
  const { runExitCode } = await import('./eval-sandbox.mjs');
  expect(runExitCode({ passed: 18, total: 20, regressed: false, skipped: 0, baseline: true })).toBe(0);
  expect(runExitCode({ passed: 18, total: 20, regressed: true, skipped: 0, baseline: true })).toBe(1);
  expect(runExitCode({ passed: 19, total: 20, regressed: false, skipped: 1, baseline: true })).toBe(1);
  expect(runExitCode({ passed: 18, total: 20, regressed: false, skipped: 0, baseline: false })).toBe(1);
  expect(runExitCode({ passed: 20, total: 20, regressed: false, skipped: 0, baseline: false })).toBe(0);
});
