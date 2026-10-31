#!/usr/bin/env bun
// scripts/session-metrics.mjs
//
// Read-only report of pipeline cost and behaviour from Claude Code transcripts
// plus the PR registry. It prints counts only: transcript text, tool inputs and
// tool results are parsed for numbers and never echoed.
//
//   bun scripts/session-metrics.mjs [--repo <path>] [--projects-dir <dir>]
//     [--registry <path>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
//
// Exit 0 ok, 1 when the project dir is missing, 2 on a usage error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { num, readTranscriptSignals } from './lib/session-signals.mjs';

// USD per million tokens: Anthropic list prices via the claude-api skill (model table cached 2026-10-06).
const card = (input, output, cacheRead) => ({ input, output, cacheRead });
export const PRICES = {
  'claude-fable-5-1': card(10, 50, 0.25),
  'claude-mythos-5-1': card(10, 50, 0.25),
  'claude-fable-5': card(10, 50, 1),
  'claude-mythos-5': card(10, 50, 1),
  'claude-opus-5-5': card(4, 20, 0.2),
  'claude-opus-5': card(5, 25, 0.5),
  'claude-opus-4-8': card(5, 25, 0.5),
  'claude-opus-4-7': card(5, 25, 0.5),
  'claude-opus-4-6': card(5, 25, 0.5),
  'claude-sonnet-5-5': card(2, 10, 0.2),
  'claude-sonnet-5': card(2, 10, 0.2),
  'claude-sonnet-4-6': card(3, 15, 0.3),
  'claude-haiku-5-5': { ...card(0.1, 0.5, 0.01), long: { above: 100000, ...card(0.5, 2.5, 0.05) } },
  'claude-haiku-4-5': card(1, 5, 0.1),
};
export const PRICES_AS_OF = '2026-10-20';
const DAY_MS = 86400000;
// Skill and agent names are printed, so anything that does not look like a name
// is folded into one bucket rather than risk echoing free text.
const NAME_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
// Sprite agent types are stored padded with spaces (" chef "), so trim first.
const safeName = (s) => (typeof s === 'string' && NAME_RE.test(s.trim()) ? s.trim() : '<other>');

// dup-defs: allow a Claude Code project slug, not the vault note slug of vault-index-structural.mjs
export function slugFor(repoPath) {
  return path.resolve(repoPath).replace(/\//g, '-');
}

export async function readTranscript(file) {
  const byId = new Map();
  let firstTs = null;
  let lastTs = null;
  let anon = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec.timestamp === 'string') {
      if (firstTs === null || rec.timestamp < firstTs) firstTs = rec.timestamp;
      if (lastTs === null || rec.timestamp > lastTs) lastTs = rec.timestamp;
    }
    if (rec.type !== 'assistant' || !rec.message) continue;
    const msg = rec.message;
    // An id-less message must never collide with one in another file during cross-file dedupe.
    const id = msg.id ?? `${file}#anon-${anon++}`;
    let call = byId.get(id);
    if (!call) {
      call = { id, model: null, usage: null, tools: [], skills: [], seen: new Set() };
      byId.set(id, call);
    }
    if (msg.model != null) call.model = msg.model;
    if (msg.usage) call.usage = msg.usage;
    for (const item of Array.isArray(msg.content) ? msg.content : []) {
      if (item?.type !== 'tool_use') continue;
      const key = item.id ?? `${call.tools.length}`;
      if (call.seen.has(key)) continue;
      call.seen.add(key);
      call.tools.push(safeName(item.name));
      if (item.name === 'Skill') call.skills.push(safeName(item.input?.skill));
    }
  }
  const calls = [...byId.values()].map(({ seen, ...c }) => ({ ...c, usage: c.usage ?? {} }));
  return { calls, firstTs, lastTs };
}

// The TTL split can exceed the reported total (seen once: total 0, 1-hour split 4076), so the larger counts.
const writesOf = (u) => Math.max(num(u.cache_creation_input_tokens),
  num(u.cache_creation?.ephemeral_5m_input_tokens) + num(u.cache_creation?.ephemeral_1h_input_tokens));
const ctxOf = (u) => num(u.input_tokens) + writesOf(u) + num(u.cache_read_input_tokens);
const round = (v, d = 4) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const ratio = (a, b) => (b ? round(a / b) : null);

// USD for one API call, or null when its model has no price.
export function callCostUsd(model, usage = {}) {
  // hasOwn, so a model string such as "toString" never reads Object.prototype.
  if (!Object.hasOwn(PRICES, model)) return null;
  const base = PRICES[model];
  const rate = base.long && ctxOf(usage) > base.long.above ? base.long : base;
  const writes = num(usage.cache_creation_input_tokens);
  // Without the TTL split every write is a 5-minute write, the API default TTL.
  const split = usage.cache_creation;
  const w5m = split ? num(split.ephemeral_5m_input_tokens) : writes;
  const w1h = split ? num(split.ephemeral_1h_input_tokens) : 0;
  return (num(usage.input_tokens) * rate.input + w5m * rate.input * 1.25 + w1h * rate.input * 2
    + num(usage.cache_read_input_tokens) * rate.cacheRead + num(usage.output_tokens) * rate.output) / 1e6;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function windowBounds(window = {}) {
  return {
    from: window.since ? Date.parse(`${window.since}T00:00:00Z`) : -Infinity,
    to: window.until ? Date.parse(`${window.until}T00:00:00Z`) + DAY_MS : Infinity,
  };
}

function inWindow(ts, b) {
  if (!ts) return false;
  const t = Date.parse(ts);
  return t >= b.from && t < b.to;
}

export function repoMatches(entry, repo) {
  const name = path.basename(path.resolve(repo));
  if (entry.repo) return path.basename(path.resolve(entry.repo)) === name;
  const segs = String(entry.worktree ?? '').split('/');
  // vivera was named ai-skills, and its oldest registry entries still carry that worktree path.
  return segs.includes(`${name}-wt`) || (name === 'vivera' && segs.includes('ai-skills-wt'));
}

// dup-defs: allow the skipif-registry-audit bump is private to that CLI module
const bump = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };
// No prototype, so a name such as "toString" or "__proto__" counts like any other.
const counter = () => Object.create(null);
// Code point order, not localeCompare, so ties sort the same under every locale.
const byCountThenName = (obj) => Object.fromEntries(
  Object.entries(obj).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)),
);

// Claude Code can leave one conversation in two transcript files (a resumed or
// copied session), so a message id is counted once across the whole set. The
// earliest file keeps it, and a file left with no calls is not a session.
function dedupeAcross(transcripts) {
  const order = [...transcripts].sort((x, y) => (x.firstTs ?? '').localeCompare(y.firstTs ?? '') || (x.file ?? '').localeCompare(y.file ?? ''));
  const seen = new Set();
  const out = [];
  for (const t of order) {
    const calls = t.calls.filter((c) => !seen.has(c.id));
    for (const c of calls) seen.add(c.id);
    if (calls.length) out.push({ ...t, calls });
  }
  return out;
}

// dup-defs: allow the summarize(...) signature is the contract named in plan 2026-10-19-pipeline-efficiency T3
export function summarize({ mains, subs, registry, fixes, window = {}, repo = '' }) {
  const b = windowBounds(window);
  const M = dedupeAcross(mains.filter((t) => inWindow(t.firstTs, b)));
  const S = dedupeAcross(subs.filter((t) => inWindow(t.firstTs, b)));
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const skills = counter();
  const usdByModel = {};
  const unpricedModels = counter();
  let usd = 0;
  let apiCalls = 0;
  let ask = 0;
  let agentCalls = 0;
  for (const t of [...M, ...S]) {
    for (const c of t.calls) {
      apiCalls++;
      tokens.input += num(c.usage.input_tokens);
      tokens.cacheWrite += writesOf(c.usage);
      tokens.cacheRead += num(c.usage.cache_read_input_tokens);
      tokens.output += num(c.usage.output_tokens);
      // A call with no tokens costs nothing whatever its model (e.g. <synthetic>).
      if (ctxOf(c.usage) + num(c.usage.output_tokens) > 0) {
        const model = safeName(c.model ?? 'unknown');
        const cost = callCostUsd(c.model, c.usage);
        if (cost === null) bump(unpricedModels, model);
        else {
          usd += cost;
          usdByModel[model] = (usdByModel[model] ?? 0) + cost;
        }
      }
      for (const name of c.tools) {
        if (name === 'AskUserQuestion') ask++;
        if (name === 'Agent') agentCalls++;
      }
      for (const s of c.skills) bump(skills, s);
    }
  }
  const firstCtx = (t) => {
    const c = t.calls.find((x) => ctxOf(x.usage) > 0);
    return c ? ctxOf(c.usage) : null;
  };
  const firsts = (ts) => ts.map(firstCtx).filter((v) => v !== null);
  const shares = S.filter((t) => firstCtx(t) !== null).map((t) => {
    const first = firstCtx(t);
    let num_ = 0;
    let den = 0;
    for (const c of t.calls) {
      const ctx = ctxOf(c.usage);
      num_ += Math.min(first, ctx);
      den += ctx;
    }
    return den ? num_ / den : null;
  }).filter((v) => v !== null);
  const subagentsByType = counter();
  for (const t of S) bump(subagentsByType, safeName(t.agentType ?? 'unknown'));

  let mergedPrs = null;
  if (registry) {
    mergedPrs = (registry.sessions ?? []).filter((e) => e.merged_at && inWindow(e.merged_at, b) && repoMatches(e, repo)).length;
  }
  const escapes = Number.isFinite(fixes) ? fixes : null;
  // Main sessions only: a subagent's own repeats and rebuilds belong to its run, not the session.
  const sig = (f) => M.reduce((n, t) => n + (t.signals ? f(t.signals) : 0), 0);
  const context = tokens.input + tokens.cacheWrite + tokens.cacheRead;
  const per = (v) => (mergedPrs && v !== null ? round(v / mergedPrs) : null);
  return {
    window: { since: window.since ?? null, until: window.until ?? null },
    mainSessions: M.length,
    subagentRuns: S.length,
    subagentsPerMain: ratio(S.length, M.length),
    apiCalls,
    tokens,
    costUsd: round(usd),
    costUsdByModel: byCountThenName(Object.fromEntries(Object.entries(usdByModel).map(([k, v]) => [k, round(v)]))),
    unpricedModels: byCountThenName(unpricedModels),
    pricesAsOf: PRICES_AS_OF,
    medianFirstCallContext: { main: median(firsts(M)), subagent: median(firsts(S)) },
    startupPrefixShare: round(median(shares)),
    subagentsByType: byCountThenName(subagentsByType),
    agentToolCalls: agentCalls,
    askUserQuestion: ask,
    repeatedToolCallRuns: { runs: sig((g) => g.repeatedToolCallRuns.runs), calls: sig((g) => g.repeatedToolCallRuns.calls) },
    cacheRebuildTurns: sig((g) => g.cacheRebuildTurns),
    skills: byCountThenName(skills),
    mergedPrs,
    escapes,
    perMergedPr: {
      contextTokens: per(context),
      outputTokens: per(tokens.output),
      // Divided before rounding, so a small total does not lose its per-PR share.
      costUsd: per(usd),
      askUserQuestion: per(ask),
      escapes: per(escapes),
    },
  };
}

function countFixes(repo, window) {
  const args = ['-C', repo, 'log', 'origin/main', '--format=%(trailers:key=Fixes,valueonly)'];
  if (window.since) args.push(`--since=${window.since} 00:00:00 +0000`);
  if (window.until) args.push(`--until=${window.until} 23:59:59 +0000`);
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter((l) => l.trim()).length;
}

function listTranscripts(dir, sinceMs) {
  // A file last written before the window start cannot have its first line inside it.
  const fresh = (f) => fs.statSync(f).mtimeMs >= sinceMs;
  const mains = [];
  const subs = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      if (fresh(p)) mains.push(p);
    } else if (ent.isDirectory()) {
      const sd = path.join(p, 'subagents');
      if (!fs.existsSync(sd)) continue;
      for (const f of fs.readdirSync(sd)) {
        const fp = path.join(sd, f);
        if (/^agent-.*\.jsonl$/.test(f) && fresh(fp)) subs.push(fp);
      }
    }
  }
  return { mains, subs };
}

function agentTypeOf(file) {
  try {
    return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const fmt = (v) => (v === null ? 'n/a' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 4 }) : String(v));

function renderText(s, notes) {
  const rows = [
    ['window (UTC)', `${s.window.since ?? 'start'} .. ${s.window.until ?? 'now'}`],
    ['main sessions', s.mainSessions],
    ['subagent runs', s.subagentRuns],
    ['subagents per main session', s.subagentsPerMain],
    ['API calls', s.apiCalls],
    ['tokens input', s.tokens.input],
    ['tokens cache write', s.tokens.cacheWrite],
    ['tokens cache read', s.tokens.cacheRead],
    ['tokens output', s.tokens.output],
    ['API list-price equivalent, USD', s.costUsd],
    ['prices as of', s.pricesAsOf],
    ['median first-call context, main', s.medianFirstCallContext.main],
    ['median first-call context, subagent', s.medianFirstCallContext.subagent],
    ['startup-prefix share of subagents', s.startupPrefixShare],
    ['Agent tool calls', s.agentToolCalls],
    ['AskUserQuestion calls', s.askUserQuestion],
    ['repeated identical tool-call runs (3+)', `${s.repeatedToolCallRuns.runs} runs, ${s.repeatedToolCallRuns.calls} calls`],
    ['cache rebuild turns', s.cacheRebuildTurns],
    ['merged PRs in window', s.mergedPrs],
    ['escapes (Fixes: trailers on origin/main)', s.escapes],
    ['per merged PR: context tokens', s.perMergedPr.contextTokens],
    ['per merged PR: output tokens', s.perMergedPr.outputTokens],
    ['per merged PR: API list-price USD', s.perMergedPr.costUsd],
    ['per merged PR: AskUserQuestion', s.perMergedPr.askUserQuestion],
    ['per merged PR: escapes', s.perMergedPr.escapes],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `${k.padEnd(width)}  ${fmt(v)}`);
  const block = (title, obj) => {
    const keys = Object.keys(byCountThenName(obj));
    lines.push('', title, ...(keys.length ? keys.map((k) => `  ${k.padEnd(width - 2)}  ${obj[k]}`) : ['  (none)']));
  };
  block('API list-price USD by model', s.costUsdByModel);
  block('subagent runs by agentType', s.subagentsByType);
  block('Skill loads by name', s.skills);
  if (notes.length) lines.push('', ...notes.map((n) => `note: ${n}`));
  return lines.join('\n') + '\n';
}

function usage(msg) {
  process.stderr.write(`session-metrics: ${msg}\nusage: bun scripts/session-metrics.mjs [--repo <path>] [--projects-dir <dir>] [--registry <path>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]\n`);
  return 2;
}

export async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        repo: { type: 'string' }, 'projects-dir': { type: 'string' }, registry: { type: 'string' },
        since: { type: 'string' }, until: { type: 'string' }, json: { type: 'boolean' },
      },
    }));
  } catch (e) {
    return usage(e.message);
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  for (const k of ['since', 'until']) {
    const v = values[k];
    const real = DATE_RE.test(v ?? '') && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
      && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
    if (v !== undefined && !real) {
      return usage(`--${k} must be YYYY-MM-DD`);
    }
  }
  let repo = values.repo;
  if (!repo) {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (r.status !== 0) return usage('not inside a git repository; pass --repo');
    repo = r.stdout.trim();
  }
  repo = path.resolve(repo);
  let projectsDir = values['projects-dir'] ?? path.join(os.homedir(), '.claude', 'projects', slugFor(repo));
  let fallback = null;
  // Transcripts are keyed by the dir a session started in, usually the main checkout, not a linked worktree.
  if (!values.repo && !values['projects-dir'] && !fs.existsSync(projectsDir)) {
    const g = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { encoding: 'utf8' });
    const [gitDir, common] = g.status === 0 ? g.stdout.trim().split('\n') : [];
    if (common && gitDir !== common) {
      repo = path.dirname(common);
      projectsDir = path.join(os.homedir(), '.claude', 'projects', slugFor(repo));
      fallback = `linked worktree: read the transcripts of the main checkout ${repo}`;
    }
  }
  const registryPath = values.registry ?? path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'pr.registry.json');
  if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) {
    process.stderr.write(`session-metrics: project dir not found: ${projectsDir}\nNo transcripts were read, so no counts are reported.\n`);
    return 1;
  }
  const window = { since: values.since, until: values.until };
  const notes = fallback ? [fallback] : [];
  const files = listTranscripts(projectsDir, windowBounds(window).from);
  const mains = [];
  for (const f of files.mains) mains.push({ file: f, ...(await readTranscript(f)), signals: await readTranscriptSignals(f) });
  const subs = [];
  for (const f of files.subs) subs.push({ file: f, agentType: agentTypeOf(f), ...(await readTranscript(f)) });
  let registry = null;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    notes.push(`registry not read (${registryPath}); merged PR counts are n/a, not zero`);
  }
  const fixes = countFixes(repo, window);
  if (fixes === null) notes.push('git log origin/main failed; escapes are n/a, not zero');
  const s = summarize({ mains, subs, registry, fixes, window, repo });
  const unpriced = Object.entries(s.unpricedModels);
  if (unpriced.length) {
    const calls = unpriced.reduce((n, [, v]) => n + v, 0);
    notes.push(`${calls} call(s) from models without a price (${unpriced.map(([k, v]) => `${k} x${v}`).join(', ')}); costUsd leaves them out, it is not zero for them`);
  }
  process.stdout.write(values.json ? `${JSON.stringify({ ...s, notes }, null, 2)}\n` : renderText(s, notes));
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
