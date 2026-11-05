// scripts/lib/plan-runner-numbers.mjs
//
// Shape checks for the numbers and ids ultra-plan-runner.mjs feeds straight into
// execution and into a RegExp. Split out because the runner sits at its size
// ceiling. executePlan uses these values raw, so a value that passes here must
// be safe to use without another check: step_timeout_s 0 used to disable the
// timeout, and a task id such as `T1(` made validatePlan throw a SyntaxError.

export const STEP_TIMEOUT_MAX_S = 86400;
export const RETRY_MAX = 10;
export const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;

export function isStepTimeout(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

const isRetry = (v) => Number.isInteger(v) && v >= 0 && v <= RETRY_MAX;
const retryRule = `must be an integer from 0 to ${RETRY_MAX}`;

export function validateRunnerNumbers(plan, errors) {
  const d = plan.defaults ?? {};
  if (d.step_timeout_s !== undefined && !(isStepTimeout(d.step_timeout_s) && d.step_timeout_s <= STEP_TIMEOUT_MAX_S)) {
    errors.push(`defaults.step_timeout_s must be a positive number of seconds up to ${STEP_TIMEOUT_MAX_S}, got ${JSON.stringify(d.step_timeout_s)}`);
  }
  if (d.retry_transient_max !== undefined && !isRetry(d.retry_transient_max)) {
    errors.push(`defaults.retry_transient_max ${retryRule}, got ${JSON.stringify(d.retry_transient_max)}`);
  }
  for (const t of plan.tasks || []) {
    if (t.id && (typeof t.id !== 'string' || !TASK_ID_RE.test(t.id))) {
      errors.push(`task id ${JSON.stringify(t.id)} must match ^[A-Za-z0-9._-]+$`);
    }
    if (!Array.isArray(t.run)) continue;
    t.run.forEach((step, i) => {
      if (!step || typeof step !== 'object') return;
      if (step.retry !== undefined && !isRetry(step.retry)) {
        errors.push(`task ${t.id} run[${i}] retry ${retryRule}, got ${JSON.stringify(step.retry)}`);
      }
      if (step.timeout_s !== undefined && !isStepTimeout(step.timeout_s)) {
        errors.push(`task ${t.id} run[${i}] timeout_s must be a positive number of seconds, got ${JSON.stringify(step.timeout_s)}`);
      }
    });
  }
}
