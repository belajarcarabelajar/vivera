// scripts/pr-registry-reconcile.test.mjs
//
// `reconcile` reads GitHub and records what it says. GitHub is replaced by a
// fake `gh` on PATH that answers per PR number and logs every call, so the tests
// prove both the recorded states and that nothing but `gh pr view` ran.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRegistry } from './pr-registry.mjs';
import { parseRemote, resolveRepoPath, applyReconcile, reconcile } from './lib/registry-sync.mjs';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'pr-registry.mjs');
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
// The merged verdict reads the issue store; a path that never exists keeps the
// machine's real plan.issues.json out of these tests.
const NO_STORE = path.join(tmpdir(), 'pr-registry-reconcile-no-issue-store', 'plan.issues.json');
const DUE = 'due: bun scripts/plan-close-loop.mjs --due';

const ANSWERS = {
  11: { state: 'MERGED', mergedAt: '2026-10-10T01:00:00Z', closedAt: '2026-10-10T01:00:00Z', headRefName: 'p/m1' },
  12: { state: 'MERGED', mergedAt: '2026-10-11T02:00:00Z', closedAt: '2026-10-11T02:00:00Z', headRefName: 'p/v1' },
  14: { state: 'CLOSED', mergedAt: null, closedAt: '2026-10-12T03:00:00Z', headRefName: 'p/c1' },
  15: { state: 'OPEN', mergedAt: null, closedAt: null, headRefName: 'p/o1' },
  18: { state: 'MERGED', mergedAt: '2026-10-13T00:00:00Z', closedAt: '2026-10-13T00:00:00Z', headRefName: 'someone/else' },
  19: { state: 'MERGED', mergedAt: '2026-10-14T00:00:00Z', closedAt: '2026-10-14T00:00:00Z', headRefName: 'p/r1' },
};

function git(cwd, ...args) {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...GIT_ENV } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function fixture({ only } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-registry-reconcile-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'gh.log');
  // PR 13 is the gh failure. Any other unknown number also fails, loudly.
  const cases = Object.entries(ANSWERS).map(([n, a]) => `  ${n}) echo '${JSON.stringify(a)}' ;;`).join('\n');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\ncase "$3" in\n${cases}\n  *) echo "gh: HTTP 502 for $3" >&2; exit 1 ;;\nesac\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);

  const repoSsh = path.join(dir, 'widgets');
  const repoHttps = path.join(dir, 'gadgets');
  const other = path.join(dir, 'Other');
  for (const [repo, url] of [[repoSsh, 'git@github.com:acme/widgets.git'], [repoHttps, 'https://github.com/acme/gadgets.git'], [other, 'git@github.com:acme/other.git']]) {
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', url);
  }
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const fresh = new Date().toISOString();
  const row = (session, state, pr, repo, claimed_at = fresh, worktree = `${dir}/wt/${session}`) => ({
    session, plan: 'p', branch: `p/${session}`, worktree, repo, base: 'main', state, pr, depends_on: [], claimed_at,
  });
  const registry = {
    version: 1,
    sessions: [
      row('m1', 'open', 11, repoSsh),
      row('v1', 'verified', 12, repoHttps),
      row('f1', 'open', 13, repoSsh),
      row('c1', 'open', 14, repoSsh),
      row('o1', 'open', 15, repoHttps),
      row('n1', 'open', 16, path.join(dir, 'not-a-repo')),
      row('s1', 'isolated', null, repoSsh, old),
      row('y1', 'active', null, repoSsh),
      row('t1', 'merged', 17, repoSsh),
      row('x1', 'open', 18, repoSsh),
      row('r1', 'open', 19, undefined, fresh, `${other}-wt/r1`),
      row('g1', 'open', 20, undefined, fresh, `${dir}/Gone-wt/g1`),
    ],
  };
  if (only) registry.sessions = registry.sessions.filter((s) => only.includes(s.session));
  const file = path.join(dir, 'pr.registry.json');
  writeFileSync(file, JSON.stringify(registry, null, 2));
  const run = (...args) => {
    const r = Bun.spawnSync(['bun', SCRIPT, 'reconcile', '--registry', file, ...args], {
      env: { ...process.env, ...GIT_ENV, PLAN_ISSUES_CONFIG: NO_STORE, PATH: `${bin}:${process.env.PATH}` },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const state = (s) => loadRegistry(file).sessions.find((x) => x.session === s);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  // In-process, so a verdict function can be injected; the fake gh still answers.
  const runIn = (verdict, flags = {}) => {
    const saved = { PATH: process.env.PATH, ...Object.fromEntries(Object.keys(GIT_ENV).map((k) => [k, process.env[k]])) };
    const log = console.log;
    const out = [];
    Object.assign(process.env, GIT_ENV, { PATH: `${bin}:${process.env.PATH}` });
    console.log = (...a) => out.push(a.join(' '));
    try {
      const code = reconcile({ registryPath: file, rootDir: dir, flags, verdict });
      return { code, lines: out.join('\n').split('\n') };
    } finally {
      console.log = log;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  return { dir, file, repoSsh, run, runIn, state, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('parseRemote reads owner/repo from https and ssh origin URLs', () => {
  assert.equal(parseRemote('https://github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(parseRemote('https://github.com/acme/widgets'), 'acme/widgets');
  assert.equal(parseRemote('git@github.com:acme/widgets.git'), 'acme/widgets');
  assert.equal(parseRemote('ssh://git@github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(parseRemote('not a url'), null);
});

test('reconcile records a GitHub MERGED PR as merged with its merged_at, even from verified', () => {
  const f = fixture();
  try {
    f.run();
    assert.equal(f.state('m1').state, 'merged');
    assert.equal(f.state('m1').merged_at, '2026-10-10T01:00:00Z');
    assert.equal(f.state('v1').state, 'merged');
    assert.equal(f.state('v1').merged_at, '2026-10-11T02:00:00Z');
  } finally { f.cleanup(); }
});

test('reconcile records a GitHub CLOSED PR as closed and leaves an OPEN PR unchanged', () => {
  const f = fixture();
  try {
    f.run();
    assert.equal(f.state('c1').state, 'closed');
    assert.equal(f.state('c1').closed_at, '2026-10-12T03:00:00Z');
    assert.equal(f.state('o1').state, 'open');
  } finally { f.cleanup(); }
});

test('reconcile resolves owner/repo per session repository and only reads GitHub', () => {
  const f = fixture();
  try {
    f.run();
    const calls = f.calls();
    assert.ok(calls.includes('pr view 11 -R acme/widgets --json state,mergedAt,closedAt,headRefName'), calls.join('\n'));
    assert.ok(calls.includes('pr view 12 -R acme/gadgets --json state,mergedAt,closedAt,headRefName'), calls.join('\n'));
    assert.ok(calls.every((c) => c.startsWith('pr view ')), calls.join('\n'));
    assert.ok(!calls.some((c) => c.startsWith('pr view 17 ')), 'a terminal session is not queried');
  } finally { f.cleanup(); }
});

test('reconcile names a gh failure and an unresolvable repository as skipped and exits 1', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.code, 1, r.out + r.err);
    const all = r.out + r.err;
    assert.match(all, /skipped f1 .*HTTP 502/);
    assert.match(all, /skipped n1 /);
    assert.equal(f.state('f1').state, 'open');
    assert.match(r.out, /^reconciled 11: merged 3, closed 1, stale 1, stale-closed 0, skipped 4$/m);
  } finally { f.cleanup(); }
});

test('reconcile lists a stale PR-less session without closing it unless --close-stale', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.match(r.out, /stale s1 /);
    assert.equal(f.state('s1').state, 'isolated');
    assert.equal(f.state('y1').state, 'active');
    f.run('--close-stale', '--stale-days', '7');
    assert.equal(f.state('s1').state, 'closed');
    assert.ok(f.state('s1').closed_at);
    assert.equal(f.state('y1').state, 'active');
  } finally { f.cleanup(); }
});

test('reconcile --close-stale counts the stale sessions it closed apart from PR closures', () => {
  const f = fixture();
  try {
    const dry = f.run('--dry-run', '--close-stale');
    assert.match(dry.out, /^reconciled 11: merged 3, closed 1, stale 1, stale-closed 0, skipped 4$/m);
    const r = f.run('--close-stale');
    assert.match(r.out, /^reconciled 11: merged 3, closed 1, stale 1, stale-closed 1, skipped 4$/m);
  } finally { f.cleanup(); }
});

test('reconcile --stale-days widens or narrows the stale window', () => {
  const f = fixture();
  try {
    const r = f.run('--stale-days', '60');
    assert.ok(!/stale s1 /.test(r.out), r.out);
    assert.match(r.out, /stale 0,/);
  } finally { f.cleanup(); }
});

test('reconcile --dry-run prints the planned changes and writes nothing', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.file);
    const r = f.run('--dry-run', '--close-stale');
    assert.match(r.out, /merged m1 /);
    assert.match(r.out, /closed c1 /);
    assert.match(r.out, /dry run/i);
    assert.ok(Buffer.compare(before, readFileSync(f.file)) === 0, 'the registry bytes must not change');
    assert.ok(!existsSync(`${f.file}.bak`), 'no backup generation is written either');
  } finally { f.cleanup(); }
});

test('reconcile resolves a session without repo from the sibling of its -wt worktree directory', () => {
  const f = fixture();
  try {
    f.run();
    assert.ok(f.calls().includes('pr view 19 -R acme/other --json state,mergedAt,closedAt,headRefName'), f.calls().join('\n'));
    assert.equal(f.state('r1').state, 'merged');
  } finally { f.cleanup(); }
});

test('reconcile skips a session without repo whose -wt sibling does not exist, without asking GitHub', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.match(r.out, /skipped g1 /);
    assert.ok(!f.calls().some((c) => c.startsWith('pr view 20 ')), f.calls().join('\n'));
    assert.equal(f.state('g1').state, 'open');
  } finally { f.cleanup(); }
});

test('reconcile skips a PR whose head branch is not the session branch', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.match(r.out, /skipped x1 .*branch mismatch: registry p\/x1, GitHub someone\/else/);
    assert.equal(f.state('x1').state, 'open');
  } finally { f.cleanup(); }
});

test('resolveRepoPath uses this repository only for its own legacy ai-skills-wt worktrees', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-registry-resolve-'));
  try {
    const main = path.join(dir, 'Main');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    assert.deepEqual(resolveRepoPath({ worktree: `${dir}/ai-skills-wt/s` }, main), { path: main });
    assert.ok(resolveRepoPath({ worktree: `${dir}/Elsewhere/s` }, main).error);
    assert.deepEqual(resolveRepoPath({ repo: '/given', worktree: `${dir}/Elsewhere/s` }, main), { path: '/given' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stale close is dropped at write time when the session gained a PR since the read', () => {
  const live = { session: 's1', plan: 'p', branch: 'p/s1', worktree: '/w/s1', state: 'isolated', pr: null };
  const facts = new Map([['s1', { patch: { state: 'closed', closed_at: 'x' }, stale: true }]]);
  assert.equal(applyReconcile({ version: 1, sessions: [live] }, facts).sessions[0].state, 'closed');
  const gained = { ...live, state: 'verified', pr: 9 };
  assert.deepEqual(applyReconcile({ version: 1, sessions: [gained] }, facts).sessions[0], gained);
});

test('reconcile prints the close-out verdict right after each merged line, and none in --dry-run', () => {
  const f = fixture();
  try {
    const plans = path.join(f.repoSsh, 'docs', 'code-plan', 'plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(path.join(plans, 'p.md'), '---\nstatus: Verification\n---\n\n# p\n');
    const dry = f.run('--dry-run');
    assert.ok(!/warning: recording|^note: close-out|^due: /m.test(dry.out), dry.out);
    const lines = f.run().out.split('\n');
    const at = lines.findIndex((l) => l.startsWith('merged m1 '));
    assert.ok(at >= 0, lines.join('\n'));
    // The verdict block runs from the merged line to the next reconcile line.
    const block = [];
    for (let i = at + 1; i < lines.length && !/^(merged|closed|skipped|stale|reconciled) /.test(lines[i]); i++) block.push(lines[i]);
    assert.ok(block.includes('warning: recording "m1" as merged, but plan p is not closed out:'), lines.join('\n'));
    assert.equal(block.at(-1), DUE, lines.join('\n'));
    assert.equal(f.state('m1').state, 'merged');
  } finally { f.cleanup(); }
});

test('reconcile asks the verdict with the merge repository of the session', () => {
  const f = fixture({ only: ['m1', 'o1'] });
  try {
    const seen = [];
    const r = f.runIn((s, opts) => { seen.push([s.session, opts.repoRoot]); return { lines: ['verdict line'] }; });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.deepEqual(seen, [['m1', f.repoSsh]]);
    const at = r.lines.findIndex((l) => l.startsWith('merged m1 '));
    assert.equal(r.lines[at + 1], 'verdict line');
  } finally { f.cleanup(); }
});

test('reconcile asks the verdict with the -wt derived repository for a session that records none', () => {
  const f = fixture({ only: ['r1'] });
  try {
    const seen = [];
    const r = f.runIn((s, opts) => { seen.push([s.session, opts.repoRoot]); return { lines: [] }; });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.deepEqual(seen, [['r1', path.join(f.dir, 'Other')]]);
  } finally { f.cleanup(); }
});

test('reconcile turns a verdict that throws into one note line and keeps the exit code', () => {
  const f = fixture({ only: ['m1'] });
  try {
    const r = f.runIn(() => { throw new Error('boom'); });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(f.state('m1').state, 'merged');
    const notes = r.lines.filter((l) => l.startsWith('note: '));
    assert.equal(notes.length, 1, r.lines.join('\n'));
    assert.match(notes[0], /m1.*boom/);
  } finally { f.cleanup(); }
});

test('reconcile --dry-run never asks the verdict', () => {
  const f = fixture({ only: ['m1'] });
  try {
    let asked = 0;
    const r = f.runIn(() => { asked++; return { lines: ['verdict line'] }; }, { 'dry-run': true });
    assert.equal(asked, 0);
    assert.ok(!r.lines.includes('verdict line'), r.lines.join('\n'));
  } finally { f.cleanup(); }
});
