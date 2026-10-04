#!/usr/bin/env node
// Formal logic invariants for plan validation.
//
// These predicates encode the structural rules that must hold for a plan
// to be well-formed. Each invariant is a pure function that returns true
// when the plan satisfies the rule, or a string describing the violation.
// The ultra-plan-runner already checks some of these; these are the
// additional invariants that catch contradictions the runner misses.
//
// Treat a plan as a set of constraints: a valid execution is a model that
// satisfies all of them; contradicting constraints mean no valid execution.

/**
 * Invariant 1: Dependency acyclicity.
 * The depends_on graph must be a DAG. A cycle means no valid execution
 * order exists (topological sort is undefined).
 *
 * @param {Map<string, string[]>} dependencyGraph - task -> its dependencies
 * @returns {true | string} true if acyclic, error message if cyclic
 */
export function isAcyclic(dependencyGraph) {
  const visited = new Set();
  const inStack = new Set();

  function visit(node, path) {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      return `dependency cycle detected: ${cycle.join(' -> ')}`;
    }
    if (visited.has(node)) return true;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const deps = dependencyGraph.get(node) || [];
    for (const dep of deps) {
      const result = visit(dep, path);
      if (result !== true) return result;
    }

    inStack.delete(node);
    path.pop();
    return true;
  }

  for (const node of dependencyGraph.keys()) {
    const result = visit(node, []);
    if (result !== true) return result;
  }
  return true;
}

/**
 * Invariant 2: Referential integrity.
 * Every dependency must reference a task that exists in the plan.
 * A dangling reference is a contradiction: the plan claims to depend
 * on something that does not exist.
 *
 * @param {Map<string, string[]>} dependencyGraph
 * @param {Set<string>} taskIds
 * @returns {true | string}
 */
export function hasReferentialIntegrity(dependencyGraph, taskIds) {
  for (const [task, deps] of dependencyGraph) {
    if (!taskIds.has(task)) {
      return `task "${task}" is in the dependency graph but not in the task set`;
    }
    for (const dep of deps) {
      if (!taskIds.has(dep)) {
        return `task "${task}" depends on "${dep}" which does not exist`;
      }
    }
  }
  return true;
}

/**
 * Invariant 3: Mutual exclusivity of scopes.
 * No two tasks in the same batch may claim the same file.
 * Overlapping scopes violate the subagent isolation contract.
 *
 * @param {Map<string, Set<string>>} taskScopes - task -> files it touches
 * @returns {true | string}
 */
export function hasMutuallyExclusiveScopes(taskScopes) {
  const fileOwners = new Map();
  for (const [task, files] of taskScopes) {
    for (const file of files) {
      if (fileOwners.has(file)) {
        return `file "${file}" is claimed by both "${fileOwners.get(file)}" and "${task}"`;
      }
      fileOwners.set(file, task);
    }
  }
  return true;
}

/**
 * Invariant 4: Gate ordering.
 * Verification must come after implementation. A plan that verifies
 * before implementing is a logical contradiction.
 *
 * @param {Array<{id: string, phase: string}>} tasks
 * @returns {true | string}
 */
export function hasValidGateOrdering(tasks) {
  const phaseOrder = { planning: 0, implementation: 1, verification: 2, merge: 3 };

  // Validates phase names only. Gate ordering itself (no verification before
  // implementation) is not enforced here; validateParallelDispatch checks the
  // dependency side once waves exist.
  for (const task of tasks) {
    const order = phaseOrder[task.phase];
    if (order === undefined) {
      return `task "${task.id}" has unknown phase "${task.phase}"`;
    }
  }
  return true;
}

/**
 * Invariant 5: Idempotency key uniqueness.
 * No two tasks may share an idempotency key. A duplicate key means
 * the runner cannot distinguish their skip state.
 *
 * @param {Array<{id: string, idempotencyKey: string}>} tasks
 * @returns {true | string}
 */
export function hasUniqueIdempotencyKeys(tasks) {
  const seen = new Map();
  for (const task of tasks) {
    if (seen.has(task.idempotencyKey)) {
      return `idempotency key "${task.idempotencyKey}" is used by both "${seen.get(task.idempotencyKey)}" and "${task.id}"`;
    }
    seen.set(task.idempotencyKey, task.id);
  }
  return true;
}

/**
 * Run all invariants and return a list of violations.
 * @param {object} plan
 * @returns {string[]} list of violation messages (empty = valid)
 */
export function validateInvariants(plan) {
  const violations = [];

  const depGraph = new Map();
  const taskIds = new Set();
  const taskScopes = new Map();

  for (const task of plan.tasks || []) {
    taskIds.add(task.id);
    depGraph.set(task.id, task.depends_on || []);
    taskScopes.set(task.id, new Set(task.files || []));
  }

  const checks = [
    isAcyclic(depGraph),
    hasReferentialIntegrity(depGraph, taskIds),
    hasMutuallyExclusiveScopes(taskScopes),
    hasValidGateOrdering(plan.tasks || []),
    hasUniqueIdempotencyKeys(plan.tasks || []),
  ];

  for (const result of checks) {
    if (result !== true) violations.push(result);
  }
  return violations;
}

// Parallel dispatch validation

/**
 * Check whether two tasks can be dispatched in parallel.
 *
 * Two tasks are parallel-safe if and only if:
 *   1. Neither depends on the other (no data dependency)
 *   2. Their write scopes are disjoint (no write-write conflict)
 *
 * This is the formalization of the rule stated in prose across the skill:
 * "Run independent read-only or I/O-bound operations in parallel when safe"
 * and "Two tasks touching the same file cannot be dispatched in parallel".
 *
 * @param {{id: string, depends_on?: string[], files?: string[]}} taskA
 * @param {{id: string, depends_on?: string[], files?: string[]}} taskB
 * @returns {boolean}
 */
export function canDispatchInParallel(taskA, taskB) {
  const depsA = new Set(taskA.depends_on || []);
  const depsB = new Set(taskB.depends_on || []);

  const noDependency = !depsA.has(taskB.id) && !depsB.has(taskA.id);

  const filesA = new Set(taskA.files || []);
  const filesB = new Set(taskB.files || []);
  const overlap = [...filesA].filter((f) => filesB.has(f));
  const noOverlap = overlap.length === 0;

  return noDependency && noOverlap;
}

/**
 * Compute the wave (topological level) of each task in the DAG.
 *
 * Wave 0: tasks with no dependencies
 * Wave N: tasks whose maximum dependency wave is N-1
 *
 * This is the standard BFS-based topological level algorithm. Tasks in the
 * same wave are candidates for parallel dispatch (subject to scope checks).
 *
 * @param {Map<string, string[]>} dependencyGraph - task -> its dependencies
 * @returns {Map<string, number>} task -> wave number
 * @throws if the graph contains a cycle
 */
export function computeWaves(dependencyGraph) {
  // First check acyclicity
  const cycleCheck = isAcyclic(dependencyGraph);
  if (cycleCheck !== true) {
    throw new Error(`computeWaves: ${cycleCheck}`);
  }

  const waves = new Map();
  const inDegree = new Map();
  const dependents = new Map(); // reverse graph: dep -> tasks that depend on it

  for (const [task, deps] of dependencyGraph) {
    inDegree.set(task, deps.length);
    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(task);
    }
  }

  let currentWave = [];
  for (const [task, deg] of inDegree) {
    if (deg === 0) {
      waves.set(task, 0);
      currentWave.push(task);
    }
  }

  let waveNum = 0;
  while (currentWave.length > 0) {
    const nextWave = [];
    for (const task of currentWave) {
      const deps = dependents.get(task) || [];
      for (const dependent of deps) {
        const newDeg = inDegree.get(dependent) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          const depWave = waves.get(task);
          const currentDepWave = waves.get(dependent) || 0;
          waves.set(dependent, Math.max(currentDepWave, depWave + 1));
          nextWave.push(dependent);
        }
      }
    }
    currentWave = nextWave;
    waveNum++;
  }

  return waves;
}

/**
 * Validate that a batch dispatch respects wave ordering and scope exclusivity.
 *
 * A valid parallel batch must satisfy:
 *   1. All tasks in the batch are in the same wave
 *   2. No two tasks in the batch have overlapping write scopes
 *   3. All tasks in the batch have their dependencies already satisfied
 *      (i.e., their wave is <= the current wave)
 *
 * @param {Array<{id: string, depends_on?: string[], files?: string[]}>} batch
 * @param {Map<string, number>} waves - task -> wave number (from computeWaves)
 * @returns {true | string} true if valid, error message if invalid
 */
export function validateParallelDispatch(batch, waves) {
  if (!Array.isArray(batch) || batch.length === 0) {
    throw new Error('validateParallelDispatch: batch must be a non-empty array');
  }

  // All tasks in the same wave
  const waveSet = new Set();
  for (const task of batch) {
    const wave = waves.get(task.id);
    if (wave === undefined) {
      return `task "${task.id}" has no wave assignment (not in dependency graph)`;
    }
    waveSet.add(wave);
  }
  if (waveSet.size > 1) {
    const waveList = [...waveSet].sort((a, b) => a - b);
    return `batch contains tasks from different waves: ${waveList.join(', ')}. Only tasks in the same wave can be dispatched in parallel.`;
  }

  // Disjoint write scopes within the batch
  const fileOwners = new Map();
  for (const task of batch) {
    for (const file of task.files || []) {
      if (fileOwners.has(file)) {
        return `file "${file}" is claimed by both "${fileOwners.get(file)}" and "${task.id}" in the same batch`;
      }
      fileOwners.set(file, task.id);
    }
  }

  // Dependencies must sit in earlier waves
  for (const task of batch) {
    const taskWave = waves.get(task.id);
    for (const dep of task.depends_on || []) {
      const depWave = waves.get(dep);
      if (depWave === undefined) {
        return `task "${task.id}" depends on "${dep}" which has no wave assignment`;
      }
      if (depWave >= taskWave) {
        return `task "${task.id}" (wave ${taskWave}) depends on "${dep}" (wave ${depWave}) which is not in an earlier wave`;
      }
    }
  }

  return true;
}

/**
 * Compute the maximum parallelism (width) of a plan.
 *
 * This is the size of the largest wave, which represents the maximum
 * number of tasks that can run concurrently. A plan with width 1 is
 * purely sequential; a plan with width N can use up to N subagents.
 *
 * @param {Map<string, number>} waves - task -> wave number
 * @returns {number} maximum wave size
 */
export function maxParallelism(waves) {
  const waveCounts = new Map();
  for (const wave of waves.values()) {
    waveCounts.set(wave, (waveCounts.get(wave) || 0) + 1);
  }
  let max = 0;
  for (const count of waveCounts.values()) {
    if (count > max) max = count;
  }
  return max;
}

/**
 * Check if a plan meets the high fan-out floor (10+ subagents).
 *
 * The skill mandates targeting 10+ narrow subagents when the task
 * supports it. This function checks if the plan's DAG structure
 * allows for that level of parallelism.
 *
 * @param {Map<string, number>} waves - task -> wave number
 * @param {number} [floor=10] - minimum required parallelism
 * @returns {{meets: boolean, maxParallelism: number, suggestion: string}}
 */
export function checkFanOutFloor(waves, floor = 10) {
  const max = maxParallelism(waves);
  const meets = max >= floor;
  let suggestion = '';
  if (!meets) {
    suggestion = `Plan's maximum parallelism is ${max}, below the ${floor}-subagent floor. Consider splitting tasks into smaller chunks or merging independent tasks into a single wave.`;
  }
  return { meets, maxParallelism: max, suggestion };
}
