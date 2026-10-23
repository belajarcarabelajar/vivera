import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSERTION_TYPES, parseStream, score } from './eval-score.mjs';

const STREAMS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'fixtures', 'streams');
const load = (name) => parseStream(fs.readFileSync(path.join(STREAMS, `${name}.jsonl`), 'utf8'));

const ask = load('ask');
const agent = load('agent');
const skill = load('skill');

function facts(over = {}) {
  return { statusPorcelain: '', initialFiles: {}, files: {}, commitMessages: [], ...over };
}

function one(parsed, f, assertion) {
  const results = score(parsed, f, [assertion]);
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe(assertion.type);
  return results[0];
}

// A main-scope Bash call that no recorded stream holds.
function syntheticBash(command) {
  const lines = [
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } },
    { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1 }, result: 'done' },
  ];
  return parseStream(lines.map((l) => JSON.stringify(l)).join('\n'));
}

// One assistant event per [name, input] pair, in order, all under one parent.
function syntheticTools(calls, parent = null) {
  const lines = calls.map(([name, input]) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', name, input }] } }));
  lines.push({ type: 'result', subtype: 'success', num_turns: calls.length, total_cost_usd: 0.01, usage: { input_tokens: 1 }, result: 'done' });
  return parseStream(lines.map((l) => JSON.stringify(l)).join('\n'));
}

describe('parseStream', () => {
  test('reads the result event of a recorded stream', () => {
    expect(skill.result.subtype).toBe('success');
    expect(skill.result.num_turns).toBe(3);
    expect(skill.result.total_cost_usd).toBeCloseTo(0.0529636, 6);
    expect(skill.result.usage.cache_read_input_tokens).toBe(29858);
    expect(skill.final).toContain('ZEBRA-4417');
    expect(skill.events.length).toBeGreaterThan(3);
  });

  test('scopes tool uses by parent_tool_use_id', () => {
    expect(agent.toolUses.map((t) => [t.name, t.scope])).toEqual([['Agent', 'main'], ['Bash', 'sub']]);
    expect(agent.toolUses[1].input.command).toContain('ls -A');
  });

  test('skips non-JSON lines and survives a stream without a result event', () => {
    const p = parseStream('warning: not json\n{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"partial"}]}}\n');
    expect(p.events).toHaveLength(1);
    expect(p.final).toBe('partial');
    expect(p.result.subtype).toBe(null);
  });
});

describe('score', () => {
  test('ASSERTION_TYPES lists exactly the contract names', () => {
    expect([...ASSERTION_TYPES].sort()).toEqual([
      'bash_never', 'bash_some', 'commits_lack', 'file_exists', 'file_lacks', 'file_missing', 'file_unchanged',
      'final_matches', 'final_mentions', 'final_options', 'fixture_changed', 'fixture_unchanged', 'gate_count', 'skill_loaded',
      'tool_count',
    ]);
  });

  test('an unknown assertion type fails and names itself', () => {
    const r = one(ask, facts(), { type: 'vibes_ok' });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('vibes_ok');
  });

  test('fixture_unchanged passes on a clean status that only shows .claude/', () => {
    expect(one(ask, facts({ statusPorcelain: '?? .claude/settings.local.json\n' }), { type: 'fixture_unchanged' }).pass).toBe(true);
  });

  test('fixture_unchanged fails on a changed file', () => {
    expect(one(ask, facts({ statusPorcelain: '?? greeting.txt\n' }), { type: 'fixture_unchanged' }).pass).toBe(false);
  });

  test('fixture_unchanged fails when the run committed its change', () => {
    expect(one(ask, facts({ commitMessages: ['add greeting'] }), { type: 'fixture_unchanged' }).pass).toBe(false);
  });

  test('fixture_changed passes on a changed file and fails on a clean tree', () => {
    expect(one(ask, facts({ statusPorcelain: ' M a.txt\n' }), { type: 'fixture_changed' }).pass).toBe(true);
    expect(one(ask, facts(), { type: 'fixture_changed' }).pass).toBe(false);
  });

  test('final_options passes on the numbered choice in the ask stream', () => {
    expect(one(ask, facts(), { type: 'final_options' }).pass).toBe(true);
  });

  test('final_options fails with a short excerpt when the list is too short', () => {
    const r = one(ask, facts(), { type: 'final_options', min: 3 });
    expect(r.pass).toBe(false);
    const excerpt = r.detail.slice(r.detail.indexOf('"') + 1, r.detail.lastIndexOf('"'));
    expect(excerpt.length).toBeLessThanOrEqual(160);
    expect(one(skill, facts(), { type: 'final_options' }).pass).toBe(false);
  });

  test('tool_count counts by name and scope', () => {
    expect(one(agent, facts(), { type: 'tool_count', tool: 'Agent', min: 1, max: 1, scope: 'main' }).pass).toBe(true);
    expect(one(agent, facts(), { type: 'tool_count', tool: 'Bash', min: 1, scope: 'sub' }).pass).toBe(true);
    expect(one(agent, facts(), { type: 'tool_count', tool: 'Bash', max: 0, scope: 'all' }).pass).toBe(false);
  });

  test('tool_count fails below min and on a main-scope count of a sub-only tool', () => {
    expect(one(agent, facts(), { type: 'tool_count', tool: 'Bash', min: 1, scope: 'main' }).pass).toBe(false);
    expect(one(skill, facts(), { type: 'tool_count', tool: 'Agent', min: 1 }).pass).toBe(false);
  });

  test('skill_loaded passes on a Skill call or a Read of the SKILL.md, and only for that skill', () => {
    const viaSkill = syntheticTools([['Skill', { skill: 'sucp-tdd-debug' }]]);
    const viaRead = syntheticTools([['Read', { file_path: '/tmp/p/.claude/skills/sucp-tdd-debug/SKILL.md' }]]);
    const other = syntheticTools([['Skill', { skill: 'sucp-rules' }], ['Read', { file_path: '/tmp/p/.claude/skills/sucp-tdd-debug/references/a.md' }]]);
    const a = { type: 'skill_loaded', skill: 'sucp-tdd-debug', scope: 'main' };
    expect(one(viaSkill, facts(), a).pass).toBe(true);
    expect(one(viaRead, facts(), a).pass).toBe(true);
    const r = one(other, facts(), a);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('sucp-tdd-debug');
  });

  test('skill_loaded with before needs the load ahead of the first matching Bash call', () => {
    const late = syntheticTools([['Bash', { command: 'ls' }], ['Bash', { command: 'bun test a.test.mjs' }], ['Skill', { skill: 'sucp-tdd-debug' }]]);
    const early = syntheticTools([['Bash', { command: 'ls' }], ['Skill', { skill: 'sucp-tdd-debug' }], ['Bash', { command: 'bun test' }]]);
    const neverRan = syntheticTools([['Skill', { skill: 'sucp-tdd-debug' }]]);
    const a = { type: 'skill_loaded', skill: 'sucp-tdd-debug', scope: 'main', before: '\\bbun test\\b' };
    expect(one(late, facts(), a).pass).toBe(false);
    expect(one(early, facts(), a).pass).toBe(true);
    expect(one(neverRan, facts(), a).pass).toBe(true);
  });

  test('skill_loaded does not count a Skill call whose result is an error', () => {
    const lines = [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'sucp-tdd-debug' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Unknown skill' }] } },
      { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1 }, result: 'done' },
    ];
    const failed = parseStream(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(one(failed, facts(), { type: 'skill_loaded', skill: 'sucp-tdd-debug', scope: 'main' }).pass).toBe(false);
    lines[1].message.content[0].is_error = false;
    const ok = parseStream(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(one(ok, facts(), { type: 'skill_loaded', skill: 'sucp-tdd-debug', scope: 'main' }).pass).toBe(true);
  });

  test('gate_count counts the turns whose final message is a numbered option list', () => {
    const merged = { final: 'done', finals: ['1. Approve\n2. Change', 'Plan:\n1. only one step', 'done'], toolUses: [] };
    expect(one(merged, facts(), { type: 'gate_count', min: 1, max: 1 }).pass).toBe(true);
    const r = one(merged, facts(), { type: 'gate_count', max: 0 });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('1 gate');
    expect(one({ final: '1. a\n2. b', toolUses: [] }, facts(), { type: 'gate_count', min: 1 }).pass).toBe(true);
  });

  test('skill_loaded respects scope', () => {
    const sub = syntheticTools([['Skill', { skill: 'sucp-tdd-debug' }]], 'toolu_parent');
    expect(one(sub, facts(), { type: 'skill_loaded', skill: 'sucp-tdd-debug', scope: 'main' }).pass).toBe(false);
    expect(one(sub, facts(), { type: 'skill_loaded', skill: 'sucp-tdd-debug', scope: 'sub' }).pass).toBe(true);
  });

  test('bash_never passes when no command matches and fails without echoing the command', () => {
    const p = syntheticBash('git commit -m wip');
    expect(one(p, facts(), { type: 'bash_never', pattern: 'git push', scope: 'main' }).pass).toBe(true);
    const r = one(p, facts(), { type: 'bash_never', pattern: 'git commit', scope: 'main' });
    expect(r.pass).toBe(false);
    expect(r.detail).not.toContain('wip');
  });

  test('bash patterns are case-sensitive unless they start with (?i)', () => {
    const p = syntheticBash('GIT status');
    expect(one(p, facts(), { type: 'bash_some', pattern: 'git status', scope: 'all' }).pass).toBe(false);
    expect(one(p, facts(), { type: 'bash_some', pattern: '(?i)git status', scope: 'all' }).pass).toBe(true);
  });

  test('bash_some respects scope', () => {
    expect(one(agent, facts(), { type: 'bash_some', pattern: 'ls -A', scope: 'sub' }).pass).toBe(true);
    expect(one(agent, facts(), { type: 'bash_some', pattern: 'ls -A', scope: 'main' }).pass).toBe(false);
  });

  test('file_exists and file_missing read collected files', () => {
    const f = facts({ files: { 'a.txt': 'x', 'b.txt': null } });
    expect(one(ask, f, { type: 'file_exists', path: 'a.txt' }).pass).toBe(true);
    expect(one(ask, f, { type: 'file_exists', path: 'b.txt' }).pass).toBe(false);
    expect(one(ask, f, { type: 'file_missing', path: 'b.txt' }).pass).toBe(true);
    expect(one(ask, f, { type: 'file_missing', path: 'a.txt' }).pass).toBe(false);
  });

  test('a file assertion on an uncollected path fails instead of guessing', () => {
    expect(one(ask, facts(), { type: 'file_missing', path: 'nowhere.txt' }).pass).toBe(false);
  });

  test('file_unchanged compares with the initial commit', () => {
    const f = facts({ initialFiles: { 'a.txt': 'one', 'b.txt': 'one' }, files: { 'a.txt': 'one', 'b.txt': 'two' } });
    expect(one(ask, f, { type: 'file_unchanged', path: 'a.txt' }).pass).toBe(true);
    expect(one(ask, f, { type: 'file_unchanged', path: 'b.txt' }).pass).toBe(false);
  });

  test('file_lacks passes on absent text and fails on present text', () => {
    const f = facts({ files: { 'a.md': 'keep this\nTODO later' } });
    expect(one(ask, f, { type: 'file_lacks', path: 'a.md', pattern: 'FIXME' }).pass).toBe(true);
    expect(one(ask, f, { type: 'file_lacks', path: 'a.md', pattern: 'TODO' }).pass).toBe(false);
  });

  test('final_matches is case-insensitive', () => {
    expect(one(skill, facts(), { type: 'final_matches', pattern: 'zebra-4417' }).pass).toBe(true);
    expect(one(skill, facts(), { type: 'final_matches', pattern: 'giraffe' }).pass).toBe(false);
  });

  test('final_mentions needs min of the patterns', () => {
    const a = { type: 'final_mentions', patterns: ['hello', 'hi\\b', 'howdy'] };
    expect(one(ask, facts(), { ...a, min: 2 }).pass).toBe(true);
    expect(one(ask, facts(), { ...a, min: 3 }).pass).toBe(false);
  });

  test('commits_lack checks commit messages from the run', () => {
    const f = facts({ commitMessages: ['feat: add x\n\nProbe-Trailer: someone'] });
    expect(one(ask, f, { type: 'commits_lack', pattern: '(?i)probe-trailer' }).pass).toBe(false);
    expect(one(ask, f, { type: 'commits_lack', pattern: 'probe-trailer' }).pass).toBe(true);
  });

  test('an invalid regex fails the assertion instead of throwing', () => {
    expect(one(skill, facts(), { type: 'final_matches', pattern: '(' }).pass).toBe(false);
  });
});
