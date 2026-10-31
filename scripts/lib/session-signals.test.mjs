import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheRebuildTurns, readTranscriptSignals, repeatedCallRuns } from './session-signals.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const bash = (command) => ({ name: 'Bash', input: { command } });
const read = (file_path) => ({ name: 'Read', input: { file_path } });
const turn = (input, write, readTokens) => ({
  usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: readTokens },
});
const opening = turn(0, 200000, 0);

describe('repeatedCallRuns', () => {
  test('a run of 3 identical consecutive calls is counted', () => {
    const s = bash('git status');
    expect(repeatedCallRuns([read('/a'), s, s, s, read('/b')])).toEqual({ runs: 1, calls: 3 });
  });

  test('a run of 2 is below the default minimum', () => {
    const s = bash('git status');
    expect(repeatedCallRuns([s, s, read('/a')])).toEqual({ runs: 0, calls: 0 });
  });

  test('identical calls interleaved with another call are not a run', () => {
    const s = bash('git status');
    expect(repeatedCallRuns([s, read('/a'), s, read('/a'), s])).toEqual({ runs: 0, calls: 0 });
  });

  test('a different input breaks a run', () => {
    expect(repeatedCallRuns([bash('ls'), bash('ls'), bash('ls -la'), bash('ls')])).toEqual({ runs: 0, calls: 0 });
  });

  test('the same input under another tool name breaks a run', () => {
    const input = { file_path: '/a' };
    const calls = [{ name: 'Read', input }, { name: 'Read', input }, { name: 'Edit', input }];
    expect(repeatedCallRuns(calls)).toEqual({ runs: 0, calls: 0 });
  });

  test('each counted run adds its full length to calls', () => {
    const s = bash('sleep 5');
    const r = read('/x');
    expect(repeatedCallRuns([s, s, s, s, s, r, r, r])).toEqual({ runs: 2, calls: 8 });
  });

  test('min is configurable', () => {
    const s = bash('ls');
    expect(repeatedCallRuns([s, s, read('/a')], 2)).toEqual({ runs: 1, calls: 2 });
  });

  test('an empty list has no runs', () => {
    expect(repeatedCallRuns([])).toEqual({ runs: 0, calls: 0 });
  });
});

describe('cacheRebuildTurns', () => {
  test('a cache write above half of a context over 50k is a cache rebuild', () => {
    // context 100001, write 50001 > 50000.5
    expect(cacheRebuildTurns([opening, turn(0, 50001, 50000)])).toBe(1);
  });

  test('a write of exactly half the context is not a cache rebuild', () => {
    // context 100000, write 50000, not greater than 50000
    expect(cacheRebuildTurns([opening, turn(0, 50000, 50000)])).toBe(0);
  });

  test('a context of 50k or less is ignored even when it is all writes', () => {
    expect(cacheRebuildTurns([opening, turn(0, 50000, 0), turn(0, 40000, 0)])).toBe(0);
    expect(cacheRebuildTurns([opening, turn(0, 50001, 0)])).toBe(1);
  });

  test('the first assistant turn of a transcript is skipped', () => {
    expect(cacheRebuildTurns([opening])).toBe(0);
    expect(cacheRebuildTurns([opening, opening])).toBe(1);
  });

  test('missing usage fields count as 0', () => {
    const turns = [opening, {}, { usage: {} }, { usage: { cache_creation_input_tokens: 60000 } }, { usage: { input_tokens: 90000 } }];
    expect(cacheRebuildTurns(turns)).toBe(1);
  });

  test('ratio and minContext are configurable', () => {
    const t = turn(0, 300, 700);
    expect(cacheRebuildTurns([opening, t], { ratio: 0.25, minContext: 999 })).toBe(1);
    expect(cacheRebuildTurns([opening, t], { ratio: 0.25 })).toBe(0);
  });
});

describe('readTranscriptSignals', () => {
  test('dedupes streamed lines by message id and tool_use id, then counts both signals', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-signals-'));
    dirs.push(root);
    const file = path.join(root, 's.jsonl');
    const use = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
    const asst = (id, usage, content) => ({ type: 'assistant', message: { id, usage, content } });
    const rebuild = turn(0, 80000, 20000).usage;
    const lines = [
      asst('m0', rebuild, [{ type: 'text', text: 'hi' }]),
      asst('m1', rebuild, [use('t1', 'git status')]),
      // The same message streamed again on a second line must not count twice.
      asst('m1', rebuild, [use('t1', 'git status')]),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
      asst('m2', turn(0, 10, 100000).usage, [use('t2', 'git status')]),
      asst('m3', turn(0, 10, 100000).usage, [use('t3', 'git status')]),
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
    expect(await readTranscriptSignals(file)).toEqual({ repeatedToolCallRuns: { runs: 1, calls: 3 }, cacheRebuildTurns: 1 });
  });
});
