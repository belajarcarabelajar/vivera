import { describe, expect, test } from 'bun:test';
import { FLAKY_ATTEMPTS, FLAKY_BELOW, FLAKY_MIN_ATTEMPTS, FLAKY_RATE_DROP, baselineMap, compareBaseline, isFlaky, runRepeated } from './eval-repeat.mjs';

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

  test('fullRun runs all five attempts of repeat 5 where the majority rule stops at three', async () => {
    expect(await runRepeated(scripted('PPPPP'), { repeat: 5, confirmFlips: 0, canRun: () => true })).toMatchObject({ attempts: 3 });
    const r = await runRepeated(scripted('PPPPP'), { repeat: 5, confirmFlips: 0, canRun: () => true, fullRun: true });
    expect(r).toMatchObject({ pass: true, confirmed: true, attempts: 5, passes: 5, pass_rate: 1 });
  });

  test('fullRun records the pass rate as passes over all attempts', async () => {
    const r = await runRepeated(scripted('PFPPF'), { repeat: 5, confirmFlips: 0, canRun: () => true, fullRun: true });
    expect(r).toMatchObject({ pass: true, confirmed: true, attempts: 5, passes: 3, pass_rate: 0.6, attempt_passes: [true, false, true, true, false] });
  });

  test('fullRun stopped by the budget before its limit is unconfirmed even with a majority', async () => {
    let calls = 0;
    const r = await runRepeated(scripted('PPPPP'), { repeat: 5, confirmFlips: 0, canRun: () => ++calls < 3, fullRun: true });
    expect(r).toMatchObject({ attempts: 3, passes: 3, confirmed: false });
  });
});

describe('isFlaky', () => {
  test('the owner thresholds are five attempts, below 0.9, five gate runs, and a 0.4 drop', () => {
    expect([FLAKY_MIN_ATTEMPTS, FLAKY_BELOW, FLAKY_ATTEMPTS, FLAKY_RATE_DROP]).toEqual([5, 0.9, 5, 0.4]);
  });

  test('five attempts at 0.8 is flaky', () => {
    expect(isFlaky({ attempts: 5, pass_rate: 0.8 })).toBe(true);
  });

  test('five attempts at 0.9 is not flaky', () => {
    expect(isFlaky({ attempts: 5, pass_rate: 0.9 })).toBe(false);
  });

  test('five attempts that all failed is not flaky, while one pass in five is', () => {
    expect(isFlaky({ attempts: 5, pass_rate: 0 })).toBe(false);
    expect(isFlaky({ attempts: 5, pass_rate: 0.2 })).toBe(true);
  });

  test('three attempts at 0.67 is not flaky', () => {
    expect(isFlaky({ attempts: 3, pass_rate: 0.67 })).toBe(false);
  });

  test('an entry without attempts or without a pass rate is not flaky', () => {
    expect(isFlaky({ pass_rate: 0.5 })).toBe(false);
    expect(isFlaky({ attempts: 5, pass_rate: null })).toBe(false);
  });
});

describe('baseline comparison', () => {
  test('an old baseline without pass_rate reads it from pass', () => {
    const b = baselineMap({ scenarios: [{ id: 'a', pass: true }, { id: 'b', pass: false, invoke: 'x' }, { id: 'c', pass: true, pass_rate: 0.67 }] });
    expect(b.get('a')).toEqual({ pass: true, invoke: false, pass_rate: 1, attempts: null, flaky: false });
    expect(b.get('b')).toEqual({ pass: false, invoke: 'x', pass_rate: 0, attempts: null, flaky: false });
    expect(b.get('c').pass_rate).toBe(0.67);
  });

  test('a baseline entry with five attempts below 0.9 is flaky, an older or shorter one is not', () => {
    const b = baselineMap({ scenarios: [
      { id: 'f', pass: true, attempts: 5, pass_rate: 0.8 },
      { id: 's', pass: true, attempts: 5, pass_rate: 1 },
      { id: 'short', pass: true, attempts: 3, pass_rate: 0.67 },
      { id: 'old', pass: true, pass_rate: 0.67 },
    ] });
    expect(b.get('f')).toEqual({ pass: true, invoke: false, pass_rate: 0.8, attempts: 5, flaky: true });
    expect(b.get('s')).toMatchObject({ attempts: 5, flaky: false });
    expect(b.get('short')).toMatchObject({ attempts: 3, flaky: false });
    expect(b.get('old')).toMatchObject({ attempts: null, flaky: false });
  });

  // pass is the majority of the five runs: true from 0.6 up.
  const flakyBaseline = (pass_rate) => baselineMap({ scenarios: [{ id: 'f', pass: pass_rate > 0.5, attempts: 5, pass_rate }] });
  const fiveRuns = (pass_rate) => [{ id: 'f', pass: pass_rate > 0.5, pass_rate, attempts: 5, confirmed: true }];

  test('a flaky scenario that drops from 0.8 to 0.6 is neither a regression nor an improvement', () => {
    expect(compareBaseline(flakyBaseline(0.8), fiveRuns(0.6))).toEqual({ regressions: [], improvements: [] });
  });

  test('a flaky scenario whose majority flips from 0.6 to 0.4 is no regression, the drop being under 0.4', () => {
    expect(compareBaseline(flakyBaseline(0.6), fiveRuns(0.4))).toEqual({ regressions: [], improvements: [] });
  });

  test('a flaky scenario that drops from 0.8 to 0.4 is a regression with the flaky label', () => {
    expect(compareBaseline(flakyBaseline(0.8), fiveRuns(0.4))).toEqual({ regressions: ['f (flaky, pass rate 0.8 -> 0.4)'], improvements: [] });
  });

  test('a flaky drop from 0.6 to 0.2 is a regression although the float difference is just under 0.4', () => {
    expect(compareBaseline(flakyBaseline(0.6), fiveRuns(0.2)).regressions).toEqual(['f (flaky, pass rate 0.6 -> 0.2)']);
  });

  test('a flaky scenario that rises from 0.4 to 0.8 is an improvement with the flaky label', () => {
    expect(compareBaseline(flakyBaseline(0.4), fiveRuns(0.8))).toEqual({ regressions: [], improvements: ['f (flaky, pass rate 0.4 -> 0.8)'] });
  });

  test('a flaky baseline entry against a run of one attempt gives no verdict', () => {
    const now = [{ id: 'f', pass: false, pass_rate: 0, attempts: 1, confirmed: true }];
    expect(compareBaseline(flakyBaseline(0.8), now)).toEqual({ regressions: [], improvements: [] });
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
