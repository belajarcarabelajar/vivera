import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baselineMap, compareBaseline, runRepeated } from './eval-repeat.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'eval-run.mjs');
const STREAMS = path.join(HERE, '..', '..', 'evals', 'fixtures', 'streams');
const GATE = [{ type: 'fixture_unchanged' }, { type: 'final_options', min: 2 }];
const ASK_COST = 0.130596;

// The prompt "seq:<name>:<PF...>" makes attempt n pass or fail by the nth letter: a failing
// attempt writes a file, which breaks fixture_unchanged. The run count lives in a file per
// name under the test's temp dir, because the runner scrubs the child env.
const STUB = `#!/bin/sh
prompt=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-p" ]; then prompt="$a"; fi
  if [ "$prev" = "--max-budget-usd" ]; then cap="$a"; fi
  prev="$a"
done
prompt="\${prompt#* }"
rest="\${prompt#seq:}"
name="\${rest%%:*}"
pattern="\${rest#*:}"
count="@ROOT@/count-$name"
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$count"
echo "RUN $name $n cap=$cap" >> "@ROOT@/stub.log"
c=$(printf %s "$pattern" | cut -c"$n")
if [ "$c" = "F" ]; then echo hello > greeting.txt; fi
cat "@STREAMS@/ask.jsonl"
`;

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(scenarios) {
  // Outside $HOME: the runner refuses a scratch root under it.
  const root = fs.mkdtempSync('/tmp/eval-repeat-');
  dirs.push(root);
  const scenDir = path.join(root, 'evals', 'scenarios');
  const fixDir = path.join(root, 'evals', 'fixtures', 'tiny');
  fs.mkdirSync(scenDir, { recursive: true });
  fs.mkdirSync(fixDir, { recursive: true });
  fs.writeFileSync(path.join(fixDir, 'math.mjs'), 'export const add = (a, b) => a + b;\n');
  for (const [id, pattern] of Object.entries(scenarios)) {
    fs.writeFileSync(path.join(scenDir, `${id}.json`), JSON.stringify({
      id, prompt: `seq:${id}:${pattern}`, fixture: 'tiny', max_turns: 4, permission_mode: 'dontAsk', assertions: GATE,
    }));
  }
  const stub = path.join(root, 'claude-stub.sh');
  fs.writeFileSync(stub, STUB.replaceAll('@ROOT@', root).replace('@STREAMS@', STREAMS), { mode: 0o755 });
  return { root, scenDir, stub, out: path.join(root, 'o.json') };
}

function run(ctx, ...args) {
  const env = { ...process.env, EVAL_CLAUDE_BIN: ctx.stub, EVAL_TMP_ROOT: path.join(ctx.root, 'runs') };
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', ctx.scenDir, '--no-sandbox', '--out', ctx.out, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const runs = (ctx) => {
  const log = path.join(ctx.root, 'stub.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
};
const report = (ctx, id) => JSON.parse(fs.readFileSync(ctx.out, 'utf8')).scenarios.find((s) => s.id === id);

// A fake single run for the unit tests: pass or fail by letter, a fixed cost each.
function scripted(pattern, cost = 0.1) {
  let n = 0;
  return async () => {
    const pass = pattern[n++] === 'P';
    return { id: 'x', pass, results: [{ type: 'n', pass, detail: String(n) }], cost, seconds: 1 };
  };
}

describe('runRepeated', () => {
  test('repeat 3 stops after two passes and records the attempts', async () => {
    const r = await runRepeated(scripted('PPF'), { repeat: 3, confirmFlips: 0, canRun: () => true });
    expect(r).toMatchObject({ pass: true, attempts: 2, passes: 2, pass_rate: 1, attempt_passes: [true, true] });
  });

  test('repeat 3 with one pass and two fails is a majority fail and keeps the last results', async () => {
    const r = await runRepeated(scripted('PFF'), { repeat: 3, confirmFlips: 0, canRun: () => true });
    expect(r).toMatchObject({ pass: false, attempts: 3, passes: 1, attempt_passes: [true, false, false] });
    expect(r.pass_rate).toBeCloseTo(1 / 3, 5);
    expect(r.results[0].detail).toBe('3');
  });

  test('cost sums every attempt, and stays unknown when one attempt is unknown', async () => {
    expect((await runRepeated(scripted('PFP', 0.25), { repeat: 3, confirmFlips: 0, canRun: () => true })).cost).toBeCloseTo(0.75, 9);
    let n = 0;
    const once = async () => ({ pass: n++ > 0, results: [], cost: n === 1 ? null : 0.1, seconds: 1 });
    expect((await runRepeated(once, { repeat: 3, confirmFlips: 0, canRun: () => true })).cost).toBeNull();
  });

  test('without an expected verdict, confirm-flips does not repeat a passing first attempt', async () => {
    const r = await runRepeated(scripted('PFF'), { repeat: 1, confirmFlips: 2, canRun: () => true });
    expect(r).toMatchObject({ pass: true, attempts: 1 });
  });

  test('without an expected verdict, confirm-flips 2 reruns a failure and decides by the majority of three', async () => {
    expect(await runRepeated(scripted('FPP'), { repeat: 1, confirmFlips: 2, canRun: () => true })).toMatchObject({ pass: true, attempts: 3, passes: 2 });
    expect(await runRepeated(scripted('FFP'), { repeat: 1, confirmFlips: 2, canRun: () => true })).toMatchObject({ pass: false, attempts: 2 });
  });

  test('confirm-flips reruns a first attempt that disagrees with a failing baseline verdict', async () => {
    expect(await runRepeated(scripted('PFF'), { repeat: 1, confirmFlips: 2, expected: false, canRun: () => true })).toMatchObject({ pass: false, attempts: 3 });
    expect(await runRepeated(scripted('FPP'), { repeat: 1, confirmFlips: 2, expected: false, canRun: () => true })).toMatchObject({ pass: false, attempts: 1 });
  });

  test('a spent budget stops further attempts and a tie is not a pass', async () => {
    let calls = 0;
    const r = await runRepeated(scripted('PFP'), { repeat: 3, confirmFlips: 0, canRun: () => ++calls < 2 });
    expect(r).toMatchObject({ pass: false, attempts: 2, passes: 1, attempt_passes: [true, false], confirmed: false });
  });

  test('a decided scenario is confirmed and its usage tokens sum over the attempts', async () => {
    let n = 0;
    const once = async () => ({ pass: n++ !== 1, results: [], cost: 0.1, seconds: 1, usage: { input_tokens: 10, output_tokens: n } });
    const r = await runRepeated(once, { repeat: 3, confirmFlips: 0, canRun: () => true });
    expect(r).toMatchObject({ confirmed: true, attempts: 3, usage: { input_tokens: 30, output_tokens: 6 } });
  });
});

describe('baseline comparison', () => {
  test('an old baseline without pass_rate reads it from pass', () => {
    const b = baselineMap({ scenarios: [{ id: 'a', pass: true }, { id: 'b', pass: false, invoke: 'x' }, { id: 'c', pass: true, pass_rate: 0.67 }] });
    expect(b.get('a')).toEqual({ pass: true, invoke: false, pass_rate: 1 });
    expect(b.get('b')).toEqual({ pass: false, invoke: 'x', pass_rate: 0 });
    expect(b.get('c').pass_rate).toBe(0.67);
  });

  test('a budget-skipped baseline entry is unknown, never a fail', () => {
    expect(baselineMap({ scenarios: [{ id: 'a', pass: false, skipped: true }] }).has('a')).toBe(false);
  });

  test('an unconfirmed scenario is never a regression or an improvement', () => {
    const b = baselineMap({ scenarios: [{ id: 'a', pass: true }, { id: 'b', pass: false }] });
    const now = [{ id: 'a', pass: false, pass_rate: 0.5, confirmed: false }, { id: 'b', pass: true, pass_rate: 1, confirmed: false }];
    expect(compareBaseline(b, now)).toEqual({ regressions: [], improvements: [] });
  });

  test('a regression is baseline majority pass and now majority fail, with both rates', () => {
    const b = baselineMap({ scenarios: [{ id: 'a', pass: true, pass_rate: 0.67 }, { id: 'b', pass: false }, { id: 'c', pass: true }] });
    const now = [
      { id: 'a', pass: false, pass_rate: 1 / 3 },
      { id: 'b', pass: true, pass_rate: 1 },
      { id: 'c', pass: true, pass_rate: 0.67 },
      { id: 'd', pass: false, pass_rate: 0 },
    ];
    expect(compareBaseline(b, now)).toEqual({
      regressions: ['a (pass rate 0.67 -> 0.33)'],
      improvements: ['b (pass rate 0 -> 1)'],
    });
  });
});

describe('eval-run --repeat and --confirm-flips', () => {
  test('--repeat 3 runs pass, fail, pass to a majority pass and sums the cost', () => {
    const ctx = setup({ flaky: 'PFP' });
    const r = run(ctx, '--repeat', '3');
    expect([r.code, runs(ctx).length]).toEqual([0, 3]);
    expect(r.out).toMatch(/flaky\s+PASS.*passes=2\/3/);
    expect(report(ctx, 'flaky')).toMatchObject({ pass: true, attempts: 3, passes: 2, attempt_passes: [true, false, true] });
    expect(report(ctx, 'flaky').cost).toBeCloseTo(3 * ASK_COST, 5);
    expect(r.out).toContain(`total cost $${Math.round(3 * ASK_COST * 10000) / 10000}`);
    expect(report(ctx, 'flaky').usage.cache_read_input_tokens).toBe(3 * 28960);
  });

  test('--repeat defaults to 3 and stops early once two attempts agree', () => {
    const ctx = setup({ steady: 'PPF' });
    expect(run(ctx).code).toBe(0);
    expect(runs(ctx)).toHaveLength(2);
    expect(report(ctx, 'steady')).toMatchObject({ attempts: 2, pass_rate: 1 });
  });

  test('--confirm-flips 2 without a baseline reruns only the scenario whose first run failed', () => {
    const ctx = setup({ 'a-ok': 'PFF', 'b-flaky': 'FPP' });
    const r = run(ctx, '--repeat', '1', '--confirm-flips', '2');
    expect(r.code).toBe(0);
    expect(runs(ctx).map((l) => l.split(' ').slice(0, 3).join(' '))).toEqual(['RUN a-ok 1', 'RUN b-flaky 1', 'RUN b-flaky 2', 'RUN b-flaky 3']);
    expect(report(ctx, 'a-ok').attempts).toBe(1);
    expect(report(ctx, 'b-flaky')).toMatchObject({ pass: true, attempts: 3, passes: 2 });
  });

  test('no further attempt starts with less than the run ceiling left, and the stop is unconfirmed', () => {
    const ctx = setup({ flaky: 'PFP' });
    run(ctx, '--repeat', '3', '--budget-usd', '0.2');
    expect(runs(ctx)).toEqual(['RUN flaky 1 cap=0.20']);
    expect(report(ctx, 'flaky')).toMatchObject({ attempts: 1, confirmed: false });
  });

  test('an unconfirmed scenario is no regression against the baseline but still exits 1 like a skip', () => {
    const ctx = setup({ flaky: 'PFP' });
    const baseline = path.join(ctx.root, 'base.json');
    fs.writeFileSync(baseline, JSON.stringify({ scenarios: [{ id: 'flaky', pass: true, invoke: 'super-ultra-code-plan' }] }));
    const r = run(ctx, '--baseline', baseline, '--repeat', '3', '--budget-usd', '2.2');
    expect(runs(ctx)).toEqual(['RUN flaky 1 cap=2.00', 'RUN flaky 2 cap=2.00']);
    expect([r.code, r.out.includes('regression'), r.out.includes('1 unconfirmed')]).toEqual([1, false, true]);
  });

  test('a baseline majority pass that now fails twice is a regression printed with both rates', () => {
    const ctx = setup({ gate: 'FFP' });
    const baseline = path.join(ctx.root, 'base.json');
    fs.writeFileSync(baseline, JSON.stringify({ scenarios: [{ id: 'gate', pass: true, invoke: 'super-ultra-code-plan' }] }));
    const r = run(ctx, '--baseline', baseline, '--repeat', '1', '--confirm-flips', '2');
    expect(r.code).toBe(1);
    expect(runs(ctx)).toHaveLength(2);
    expect(r.out).toContain('regression: gate (pass rate 1 -> 0)');
  });

  test('with a baseline, a single pass that flips a baseline fail is rerun and is no improvement', () => {
    const ctx = setup({ 'a-flip': 'PFF', 'b-new': 'FPP' });
    const baseline = path.join(ctx.root, 'base.json');
    fs.writeFileSync(baseline, JSON.stringify({ scenarios: [{ id: 'a-flip', pass: false, invoke: 'super-ultra-code-plan' }] }));
    const r = run(ctx, '--baseline', baseline, '--repeat', '1', '--confirm-flips', '2');
    expect(runs(ctx).map((l) => l.split(' ').slice(0, 3).join(' '))).toEqual(['RUN a-flip 1', 'RUN a-flip 2', 'RUN a-flip 3', 'RUN b-new 1', 'RUN b-new 2', 'RUN b-new 3']);
    expect([r.code, r.out.includes('improvement')]).toEqual([0, false]);
  });

  test('an even --repeat, an odd --confirm-flips, a non-number, or the retired --confirm-failures is a usage error', () => {
    const ctx = setup({ x: 'P' });
    for (const args of [['--repeat', '0'], ['--repeat', '1.5'], ['--confirm-flips', '-1'], ['--confirm-failures', '2'], ['--repeat', '2'], ['--confirm-flips', '1']]) {
      expect(run(ctx, ...args).code).toBe(2);
    }
    expect(runs(ctx)).toEqual([]);
  });
});
