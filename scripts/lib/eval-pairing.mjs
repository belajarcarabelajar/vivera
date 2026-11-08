// scripts/lib/eval-pairing.mjs
//
// The main model and advisor model an eval run was made with (eval-run.mjs --model, --advisor),
// and what the advisor did in it. Shape seen on Claude Code 2.1.319: an advisor call is an
// assistant content block `server_tool_use` named `advisor`; its reply (`advisor_tool_result`)
// is encrypted in the stream; the advisor's tokens are a separate `result.modelUsage` entry
// under its own model ID, already inside `total_cost_usd`. Evidence: plan 2026-11-08-advisor-eval, T1.

/**
 * Flat numeric keys, so the existing per-turn and per-attempt usage sums add them up:
 * advisor calls in the main session, advisor calls inside subagents, and cost per model ID.
 */
export function advisorUsage(events, resultEvent) {
  const out = { advisor_calls: 0, advisor_calls_sub: 0 };
  for (const e of events) {
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (block?.type !== 'server_tool_use' || block.name !== 'advisor') continue;
      if (e.parent_tool_use_id == null) out.advisor_calls += 1;
      else out.advisor_calls_sub += 1;
    }
  }
  for (const [model, u] of Object.entries(resultEvent?.modelUsage ?? {})) {
    if (typeof u?.costUSD === 'number') out[`cost_usd:${model}`] = u.costUSD;
  }
  return out;
}

const label = (p) => `${p.model ?? 'default'}/${p.advisor ?? 'none'}`;

// A run on another model or advisor measures a different agent, so it never compares
// with the baseline. A baseline entry without the fields predates them: default model, no advisor.
export function pairingMismatch(baseline, scenarios, pairing) {
  const want = label(pairing);
  const off = scenarios.filter((s) => baseline.has(s.id) && label(baseline.get(s.id)) !== want);
  if (!off.length) return null;
  const s = off[0];
  return `baseline model/advisor differs for ${off.length} scenario(s), first ${s.id}: baseline ${label(baseline.get(s.id))}, this run ${want}`;
}

/** The claude flags for a pairing; none when the run uses the account default and no advisor. */
export function pairingArgs({ model, advisor }) {
  return [...(model ? ['--model', model] : []), ...(advisor ? ['--advisor', advisor] : [])];
}
