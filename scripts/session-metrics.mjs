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

export const COST_WEIGHTS = { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 };
const WEIGHTS_TEXT = '0.1*cache_read + 2*cache_write + 5*output + input';
const DAY_MS = 86400000;
// Skill and agent names are printed, so anything that does not look like a name
// is folded into one bucket rather than risk echoing free text.
const NAME_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
// Sprite agent types are stored padded with spaces (" chef "), so trim first.
const safeName = (s) => (typeof s === 'string' && NAME_RE.test(s.trim()) ? s.trim() : '<other>');

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
    const id = msg.id ?? `anon-${anon++}`;
    let call = byId.get(id);
    if (!call) {
      call = { id, usage: null, tools: [], skills: [], seen: new Set() };
      byId.set(id, call);
    }
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

const num = (v) => (Number.isFinite(v) ? v : 0);
const ctxOf = (u) => num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
const round = (v, d = 4) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const ratio = (a, b) => (b ? round(a / b) : null);

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
  if (entry.repo) return entry.repo.replace(/\/+$/, '').endsWith(name);
  const segs = String(entry.worktree ?? '').split('/');
  return segs.includes(name) || segs.includes(`${name}-wt`);
}

const bump = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };

export function summarize({ mains, subs, registry, fixes, window = {}, repo = '' }) {
  const b = windowBounds(window);
  const M = mains.filter((t) => inWindow(t.firstTs, b));
  const S = subs.filter((t) => inWindow(t.firstTs, b));
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const skills = {};
  let apiCalls = 0;
  let ask = 0;
  let agentCalls = 0;
  for (const t of [...M, ...S]) {
    for (const c of t.calls) {
      apiCalls++;
      tokens.input += num(c.usage.input_tokens);
      tokens.cacheWrite += num(c.usage.cache_creation_input_tokens);
      tokens.cacheRead += num(c.usage.cache_read_input_tokens);
      tokens.output += num(c.usage.output_tokens);
      for (const name of c.tools) {
        if (name === 'AskUserQuestion') ask++;
        if (name === 'Agent') agentCalls++;
      }
      for (const s of c.skills) bump(skills, s);
    }
  }
  const costUnits = round(
    COST_WEIGHTS.input * tokens.input + COST_WEIGHTS.cacheWrite * tokens.cacheWrite
    + COST_WEIGHTS.cacheRead * tokens.cacheRead + COST_WEIGHTS.output * tokens.output, 1,
  );
  const firstCtx = (t) => (t.calls.length ? ctxOf(t.calls[0].usage) : null);
  const firsts = (ts) => ts.map(firstCtx).filter((v) => v !== null);
  const shares = S.filter((t) => t.calls.length).map((t) => {
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
  const subagentsByType = {};
  for (const t of S) bump(subagentsByType, safeName(t.agentType ?? 'unknown'));

  let mergedPrs = null;
  if (registry) {
    mergedPrs = (registry.sessions ?? []).filter((e) => e.merged_at && inWindow(e.merged_at, b) && repoMatches(e, repo)).length;
  }
  const escapes = Number.isFinite(fixes) ? fixes : null;
  const context = tokens.input + tokens.cacheWrite + tokens.cacheRead;
  const per = (v) => (mergedPrs && v !== null ? round(v / mergedPrs) : null);
  return {
    window: { since: window.since ?? null, until: window.until ?? null },
    mainSessions: M.length,
    subagentRuns: S.length,
    subagentsPerMain: ratio(S.length, M.length),
    apiCalls,
    tokens,
    costWeights: COST_WEIGHTS,
    costUnits,
    medianFirstCallContext: { main: median(firsts(M)), subagent: median(firsts(S)) },
    startupPrefixShare: round(median(shares)),
    subagentsByType,
    agentToolCalls: agentCalls,
    askUserQuestion: ask,
    skills,
    mergedPrs,
    escapes,
    perMergedPr: {
      contextTokens: per(context),
      outputTokens: per(tokens.output),
      costUnits: per(costUnits),
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
    [`cost-weighted units (${WEIGHTS_TEXT})`, s.costUnits],
    ['median first-call context, main', s.medianFirstCallContext.main],
    ['median first-call context, subagent', s.medianFirstCallContext.subagent],
    ['startup-prefix share of subagents', s.startupPrefixShare],
    ['Agent tool calls', s.agentToolCalls],
    ['AskUserQuestion calls', s.askUserQuestion],
    ['merged PRs in window', s.mergedPrs],
    ['escapes (Fixes: trailers on origin/main)', s.escapes],
    ['per merged PR: context tokens', s.perMergedPr.contextTokens],
    ['per merged PR: output tokens', s.perMergedPr.outputTokens],
    ['per merged PR: cost-weighted units', s.perMergedPr.costUnits],
    ['per merged PR: AskUserQuestion', s.perMergedPr.askUserQuestion],
    ['per merged PR: escapes', s.perMergedPr.escapes],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `${k.padEnd(width)}  ${fmt(v)}`);
  const block = (title, obj) => {
    const keys = Object.keys(obj).sort((a, b) => obj[b] - obj[a] || a.localeCompare(b));
    lines.push('', title, ...(keys.length ? keys.map((k) => `  ${k.padEnd(width - 2)}  ${obj[k]}`) : ['  (none)']));
  };
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
    if (values[k] !== undefined && (!DATE_RE.test(values[k]) || Number.isNaN(Date.parse(values[k])))) {
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
  const projectsDir = values['projects-dir'] ?? path.join(os.homedir(), '.claude', 'projects', slugFor(repo));
  const registryPath = values.registry ?? path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'pr.registry.json');
  if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) {
    process.stderr.write(`session-metrics: project dir not found: ${projectsDir}\nNo transcripts were read, so no counts are reported.\n`);
    return 1;
  }
  const window = { since: values.since, until: values.until };
  const notes = [];
  const files = listTranscripts(projectsDir, windowBounds(window).from);
  const mains = [];
  for (const f of files.mains) mains.push(await readTranscript(f));
  const subs = [];
  for (const f of files.subs) subs.push({ agentType: agentTypeOf(f), ...(await readTranscript(f)) });
  let registry = null;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    notes.push(`registry not read (${registryPath}); merged PR counts are n/a, not zero`);
  }
  const fixes = countFixes(repo, window);
  if (fixes === null) notes.push('git log origin/main failed; escapes are n/a, not zero');
  const s = summarize({ mains, subs, registry, fixes, window, repo });
  process.stdout.write(values.json ? `${JSON.stringify({ ...s, notes }, null, 2)}\n` : renderText(s, notes));
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
