import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callCostUsd, summarize } from './session-metrics.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-metrics.mjs');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: os.tmpdir() };
const TS = '2026-10-10T00:00:00Z';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const usage = (input, writes, read, out, cacheCreation) => ({
  input_tokens: input, cache_creation_input_tokens: writes, cache_read_input_tokens: read, output_tokens: out, cache_creation: cacheCreation,
});
const split = (m5, h1) => ({ ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 });
const call = (id, u, extra = {}) => ({ id, model: null, usage: u, tools: [], skills: [], ...extra });
const sum = (mains, subs = []) => summarize({ mains, subs, registry: null, fixes: null, window: {} });
const writeJsonl = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

describe('counters named like Object.prototype keys', () => {
  test('skills and agent types named toString or __proto__ are counted exactly', () => {
    const skills = ['toString', '__proto__', 'toString'];
    const sub = (id, agentType) => ({ calls: [call(id, usage(1, 0, 0, 1))], firstTs: TS, agentType });
    const s = sum([{ calls: [call('m1', usage(1, 0, 0, 1), { skills })], firstTs: TS }], [sub('a', '__proto__'), sub('b', 'toString'), sub('c', '__proto__')]);
    expect(Object.entries(s.skills)).toEqual([['toString', 2], ['__proto__', 1]]);
    expect(Object.entries(s.subagentsByType)).toEqual([['__proto__', 2], ['toString', 1]]);
  });

  test('the CLI keeps them in --json and in the text blocks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-metrics-counters-'));
    dirs.push(root);
    const proj = path.join(root, 'projects');
    const asst = (id, content) => ({ type: 'assistant', timestamp: TS, message: { id, usage: usage(1, 0, 0, 1), content } });
    const skill = (id, name) => ({ type: 'tool_use', id, name: 'Skill', input: { skill: name } });
    writeJsonl(path.join(proj, 'sess.jsonl'), [asst('m1', [skill('t1', 'toString'), skill('t2', '__proto__'), skill('t3', 'toString')])]);
    ['__proto__', 'toString', '__proto__'].forEach((agentType, i) => {
      const file = path.join(proj, 'sess', 'subagents', `agent-${i}.jsonl`);
      writeJsonl(file, [asst(`s${i}`, [])]);
      fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType }));
    });
    const run = (...extra) => spawnSync(process.execPath, [SCRIPT, '--repo', root, '--projects-dir', proj, '--registry', path.join(root, 'none.json'), ...extra], { cwd: root, env: ENV, encoding: 'utf8' });
    const j = run('--json');
    expect(j.status).toBe(0);
    expect(Object.entries(JSON.parse(j.stdout).skills)).toEqual([['toString', 2], ['__proto__', 1]]);
    expect(Object.entries(JSON.parse(j.stdout).subagentsByType)).toEqual([['__proto__', 2], ['toString', 1]]);
    const text = run().stdout;
    expect(text).toMatch(/subagent runs by agentType\n\s+__proto__\s+2\n\s+toString\s+1\n/);
    expect(text).toMatch(/Skill loads by name\n\s+toString\s+2\n\s+__proto__\s+1\n/);
  });
});

// Hand-worked from the 2026-10-20 list prices, USD per million tokens.
describe('cache writes from the TTL split', () => {
  test('a split larger than the reported total is counted, priced, and not a zero-token call', () => {
    // Seen once in real data: total 0, 1-hour split 4076. Opus 5.5 1-hour write: 4076*8 = 32608 per million.
    const s = sum([{ calls: [
      call('m1', usage(0, 0, 0, 0, split(0, 4076)), { model: 'claude-opus-5-5' }),
      call('m2', usage(0, 0, 0, 0, split(100, 0)), { model: 'mystery-model-9' }),
    ], firstTs: TS }]);
    expect(s.tokens.cacheWrite).toBe(4176);
    expect(s.costUsd).toBe(0.0326);
    expect(s.unpricedModels).toEqual({ 'mystery-model-9': 1 });
  });

  test('a reported total larger than the split still counts in full', () => {
    const s = sum([{ calls: [call('m1', usage(0, 500, 0, 0, split(200, 0)))], firstTs: TS }]);
    expect(s.tokens.cacheWrite).toBe(500);
  });

  test('the Haiku 5.5 card switch counts the split when it is larger', () => {
    // 40000 + 30001 + 30000 = 100001 prompt tokens, so the long card:
    // 40000*0.5 + 30001*1 + 30000*0.05 + 1000*2.5 = 54001 per million.
    expect(callCostUsd('claude-haiku-5-5', usage(40000, 0, 30000, 1000, split(0, 30001)))).toBeCloseTo(0.054001, 12);
  });
});

describe('session signals', () => {
  test('repeated tool-call runs and cache rebuild turns come from in-window mains only, as counts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-metrics-signals-'));
    dirs.push(root);
    const proj = path.join(root, 'projects');
    const SECRET_CMD = 'echo SIGNAL_INPUT_MUST_NOT_LEAK';
    const use = (id) => ({ type: 'tool_use', id, name: 'Bash', input: { command: SECRET_CMD } });
    const asst = (ts, id, u, content) => ({ type: 'assistant', timestamp: ts, message: { id, usage: u, content } });
    const rebuild = usage(0, 80000, 20000, 1);
    const session = (ts, p) => [
      asst(ts, `${p}0`, rebuild, []),
      asst(ts, `${p}1`, rebuild, [use(`${p}t1`)]),
      asst(ts, `${p}2`, usage(0, 10, 100000, 1), [use(`${p}t2`)]),
      asst(ts, `${p}3`, usage(0, 10, 100000, 1), [use(`${p}t3`)]),
    ];
    writeJsonl(path.join(proj, 'in.jsonl'), session(TS, 'a'));
    writeJsonl(path.join(proj, 'old.jsonl'), session('2026-10-01T00:00:00Z', 'b'));
    writeJsonl(path.join(proj, 'in', 'subagents', 'agent-x.jsonl'), session(TS, 'c'));
    const run = (...extra) => spawnSync(process.execPath, [SCRIPT, '--repo', root, '--projects-dir', proj, '--registry', path.join(root, 'none.json'), '--since', '2026-10-05', ...extra], { cwd: root, env: ENV, encoding: 'utf8' });
    const j = run('--json');
    expect(j.status).toBe(0);
    const parsed = JSON.parse(j.stdout);
    expect(parsed.repeatedToolCallRuns).toEqual({ runs: 1, calls: 3 });
    expect(parsed.cacheRebuildTurns).toBe(1);
    const t = run();
    expect(t.status).toBe(0);
    expect(t.stdout).toMatch(/repeated identical tool-call runs \(3\+\)\s+1 runs, 3 calls\n/);
    expect(t.stdout).toMatch(/cache rebuild turns\s+1\n/);
    for (const out of [j.stdout, j.stderr, t.stdout, t.stderr]) expect(out).not.toContain('SIGNAL_INPUT_MUST_NOT_LEAK');
  });
});

describe('linked worktree', () => {
  // Claude Code keys transcripts by the dir a session started in, usually the main checkout.
  function setup() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-metrics-wt-')));
    dirs.push(root);
    const main = path.join(root, 'main');
    const wt = path.join(root, 'wt');
    const git = (cwd, ...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: ENV, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    fs.mkdirSync(main);
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '--detach', wt);
    const home = path.join(root, 'home');
    const proj = path.join(home, '.claude', 'projects', main.replace(/\//g, '-'));
    writeJsonl(path.join(proj, 'sess.jsonl'), [{ type: 'assistant', timestamp: TS, message: { id: 'm1', usage: usage(1, 0, 0, 1), content: [] } }]);
    const run = (...extra) => spawnSync(process.execPath, [SCRIPT, '--registry', path.join(root, 'none.json'), ...extra], { cwd: wt, env: { ...ENV, HOME: home }, encoding: 'utf8' });
    return { main, wt, proj, run };
  }

  test('without --repo or --projects-dir it falls back to the main checkout and says so in one note', () => {
    const { main, run } = setup();
    const r = run('--json');
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.mainSessions).toBe(1);
    expect(j.notes.filter((n) => n.includes('linked worktree') && n.includes(main))).toHaveLength(1);
  });

  test('an explicit --repo or --projects-dir is never overridden', () => {
    const { wt, run } = setup();
    expect(run('--repo', wt).status).toBe(1);
    expect(run('--projects-dir', path.join(wt, 'nope')).status).toBe(1);
  });

  test('a main checkout without transcripts still exits 1', () => {
    const { proj, run } = setup();
    fs.rmSync(proj, { recursive: true, force: true });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('project dir not found');
  });
});
