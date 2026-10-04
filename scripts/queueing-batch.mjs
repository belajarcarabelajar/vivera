#!/usr/bin/env node
// Queueing theory for optimal subagent batch sizing.
//
// The subagent dispatch problem is an M/M/c queue:
//   - Tasks arrive at rate λ (tasks per minute)
//   - Each subagent processes at rate μ (tasks per minute)
//   - c = number of concurrent subagents (batch size)
//
// Key formulas (Erlang-C model):
//   ρ = λ / (cμ)  (utilization, must be < 1 for stability)
//   P_wait = Erlang-C formula (probability a task waits)
//   L_q = average queue length
//   W_q = average wait time
//
// The optimal batch size minimizes total cost:
//   cost = c × cost_per_subagent + L_q × cost_per_waiting_task
//
// These functions are pure and deterministic. Every formula has a
// hand-computed fixture in the test file.

/**
 * Compute the Erlang-C probability that an arriving task must wait.
 * This is the probability all c servers are busy.
 *
 * P_wait = (a^c / c!) × (c / (c - a)) / (Σ(k=0 to c-1) a^k/k! + (a^c / c!) × (c / (c - a)))
 *
 * where a = λ/μ (offered load in erlangs)
 *
 * @param {number} lambda - arrival rate (tasks per minute)
 * @param {number} mu - service rate (tasks per minute)
 * @param {number} c - number of servers (batch size)
 * @returns {number} probability in [0, 1]
 */
export function erlangC(lambda, mu, c) {
  if (lambda <= 0 || mu <= 0 || c <= 0) {
    throw new Error('erlangC: lambda, mu, and c must be positive');
  }
  if (!Number.isInteger(c)) {
    throw new Error('erlangC: c must be an integer');
  }

  const a = lambda / mu;
  if (a >= c) {
    throw new Error(`erlangC: system unstable — offered load a=${a.toFixed(2)} >= c=${c}`);
  }

  // Compute a^c / c!
  const aPowC = Math.pow(a, c);
  const cFact = factorial(c);
  const termC = aPowC / cFact;

  // Compute sum: Σ(k=0 to c-1) a^k / k!
  let sum = 0;
  for (let k = 0; k < c; k++) {
    sum += Math.pow(a, k) / factorial(k);
  }

  const numerator = termC * (c / (c - a));
  const denominator = sum + numerator;
  return numerator / denominator;
}

/**
 * Compute average queue length L_q.
 * L_q = P_wait × ρ / (1 - ρ)  where ρ = λ/(cμ)
 *
 * @param {number} lambda
 * @param {number} mu
 * @param {number} c
 * @returns {number}
 */
export function averageQueueLength(lambda, mu, c) {
  const pWait = erlangC(lambda, mu, c);
  const rho = lambda / (c * mu);
  return pWait * rho / (1 - rho);
}

/**
 * Compute average wait time W_q (Little's Law).
 * W_q = L_q / λ
 *
 * @param {number} lambda
 * @param {number} mu
 * @param {number} c
 * @returns {number}
 */
export function averageWaitTime(lambda, mu, c) {
  const lq = averageQueueLength(lambda, mu, c);
  return lq / lambda;
}

/**
 * Compute the optimal batch size that minimizes total cost.
 * cost(c) = c × costPerSubagent + L_q(c) × costPerWaitingTask
 *
 * @param {number} lambda - arrival rate
 * @param {number} mu - service rate
 * @param {number} costPerSubagent - cost per subagent per minute
 * @param {number} costPerWaitingTask - cost per waiting task per minute
 * @param {number} [maxBatch=50] - maximum batch size to consider
 * @returns {{optimalC: number, minCost: number, utilization: number}}
 */
export function optimalBatchSize(lambda, mu, costPerSubagent, costPerWaitingTask, maxBatch = 50) {
  if (costPerSubagent <= 0 || costPerWaitingTask <= 0) {
    throw new Error('optimalBatchSize: costs must be positive');
  }

  let bestC = 1;
  let bestCost = Infinity;

  for (let c = 1; c <= maxBatch; c++) {
    // Unstable regime: at lambda/mu >= c the queue never drains, so no optimum exists here.
    if (lambda / mu >= c) continue;

    const lq = averageQueueLength(lambda, mu, c);
    const cost = c * costPerSubagent + lq * costPerWaitingTask;

    if (cost < bestCost) {
      bestCost = cost;
      bestC = c;
    }
  }

  const utilization = lambda / (bestC * mu);
  return { optimalC: bestC, minCost: bestCost, utilization };
}

/**
 * Compute the probability that a task completes within t minutes.
 * P(T <= t) = 1 - P_wait × exp(-(cμ - λ)t)
 *
 * @param {number} lambda
 * @param {number} mu
 * @param {number} c
 * @param {number} t - time threshold in minutes
 * @returns {number}
 */
export function completionProbability(lambda, mu, c, t) {
  if (t < 0) {
    throw new Error('completionProbability: t must be non-negative');
  }
  const pWait = erlangC(lambda, mu, c);
  const rate = c * mu - lambda;
  return 1 - pWait * Math.exp(-rate * t);
}

function factorial(n) {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}
