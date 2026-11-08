// scripts/lib/eval-pairing.mjs
//
// The main model and advisor model an eval run was made with (eval-run.mjs --model, --advisor),
// and what the advisor did in it. Shape seen on Claude Code 2.1.319: an advisor call is an
// assistant content block `server_tool_use` named `advisor`; its reply (`advisor_tool_result`)
// is encrypted in the stream; the advisor's tokens are a separate `result.modelUsage` entry
// under its own model ID, already inside `total_cost_usd`. Evidence: plan 2026-11-08-advisor-eval, T1.

// stream-json forwards only some subagent events, so a subagent's advisor calls never show
// as blocks; the hand-back the parent receives names the tools the subagent used. Only the
// result of an Agent call counts: a file or command output that prints the tag, or a
// SendMessage resume of the same subagent, is not a new subagent. A background agent's
// completion arrives as plain text later and is not counted (not observed on 2.1.319).
const HAND_BACK_TOOLS = /<tools-used-before-summary>([^<]*)<\/tools-used-before-summary>/;

function handBackText(block) {
  if (block?.type !== 'tool_result') return '';
  return typeof block.content === 'string' ? block.content : (Array.isArray(block.content) ? block.content.map((c) => c?.text ?? '').join('\n') : '');
}

/**
 * Flat numeric keys, so the existing per-turn and per-attempt usage sums add them up:
 * advisor calls in the main session (exact), Agent calls whose hand-back lists the advisor
 * (the number of calls inside a subagent is not observable), and
 * cost per model ID. An advisor on the main model's own family shares its cost entry.
 */
export function advisorUsage(events, resultEvent) {
  const out = { advisor_calls: 0, advisor_subagents: 0 };
  const agentCalls = new Set();
  for (const e of events) {
    if (!Array.isArray(e?.message?.content) || e.parent_tool_use_id != null) continue;
    for (const block of e.message.content) {
      if (e.type === 'assistant' && block?.type === 'server_tool_use' && block.name === 'advisor') out.advisor_calls += 1;
      if (e.type === 'assistant' && block?.type === 'tool_use' && block.name === 'Agent') agentCalls.add(block.id);
      const used = e.type === 'user' && agentCalls.has(block?.tool_use_id) && handBackText(block).match(HAND_BACK_TOOLS);
      if (used && used[1].split(',').some((t) => t.trim() === 'advisor')) out.advisor_subagents += 1;
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
