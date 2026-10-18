import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, executePlan, RUNNER_CONTRACT_KEYS } from './ultra-plan-runner.mjs';

// Split from ultra-plan-runner.test.mjs, which sits at its size-gate ceiling.
function runWithStepBudget(tasks, defaults = {}) {
  return executePlan(
    { tasks, defaults: { retry_transient_max: 0, step_timeout_s: 30, ...defaults } },
    { execute: true },
  );
}

// One slow step (a full suite) used to force the plan-wide step_timeout_s up for
// every step. A step's own timeout_s replaces the default for that step only.
test('a step timeout_s longer than step_timeout_s lets that step finish', () => {
  const { status } = runWithStepBudget(
    [{ id: 'T1', depends_on: [], run: [{ cmd: 'sleep 2', timeout_s: 10, retry: 0 }] }],
    { step_timeout_s: 1 },
  );
  assert.equal(status.get('T1'), 'PASSED');
});

test('a step timeout_s shorter than step_timeout_s kills that step as 124', () => {
  const { status, ledger } = runWithStepBudget(
    [{ id: 'T1', depends_on: [], run: [{ cmd: 'sleep 5', timeout_s: 1, retry: 0 }] }],
    { step_timeout_s: 30 },
  );
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].exit, 124);
});

test('a step timeout_s covers only its own step, not the next one', () => {
  const { status, ledger } = runWithStepBudget(
    [{ id: 'T1', depends_on: [], run: [
      { cmd: 'sleep 2', timeout_s: 10, retry: 0 },
      { cmd: 'sleep 2', retry: 0 },
    ] }],
    { step_timeout_s: 1 },
  );
  assert.equal(status.get('T1'), 'FAILED-ISOLATED');
  assert.equal(ledger[0].step, 2);
  assert.equal(ledger[0].exit, 124);
});

test('a step timeout_s also bounds its loop_until probe', () => {
  const { status } = runWithStepBudget(
    [{ id: 'T1', depends_on: [], run: [{ cmd: 'true', loop_until: 'sleep 2', timeout_s: 10, retry: 0 }] }],
    { step_timeout_s: 1 },
  );
  assert.equal(status.get('T1'), 'PASSED');
});

test('a step timeout_s that is not a positive number is a validation error naming the task and step', () => {
  for (const bad of [0, -5, '300', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = {
      schema: 'ultra-plan/v1',
      tasks: [{ id: 'T7', depends_on: [], run: [{ cmd: 'true', timeout_s: bad }] }],
    };
    const { errors } = validatePlan(plan, null);
    assert.ok(
      errors.some((e) => /T7/.test(e) && /run\[0\]/.test(e) && /timeout_s/.test(e)),
      `timeout_s ${JSON.stringify(bad)} should be rejected, got ${JSON.stringify(errors)}`,
    );
  }
  const ok = {
    schema: 'ultra-plan/v1',
    tasks: [{ id: 'T7', depends_on: [], run: [{ cmd: 'true', timeout_s: 600 }] }],
  };
  assert.ok(!validatePlan(ok, null).errors.some((e) => /timeout_s/.test(e)));
});

test('tasks[].run[].timeout_s is a runner contract key', () => {
  assert.ok(RUNNER_CONTRACT_KEYS.includes('tasks[].run[].timeout_s'));
});
