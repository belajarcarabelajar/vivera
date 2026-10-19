#!/usr/bin/env bun
// scripts/eval-run.mjs
//
// Runner half of the pipeline micro-eval. Each scenario in evals/scenarios/ runs
// one capped `claude -p` session against a throwaway git repository built from
// evals/fixtures/<fixture>, with this branch's skills and sprites installed as
// project files, and is scored by scripts/eval-score.mjs.
//
// Usage:
//   bun scripts/eval-run.mjs [--list] [--only <id,id>] [--budget-usd <total>]
//                            [--out <file.json>] [--baseline <file.json>] [--keep]
//                            [--scenarios <dir>]
//
// --scenarios exists for the tests; fixtures are read from <dir>/../fixtures.
// EVAL_CLAUDE_BIN replaces the claude binary (tests use a stub), EVAL_TMP_ROOT
// replaces ~/.cache/tmp/vivera-eval.
//
// Exit: 0 all scenarios pass, 1 any failure, skip, or baseline regression, 2 usage.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStream, score } from './eval-score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_TIMEOUT_MS = 300_000;
const PERMISSION_MODES = new Set(['dontAsk', 'default', 'acceptEdits', 'plan']);
// --setting-sources project,local also drops the user's PreToolUse hooks (rm-tmp-guard),
// so the tool lists below are the only fence between an agent under test and this machine.
const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Skill', 'TodoWrite',
  'Bash(bun *)', 'Bash(bunx *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)',
  'Bash(git add *)', 'Bash(git commit *)', 'Bash(ls*)', 'Bash(cat *)', 'Bash(rg *)', 'Bash(wc *)', 'Bash(head *)', 'Bash(tail *)',
];
const DISALLOWED_TOOLS = ['Bash(rm *)', 'Bash(git push*)', 'Bash(gh *)', 'Bash(curl *)', 'Bash(wget *)'];
const USAGE = 'usage: eval-run.mjs [--list] [--only <id,id>] [--budget-usd <total>] [--out <file.json>] [--baseline <file.json>] [--keep] [--scenarios <dir>]';
// The fixture repository must not depend on the host's git config: a global hook
// or signing setup would change what the initial commit is, or fail it.
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'eval',
  GIT_AUTHOR_EMAIL: 'eval@local',
  GIT_COMMITTER_NAME: 'eval',
  GIT_COMMITTER_EMAIL: 'eval@local',
};

class UsageError extends Error {}
class RefusedError extends Error {}

function parseArgs(argv) {
  const opts = { list: false, only: null, budget: 15, out: null, baseline: null, keep: false, scenarios: path.join(ROOT, 'evals', 'scenarios') };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--only') opts.only = value(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--budget-usd') {
      opts.budget = Number(value(i++, a));
      if (!Number.isFinite(opts.budget) || opts.budget <= 0) throw new UsageError('--budget-usd needs a positive number');
    } else if (a === '--out') opts.out = path.resolve(value(i++, a));
    else if (a === '--baseline') opts.baseline = path.resolve(value(i++, a));
    else if (a === '--scenarios') opts.scenarios = path.resolve(value(i++, a));
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return opts;
}

function validateScenario(s, file) {
  const bad = (why) => new UsageError(`${file}: ${why}`);
  if (!s || typeof s !== 'object') throw bad('not a JSON object');
  for (const k of ['id', 'prompt', 'fixture']) if (typeof s[k] !== 'string' || !s[k]) throw bad(`missing ${k}`);
  if (!Number.isInteger(s.max_turns) || s.max_turns < 1) throw bad('max_turns must be a positive integer');
  if (s.permission_mode === 'bypassPermissions') throw bad('permission_mode bypassPermissions is refused: it lets the agent under test run any command here');
  if (!PERMISSION_MODES.has(s.permission_mode)) throw bad(`permission_mode must be one of ${[...PERMISSION_MODES].join(', ')}`);
  if (s.allowed_tools != null && (!Array.isArray(s.allowed_tools) || s.allowed_tools.length === 0
    || !s.allowed_tools.every((t) => typeof t === 'string' && t.trim() !== ''))) {
    throw bad('allowed_tools must be a non-empty array of tool names');
  }
  if (typeof s.budget_usd !== 'number' || !(s.budget_usd > 0)) throw bad('budget_usd must be a positive number');
  if (!Array.isArray(s.assertions) || s.assertions.length === 0) throw bad('assertions must be a non-empty array');
  if (s.overlay != null && (typeof s.overlay !== 'object' || Array.isArray(s.overlay))) throw bad('overlay must be a map of path to content');
  return s;
}

function loadScenarios(dir) {
  if (!fs.existsSync(dir)) throw new UsageError(`scenario directory not found: ${dir}`);
  const scenarios = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      throw new UsageError(`${f}: ${err.message}`);
    }
    return validateScenario(data, f);
  });
  const seen = new Set();
  for (const s of scenarios) {
    if (seen.has(s.id)) throw new UsageError(`duplicate scenario id: ${s.id}`);
    seen.add(s.id);
  }
  return scenarios;
}

function git(cwd, args, env = FIXTURE_GIT_ENV) {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function safeRelative(p) {
  const norm = path.normalize(String(p));
  if (path.isAbsolute(norm) || norm === '..' || norm.startsWith(`..${path.sep}`) || norm === '.') {
    throw new RefusedError(`refused: overlay path escapes the fixture: ${p}`);
  }
  return norm;
}

// Without --bare a fixture's settings hooks and .mcp.json run with no trust prompt.
function refuseRiskyConfig(dir) {
  if (fs.existsSync(path.join(dir, '.mcp.json'))) throw new RefusedError('refused: fixture contains .mcp.json');
  const claudeDir = path.join(dir, '.claude');
  if (fs.existsSync(claudeDir)) {
    const hit = fs.readdirSync(claudeDir).find((f) => /^settings.*\.json$/.test(f));
    if (hit) throw new RefusedError(`refused: fixture contains .claude/${hit}`);
  }
}

function installRules(dir) {
  const skillsSrc = path.join(ROOT, 'skills');
  const skillsDest = path.join(dir, '.claude', 'skills');
  fs.mkdirSync(skillsDest, { recursive: true });
  for (const name of fs.readdirSync(skillsSrc)) {
    const real = fs.realpathSync(path.join(skillsSrc, name));
    if (!fs.statSync(real).isDirectory()) continue;
    fs.cpSync(real, path.join(skillsDest, name), { recursive: true, dereference: true });
  }
  const agentsSrc = path.join(ROOT, '.claude', 'agents');
  const agentsDest = path.join(dir, '.claude', 'agents');
  fs.mkdirSync(agentsDest, { recursive: true });
  for (const f of fs.readdirSync(agentsSrc).filter((n) => n.endsWith('.md'))) {
    fs.copyFileSync(fs.realpathSync(path.join(agentsSrc, f)), path.join(agentsDest, f));
  }
}

function buildFixture(scenario, fixturesDir, dest) {
  const src = path.join(fixturesDir, safeRelative(scenario.fixture));
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new RefusedError(`refused: fixture not found: ${scenario.fixture}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  for (const [rel, content] of Object.entries(scenario.overlay ?? {})) {
    const target = path.join(dest, safeRelative(rel));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(content));
  }
  refuseRiskyConfig(dest);
  installRules(dest);
  gitOk(dest, ['init', '-q', '-b', 'main']);
  gitOk(dest, ['add', '-A']);
  gitOk(dest, ['commit', '-q', '-m', 'eval fixture']);
  return gitOk(dest, ['rev-parse', 'HEAD']).trim();
}

function money(n) {
  return String(Math.round(n * 10000) / 10000);
}

function runClaude(scenario, dir, budget) {
  const bin = process.env.EVAL_CLAUDE_BIN || 'claude';
  const args = [
    '-p', scenario.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(scenario.max_turns),
    '--permission-mode', scenario.permission_mode,
    '--allowedTools', (scenario.allowed_tools ?? DEFAULT_ALLOWED_TOOLS).join(','),
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    '--no-session-persistence',
    '--max-budget-usd', money(budget),
    '--setting-sources', 'project,local',
  ];
  const r = spawnSync(bin, args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  });
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL';
  return { stdout: r.stdout ?? '', status: r.status, timedOut, spawnError: timedOut ? null : r.error };
}

function collectFacts(dir, initialSha, assertions) {
  const status = git(dir, ['status', '--porcelain', '-uall']).stdout ?? '';
  const paths = [...new Set(assertions.map((a) => a?.path).filter((p) => typeof p === 'string'))];
  const initialFiles = {};
  const files = {};
  for (const p of paths) {
    const shown = git(dir, ['show', `${initialSha}:${p}`]);
    initialFiles[p] = shown.status === 0 ? shown.stdout : null;
    const abs = path.join(dir, p);
    files[p] = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null;
  }
  const log = git(dir, ['log', '--format=%B%x00', `${initialSha}..HEAD`]);
  const commitMessages = log.status === 0 ? log.stdout.split('\0').map((m) => m.trim()).filter(Boolean) : [];
  return { statusPorcelain: status, initialFiles, files, commitMessages };
}

// Names only: the denied input is the agent's own text and stays out of the report.
function deniedToolNames(events) {
  const result = [...events].reverse().find((e) => e?.type === 'result');
  const denials = Array.isArray(result?.permission_denials) ? result.permission_denials : [];
  return denials.map((d) => d?.tool_name).filter((n) => typeof n === 'string');
}

function contextTokens(usage) {
  if (!usage) return 0;
  return ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
    .reduce((sum, k) => sum + (Number(usage[k]) || 0), 0);
}

function runScenario(scenario, fixturesDir, runDir, budget) {
  const started = Date.now();
  const dest = path.join(runDir, scenario.id);
  const base = { id: scenario.id, turns: null, cost: 0, usage: null, permission_denials: [] };
  let initialSha;
  try {
    initialSha = buildFixture(scenario, fixturesDir, dest);
  } catch (err) {
    if (!(err instanceof RefusedError)) throw err;
    return { ...base, pass: false, results: [{ type: 'fixture', pass: false, detail: err.message }], seconds: 0 };
  }
  const run = runClaude(scenario, dest, budget);
  const parsed = parseStream(run.stdout);
  const results = score(parsed, collectFacts(dest, initialSha, scenario.assertions), scenario.assertions);
  if (run.timedOut) results.unshift({ type: 'run', pass: false, detail: `timed out after ${RUN_TIMEOUT_MS / 1000} s` });
  else if (run.spawnError) results.unshift({ type: 'run', pass: false, detail: `could not start claude: ${run.spawnError.code ?? run.spawnError.message}` });
  else if (parsed.result.subtype == null) results.unshift({ type: 'run', pass: false, detail: `no result event (exit ${run.status})` });
  return {
    ...base,
    pass: results.every((r) => r.pass),
    results,
    turns: parsed.result.num_turns,
    cost: Number(parsed.result.total_cost_usd) || 0,
    usage: parsed.result.usage,
    permission_denials: deniedToolNames(parsed.events),
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

function line(r, width) {
  const id = r.id.padEnd(width);
  if (r.skipped) return `${id}  SKIP  total budget reached`;
  const failed = r.results.find((x) => !x.pass);
  const why = failed ? `  ${failed.type}: ${failed.detail}` : '';
  return `${id}  ${r.pass ? 'PASS' : 'FAIL'}${why}  turns=${r.turns ?? '-'}  $${money(r.cost)}  ${r.seconds}s`;
}

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function compareBaseline(file, scenarios) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read baseline ${file}: ${err.message}`);
  }
  const before = new Map((data.scenarios ?? []).map((s) => [s.id, Boolean(s.pass)]));
  const regressions = [];
  const improvements = [];
  for (const s of scenarios) {
    if (s.skipped || !before.has(s.id)) continue;
    if (before.get(s.id) && !s.pass) regressions.push(s.id);
    if (!before.get(s.id) && s.pass) improvements.push(s.id);
  }
  return { regressions, improvements };
}

function main(argv) {
  const opts = parseArgs(argv);
  let scenarios = loadScenarios(opts.scenarios);
  if (opts.only) {
    const known = new Set(scenarios.map((s) => s.id));
    const unknown = opts.only.filter((id) => !known.has(id));
    if (unknown.length) throw new UsageError(`unknown scenario id: ${unknown.join(', ')}`);
    const wanted = new Set(opts.only);
    scenarios = scenarios.filter((s) => wanted.has(s.id));
  }
  if (opts.list) {
    for (const s of scenarios) console.log(`${s.id}  ${s.behaviour ?? ''}`);
    return 0;
  }
  const fixturesDir = path.join(path.dirname(opts.scenarios), 'fixtures');
  const date = localDate();
  const commit = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const tmpRoot = process.env.EVAL_TMP_ROOT || path.join(os.homedir(), '.cache', 'tmp', 'vivera-eval');
  const runDir = path.join(tmpRoot, runId);
  const width = Math.max(...scenarios.map((s) => s.id.length), 2);

  const done = [];
  let spent = 0;
  try {
    for (const s of scenarios) {
      if (spent >= opts.budget) {
        done.push({ id: s.id, pass: false, skipped: true, results: [], turns: null, cost: 0, usage: null, permission_denials: [], seconds: 0 });
      } else {
        const r = runScenario(s, fixturesDir, runDir, Math.min(s.budget_usd, opts.budget - spent));
        spent += r.cost;
        done.push(r);
      }
      console.log(line(done[done.length - 1], width));
    }
  } finally {
    if (opts.keep) console.log(`kept fixtures in ${runDir}`);
    else fs.rmSync(runDir, { recursive: true, force: true });
  }

  const passed = done.filter((r) => r.pass).length;
  const skipped = done.filter((r) => r.skipped).length;
  const tokens = done.reduce((sum, r) => sum + contextTokens(r.usage), 0);
  console.log(`${passed}/${done.length} passed${skipped ? `, ${skipped} skipped` : ''}, total cost $${money(spent)}, context tokens ${tokens}`);

  const out = opts.out ?? path.join(ROOT, 'docs', 'code-plan', 'evals', `${date}-${commit.slice(0, 7) || 'nocommit'}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ runId, commit, date, scenarios: done }, null, 2)}\n`);
  console.log(`wrote ${out}`);

  let regressed = false;
  if (opts.baseline) {
    const { regressions, improvements } = compareBaseline(opts.baseline, done);
    for (const id of regressions) console.log(`regression: ${id}`);
    for (const id of improvements) console.log(`improvement: ${id}`);
    regressed = regressions.length > 0;
  }
  return passed === done.length && !regressed ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(err?.stack ?? String(err));
    process.exitCode = 1;
  }
}
