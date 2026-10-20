import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRICES, PRICES_AS_OF, callCostUsd, readTranscript, repoMatches, slugFor, summarize } from './session-metrics.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-metrics.mjs');
const SECRET = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
};

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const u = (input, cw, cr, out) => ({
  input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out,
});
const asst = (ts, id, usage, content, model) => ({ type: 'assistant', timestamp: ts, message: { id, model, usage, content } });
const writeJsonl = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

// Main A (in window): m1 streamed over two lines, then m2, both Opus 5.5; only the
// first m1 line names the model. One chef subagent run on Haiku 4.5.
// Main B (2026-10-01) sits outside a window that starts 2026-10-05, on a model
// that has no price.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-metrics-'));
  dirs.push(root);
  const proj = path.join(root, 'projects');
  writeJsonl(path.join(proj, 'sess-a.jsonl'), [
    { type: 'user', timestamp: '2026-10-10T10:00:00.000Z', message: { role: 'user', content: SECRET } },
    asst('2026-10-10T10:00:01.000Z', 'm1', u(10, 1000, 0, 5), [{ type: 'text', text: `token ${SECRET}` }], 'claude-opus-5-5'),
    asst('2026-10-10T10:00:02.000Z', 'm1', u(10, 1000, 0, 50), [
      { type: 'tool_use', id: 'tu1', name: 'Agent', input: { prompt: SECRET } },
    ]),
    asst('2026-10-10T10:01:00.000Z', 'm2', u(5, 200, 1000, 20), [
      { type: 'tool_use', id: 'tu2', name: 'AskUserQuestion', input: { questions: [SECRET] } },
      { type: 'tool_use', id: 'tu3', name: 'Skill', input: { skill: 'sucp-rules' } },
    ], 'claude-opus-5-5'),
  ]);
  const subDir = path.join(proj, 'sess-a', 'subagents');
  writeJsonl(path.join(subDir, 'agent-x1.jsonl'), [
    asst('2026-10-10T10:00:10.000Z', 's1', u(3, 500, 0, 10), [{ type: 'text', text: SECRET }], 'claude-haiku-4-5'),
    asst('2026-10-10T10:00:20.000Z', 's2', u(2, 100, 500, 30), [{ type: 'tool_use', id: 'tu4', name: 'Bash', input: { command: SECRET } }], 'claude-haiku-4-5'),
  ]);
  fs.writeFileSync(path.join(subDir, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'chef' }));
  writeJsonl(path.join(proj, 'sess-b.jsonl'), [
    asst('2026-10-01T09:00:00.000Z', 'm3', u(1, 1, 1, 1), [], 'claude-future-9'),
  ]);

  const registry = path.join(root, 'pr.registry.json');
  const s = (session, extra) => ({ session, plan: 'p', worktree: '/x/elsewhere', state: 'merged', pr: 1, claimed_at: '2026-10-09T00:00:00Z', ...extra });
  fs.writeFileSync(registry, JSON.stringify({ version: 1, sessions: [
    s('p1', { repo: '/x/vivera', merged_at: '2026-10-11T00:00:00Z' }),
    s('p2', { repo: '/x/other', merged_at: '2026-10-11T00:00:00Z' }),
    s('p3', { worktree: '/x/vivera-wt/p3', merged_at: '2026-10-11T00:00:00Z' }),
    s('p4', { repo: '/x/vivera', merged_at: '2026-10-20T00:00:00Z' }),
    s('p5', { repo: '/x/vivera', state: 'active', merged_at: null }),
  ] }));

  // A git repo named vivera whose origin/main holds one in-window Fixes commit,
  // one in-window plain commit, and one Fixes commit before the window.
  const repo = path.join(root, 'vivera');
  fs.mkdirSync(repo);
  const git = (date, ...args) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo, encoding: 'utf8',
      env: { ...ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git('2026-10-01T00:00:00+0000', 'init', '-q', '-b', 'main');
  git('2026-10-01T12:00:00+0000', 'commit', '-q', '--allow-empty', '-m', 'fix: old\n\nFixes: #1');
  git('2026-10-10T12:00:00+0000', 'commit', '-q', '--allow-empty', '-m', 'feat: plain');
  git('2026-10-10T13:00:00+0000', 'commit', '-q', '--allow-empty', '-m', 'fix: new\n\nFixes: #12');
  git('2026-10-10T13:00:00+0000', 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { root, proj, registry, repo };
}

function run(f, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', f.repo, '--projects-dir', f.proj, '--registry', f.registry, ...extra], {
    cwd: f.root, env: ENV, encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('readTranscript', () => {
  test('dedupes streamed lines by message id, keeping the last usage and every tool', async () => {
    const f = fixture();
    const t = await readTranscript(path.join(f.proj, 'sess-a.jsonl'));
    expect(t.calls.map((c) => c.id)).toEqual(['m1', 'm2']);
    expect(t.calls[0].usage.output_tokens).toBe(50);
    expect(t.calls[0].tools).toEqual(['Agent']);
    expect(t.calls[1].tools).toEqual(['AskUserQuestion', 'Skill']);
    expect(t.calls[1].skills).toEqual(['sucp-rules']);
    expect(t.firstTs).toBe('2026-10-10T10:00:00.000Z');
    expect(t.lastTs).toBe('2026-10-10T10:01:00.000Z');
  });

  test('each call carries the last model named for its id, null when none is', async () => {
    const f = fixture();
    const t = await readTranscript(path.join(f.proj, 'sess-a.jsonl'));
    expect(t.calls.map((c) => c.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
    const bare = path.join(f.root, 'bare.jsonl');
    writeJsonl(bare, [asst('2026-10-10T10:00:00.000Z', 'x1', u(1, 0, 0, 1), [])]);
    expect((await readTranscript(bare)).calls[0].model).toBeNull();
  });
});

// Expected dollars are worked by hand from the 2026-10-20 list prices (USD per
// million tokens), never recomputed with the script's own formula.
describe('callCostUsd', () => {
  const split = (m5, h1) => ({ ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 });

  test('PRICES holds the 2026-10-20 list, dated by PRICES_AS_OF', () => {
    const card = (input, output, cacheRead) => ({ input, output, cacheRead });
    expect(PRICES_AS_OF).toBe('2026-10-20');
    expect(PRICES).toEqual({
      'claude-fable-5-1': card(10, 50, 0.25),
      'claude-mythos-5-1': card(10, 50, 0.25),
      'claude-fable-5': card(10, 50, 1),
      'claude-mythos-5': card(10, 50, 1),
      'claude-opus-5-5': card(4, 20, 0.2),
      'claude-opus-5': card(5, 25, 0.5),
      'claude-opus-4-8': card(5, 25, 0.5),
      'claude-opus-4-7': card(5, 25, 0.5),
      'claude-opus-4-6': card(5, 25, 0.5),
      'claude-sonnet-5-5': card(2, 10, 0.2),
      'claude-sonnet-5': card(2, 10, 0.2),
      'claude-sonnet-4-6': card(3, 15, 0.3),
      'claude-haiku-5-5': { ...card(0.1, 0.5, 0.01), long: { above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
      'claude-haiku-4-5': card(1, 5, 0.1),
    });
  });

  test('a 5-minute cache write costs 1.25x input', () => {
    // Opus 5.5: 10*4 + 1000*5 + 50*20 = 6040 per million.
    expect(callCostUsd('claude-opus-5-5', { ...u(10, 1000, 0, 50), cache_creation: split(1000, 0) })).toBeCloseTo(0.00604, 12);
  });

  test('a 1-hour cache write costs 2x input', () => {
    // Opus 5.5: 10*4 + 1000*8 + 50*20 = 9040; mixed: 10*4 + 600*5 + 400*8 + 50*20 = 7240.
    expect(callCostUsd('claude-opus-5-5', { ...u(10, 1000, 0, 50), cache_creation: split(0, 1000) })).toBeCloseTo(0.00904, 12);
    expect(callCostUsd('claude-opus-5-5', { ...u(10, 1000, 0, 50), cache_creation: split(600, 400) })).toBeCloseTo(0.00724, 12);
  });

  test('a call without the TTL split prices every write as 5-minute', () => {
    // Sonnet 4.6: 2000*3.75 = 7500 per million.
    expect(callCostUsd('claude-sonnet-4-6', u(0, 2000, 0, 0))).toBeCloseTo(0.0075, 12);
  });

  test('Haiku 5.5 switches to the long card just above 100,000 prompt tokens', () => {
    // At 100,000: 40000*0.1 + 30000*0.125 + 30000*0.01 + 1000*0.5 = 8550.
    expect(callCostUsd('claude-haiku-5-5', u(40000, 30000, 30000, 1000))).toBeCloseTo(0.00855, 12);
    // At 100,001: 40000*0.5 + 30000*0.625 + 30001*0.05 + 1000*2.5 = 42750.05.
    expect(callCostUsd('claude-haiku-5-5', u(40000, 30000, 30001, 1000))).toBeCloseTo(0.04275005, 12);
  });

  test('a model missing from the table has no price', () => {
    expect(callCostUsd('claude-future-9', u(1, 1, 1, 1))).toBeNull();
    expect(callCostUsd('toString', u(1, 1, 1, 1))).toBeNull();
    expect(callCostUsd(null, u(1, 1, 1, 1))).toBeNull();
  });
});

test('slugFor replaces every slash with a dash', () => {
  expect(slugFor('/home/u/vivera')).toBe('-home-u-vivera');
});

describe('summarize', () => {
  test('filters transcripts by window and counts merged PRs for this repo only', async () => {
    const f = fixture();
    const mains = [await readTranscript(path.join(f.proj, 'sess-a.jsonl')), await readTranscript(path.join(f.proj, 'sess-b.jsonl'))];
    const subs = [{ agentType: 'chef', ...(await readTranscript(path.join(f.proj, 'sess-a', 'subagents', 'agent-x1.jsonl'))) }];
    const registry = JSON.parse(fs.readFileSync(f.registry, 'utf8'));
    const s = summarize({ mains, subs, registry, fixes: 1, window: { since: '2026-10-05', until: '2026-10-12' }, repo: '/x/vivera' });
    expect(s.mainSessions).toBe(1);
    expect(s.mergedPrs).toBe(2);
    const all = summarize({ mains, subs, registry, fixes: 0, window: {}, repo: '/x/vivera' });
    expect(all.mainSessions).toBe(2);
    expect(all.mergedPrs).toBe(3);
  });

  test('trims padded agent types and folds free text into <other>', () => {
    const t = (id) => ({ calls: [{ id, usage: u(1, 0, 0, 1), tools: [], skills: [] }], firstTs: '2026-10-10T00:00:00Z' });
    const subs = [{ ...t('a'), agentType: ' chef ' }, { ...t('b'), agentType: `leak ${SECRET}` }];
    const s = summarize({ mains: [], subs, registry: null, fixes: null, window: {} });
    expect(s.subagentsByType).toEqual({ chef: 1, '<other>': 1 });
  });

  test('agent types and skill loads list by count descending, then name ascending', () => {
    const t = (id, agentType, skills) => ({ calls: [{ id, usage: u(1, 0, 0, 1), tools: [], skills }], firstTs: '2026-10-10T00:00:00Z', agentType });
    const subs = [t('a', 'nappy', ['zeta']), t('b', 'chef', ['beta']), t('c', 'bold', ['zeta']), t('d', 'nappy', ['alpha'])];
    const s = summarize({ mains: [], subs, registry: null, fixes: null, window: {} });
    expect(Object.entries(s.subagentsByType)).toEqual([['nappy', 2], ['bold', 1], ['chef', 1]]);
    expect(Object.entries(s.skills)).toEqual([['zeta', 2], ['alpha', 1], ['beta', 1]]);
  });

  test('prices each call by its model, lists unpriced models, and ignores zero-token calls', () => {
    const c = (id, model, usage) => ({ id, model, usage, tools: [], skills: [] });
    const calls = [
      c('a', 'claude-haiku-4-5', u(2000, 0, 0, 2000)), // 2000*1 + 2000*5 = 12000 per million
      c('b', 'claude-sonnet-5', u(0, 0, 0, 600)), // 600*10 = 6000
      c('c', 'claude-opus-5-5', u(1500, 0, 0, 0)), // 1500*4 = 6000
      c('d', 'mystery-model-9', u(100, 0, 0, 100)),
      c('e', '<synthetic>', u(0, 0, 0, 0)),
    ];
    const s = summarize({ mains: [{ calls, firstTs: '2026-10-10T00:00:00Z' }], subs: [], registry: null, fixes: null, window: {} });
    expect(s.costUsd).toBe(0.024);
    expect(Object.entries(s.costUsdByModel)).toEqual([['claude-haiku-4-5', 0.012], ['claude-opus-5-5', 0.006], ['claude-sonnet-5', 0.006]]);
    expect(s.unpricedModels).toEqual({ 'mystery-model-9': 1 });
    expect(s.pricesAsOf).toBe('2026-10-20');
  });
});

describe('cross-file dedupe and empty sessions', () => {
  const call = (id, ctx, out = 1) => ({ id, usage: u(ctx, 0, 0, out), tools: [], skills: [] });
  const tr = (file, calls) => ({ file, calls, firstTs: '2026-10-10T00:00:00Z', lastTs: '2026-10-10T00:00:00Z' });

  test('two main files sharing message ids are counted once', () => {
    const a = tr('/p/a.jsonl', [call('m1', 100), call('m2', 200)]);
    const copy = tr('/p/b.jsonl', [call('m1', 100), call('m2', 200)]);
    const s = summarize({ mains: [copy, a], subs: [], registry: null, fixes: null, window: {} });
    expect(s.mainSessions).toBe(1);
    expect(s.apiCalls).toBe(2);
    expect(s.tokens.input).toBe(300);
  });

  test('subagent files sharing message ids are counted once', () => {
    const one = { ...tr('/p/s/agent-1.jsonl', [call('s1', 50)]), agentType: 'chef' };
    const two = { ...tr('/p/s/agent-2.jsonl', [call('s1', 50)]), agentType: 'chef' };
    const s = summarize({ mains: [], subs: [one, two], registry: null, fixes: null, window: {} });
    expect(s.subagentRuns).toBe(1);
    expect(s.subagentsByType).toEqual({ chef: 1 });
  });

  test('a transcript without API calls is not a session', () => {
    const s = summarize({ mains: [tr('/p/a.jsonl', [call('m1', 10)]), tr('/p/empty.jsonl', [])], subs: [], registry: null, fixes: null, window: {} });
    expect(s.mainSessions).toBe(1);
  });

  test('a zero-context first call is skipped when picking the first-call context', () => {
    const s = summarize({ mains: [tr('/p/a.jsonl', [call('m0', 0, 0), call('m1', 400)])], subs: [], registry: null, fixes: null, window: {} });
    expect(s.medianFirstCallContext.main).toBe(400);
  });
});

describe('repoMatches', () => {
  test('repo field matches only on its last path component', () => {
    expect(repoMatches({ repo: '/x/dawnbook' }, '/h/book')).toBe(false);
    expect(repoMatches({ repo: '/x/book/' }, '/h/book')).toBe(true);
  });

  test('worktree matches only a <name>-wt component, plus ai-skills-wt for vivera', () => {
    expect(repoMatches({ worktree: '/h/vivera/Snipset-wt/s' }, '/h/vivera')).toBe(false);
    expect(repoMatches({ worktree: '/h/Snipset-wt/s' }, '/h/Snipset')).toBe(true);
    expect(repoMatches({ worktree: '/h/ai-skills-wt/s' }, '/h/vivera')).toBe(true);
    expect(repoMatches({ worktree: '/h/ai-skills-wt/s' }, '/h/Snipset')).toBe(false);
  });
});

describe('CLI', () => {
  test('an impossible calendar date exits 2', () => {
    const f = fixture();
    expect(run(f, '--since', '2026-02-31').code).toBe(2);
    expect(run(f, '--until', '2026-13-01').code).toBe(2);
  });

  test('--json reports exact counts, ratios, and escapes for the window', () => {
    const f = fixture();
    const r = run(f, '--since', '2026-10-05', '--until', '2026-10-12', '--json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.window).toEqual({ since: '2026-10-05', until: '2026-10-12' });
    expect(j.mainSessions).toBe(1);
    expect(j.subagentRuns).toBe(1);
    expect(j.subagentsPerMain).toBe(1);
    expect(j.apiCalls).toBe(4);
    expect(j.tokens).toEqual({ input: 20, cacheWrite: 1800, cacheRead: 1500, output: 110 });
    expect(j.costWeights).toBeUndefined();
    expect(j.costUnits).toBeUndefined();
    // Opus 5.5: m1 6040 + m2 1620 = 7660 per million; Haiku 4.5: s1 678 + s2 327 = 1005.
    expect(j.costUsd).toBe(0.0087);
    expect(Object.entries(j.costUsdByModel)).toEqual([['claude-opus-5-5', 0.0077], ['claude-haiku-4-5', 0.001]]);
    expect(j.unpricedModels).toEqual({});
    expect(j.pricesAsOf).toBe('2026-10-20');
    expect(j.notes).toEqual([]);
    expect(j.medianFirstCallContext).toEqual({ main: 1010, subagent: 503 });
    expect(j.startupPrefixShare).toBeCloseTo(1006 / 1105, 4);
    expect(j.subagentsByType).toEqual({ chef: 1 });
    expect(j.askUserQuestion).toBe(1);
    expect(j.skills).toEqual({ 'sucp-rules': 1 });
    expect(j.mergedPrs).toBe(2);
    expect(j.escapes).toBe(1);
    // 8665 per million over 2 merged PRs is 0.0043325.
    expect(j.perMergedPr).toEqual({ contextTokens: 1660, outputTokens: 55, costUsd: 0.0043, askUserQuestion: 0.5, escapes: 0.5 });
  });

  test('a model without a price is left out of costUsd and named in a note', () => {
    const f = fixture();
    const r = run(f, '--json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.costUsd).toBe(0.0087);
    expect(j.unpricedModels).toEqual({ 'claude-future-9': 1 });
    expect(j.notes).toContain('1 call(s) from models without a price (claude-future-9 x1); costUsd leaves them out, it is not zero for them');
  });

  test('text output prints the list-price rows and never any transcript content', () => {
    const f = fixture();
    const r = run(f);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('cost-weighted');
    expect(r.out).toMatch(/API list-price equivalent, USD\s+0\.0087\n/);
    expect(r.out).toMatch(/prices as of\s+2026-10-20\n/);
    expect(r.out).toMatch(/per merged PR: API list-price USD\s+0\.0029\n/);
    expect(r.out).toMatch(/API list-price USD by model\n\s+claude-opus-5-5\s+0\.0077\n\s+claude-haiku-4-5\s+0\.001\n/);
    expect(r.out).toContain('note: 1 call(s) from models without a price (claude-future-9 x1)');
    expect(r.out).toMatch(/main sessions\s+2/);
    expect(r.out + r.err).not.toContain(SECRET);
    expect(run(f, '--json').out).not.toContain(SECRET);
  });

  test('a missing project dir exits 1 and says so', () => {
    const f = fixture();
    const r = spawnSync(process.execPath, [SCRIPT, '--repo', f.repo, '--projects-dir', path.join(f.root, 'nope'), '--registry', f.registry], { env: ENV, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not found');
  });

  test('usage errors exit 2', () => {
    const f = fixture();
    expect(run(f, '--bogus').code).toBe(2);
    expect(run(f, '--since', '10/05/2026').code).toBe(2);
  });
});
