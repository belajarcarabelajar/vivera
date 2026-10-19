// scripts/lib/eval-repeat.mjs
//
// Repeated attempts and the baseline rules for scripts/eval-run.mjs. One claude run per
// scenario flips between runs, so the verdict is the majority over its attempts.

// An integer at least min with the given parity (1 odd, 0 even), else NaN, so the caller
// can report a usage error. Odd attempt limits leave no tie to decide.
export function parseCount(raw, min, parity) {
  const n = /^-?\d+$/.test(String(raw)) ? Number(raw) : NaN;
  return n >= min && n % 2 === parity ? n : NaN;
}

// A first attempt that agrees with the expected verdict (the baseline's, else a pass) gets only
// --repeat attempts, so a gate pays for confirmations only when a single run would change its verdict.
function attemptLimit(firstPass, repeat, confirmFlips, expected) {
  return firstPass === (expected ?? true) ? repeat : Math.max(repeat, 1 + confirmFlips);
}

function sumUsage(tries) {
  const used = tries.map((t) => t.usage).filter(Boolean);
  if (!used.length) return null;
  const sum = {};
  for (const u of used) for (const [k, v] of Object.entries(u)) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v;
  return sum;
}

// runOnce(attempt) returns one scored run; canRun() says whether the total budget allows another.
export async function runRepeated(runOnce, { repeat, confirmFlips, expected, canRun }) {
  const tries = [await runOnce(0)];
  const limit = attemptLimit(tries[0].pass, repeat, confirmFlips, expected);
  const needed = Math.floor(limit / 2) + 1;
  const count = (want) => tries.filter((t) => t.pass === want).length;
  while (tries.length < limit && count(true) < needed && count(false) < needed && canRun()) {
    tries.push(await runOnce(tries.length));
  }
  const passes = count(true);
  const decided = tries.length === limit || count(true) >= needed || count(false) >= needed;
  const last = tries[tries.length - 1];
  return {
    ...last,
    // Only a budget stop leaves the verdict undecided; such a record is unconfirmed and a tie is no pass.
    pass: passes * 2 > tries.length,
    confirmed: decided,
    attempts: tries.length,
    passes,
    pass_rate: passes / tries.length,
    attempt_passes: tries.map((t) => t.pass),
    usage: sumUsage(tries),
    cost: tries.some((t) => t.cost == null) ? null : tries.reduce((sum, t) => sum + t.cost, 0),
    seconds: Math.round(tries.reduce((sum, t) => sum + (t.seconds || 0), 0) * 10) / 10,
  };
}

// A baseline entry without invoke predates the field, and every run then was bare;
// one without pass_rate predates repeats and had a single run.
export function baselineMap(data) {
  // A budget-skipped entry is unknown, never a fail.
  return new Map((data.scenarios ?? []).filter((s) => !s.skipped).map((s) => [s.id, {
    pass: Boolean(s.pass),
    invoke: s.invoke ?? false,
    pass_rate: typeof s.pass_rate === 'number' ? s.pass_rate : (s.pass ? 1 : 0),
  }]));
}

// A bare-model run and an orchestrated run measure different things, so they never compare.
export function invokeMismatch(baseline, scenarios, invokeOf) {
  const off = scenarios.filter((s) => baseline.has(s.id) && baseline.get(s.id).invoke !== invokeOf(s));
  if (!off.length) return null;
  const s = off[0];
  return `baseline invoke differs for ${off.length} scenario(s), first ${s.id}: `
    + `baseline ${JSON.stringify(baseline.get(s.id).invoke)}, this run ${JSON.stringify(invokeOf(s))}`;
}

const rate = (n) => String(Math.round(n * 100) / 100);

export function compareBaseline(baseline, scenarios) {
  const regressions = [];
  const improvements = [];
  for (const s of scenarios) {
    if (s.skipped || s.confirmed === false || !baseline.has(s.id)) continue;
    const before = baseline.get(s.id);
    const label = typeof s.pass_rate === 'number' ? `${s.id} (pass rate ${rate(before.pass_rate)} -> ${rate(s.pass_rate)})` : s.id;
    if (before.pass && !s.pass) regressions.push(label);
    if (!before.pass && s.pass) improvements.push(label);
  }
  return { regressions, improvements };
}
