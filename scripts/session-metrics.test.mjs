import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTranscript, slugFor, summarize } from './session-metrics.mjs';

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
const asst = (ts, id, usage, content) => ({ type: 'assistant', timestamp: ts, message: { id, usage, content } });
const writeJsonl = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

// Main A (in window): m1 streamed over two lines, then m2. One chef subagent run.
// Main B (2026-10-01) sits outside a window that starts 2026-10-05.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-metrics-'));
  dirs.push(root);
  const proj = path.join(root, 'projects');
  writeJsonl(path.join(proj, 'sess-a.jsonl'), [
    { type: 'user', timestamp: '2026-10-10T10:00:00.000Z', message: { role: 'user', content: SECRET } },
    asst('2026-10-10T10:00:01.000Z', 'm1', u(10, 1000, 0, 5), [{ type: 'text', text: `token ${SECRET}` }]),
    asst('2026-10-10T10:00:02.000Z', 'm1', u(10, 1000, 0, 50), [
      { type: 'tool_use', id: 'tu1', name: 'Agent', input: { prompt: SECRET } },
    ]),
    asst('2026-10-10T10:01:00.000Z', 'm2', u(5, 200, 1000, 20), [
      { type: 'tool_use', id: 'tu2', name: 'AskUserQuestion', input: { questions: [SECRET] } },
      { type: 'tool_use', id: 'tu3', name: 'Skill', input: { skill: 'sucp-rules' } },
    ]),
  ]);
  const subDir = path.join(proj, 'sess-a', 'subagents');
  writeJsonl(path.join(subDir, 'agent-x1.jsonl'), [
    asst('2026-10-10T10:00:10.000Z', 's1', u(3, 500, 0, 10), [{ type: 'text', text: SECRET }]),
    asst('2026-10-10T10:00:20.000Z', 's2', u(2, 100, 500, 30), [{ type: 'tool_use', id: 'tu4', name: 'Bash', input: { command: SECRET } }]),
  ]);
  fs.writeFileSync(path.join(subDir, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'chef' }));
  writeJsonl(path.join(proj, 'sess-b.jsonl'), [
    asst('2026-10-01T09:00:00.000Z', 'm3', u(1, 1, 1, 1), []),
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
    const t = { calls: [], firstTs: '2026-10-10T00:00:00Z' };
    const subs = [{ ...t, agentType: ' chef ' }, { ...t, agentType: `leak ${SECRET}` }];
    const s = summarize({ mains: [], subs, registry: null, fixes: null, window: {} });
    expect(s.subagentsByType).toEqual({ chef: 1, '<other>': 1 });
  });
});

describe('CLI', () => {
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
    expect(j.costWeights).toEqual({ input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 });
    expect(j.costUnits).toBe(4320);
    expect(j.medianFirstCallContext).toEqual({ main: 1010, subagent: 503 });
    expect(j.startupPrefixShare).toBeCloseTo(1006 / 1105, 4);
    expect(j.subagentsByType).toEqual({ chef: 1 });
    expect(j.askUserQuestion).toBe(1);
    expect(j.skills).toEqual({ 'sucp-rules': 1 });
    expect(j.mergedPrs).toBe(2);
    expect(j.escapes).toBe(1);
    expect(j.perMergedPr).toEqual({ contextTokens: 1660, outputTokens: 55, costUnits: 2160, askUserQuestion: 0.5, escapes: 0.5 });
  });

  test('text output prints the weights and never any transcript content', () => {
    const f = fixture();
    const r = run(f);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0.1*cache_read + 2*cache_write + 5*output + input');
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
