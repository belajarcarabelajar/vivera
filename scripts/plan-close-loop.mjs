// scripts/plan-close-loop.mjs
//
// The close-out loop: which landed plans may be marked Complete now. `--due`
// measures every plan whose registry sessions all landed while the plan never
// reached Complete, and caches the result for the session-start note.
// `--keep-open` records the owner's answer for a plan at its current hash, so
// the plan stays off the list until its text changes. Neither mode writes a plan
// file. `--flip` is the Complete flip, run only after the owner's Close plan
// answer: one close-out PR per repository (scripts/lib/closeout-flip.mjs).

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { auditCloseout } from './plan-closeout.mjs';
import { planStatus, ghRunner, loadConfig, resolveProjectRepo, ISSUES_STORE } from './plan-issue-sync.mjs';
import { extractFrontmatter } from './ultra-plan-runner.mjs';
import { readinessVerdict, openNowRows, openStepBoxes } from './lib/plan-readiness.mjs';
import { planFileOf } from './lib/registry-plan-file.mjs';
import { hashOf } from './lib/plan-issue-render.mjs';
import { readDue, writeDue, readKept, writeKept } from './lib/closeout-state.mjs';
import { flipRepo } from './lib/closeout-flip.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const closeoutScript = path.join(repoRoot, 'scripts', 'plan-closeout.mjs');
const PR_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

const entryOf = (row, p, fallbackRepo) => ({
  plan: row.plan, repo: row.repo ?? fallbackRepo ?? null, file: p?.file ?? null, hash: null,
  verdict: null, asserted: 0, tickable: 0, pending_pr: null,
});

export function dueList({ sessions, readPlan, measure, kept = {}, prior = {}, now = Date.now(), fallbackRepo = null }) {
  const read = new Map();
  const planOf = (s) => {
    if (!read.has(s.plan)) read.set(s.plan, readPlan(s));
    return read.get(s.plan);
  };
  const planStatusOf = (s) => {
    const p = planOf(s);
    return p?.text != null ? planStatus(p.text) : null;
  };
  const priorOf = new Map((prior.plans ?? []).map((e) => [e.plan, e]));
  const plans = [];
  const skipped = [];
  // Skipped plans whose close-out PR is still open; due.json keeps them, or the next run would forget the PR.
  const carried = [];
  for (const row of auditCloseout({ sessions, planStatusOf })) {
    // auditCloseout picks the first merged session as the plan's landed one.
    const p = planOf(sessions.find((s) => s.plan === row.plan && s.state === 'merged'));
    const before = priorOf.get(row.plan);
    const pr = before?.pending_pr ?? null;
    // An open close-out PR outlives a run that could not read the plan, or the next run would open a second one.
    const entry = { ...entryOf(row, p, fallbackRepo), pending_pr: pr };
    if (p?.text == null) {
      plans.push({ ...entry, verdict: 'NO-FILE' });
      continue;
    }
    entry.hash = hashOf(p.text);
    if (pr) {
      if (now - Date.parse(pr.opened_at) < PR_FRESH_MS) {
        skipped.push({ plan: row.plan, reason: `closeout PR #${pr.number} open` });
        // The session-start note counts READY entries, so the kept record must not read as due.
        carried.push({ ...entry, verdict: 'PR-OPEN', asserted: before.asserted ?? 0, tickable: before.tickable ?? 0 });
      } else {
        plans.push({ ...entry, verdict: 'PR-STALE', asserted: before.asserted ?? 0, tickable: before.tickable ?? 0, pending_pr: pr });
      }
      continue;
    }
    if (kept[row.plan]?.hash === entry.hash) {
      skipped.push({ plan: row.plan, reason: 'kept-open' });
      continue;
    }
    let tasks;
    let body;
    try {
      ({ body } = extractFrontmatter(p.text));
      tasks = measure(p.text, p.file);
    } catch {
      plans.push({ ...entry, verdict: 'UNREADABLE' });
      continue;
    }
    // Boxes of tasks whose skip_if passed are what plan-mark-done --from ticks, so they are not a reason to wait.
    const done = new Set(tasks.filter((t) => t.state === 'DONE').map((t) => t.id));
    const boxes = openStepBoxes(p.text);
    const tickable = boxes.filter((b) => done.has(b.task)).length;
    const v = readinessVerdict({ tasks, openNow: openNowRows(body), openBoxes: boxes.length - tickable });
    plans.push({ ...entry, verdict: v.verdict, asserted: v.asserted, tickable });
  }
  return { plans, skipped, carried };
}

const TASK_ROW = /^([^\s\t][^\t]*)\t(DONE-ASSERTED|DONE|OPEN|UNREAD|UNPROVEN)(?:\t|$)/;

// The readiness CLI is spawned rather than imported: its bash runner and its
// origin/main re-read are private to it, and --due must agree with --readiness.
// Its verdict is not used, because it counts open boxes of DONE tasks as blocking.
export function readinessMeasure({ registry, timeoutS }) {
  return (_text, file) => {
    const r = spawnSync(process.execPath, [closeoutScript, '--readiness', file, '--registry', registry, '--timeout-s', String(timeoutS)], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env,
    });
    if (r.error || ![0, 1, 3].includes(r.status)) {
      console.error(`readiness failed for ${file} (exit ${r.status}): ${String(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
      throw new Error('readiness failed');
    }
    return r.stdout.split('\n').map((l) => l.match(TASK_ROW)).filter(Boolean).map((m) => ({ id: m[1], state: m[2] }));
  };
}

const USAGE = [
  'usage: bun scripts/plan-close-loop.mjs --due [--repo <dir>] [--registry <path>] [--timeout-s <n>]',
  '       bun scripts/plan-close-loop.mjs --keep-open <plan>... --reason <text> [--repo <dir>] [--registry <path>]',
  '       bun scripts/plan-close-loop.mjs --flip <plan>... [--repo <dir>] [--registry <path>] [--timeout-s <n>]',
].join('\n');

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const allowed = mode === '--due' || mode === '--flip' ? ['--repo', '--registry', '--timeout-s'] : mode === '--keep-open' ? ['--repo', '--registry', '--reason'] : null;
  if (!allowed) return null;
  const opts = { mode, plans: [] };
  if (mode !== '--due') while (rest.length && !rest[0].startsWith('--')) opts.plans.push(rest.shift());
  while (rest.length) {
    const flag = rest.shift();
    const value = rest.shift();
    if (!allowed.includes(flag) || value === undefined) return null;
    opts[flag] = value;
  }
  if (opts['--timeout-s'] !== undefined && !(Number(opts['--timeout-s']) > 0)) return null;
  if (mode === '--keep-open' && (!opts.plans.length || !opts['--reason']?.trim())) return null;
  if (mode === '--flip' && !opts.plans.length) return null;
  return opts;
}

// A missing registry is an error, not an empty one: --due would otherwise replace due.json with nothing.
const readSessions = (registry) => JSON.parse(readFileSync(registry, 'utf8')).sessions ?? [];

function dueCli(opts, { registry, fallbackRepo, sessions }) {
  const readPlan = (s) => {
    const file = planFileOf(s, fallbackRepo);
    return { file, text: existsSync(file) ? readFileSync(file, 'utf8') : null };
  };
  const now = Date.now();
  const measure = readinessMeasure({ registry, timeoutS: opts['--timeout-s'] ?? 300 });
  const { plans, skipped, carried } = dueList({ sessions, readPlan, measure, kept: readKept(), prior: readDue(), now, fallbackRepo });
  for (const p of plans) if (p.verdict !== 'NO-FILE') console.log(`${p.verdict}\t${p.plan}\t${p.repo}\tasserted=${p.asserted} tickable=${p.tickable}`);
  // Registries carry many plan_missing sessions; one row each would bury the READY lines.
  const missing = plans.filter((p) => p.verdict === 'NO-FILE').map((p) => p.plan);
  if (missing.length) console.log(`no-file: ${missing.length} plan(s) without a plan file (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''})`);
  for (const s of skipped) console.log(`skipped\t${s.plan}\t${s.reason}`);
  const ready = plans.filter((p) => p.verdict === 'READY').length;
  console.log(`due: ${ready} plan(s) READY`);
  writeDue({ generated_at: new Date(now).toISOString(), plans: [...plans, ...carried] });
  return ready > 0 ? 10 : 0;
}

function keepOpenCli(opts, { fallbackRepo, sessions }) {
  const found = [];
  const errors = [];
  for (const plan of opts.plans) {
    const own = sessions.filter((s) => s.plan === plan);
    const s = own.find((x) => x.state === 'merged') ?? own[0];
    const file = s && planFileOf(s, fallbackRepo);
    if (!s) errors.push(`unknown plan: ${plan} (no registry session)`);
    else if (!existsSync(file)) errors.push(`no plan file for ${plan}: ${file}`);
    else found.push({ plan, hash: hashOf(readFileSync(file, 'utf8')) });
  }
  // Nothing is recorded unless every named plan resolves, so a typo never half-applies.
  if (errors.length) {
    for (const e of errors) console.error(e);
    return 2;
  }
  const kept = readKept();
  const at = new Date().toISOString();
  for (const { plan, hash } of found) {
    kept[plan] = { hash, at, reason: opts['--reason'].trim() };
    console.log(`kept open: ${plan} at ${hash}`);
  }
  writeKept(kept);
  return 0;
}

// Rule B4: synced from the temp worktree, plan-issue-sync would take the worktree's
// directory name as the project, so the main checkout's mapped project is named.
// An unmapped one is left out; the sync then falls back to the origin remote.
function issueProject(planRepo) {
  try {
    const cfg = loadConfig(ISSUES_STORE);
    const { project } = resolveProjectRepo(cfg, planRepo);
    return cfg.projects[project] ? project : null;
  } catch {
    return null;
  }
}

function flipCli(opts, { registry, fallbackRepo, sessions }) {
  const byRepo = new Map();
  const errors = [];
  for (const plan of opts.plans) {
    const own = sessions.filter((s) => s.plan === plan);
    const s = own.find((x) => x.state === 'merged');
    if (!own.length) {
      errors.push(`unknown plan: ${plan} (no registry session)`);
      continue;
    }
    // Only a landed plan was measured by --due, so only a landed plan may be flipped.
    if (!s) {
      errors.push(`not landed: ${plan} (no merged registry session)`);
      continue;
    }
    const file = planFileOf(s, fallbackRepo);
    if (!existsSync(file)) {
      errors.push(`no plan file for ${plan}: ${file}`);
      continue;
    }
    // The repository holding the plan file, which differs from s.repo when a vivera plan drives another repo.
    const repo = path.resolve(s.plan_repo ?? s.repo ?? fallbackRepo);
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), { plan, file }]);
  }
  // As with --keep-open, a typo stops the run before any push or PR.
  if (errors.length) {
    for (const e of errors) console.error(e);
    return 2;
  }
  const ghRun = ghRunner();
  const deps = {
    git: (args, { cwd }) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' };
    },
    gh: (args, { input }) => {
      const r = ghRun(args, input);
      return { code: r.ok ? 0 : (r.status ?? 1), stdout: r.out, stderr: r.err ?? '' };
    },
    sync: (file, { env, repoRoot: planRepo }) => {
      const project = issueProject(planRepo);
      const args = [path.join(repoRoot, 'scripts', 'plan-sync.mjs'), file, ...(project ? ['--project', project] : [])];
      return { code: spawnSync(process.execPath, args, { stdio: 'inherit', env }).status ?? 1 };
    },
    measure: readinessMeasure({ registry, timeoutS: opts['--timeout-s'] ?? 300 }),
  };
  let failed = false;
  for (const [repo, plans] of byRepo) {
    const r = flipRepo({ repoRoot: repo, plans, deps });
    const pr = r.pr ? `PR ${r.pr.url}` : 'no PR';
    console.log(`${repo}: flipped ${r.flipped.length}, ${pr}`);
    if (r.error) {
      failed = true;
      console.log(`${repo}: error: ${r.error}`);
    }
    for (const s of r.skipped) console.log(`skipped\t${s.plan}\t${s.reason}`);
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(2);
  }
  const registry = path.resolve(opts['--registry'] ?? path.join(repoRoot, 'pr.registry.json'));
  const fallbackRepo = path.resolve(opts['--repo'] ?? repoRoot);
  let sessions;
  try {
    sessions = readSessions(registry);
  } catch (e) {
    console.error(`cannot read registry ${registry}: ${e.message}`);
    process.exit(2);
  }
  const ctx = { registry, fallbackRepo, sessions };
  const modes = { '--due': dueCli, '--keep-open': keepOpenCli, '--flip': flipCli };
  process.exit(modes[opts.mode](opts, ctx));
}
