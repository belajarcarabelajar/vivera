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
//                            [--no-invoke] [--no-sandbox] [--scenarios <dir>]
//                            [--repeat <odd n>] [--confirm-flips <even k>] [--no-early-stop]
// The last three set the repeated attempts behind each verdict and the flaky rule:
// scripts/lib/eval-repeat.mjs. Console and file output: scripts/lib/eval-run-report.mjs.
//
// A scenario's prompt is sent as `/<invoke> <prompt>`, invoke defaulting to the
// orchestrator skill, because a plain headless prompt never loads the pipeline
// rules. `invoke: false` or --no-invoke sends it bare, as a bare-model control.
//
// --scenarios exists for the tests; fixtures are read from <dir>/../fixtures.
// EVAL_CLAUDE_BIN replaces the claude binary (tests use a stub), EVAL_TMP_ROOT
// replaces /tmp/vivera-eval and is refused inside the home directory.
//
// Each claude run goes through bwrap (scripts/lib/eval-sandbox.mjs) when it exists:
// the host is read-only with an empty home, and only the run dir is writable. Without bwrap
// the runner warns and runs unsandboxed; --no-sandbox turns it off. EVAL_BWRAP
// replaces /usr/bin/bwrap for the tests.
//
// Exit: 0 all pass (with --baseline: no regression and no skip), else 1; 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStream, score } from './eval-score.mjs';
import { FLAKY_ATTEMPTS, baselineMap, invokeMismatch, parseCount, runRepeated } from './lib/eval-repeat.mjs';
import { line, localDate, printComparison, printSummary, writeReport } from './lib/eval-run-report.mjs';
import { DISALLOWED_TOOLS, EVAL_NOTE, runExitCode, allowedTools, childEnv, runInGroup, sandboxCommand, scratchRoot } from './lib/eval-sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// EVAL_SCENARIO_TIMEOUT_S exists for the tests, which need a run killed in seconds.
const RUN_TIMEOUT_S = Number(process.env.EVAL_SCENARIO_TIMEOUT_S) > 0 ? Number(process.env.EVAL_SCENARIO_TIMEOUT_S) : 300;
const DEFAULT_INVOKE = 'super-ultra-code-plan';
// One ceiling for every run: a per-scenario figure the model can see made it skip work to save money.
const RUN_CEILING_USD = 2;
const PERMISSION_MODES = new Set(['dontAsk', 'default', 'acceptEdits', 'plan']);
const USAGE = 'usage: eval-run.mjs [--list] [--only <id,id>] [--budget-usd <total>] [--out <file.json>] [--baseline <file.json>] [--keep] [--no-invoke] [--no-sandbox] [--scenarios <dir>] [--repeat <odd n>] [--confirm-flips <even k>] [--no-early-stop]';
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
  const opts = { list: false, noInvoke: false, noSandbox: false, only: null, budget: 15, out: null, baseline: null, keep: false, repeat: 3, confirmFlips: 0, noEarlyStop: false, scenarios: path.join(ROOT, 'evals', 'scenarios') };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--no-invoke') opts.noInvoke = true;
    else if (a === '--no-sandbox') opts.noSandbox = true;
    else if (a === '--no-early-stop') opts.noEarlyStop = true;
    else if (a === '--only') opts.only = value(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--budget-usd') {
      opts.budget = Number(value(i++, a));
      if (!Number.isFinite(opts.budget) || opts.budget <= 0) throw new UsageError('--budget-usd needs a positive number');
    } else if (a === '--out') opts.out = path.resolve(value(i++, a));
    else if (a === '--baseline') opts.baseline = path.resolve(value(i++, a));
    else if (a === '--repeat' || a === '--confirm-flips') {
      const r = a === '--repeat';
      const n = parseCount(value(i++, a), r ? 1 : 0, r ? 1 : 0);
      if (Number.isNaN(n)) throw new UsageError(`${a} needs ${r ? 'an odd' : 'an even'} whole number, at least ${r ? 1 : 0}`);
      opts[r ? 'repeat' : 'confirmFlips'] = n;
    } else if (a === '--scenarios') opts.scenarios = path.resolve(value(i++, a));
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return opts;
}

function validateScenario(s, file, skills) {
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
  if (!Array.isArray(s.assertions) || s.assertions.length === 0) throw bad('assertions must be a non-empty array');
  if (s.invoke !== undefined && s.invoke !== false && !(typeof s.invoke === 'string' && skills.has(s.invoke))) {
    throw bad(`invoke must be false or one of the installed skills, got ${JSON.stringify(s.invoke)}`);
  }
  if (s.overlay != null && (typeof s.overlay !== 'object' || Array.isArray(s.overlay))) throw bad('overlay must be a map of path to content');
  return s;
}

// The skill directories installRules copies into every fixture.
function installedSkills() {
  const src = path.join(ROOT, 'skills');
  return new Set(fs.readdirSync(src).filter((n) => fs.statSync(fs.realpathSync(path.join(src, n))).isDirectory()));
}

function loadScenarios(dir) {
  if (!fs.existsSync(dir)) throw new UsageError(`scenario directory not found: ${dir}`);
  const skills = installedSkills();
  const scenarios = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      throw new UsageError(`${f}: ${err.message}`);
    }
    return validateScenario(data, f, skills);
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

// Rounded down to the cent so the cap never exceeds what is left, and never zero.
function ceiling(remaining) {
  return Math.max(0.01, Math.floor(Math.min(RUN_CEILING_USD, remaining) * 100 + 1e-9) / 100);
}

async function runClaude(scenario, dir, budget, invoke, root, bwrap) {
  const bin = process.env.EVAL_CLAUDE_BIN || 'claude';
  const args = [
    '-p', invoke ? `/${invoke} ${scenario.prompt}` : scenario.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(scenario.max_turns),
    '--permission-mode', scenario.permission_mode,
    '--allowedTools', allowedTools(scenario, dir).join(','),
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    '--append-system-prompt', EVAL_NOTE,
    '--no-session-persistence',
    '--max-budget-usd', budget.toFixed(2),
    '--setting-sources', 'project,local',
  ];
  const run = bwrap ? sandboxCommand({ bwrap: bwrap.bin, runDir: bwrap.runDir, bin, args, env: childEnv(root) }) : { cmd: bin, argv: args, env: childEnv(root) };
  return runInGroup(run.cmd, run.argv, { cwd: dir, env: run.env, timeoutMs: RUN_TIMEOUT_S * 1000 });
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

async function runScenario(scenario, fixturesDir, runDir, budget, invoke, keep, index, bwrap, attempt) {
  const started = Date.now();
  // A path naming the scenario tells the agent what is tested and leaks into scored commands.
  const nth = attempt ? `-${attempt + 1}` : '';
  const dest = path.join(runDir, `${String(index + 1).padStart(2, '0')}${nth}`, 'project');
  const base = { id: scenario.id, invoke, turns: null, cost: 0, usage: null, permission_denials: [] };
  let initialSha;
  try {
    initialSha = buildFixture(scenario, fixturesDir, dest);
  } catch (err) {
    if (!(err instanceof RefusedError)) throw err;
    return { ...base, pass: false, results: [{ type: 'fixture', pass: false, detail: err.message }], seconds: 0 };
  }
  const run = await runClaude(scenario, dest, budget, invoke, path.dirname(runDir), bwrap && { bin: bwrap, runDir });
  // Beside the fixture, not inside it, so the stream never shows up in its git status.
  const stream = keep ? path.join(runDir, `${scenario.id}${nth}.stream.jsonl`) : undefined;
  if (stream) fs.writeFileSync(stream, run.stdout);
  const parsed = parseStream(run.stdout);
  const results = score(parsed, collectFacts(dest, initialSha, scenario.assertions), scenario.assertions);
  if (run.timedOut) results.unshift({ type: 'run', pass: false, detail: `timed out after ${RUN_TIMEOUT_S} s` });
  else if (run.spawnError) results.unshift({ type: 'run', pass: false, detail: `could not start claude: ${run.spawnError.code ?? run.spawnError.message}` });
  else if (parsed.result.subtype == null) results.unshift({ type: 'run', pass: false, detail: `no result event (exit ${run.status})` });
  return {
    ...base,
    pass: results.every((r) => r.pass),
    results,
    turns: parsed.result.num_turns,
    // Unknown, not zero: a run killed before its result event may have spent up to its ceiling.
    cost: run.timedOut && parsed.result.subtype == null ? null : Number(parsed.result.total_cost_usd) || 0,
    timed_out: run.timedOut,
    usage: parsed.result.usage,
    permission_denials: deniedToolNames(parsed.events),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ...(stream ? { stream, fixture: dest } : {}),
  };
}

function readBaseline(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read baseline ${file}: ${err.message}`);
  }
  return baselineMap(data);
}

async function main(argv) {
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
  const { root: scratch, error } = scratchRoot();
  if (error) throw new UsageError(error);
  const invokeOf = (s) => (opts.noInvoke ? false : s.invoke ?? DEFAULT_INVOKE);
  const baseline = opts.baseline ? readBaseline(opts.baseline) : null;
  const mismatch = baseline && invokeMismatch(baseline, scenarios, invokeOf);
  if (mismatch) throw new UsageError(mismatch);
  const fixturesDir = path.join(path.dirname(opts.scenarios), 'fixtures');
  const date = localDate();
  const commit = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const runDir = path.join(scratch, runId);
  const width = Math.max(...scenarios.map((s) => s.id.length), 2);
  let bwrap = opts.noSandbox ? null : process.env.EVAL_BWRAP || '/usr/bin/bwrap';
  if (bwrap && !fs.existsSync(bwrap)) {
    console.error(`warning: bwrap not found at ${bwrap}; running claude without the OS sandbox`);
    bwrap = null;
  }

  const done = [];
  let spent = 0;
  try {
    for (const [index, s] of scenarios.entries()) {
      if (spent >= opts.budget) {
        done.push({ id: s.id, invoke: invokeOf(s), pass: false, skipped: true, attempts: 0, passes: 0, pass_rate: null, results: [], turns: null, cost: 0, usage: null, permission_denials: [], seconds: 0 });
      } else {
        const before = baseline?.get(s.id);
        // A flaky scenario's majority flips by chance, so it always gets the full five runs its pass rate rule needs.
        const repeat = before?.flaky
          ? { repeat: FLAKY_ATTEMPTS, confirmFlips: 0, fullRun: true }
          : { repeat: opts.repeat, confirmFlips: opts.confirmFlips, fullRun: opts.noEarlyStop };
        // A full ceiling per attempt, so a confirmation never stops undecided.
        const record = await runRepeated(async (attempt) => {
          const cap = ceiling(opts.budget - spent);
          const r = await runScenario(s, fixturesDir, runDir, cap, invokeOf(s), opts.keep, index, bwrap, attempt);
          spent += r.cost ?? cap;
          return r;
        }, { ...repeat, expected: before?.pass, canRun: () => opts.budget - spent >= RUN_CEILING_USD });
        done.push(before?.flaky ? { ...record, flaky: true } : record);
      }
      console.log(line(done[done.length - 1], width));
    }
  } finally {
    if (opts.keep) console.log(`kept fixtures in ${runDir}`);
    else fs.rmSync(runDir, { recursive: true, force: true });
  }

  const { passed, skipped, unconfirmed } = printSummary(done, spent);

  const out = opts.out ?? path.join(ROOT, 'docs', 'code-plan', 'evals', `${date}-${commit.slice(0, 7) || 'nocommit'}.json`);
  writeReport(out, { runId, commit, date, scenarios: done });
  const regressed = baseline ? printComparison(baseline, done) : false;
  return runExitCode({ passed, total: done.length, regressed, skipped: skipped + unconfirmed, baseline: Boolean(baseline) });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(err?.stack ?? String(err));
    process.exitCode = 1;
  }
}
