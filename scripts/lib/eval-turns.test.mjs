import { describe, expect, test } from 'bun:test';
import { parseStream } from '../eval-score.mjs';
import { mergeParsed, runTurns, scoreTurns, sessionFlags, turnsOf } from './eval-turns.mjs';

// One recorded turn: a final message, optional tool calls, and its cost.
function turn(final, { tools = [], cost = 0.1, subtype = 'success' } = {}) {
  const lines = tools.map(([name, input]) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name, input }] } }));
  lines.push({ type: 'result', subtype, num_turns: tools.length + 1, total_cost_usd: cost, usage: { input_tokens: 1 }, result: final });
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

describe('turnsOf', () => {
  test('a single prompt is one turn; turns pass through', () => {
    expect(turnsOf({ prompt: 'p' })).toEqual([{ prompt: 'p' }]);
    const turns = [{ prompt: 'a' }, { prompt: '1', assertions: [] }];
    expect(turnsOf({ turns })).toBe(turns);
  });
});

describe('sessionFlags', () => {
  test('a one-turn run keeps no session; a multi-turn run starts one and resumes it', () => {
    expect(sessionFlags(null)).toEqual(['--no-session-persistence']);
    expect(sessionFlags({ id: 'u-1', resume: false })).toEqual(['--session-id', 'u-1']);
    expect(sessionFlags({ id: 'u-1', resume: true })).toEqual(['--resume', 'u-1']);
  });
});

describe('runTurns', () => {
  test('runs every turn with the session, the invoke only on the first, and the budget left', async () => {
    const calls = [];
    const outs = [turn('1. Approve\n2. Change', { cost: 0.3 }), turn('done', { cost: 0.2 })];
    const r = await runTurns({
      turns: [{ prompt: 'build it' }, { prompt: '1' }],
      budget: 1,
      newId: () => 'u-1',
      runTurn: async (t) => { calls.push(t); return { stdout: outs[calls.length - 1], status: 0 }; },
    });
    expect(calls.map((c) => [c.prompt, c.first, c.session, c.budget])).toEqual([
      ['build it', true, { id: 'u-1', resume: false }, 1],
      ['1', false, { id: 'u-1', resume: true }, 0.7],
    ]);
    expect(r.parsed.map((p) => p.final)).toEqual(['1. Approve\n2. Change', 'done']);
    expect(r.stdout).toBe(`${outs[0]}\n${outs[1]}`);
  });

  test('stops when the budget of the attempt is spent or a turn ended on a max-turns or max-budget limit', async () => {
    for (const first of [turn('x', { cost: 1.2 }), turn('x', { cost: 0.1, subtype: 'error_max_turns' }), turn('x', { cost: 0.1, subtype: 'error_max_budget_usd' })]) {
      let n = 0;
      await runTurns({ turns: [{ prompt: 'a' }, { prompt: 'b' }], budget: 1, newId: () => 'u', runTurn: async () => { n++; return { status: 0, stdout: first }; } });
      expect(n).toBe(1);
    }
  });

  test('a one-turn scenario starts no session', async () => {
    const calls = [];
    await runTurns({ turns: [{ prompt: 'p' }], budget: 2, newId: () => 'x', runTurn: async (t) => { calls.push(t); return { stdout: turn('ok'), status: 0 }; } });
    expect(calls[0].session).toBe(null);
  });

  test('stops after a turn that timed out, failed to start, or ended without a result', async () => {
    for (const bad of [{ timedOut: true, stdout: '' }, { spawnError: new Error('x'), stdout: '' }, { stdout: '{"type":"assistant"}' }]) {
      let n = 0;
      const r = await runTurns({ turns: [{ prompt: 'a' }, { prompt: 'b' }], budget: 2, newId: () => 'u', runTurn: async () => { n++; return { status: 0, ...bad }; } });
      expect(n).toBe(1);
      expect(r.parsed).toHaveLength(1);
      expect(r.last).toMatchObject(bad);
    }
  });
});

describe('mergeParsed', () => {
  test('joins tool calls with their turn, sums cost and turns, keeps every final, and takes the last result', () => {
    const a = parseStream(turn('1. Yes\n2. No', { tools: [['Read', { file_path: 'a' }]], cost: 0.25 }));
    const b = parseStream(turn('done', { tools: [['Bash', { command: 'bun test' }]], cost: 0.5 }));
    const m = mergeParsed([a, b]);
    expect(m.final).toBe('done');
    expect(m.finals).toEqual(['1. Yes\n2. No', 'done']);
    expect(m.toolUses.map((t) => [t.name, t.turn])).toEqual([['Read', 1], ['Bash', 2]]);
    expect(m.result.total_cost_usd).toBeCloseTo(0.75, 6);
    expect(m.result.num_turns).toBe(4);
    expect(m.result.subtype).toBe('success');
  });

  test('a turn with no result makes the merged result unknown', () => {
    const m = mergeParsed([parseStream(turn('x')), parseStream('{"type":"assistant","message":{"content":[]}}')]);
    expect(m.result.subtype).toBe(null);
  });
});

describe('scoreTurns', () => {
  test('scores each turn\'s own assertions against that turn only, and names the turn', () => {
    const parsed = [parseStream(turn('1. Approve\n2. Change')), parseStream(turn('done', { tools: [['Bash', { command: 'bun test' }]] }))];
    const turns = [
      { prompt: 'a', assertions: [{ type: 'final_options', min: 2 }, { type: 'bash_never', pattern: 'bun test', scope: 'all' }] },
      { prompt: '1', assertions: [{ type: 'bash_some', pattern: 'bun test', scope: 'all' }, { type: 'final_options', min: 2 }] },
    ];
    const r = scoreTurns(parsed, turns, {});
    expect(r.map((x) => [x.type, x.pass])).toEqual([
      ['turn 1: final_options', true], ['turn 1: bash_never', true], ['turn 2: bash_some', true], ['turn 2: final_options', false],
    ]);
  });

  test('with one facts record per turn, a file assertion reads the files as that turn left them', () => {
    const parsed = [parseStream(turn('1. a\n2. b')), parseStream(turn('done'))];
    const turns = [{ prompt: 'a', assertions: [{ type: 'fixture_unchanged' }] }, { prompt: '1', assertions: [{ type: 'fixture_changed' }] }];
    const r = scoreTurns(parsed, turns, [{ statusPorcelain: '' }, { statusPorcelain: ' M math.mjs\n' }]);
    expect(r.map((x) => x.pass)).toEqual([true, true]);
  });

  test('a turn that never ran fails each of its assertions', () => {
    const r = scoreTurns([parseStream(turn('x'))], [{ prompt: 'a' }, { prompt: 'b', assertions: [{ type: 'final_options', min: 1 }] }], {});
    expect(r).toEqual([{ type: 'turn 2: final_options', pass: false, detail: 'turn 2 did not run' }]);
  });
});
