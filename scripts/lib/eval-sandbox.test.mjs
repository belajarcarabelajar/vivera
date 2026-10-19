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
  fs.writeFileSync(path.join(root, 'claude'), `#!/bin/sh\necho "RUN $(pwd)" >> "${log}"\ncat "${ASK}"\n`, { mode: 0o755 });
  const fake = path.join(root, 'bwrap');
  fs.writeFileSync(fake, `#!/bin/sh\necho "BWRAP $*" >> "${log}"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', path.join(root, 'evals', 'scenarios'), '--out', path.join(root, 'o.json'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, EVAL_CLAUDE_BIN: path.join(root, 'claude'), EVAL_TMP_ROOT: path.join(root, 'runs'), EVAL_BWRAP: bwrap === 'fake' ? fake : bwrap },
  });
  return { code: r.status, err: r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

describe('eval-run sandbox', () => {
  test('the claude command runs inside bwrap, which binds the run dir writable', () => {
    const r = runWith('fake');
    const runDir = path.dirname(path.dirname(r.log.match(/^RUN (.*)$/m)[1]));
    expect(r.code).toBe(0);
    expect(r.log).toContain(`BWRAP --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind ${runDir} ${runDir} `);
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
  test('mounts the host read-only with a private /tmp, then binds the run dir and claude state writable', () => {
    const args = bwrapArgs({ runDir: RUN, home: HOME, exists: () => true });
    expect(args.slice(0, 12)).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', RUN, RUN]);
    expect(args.join(' ')).toContain(`--bind ${HOME}/.claude ${HOME}/.claude --bind ${HOME}/.claude.json ${HOME}/.claude.json`);
  });

  test('hides every secret directory behind an empty tmpfs', () => {
    const args = bwrapArgs({ runDir: RUN, home: HOME, exists: () => true });
    const hidden = args.flatMap((a, i) => (a === '--tmpfs' ? [args[i + 1]] : []));
    expect(hidden).toEqual(['/tmp', ...['cloudflare', '.config/tinyfish', '.ssh', '.local/share/bmp-cli', '.config/amo',
      'iwan-kurniawan', 'Dokumen', '.mozilla', '.config/mozilla'].map((d) => `${HOME}/${d}`)]);
  });

  test('skips a mount whose source is missing, since bwrap cannot create it on a read-only root', () => {
    const args = bwrapArgs({ runDir: RUN, home: HOME, exists: (p) => !p.endsWith('.ssh') && !p.endsWith('.claude.json') });
    expect(args).not.toContain(`${HOME}/.ssh`);
    expect(args).not.toContain(`${HOME}/.claude.json`);
    expect(args).toContain(`${HOME}/cloudflare`);
  });

  test('isolates the pid namespace, dies with the runner, shares the network, and ends with the command separator', () => {
    const args = bwrapArgs({ runDir: RUN, home: HOME, exists: () => true });
    expect(args.slice(-3)).toEqual(['--unshare-pid', '--die-with-parent', '--']);
    expect(args.some((a) => a.startsWith('--unshare-net') || a === '--unshare-all')).toBe(false);
  });
});
