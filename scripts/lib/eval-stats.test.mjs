import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { failedStreamPath, keepFailedStream, passK, pruneStreamRuns, wilson } from './eval-stats.mjs';
import { line, printSummary } from './eval-run-report.mjs';

// Expected bounds are published Wilson 95% intervals for n = 5, not recomputed here.
describe('wilson', () => {
  test('5/5 has a lower bound near 0.566 and an upper bound of 1', () => {
    const { low, high } = wilson(5, 5);
    expect(low).toBeCloseTo(0.5655, 3);
    expect(high).toBeCloseTo(1, 6);
    expect(high).toBeLessThanOrEqual(1);
  });

  test('0/5 has a lower bound of 0 and an upper bound near 0.434', () => {
    const { low, high } = wilson(0, 5);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeCloseTo(0, 6);
    expect(high).toBeCloseTo(0.4345, 3);
  });

  test('3/5 spans about 0.231 to 0.882', () => {
    const { low, high } = wilson(3, 5);
    expect(low).toBeCloseTo(0.2307, 3);
    expect(high).toBeCloseTo(0.8824, 3);
  });

  test('no attempts gives the whole range', () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('passK', () => {
  test('is the chance that k runs in a row all pass', () => {
    expect(passK(0.8, 5)).toBeCloseTo(0.32768, 10);
    expect(passK(1, 5)).toBe(1);
    expect(passK(0.5, 1)).toBe(0.5);
  });
});

const rec = (over) => ({ id: 'gate-a', pass: true, results: [], turns: 3, cost: 0.1, seconds: 2, attempts: 1, passes: 1, ...over });

describe('line', () => {
  test('a repeated scenario shows the 95% interval after its pass count', () => {
    expect(line(rec({ attempts: 5, passes: 3 }), 6)).toContain('passes=3/5 (95% CI 0.23-0.88)');
    expect(line(rec({ attempts: 5, passes: 5 }), 6)).toContain('passes=5/5 (95% CI 0.57-1.00)');
  });

  test('a single attempt line has no interval', () => {
    expect(line(rec({}), 6)).not.toContain('CI');
  });

  test('a stream without a kept fixture prints only the stream', () => {
    const text = line(rec({ pass: false, stream: '/x/gate-a.stream.jsonl' }), 6);
    expect(text).toContain('stream=/x/gate-a.stream.jsonl');
    expect(text).not.toContain('fixture=');
  });
});

describe('printSummary', () => {
  let spy;
  afterEach(() => spy?.mockRestore());
  const capture = (done) => {
    spy = spyOn(console, 'log').mockImplementation(() => {});
    printSummary(done, 0);
    return spy.mock.calls.map((c) => c[0]);
  };

  test('prints pass^k for each scenario with at least five attempts', () => {
    const lines = capture([
      rec({ id: 'a', attempts: 5, passes: 4, pass_rate: 0.8 }),
      rec({ id: 'b', attempts: 5, passes: 5, pass_rate: 1 }),
    ]);
    expect(lines.filter((l) => l.startsWith('pass^'))).toEqual(['pass^5: a 0.33', 'pass^5: b 1.00']);
  });

  test('prints no pass^k line when no scenario ran five times', () => {
    const lines = capture([rec({ id: 'a', attempts: 3, passes: 2, pass_rate: 2 / 3 }), rec({ id: 'b', skipped: true, attempts: 0 })]);
    expect(lines.some((l) => l.startsWith('pass^'))).toBe(false);
  });
});

describe('failed streams', () => {
  const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'eval-stats-'));

  test('failedStreamPath puts a failed attempt under streams/<runId>', () => {
    expect(failedStreamPath('/r/evals', 'run1', 'gate-a', '-2')).toBe('/r/evals/streams/run1/gate-a-2.stream.jsonl');
  });

  test('keepFailedStream writes the stream and returns its path', () => {
    const dir = tmp();
    const file = keepFailedStream(dir, 'run1', 'gate-a', '', 'line\n');
    expect(file).toBe(path.join(dir, 'streams', 'run1', 'gate-a.stream.jsonl'));
    expect(fs.readFileSync(file, 'utf8')).toBe('line\n');
  });

  test('keepFailedStream warns once and returns undefined when the write fails', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'streams'), 'a file, not a dir');
    const warn = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(keepFailedStream(dir, 'run1', 'gate-a', '', 'x')).toBeUndefined();
      expect(warn.mock.calls.length).toBe(1);
      expect(String(warn.mock.calls[0][0])).toStartWith('warning:');
    } finally {
      warn.mockRestore();
    }
  });

  test('pruneStreamRuns keeps the newest five of six run dirs', () => {
    const dir = tmp();
    const names = ['2026-10-01T00-00-00-000Z-1', '2026-10-02T00-00-00-000Z-1', '2026-10-03T00-00-00-000Z-1',
      '2026-10-04T00-00-00-000Z-1', '2026-10-05T00-00-00-000Z-1', '2026-10-06T00-00-00-000Z-1'];
    for (const n of [...names].reverse()) fs.mkdirSync(path.join(dir, n));
    fs.writeFileSync(path.join(dir, names[0], 'x.stream.jsonl'), 'x');
    pruneStreamRuns(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(1));
  });

  test('pruneStreamRuns is silent when the dir does not exist and warns once on an error', () => {
    const warn = spyOn(console, 'error').mockImplementation(() => {});
    try {
      pruneStreamRuns(path.join(tmp(), 'missing'));
      expect(warn.mock.calls.length).toBe(0);
      const file = path.join(tmp(), 'plain');
      fs.writeFileSync(file, 'not a dir');
      pruneStreamRuns(file);
      expect(warn.mock.calls.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// The real runner with a stub claude that prints one recorded stream whatever it is asked.
describe('eval-run keeps failed streams', () => {
  const RUNNER = path.join(import.meta.dir, '..', 'eval-run.mjs');
  const roots = [];
  afterEach(() => {
    for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const STREAM = `${JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.1, usage: { input_tokens: 1 }, result: 'Pick:\n1. A\n2. B' })}\n`;
  function setup() {
    const root = fs.mkdtempSync('/tmp/eval-stats-run-');
    roots.push(root);
    const scenDir = path.join(root, 'evals', 'scenarios');
    const fixDir = path.join(root, 'evals', 'fixtures', 'tiny');
    for (const d of [scenDir, fixDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(fixDir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(root, 'stream.jsonl'), STREAM);
    fs.writeFileSync(path.join(scenDir, 'gate-a.json'), JSON.stringify({
      id: 'gate-a', behaviour: 'b', fixture: 'tiny', max_turns: 4, permission_mode: 'dontAsk', budget_usd: 1, prompt: 'ask',
      assertions: [{ type: 'final_options', min: 9 }],
    }));
    const stub = path.join(root, 'claude-stub.sh');
    fs.writeFileSync(stub, `#!/bin/sh\ncat "${path.join(root, 'stream.jsonl')}"\n`, { mode: 0o755 });
    return { root, scenDir, stub, out: path.join(root, 'reports', 'o.json'), streams: path.join(root, 'reports', 'streams') };
  }
  const run = (ctx, ...args) => {
    const env = { ...process.env, EVAL_CLAUDE_BIN: ctx.stub, EVAL_TMP_ROOT: path.join(ctx.root, 'runs') };
    const r = spawnSync(process.execPath, [RUNNER, '--scenarios', ctx.scenDir, '--no-sandbox', '--repeat', '1', '--out', ctx.out, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 60_000,
    });
    return { code: r.status, out: r.stdout };
  };

  test('without --keep a failed attempt lands in streams/<runId> beside the out file and five run dirs stay', () => {
    const ctx = setup();
    const old = ['01', '02', '03', '04', '05'].map((d) => `2026-01-${d}T00-00-00-000Z-1`);
    for (const d of old) fs.mkdirSync(path.join(ctx.streams, d), { recursive: true });
    const r = run(ctx);
    const report = JSON.parse(fs.readFileSync(ctx.out, 'utf8'));
    const file = path.join(ctx.streams, report.runId, 'gate-a.stream.jsonl');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/gate-a\s+FAIL.*stream=\S*gate-a\.stream\.jsonl/);
    expect(r.out).not.toContain('fixture=');
    expect(report.scenarios[0].stream).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(STREAM);
    expect(fs.readdirSync(ctx.streams).sort()).toEqual([...old.slice(1), report.runId]);
  });

  test('with --keep the stream stays beside the kept fixture and nothing goes to streams/', () => {
    const ctx = setup();
    const r = run(ctx, '--keep');
    expect([r.code, fs.existsSync(ctx.streams), /fixture=\S+\s+stream=\S*gate-a\.stream\.jsonl/.test(r.out)]).toEqual([1, false, true]);
  });
});
