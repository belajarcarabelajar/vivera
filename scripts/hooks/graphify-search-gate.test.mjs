// scripts/hooks/graphify-search-gate.test.mjs
//
// Guards for the gate in graphify-search-nudge.mjs (2026-11-18): before the
// first graph query of a session and agent, a recursive content search in a
// registered repository is blocked with exit 2, at most MAX_BLOCKS times,
// fail-open, with a kill switch. Fixtures: ../lib/graphify-nudge-test-helpers.mjs.

import { test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEEP_LEVELS, depthBelowRoot, gateTarget, MAX_BLOCKS, shellPipelines } from './graphify-search-nudge.mjs';
import {
  contextOf,
  event,
  graphPathOf,
  HOOK,
  ISOLATED_ENV,
  isolateGitEnv,
  repo,
  run,
  tempDir,
} from '../lib/graphify-nudge-test-helpers.mjs';

isolateGitEnv();

function gateEnv(extra = {}) {
  return { GRAPHIFY_GATE: '1', GRAPHIFY_GATE_OFF_FILE: path.join(tempDir('off'), 'off'), ...extra };
}

test('the gate blocks the first Grep in a registered repository with exit 2 and the exact query command', () => {
  const root = repo('gate-grep');
  const r = run(event(root, 'Grep', { pattern: 'foo' }), { env: gateEnv() });
  expect(r.status).toBe(2);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain(`graphify query "<question>" --graph ${graphPathOf(root)}`);
  expect(r.stderr).toContain(`1 of ${MAX_BLOCKS}`);
  expect(r.stderr).not.toContain('\u2014');
});

test('the gate follows cd into a registered repository before rg', () => {
  const root = repo('gate-cd');
  const elsewhere = tempDir('elsewhere');
  const r = run(event(elsewhere, 'Bash', { command: `cd '${root}' && rg -n 'a|b' -g '*.ts'` }), { env: gateEnv() });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(graphPathOf(root));
});

test('the gate also blocks grep -r and an rg path argument inside the repository', () => {
  const root = repo('gate-paths');
  const elsewhere = tempDir('elsewhere2');
  expect(run(event(elsewhere, 'Bash', { command: `grep -rn foo ${root}` }), { env: gateEnv() }).status).toBe(2);
  expect(run(event(elsewhere, 'Bash', { command: `timeout 30 rg foo ${root}` }), { env: gateEnv() }).status).toBe(2);
});

test('a graph query unlocks the gate for the rest of the session and agent', () => {
  const root = repo('gate-unlock');
  const stateDir = tempDir('state');
  const env = gateEnv();
  expect(run(event(root, 'Grep', { pattern: 'x' }), { stateDir, env }).status).toBe(2);
  expect(run(event(root, 'Bash', { command: 'graphify query "where is x"' }), { stateDir, env }).status).toBe(0);
  const after = run(event(root, 'Bash', { command: 'rg x' }), { stateDir, env });
  expect(after.status).toBe(0);
  expect(after.stdout).toBe('');
});

test('the gate blocks at most MAX_BLOCKS times, then the search runs with the reminder', () => {
  const root = repo('gate-cap');
  const stateDir = tempDir('state');
  const env = gateEnv();
  for (let i = 1; i <= MAX_BLOCKS; i++) {
    const r = run(event(root, 'Grep', { pattern: 'x' }), { stateDir, env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${i} of ${MAX_BLOCKS}`);
  }
  const r = run(event(root, 'Grep', { pattern: 'x' }), { stateDir, env });
  expect(r.status).toBe(0);
  expect(contextOf(r.stdout)).toContain(graphPathOf(root));
});

test('the gate never blocks Read, Glob, find, single-file searches, pipe filters or plain grep', () => {
  const root = repo('gate-allow');
  const stateDir = tempDir('state');
  const env = gateEnv();
  const file = path.join(root, 'a.txt');
  const calls = [
    ['Read', { file_path: file }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Grep', { pattern: 'a', path: file }],
    ['Bash', { command: `find ${root} -name '*.ts'` }],
    ['Bash', { command: `rg a ${file}` }],
    ['Bash', { command: 'ps -eo pid,cmd | rg claude' }],
    ['Bash', { command: `grep a ${file}` }],
    ['Bash', { command: 'ls -la' }],
  ];
  for (const [tool, input] of calls) {
    const r = run(event(root, tool, input), { stateDir, env });
    expect(r.status).toBe(0);
  }
});

test('a search two or more folders below the repository root is never blocked; one folder below still is', () => {
  const root = repo('gate-deep');
  mkdirSync(path.join(root, 'apps', 'web', 'src'), { recursive: true });
  const env = gateEnv();
  const status = (tool, input) => run(event(root, tool, input), { stateDir: tempDir('state'), env }).status;
  expect(DEEP_LEVELS).toBe(2);
  expect(status('Bash', { command: 'rg foo apps/web' })).toBe(0);
  expect(status('Bash', { command: `cd '${root}/apps/web/src' && rg -n foo` })).toBe(0);
  expect(status('Grep', { pattern: 'foo', path: path.join(root, 'apps', 'web') })).toBe(0);
  expect(status('Bash', { command: 'rg foo apps' })).toBe(2);
  expect(status('Bash', { command: 'rg foo' })).toBe(2);
});

test('depthBelowRoot counts folders between the repository root and the target', () => {
  const g = path.join('/r', 'graphify-out', 'graph.json');
  expect(['/r', '/r/a', '/r/a/b', '/r/a/b/c', '/elsewhere', '/r/../x'].map((d) => depthBelowRoot(g, d))).toEqual([0, 1, 2, 3, 0, 0]);
});

test('the gate stays open in a repository without a graph and outside any repository', () => {
  const plain = repo('gate-nograph', { graph: false });
  expect(run(event(plain, 'Bash', { command: 'rg foo' }), { env: gateEnv() }).status).toBe(0);
  const outside = tempDir('gate-outside');
  expect(run(event(outside, 'Grep', { pattern: 'foo' }), { env: gateEnv() }).status).toBe(0);
});

test('the kill switch file and GRAPHIFY_GATE=0 turn the gate off', () => {
  const root = repo('gate-off');
  const offDir = tempDir('offfile');
  const off = path.join(offDir, 'off');
  writeFileSync(off, '');
  expect(run(event(root, 'Grep', { pattern: 'x' }), { env: gateEnv({ GRAPHIFY_GATE_OFF_FILE: off }) }).status).toBe(0);
  expect(run(event(root, 'Grep', { pattern: 'x' }), { env: gateEnv({ GRAPHIFY_GATE: '0' }) }).status).toBe(0);
});

test('the gate fails open when its state cannot be saved', () => {
  const root = repo('gate-ro');
  const ro = tempDir('ro');
  chmodSync(ro, 0o500);
  const r = run(event(root, 'Grep', { pattern: 'x' }), { stateDir: path.join(ro, 'nested'), env: gateEnv() });
  chmodSync(ro, 0o700);
  expect(r.status).toBe(0);
  expect(r.stderr).toBe('');
});

test('shellPipelines keeps quoted separators inside one word', () => {
  expect(shellPipelines("cd '/a b' && rg 'x|y' src | head -3; ls")).toEqual([
    [['cd', '/a b']],
    [['rg', 'x|y', 'src'], ['head', '-3']],
    [['ls']],
  ]);
});

test('gateTarget skips flag values and reads paths after the pattern', () => {
  const root = repo('gate-target');
  mkdirSync(path.join(root, 'src'));
  expect(gateTarget('Bash', { command: 'rg -g "*.ts" -m 3 foo src' }, root)).toBe(path.join(root, 'src'));
  expect(gateTarget('Bash', { command: 'rg -e foo -e bar src' }, root)).toBe(path.join(root, 'src'));
  expect(gateTarget('Bash', { command: 'rg foo' }, root)).toBe(root);
  expect(gateTarget('Bash', { command: 'rg foo a.txt' }, root)).toBe(null);
  expect(gateTarget('Bash', { command: 'grep foo src' }, root)).toBe(null);
  expect(gateTarget('Bash', { command: 'echo hi | rg hi' }, root)).toBe(null);
});


// Code Mode, and any parallel tool batch, runs this hook in several processes at
// once; each reads the state file and writes it back, so the last write wins.
// These cases replay that interleaving by restoring a stale copy of the state
// file between calls, then check the same facts with real concurrent processes.
function stateFileOf(stateDir) {
  return path.join(stateDir, 'sess-1.main.json');
}

test('a stale state write after a graph query does not undo the query', () => {
  const root = repo('race-query');
  const stateDir = tempDir('state');
  const env = gateEnv();
  run(event(root, 'Glob', { pattern: '*' }), { stateDir, env });
  const stale = readFileSync(stateFileOf(stateDir), 'utf8');
  expect(run(event(root, 'Bash', { command: 'graphify query "q" --graph g.json' }), { stateDir, env }).status).toBe(0);
  writeFileSync(stateFileOf(stateDir), stale);
  const r = run(event(root, 'Grep', { pattern: 'x' }), { stateDir, env });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
});

test('stale state writes between blocks do not lift the MAX_BLOCKS cap', () => {
  const root = repo('race-cap');
  const stateDir = tempDir('state');
  const env = gateEnv();
  const outcomes = [];
  for (let i = 0; i <= MAX_BLOCKS; i++) {
    if (existsSync(stateFileOf(stateDir))) writeFileSync(stateFileOf(stateDir), '{}\n');
    const r = run(event(root, 'Grep', { pattern: 'x' }), { stateDir, env });
    outcomes.push(r.status === 2 ? r.stderr.match(/\d+ of \d+/)[0] : `exit ${r.status}`);
  }
  expect(outcomes).toEqual([...Array.from({ length: MAX_BLOCKS }, (_, i) => `${i + 1} of ${MAX_BLOCKS}`), 'exit 0']);
});

async function runAll(inputs, stateDir, env) {
  return Promise.all(
    inputs.map(async (input) => {
      const p = Bun.spawn([process.execPath, HOOK], {
        stdin: new Blob([JSON.stringify(input)]),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...ISOLATED_ENV, GRAPHIFY_HOOK_STATE_DIR: stateDir, ...env },
      });
      const [status, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      return { status, stderr };
    }),
  );
}

test('concurrent searches are blocked exactly MAX_BLOCKS times, each with its own number', async () => {
  const root = repo('race-parallel');
  const stateDir = tempDir('state');
  const results = await runAll(Array.from({ length: 6 }, () => event(root, 'Grep', { pattern: 'x' })), stateDir, gateEnv());
  const labels = results.filter((r) => r.status === 2).map((r) => r.stderr.match(/\d+ of \d+/)[0]).sort();
  expect(labels).toEqual(Array.from({ length: MAX_BLOCKS }, (_, i) => `${i + 1} of ${MAX_BLOCKS}`));
  expect(results.filter((r) => r.status !== 2).every((r) => r.status === 0)).toBe(true);
}, 30000);

test('a query in one parallel batch lets every search of the next batch run', async () => {
  const root = repo('race-batches');
  const stateDir = tempDir('state');
  const env = gateEnv();
  const query = event(root, 'Bash', { command: 'graphify query "q" --graph g.json' });
  const search = () => event(root, 'Grep', { pattern: 'x' });
  await runAll([query, search(), search(), search()], stateDir, env);
  const next = await runAll([search(), search(), search(), search()], stateDir, env);
  expect(next.map((r) => r.status)).toEqual([0, 0, 0, 0]);
}, 30000);
