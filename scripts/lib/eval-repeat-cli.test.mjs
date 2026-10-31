import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    for (const args of [['--repeat', '0'], ['--repeat', '1.5'], ['--confirm-flips', '-1'], ['--confirm-failures', '2'], ['--repeat', '2'], ['--confirm-flips', '1'], ['--no-early-stop=1']]) {
      expect(run(ctx, ...args).code).toBe(2);
    }
    expect(runs(ctx)).toEqual([]);
  });
});

describe('eval-run flaky scenarios and --no-early-stop', () => {
  const flakyBaseline = (ctx, pass_rate) => {
    const file = path.join(ctx.root, 'base.json');
    fs.writeFileSync(file, JSON.stringify({ scenarios: [{ id: 'wobbly', pass: true, invoke: 'super-ultra-code-plan', attempts: 5, pass_rate }] }));
    return file;
  };

  test('the usage line names --no-early-stop', () => {
    expect(run(setup({ x: 'P' }), '--bogus').err).toContain('[--no-early-stop]');
  });

  test('a flaky baseline scenario runs exactly five attempts under --repeat 1 --confirm-flips 2, and its line says flaky', () => {
    const ctx = setup({ wobbly: 'PPPPP' });
    const r = run(ctx, '--baseline', flakyBaseline(ctx, 0.8), '--repeat', '1', '--confirm-flips', '2');
    expect(runs(ctx)).toHaveLength(5);
    expect(r.out).toMatch(/wobbly\s+PASS\s+passes=5\/5 \(95% CI 0\.57-1\.00\)\s+flaky\s+turns=/);
    expect(report(ctx, 'wobbly')).toMatchObject({ attempts: 5, passes: 5, confirmed: true, flaky: true });
    expect(r.code).toBe(0);
  });

  test('a flaky scenario that falls from 0.8 to 0.4 over five runs is a regression and exits 1', () => {
    const ctx = setup({ wobbly: 'PFPFF' });
    const r = run(ctx, '--baseline', flakyBaseline(ctx, 0.8), '--repeat', '1', '--confirm-flips', '2');
    expect(runs(ctx)).toHaveLength(5);
    expect(r.out).toContain('regression: wobbly (flaky, pass rate 0.8 -> 0.4)');
    expect(r.code).toBe(1);
  });

  test('a flaky scenario whose majority flips from 0.6 to 0.4 is no regression and exits 0', () => {
    const ctx = setup({ wobbly: 'FPFPF' });
    const r = run(ctx, '--baseline', flakyBaseline(ctx, 0.6), '--repeat', '1', '--confirm-flips', '2');
    expect([r.code, runs(ctx).length, r.out.includes('regression')]).toEqual([0, 5, false]);
  });

  test('a budget stop inside the five flaky runs is unconfirmed, no regression, and exits 1', () => {
    const ctx = setup({ wobbly: 'FFFFF' });
    const r = run(ctx, '--baseline', flakyBaseline(ctx, 0.8), '--repeat', '1', '--budget-usd', '2.2');
    expect(runs(ctx)).toHaveLength(2);
    expect(report(ctx, 'wobbly')).toMatchObject({ attempts: 2, confirmed: false, flaky: true });
    expect([r.code, r.out.includes('regression'), r.out.includes('1 unconfirmed')]).toEqual([1, false, true]);
  });

  test('--no-early-stop --repeat 5 runs every attempt and names the scenario below 0.9 as flaky', () => {
    const ctx = setup({ shaky: 'PPPPF', steady: 'PPPPP' });
    const r = run(ctx, '--no-early-stop', '--repeat', '5');
    expect(runs(ctx)).toHaveLength(10);
    expect(report(ctx, 'steady')).toMatchObject({ attempts: 5, confirmed: true });
    // The last attempt failed, so its failing assertion sits before the tally; no flaky tally without a baseline.
    expect(r.out).toMatch(/shaky\s+PASS.*passes=4\/5 \(95% CI 0\.38-0\.96\)\s+turns=/);
    expect(r.out).toContain('flaky: shaky (pass rate 0.8)');
    expect(r.out.includes('flaky: steady')).toBe(false);
    expect(r.code).toBe(0);
  });

  test('a baseline entry that failed all five runs takes the normal path: one agreeing attempt, no flaky tally', () => {
    const ctx = setup({ dead: 'FFFFF' });
    const file = path.join(ctx.root, 'base.json');
    fs.writeFileSync(file, JSON.stringify({ scenarios: [{ id: 'dead', pass: false, invoke: 'super-ultra-code-plan', attempts: 5, pass_rate: 0 }] }));
    const r = run(ctx, '--baseline', file, '--repeat', '1', '--confirm-flips', '2');
    expect(runs(ctx)).toHaveLength(1);
    expect(report(ctx, 'dead').flaky).toBeUndefined();
    expect(r.out).toMatch(/dead\s+FAIL.*turns=/);
    expect(r.out.includes('flaky')).toBe(false);
    expect(r.code).toBe(0);
  });

  test('no flaky list is printed when any scenario ran fewer than five attempts', () => {
    const ctx = setup({ solid: 'P', wobbly: 'PFPPF' });
    const r = run(ctx, '--baseline', flakyBaseline(ctx, 0.8), '--repeat', '1', '--confirm-flips', '2');
    expect(report(ctx, 'wobbly')).toMatchObject({ attempts: 5, pass_rate: 0.6 });
    expect(report(ctx, 'solid').attempts).toBe(1);
    expect(r.out.includes('flaky: wobbly')).toBe(false);
  });
});
