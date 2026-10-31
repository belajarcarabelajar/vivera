#!/usr/bin/env bun
// scripts/plan-cost.mjs
//
// Read-only: reports the USD a plan cost, from Claude Code transcripts.
//   bun scripts/plan-cost.mjs --plan <plan-id> [--projects-root <dir>] [--json]
//
// The PR registry stores no session id, so a main transcript belongs to a plan when one
// of its Bash tool inputs ran `pr-registry claim --plan <id>`. Its subagent transcripts
// (<sessionId>/subagents/agent-*.jsonl) are added. Every project dir is scanned, because a
// plan can be claimed from a session whose cwd is another repository. The total is an
// estimate, off in both directions: a session that continued the plan without running
// claim is missed, and other work done in a claiming session is counted with the plan.
//
// Only counts, USD, and transcript basenames are printed, never transcript text.
// Exit 0 on a report (including n/a), 2 on a usage error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { callCostUsd, readTranscript } from './session-metrics.mjs';

const CLAIM_RE = /pr-registry(?:\.mjs)?\s+claim\b([^;&|\n]*)/g;
// The id ends at whitespace, a quote, or the end, so an id never matches a longer one it prefixes.
const PLAN_ARG_RE = /--plan(?:=|\s+)['"]?([^\s'"]+)/g;
const ESTIMATE_CAVEATS = [
  'a session that continued the plan without running the registry claim is not counted',
  'other work done in a claiming session, before or after the claim, is also counted',
];

// Plan ids claimed by the Bash tool inputs of one transcript.
export async function claimedPlans(file) {
  const ids = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('claim')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant' || !Array.isArray(rec.message?.content)) continue;
    for (const item of rec.message.content) {
      const cmd = item?.type === 'tool_use' && item.name === 'Bash' ? item.input?.command : null;
      if (typeof cmd !== 'string') continue;
      for (const [, args] of cmd.matchAll(CLAIM_RE)) {
        for (const [, id] of args.matchAll(PLAN_ARG_RE)) ids.add(id);
      }
    }
  }
  return ids;
}

export async function planCost({ plan, projectsRoot }) {
  const mains = [];
  let shared = 0;
  for (const ent of fs.readdirSync(projectsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(projectsRoot, ent.name);
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.jsonl')) continue;
      const ids = await claimedPlans(path.join(dir, f));
      if (!ids.has(plan)) continue;
      mains.push(path.join(dir, f));
      if (ids.size > 1) shared++;
    }
  }
  const subs = [];
  for (const m of mains) {
    const sd = path.join(m.replace(/\.jsonl$/, ''), 'subagents');
    if (!fs.existsSync(sd)) continue;
    for (const f of fs.readdirSync(sd).sort()) if (/^agent-.*\.jsonl$/.test(f)) subs.push(path.join(sd, f));
  }
  // A resumed or copied session repeats message ids across files; each is paid once.
  const seen = new Set();
  let usd = 0;
  let unpricedCalls = 0;
  for (const f of [...mains, ...subs]) {
    for (const c of (await readTranscript(f)).calls) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const u = c.usage;
      const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
        .reduce((n, k) => n + (Number.isFinite(u[k]) ? u[k] : 0), 0);
      // A call with no tokens costs nothing whatever its model (e.g. <synthetic>).
      if (!tokens) continue;
      const cost = callCostUsd(c.model, u);
      if (cost === null) unpricedCalls++;
      else usd += cost;
    }
  }
  return {
    plan,
    mainTranscripts: mains.length,
    subagentRuns: subs.length,
    usd: mains.length ? Math.round(usd * 1e4) / 1e4 : null,
    estimate: true,
    caveats: ESTIMATE_CAVEATS,
    shared,
    unpricedCalls,
    transcripts: mains.map((m) => path.basename(m)),
  };
}

function renderPlanCost(r) {
  const lines = [
    `plan: ${r.plan}`,
    `main transcripts: ${r.mainTranscripts}`,
    `subagent runs: ${r.subagentRuns}`,
    `usd: ${r.usd === null ? 'n/a' : r.usd.toFixed(4)} (estimate)`,
    ...r.caveats.map((c) => `caveat: ${c}`),
    `shared: ${r.shared} (matched transcripts that also claimed another plan)`,
  ];
  if (r.unpricedCalls) lines.push(`unpriced calls: ${r.unpricedCalls} (models without a price; left out of usd, not zero)`);
  if (r.transcripts.length) lines.push(`transcripts: ${r.transcripts.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

function usage(msg) {
  process.stderr.write(`plan-cost: ${msg}\nusage: bun scripts/plan-cost.mjs --plan <plan-id> [--projects-root <dir>] [--json]\n`);
  return 2;
}

export async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: { plan: { type: 'string' }, 'projects-root': { type: 'string' }, json: { type: 'boolean' } },
    }));
  } catch (e) {
    return usage(e.message);
  }
  const plan = values.plan?.trim();
  if (!plan || /[\s'"]/.test(plan)) return usage('--plan <plan-id> is required');
  const projectsRoot = values['projects-root'] ?? path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot) || !fs.statSync(projectsRoot).isDirectory()) {
    return usage(`projects root not found: ${projectsRoot}`);
  }
  const r = await planCost({ plan, projectsRoot });
  process.stdout.write(values.json ? `${JSON.stringify(r, null, 2)}\n` : renderPlanCost(r));
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
