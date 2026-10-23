// scripts/lib/eval-turns.mjs
//
// Multi-turn scenarios: a scenario with `turns` runs each prompt as one headless
// `claude -p` call in the same session (`--session-id` first, `--resume` after),
// so a gate raised in turn 1 can be answered in turn 2 instead of being faked as
// "the design is approved" inside a single prompt. A scenario with `prompt` is one
// turn and keeps `--no-session-persistence`, exactly as before.

import { randomUUID } from 'node:crypto';
import { parseStream, score } from '../eval-score.mjs';

export function turnsOf(scenario) {
  return Array.isArray(scenario.turns) ? scenario.turns : [{ prompt: scenario.prompt }];
}

export function sessionFlags(session) {
  if (!session) return ['--no-session-persistence'];
  return session.resume ? ['--resume', session.id] : ['--session-id', session.id];
}

// A later turn needs a clean, complete turn before it and budget left to spend.
const stop = (run, parsed, spent, budget) => run.timedOut || run.spawnError || parsed.result.subtype == null
  || /^error_max/.test(parsed.result.subtype) || spent >= budget;

// The shape rules for prompt and turns; null when the scenario is fine.
export function turnsProblem(s) {
  if ((typeof s.prompt === 'string' && s.prompt !== '') === (s.turns !== undefined)) return 'needs exactly one of prompt or turns';
  if (s.turns !== undefined && (!Array.isArray(s.turns) || s.turns.length < 2
    || !s.turns.every((t) => typeof t?.prompt === 'string' && t.prompt && (t.assertions === undefined || Array.isArray(t.assertions))))) {
    return 'turns must hold at least two turns, each with a prompt';
  }
  if (!Array.isArray(s.assertions) || ![...s.assertions, ...(s.turns ?? []).flatMap((t) => t.assertions ?? [])].length) {
    return 'assertions must be a non-empty array (a multi-turn scenario may keep them in its turns)';
  }
  return null;
}

// runTurn({ prompt, first, session, budget }) runs one claude call and returns its run record.
// The budget each turn gets is what the earlier turns of this attempt left.
export async function runTurns({ turns, budget, runTurn, newId = randomUUID }) {
  const id = turns.length > 1 ? newId() : null;
  const parsed = [];
  const outs = [];
  let spent = 0;
  let last;
  for (let i = 0; i < turns.length; i++) {
    const left = Math.max(0.01, Math.round((budget - spent) * 100) / 100);
    last = await runTurn({ prompt: turns[i].prompt, first: i === 0, session: id && { id, resume: i > 0 }, budget: left });
    const p = parseStream(last.stdout ?? '');
    parsed.push(p);
    outs.push(last.stdout ?? '');
    spent += Number(p.result.total_cost_usd) || 0;
    if (stop(last, p, spent, budget)) break;
  }
  return { parsed, stdout: outs.join('\n'), last };
}

// One parsed stream for the scenario-level assertions: every tool call tagged with its
// turn, the last final message (and all of them in `finals`), cost and turns summed.
export function mergeParsed(list) {
  const known = list.every((p) => p.result.subtype != null);
  return {
    events: list.flatMap((p) => p.events),
    final: list.at(-1)?.final ?? '',
    finals: list.map((p) => p.final),
    toolUses: list.flatMap((p, i) => p.toolUses.map((t) => ({ ...t, turn: i + 1 }))),
    result: {
      subtype: known ? list.at(-1).result.subtype : null,
      num_turns: list.reduce((n, p) => n + (p.result.num_turns ?? 0), 0),
      total_cost_usd: list.reduce((n, p) => n + (Number(p.result.total_cost_usd) || 0), 0),
      usage: list.at(-1)?.result.usage ?? null,
    },
  };
}

// Each turn's own assertions read that turn's stream only, and with one facts record per
// turn (an array), the files as that turn left them.
export function scoreTurns(parsed, turns, facts) {
  return turns.flatMap((t, i) => (t.assertions ?? []).map((a) => {
    const name = `turn ${i + 1}: ${a.type}`;
    if (!parsed[i]) return { type: name, pass: false, detail: `turn ${i + 1} did not run` };
    const [r] = score(parsed[i], Array.isArray(facts) ? facts[i] : facts, [a]);
    return { ...r, type: name };
  }));
}
