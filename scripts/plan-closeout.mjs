// scripts/plan-closeout.mjs
//
// Close-out gaps for a plan, so `pr-registry state <session> merged` can refuse
// to record a merge while the plan is still at `Verification` or its GitHub
// issue is still open. The pipeline says a plan becomes `status: Complete` after
// the debt sweep and the issue then closes through plan-issue-sync.mjs, but
// nothing checked it.
//
// Offline on purpose: local files only, no network, no gh. The issue state read
// here is the sidecar's record, not GitHub's, and the mirror verdict comes from
// plan-publish.mjs comparing hashes on disk.
//
// `--readiness` asks whether a plan may be marked Complete, from evidence: it
// runs each task's `skip_if` (never `run[]`) with a timeout, by default in the
// worktree of the plan's newest unfinished registry session. `--audit` lists
// plans whose sessions all landed while the plan file never reached Complete.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planStatus, loadConfig, issueKey, ISSUES_STORE, resolveProjectRepo, sameRepo, hashOf, ISSUE_FORMAT } from './plan-issue-sync.mjs';
import { planFileOf, planMissingOf } from './lib/registry-plan-file.mjs';
import { planFreshness } from './plan-publish.mjs';
import { extractFrontmatter, reapGroup } from './ultra-plan-runner.mjs';
import { runPlanCommand } from './lib/remote-runner.mjs';
import { defaultCwd, rereadAtMain } from './lib/readiness-main.mjs';
import {
  BOXES_SHOWN, tickCommand, openStepBoxes, otherOpenBoxes, readinessVerdict, taskReadiness, openNowRows, evidenceLog,
} from './lib/plan-readiness.mjs';

export { openStepBoxes, otherOpenBoxes, readinessVerdict, outputTail, taskReadiness, openNowRows } from './lib/plan-readiness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The plan template puts a `# Draft|Approved|...` comment after the status value,
// and plan-issue-sync records that raw text, so both sides are compared without it.
const bare = (s) => (typeof s === 'string' ? s.replace(/\s+#.*$/, '').trim() : s);

export function closeoutGaps({ status: rawStatus, entry: rawEntry, planPath, project }) {
  const status = bare(rawStatus);
  const entry = rawEntry && typeof rawEntry === 'object' ? { ...rawEntry, status: bare(rawEntry.status) } : rawEntry;
  const gaps = [];
  const proj = project || '<project>';
  const sync = `bun scripts/plan-issue-sync.mjs --project ${proj} ${planPath}`;

  if (status !== 'Complete') {
    gaps.push({
      code: 'PLAN_NOT_COMPLETE',
      message: status == null
        ? `${planPath} declares no status, so it is not Complete`
        : `${planPath} has status "${status}", not Complete`,
      fix: `check bun scripts/plan-closeout.mjs --readiness ${planPath}, then set "status: Complete" in ${planPath} and run: bun scripts/plan-publish.mjs ${planPath} && ${sync}`,
    });
  }

  if (entry && typeof entry === 'object') {
    const ref = entry.url ? `#${entry.number} (${entry.url})` : `#${entry.number}`;
    if (entry.state !== 'closed') {
      gaps.push({
        code: 'ISSUE_NOT_CLOSED',
        message: `issue ${ref} is recorded as "${entry.state}", not closed`,
        fix: sync,
      });
    }
    if (entry.status !== status) {
      gaps.push({
        code: 'ISSUE_STALE',
        message: `issue ${ref} was synced at status "${entry.status}" but the plan is "${status}"`,
        fix: sync,
      });
    }
  }

  return gaps;
}

export function checkCloseout({
  repoRoot,
  planSlug,
  configPath = ISSUES_STORE,
  publishConfig,
  freshness = planFreshness,
}) {
  const planFile = path.join(repoRoot, 'docs', 'code-plan', 'plans', `${planSlug}.md`);
  if (!existsSync(planFile)) {
    return { skipped: `no plan file at ${planFile} (a one-task change has no plan file)`, gaps: [] };
  }

  const planText = readFileSync(planFile, 'utf8');
  const status = planStatus(planText);
  const rec = issueRecord({ planFile, repoRoot, configPath });
  const { planPath } = rec;
  const skipped = [];
  let entry = null;
  let project = null;
  let foreign = null;
  const configError = rec.error ?? null;

  if (rec.absent) {
    skipped.push(`plan.issues.json not found at ${configPath}, issue not checked`);
  } else if (!configError) {
    // defer: local record only, upgrade when a closed-by-hand reopen is observed after a merge
    entry = rec.entry;
    // A record without a repo predates the field, so its owner is looked up by value instead.
    const own = entry?.repo ? rec.own : null;
    if (entry?.repo && rec.ownError) skipped.push(`repository of ${repoRoot} not resolved (${rec.ownError}), foreign-record check not run`);
    if (rec.foreign) {
      foreign = {
        code: 'ISSUE_OTHER_REPO',
        message: `${planPath} is recorded for ${entry.repo}, but this repository is ${own.repo}; the record belongs to another repository`,
        // syncOne refuses this key under any --project while the foreign record holds it.
        fix: `rename ${planPath} so its key no longer matches the record of ${entry.repo}, then sync the renamed plan`,
      };
      entry = null;
    } else if (own) project = own.project;
    else if (entry) project = Object.keys(rec.cfg.projects).find((k) => rec.cfg.projects[k] === entry.repo) ?? null;
    else skipped.push('plan has no issue record, nothing to close');
  }

  const gaps = closeoutGaps({ status, entry, planPath, project });
  if (foreign) gaps.push(foreign);
  // A corrupt file must fail the gate; skipping here would let it pass silently.
  if (configError) gaps.push({ code: 'CONFIG_UNREADABLE', message: configError, fix: `repair ${configPath}` });

  const steps = openStepBoxes(planText);
  if (steps.length) {
    const tasks = [...new Set(steps.map((b) => b.task))].join(', ');
    gaps.push({
      code: 'OPEN_STEPS',
      message: `${planPath} has ${steps.length} open step box(es) in ${tasks} (lines ${lineNumbers(steps)})`,
      fix: tickCommand(planPath),
    });
  }
  const other = otherOpenBoxes(planText);
  // Boxes outside task sections are often ticked after closeout, so blocking on them would make the gate circular.
  if (other.length) skipped.push(`other open boxes: ${other.length} outside task sections, not counted (lines ${lineNumbers(other)})`);

  const m = freshness(planFile, publishConfig ? { config: publishConfig } : {});
  if (m.state === 'NOT-APPLICABLE') {
    skipped.push(`vault mirror not checked: plan is not covered by a mirror${m.detail ? ` (${m.detail})` : ''}`);
  } else if (m.state === 'UNROUTABLE') {
    skipped.push(`vault mirror not checked: ${String(m.detail).split('\n')[0]}`);
  } else if (m.state !== 'OK') {
    gaps.push({
      code: 'MIRROR_STALE',
      message: `vault mirror for ${planPath} is ${m.state}: ${m.detail}`,
      fix: `bun scripts/plan-publish.mjs ${planPath}`,
    });
  }

  return { skipped: skipped.length ? skipped.join('; ') : null, gaps };
}

// The sidecar record of a plan, shared by the merge gate and readiness. The key carries
// no repository, so a same-named plan elsewhere can own the record; the repository is
// decided exactly as syncOne decides it, so neither caller flags a record the sync accepts.
function issueRecord({ planFile, repoRoot, configPath }) {
  const planPath = issueKey(repoRoot, planFile);
  if (!existsSync(configPath)) return { planPath, absent: true };
  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    return { planPath, error: e.message };
  }
  const entry = cfg.issues?.[planPath] ?? null;
  let own = null;
  let ownError = null;
  try {
    own = resolveProjectRepo(cfg, repoRoot);
  } catch (e) {
    ownError = e.message.split(/\.\s/)[0];
  }
  const foreign = Boolean(own && entry?.repo && !sameRepo(own.repo, entry.repo));
  return { planPath, cfg, entry, own, ownError, foreign };
}

// Whether the plan's GitHub issue mirror matches the plan text, from the sidecar only.
// Body drift uses the same test as deriveAction in plan-issue-sync.mjs.
export function issueSyncState({ planFile, planText, repoRoot, configPath = ISSUES_STORE }) {
  const state = (s, detail, fix = null) => ({ state: s, detail, fix });
  let rec;
  try {
    rec = issueRecord({ planFile, repoRoot, configPath });
  } catch (e) {
    return state('NOT-CHECKED', e.message);
  }
  if (rec.absent) return state('NOT-CHECKED', `no sidecar at ${configPath}; run from the main checkout or set PLAN_ISSUES_CONFIG`);
  if (rec.error) return state('UNREADABLE', rec.error);
  if (rec.ownError) return state('NOT-CHECKED', `project of ${repoRoot} not resolved: ${rec.ownError}`);
  if (rec.foreign) return state('NOT-CHECKED', `${rec.planPath} is recorded for ${rec.entry.repo}, not ${rec.own.repo}`);
  const fix = `bun scripts/plan-sync.mjs ${planFile} --project ${rec.own.project}`;
  const e = rec.entry;
  if (!e) return state('MISSING', `no record for ${rec.planPath} in ${configPath}`, fix);
  if (e.hash !== hashOf(planText)) return state('DRIFT', `issue #${e.number} was synced from another text of the plan`, fix);
  if ((e.format ?? 1) !== ISSUE_FORMAT) return state('DRIFT', `issue #${e.number} body is format ${e.format ?? 1}, current is ${ISSUE_FORMAT}`, fix);
  return state('CURRENT', `issue #${e.number} matches the plan`);
}

const lineNumbers = (rows) =>
  rows.slice(0, BOXES_SHOWN).map((b) => b.line).join(', ') + (rows.length > BOXES_SHOWN ? ', ...' : '');

const TERMINAL = ['merged', 'closed'];

export function auditCloseout({ sessions, planStatusOf }) {
  const byPlan = new Map();
  for (const s of sessions) {
    if (!byPlan.has(s.plan)) byPlan.set(s.plan, []);
    byPlan.get(s.plan).push(s);
  }
  const rows = [];
  for (const [plan, group] of byPlan) {
    if (!group.every((s) => TERMINAL.includes(s.state))) continue;
    if (!group.some((s) => s.state === 'merged')) continue;
    const landed = group.find((s) => s.state === 'merged');
    const status = bare(planStatusOf(landed));
    if (status === 'Complete') continue;
    rows.push({ plan, status: status ?? null, sessions: group.map((s) => s.session), repo: landed.plan_repo ?? landed.repo ?? null });
  }
  return rows;
}

// Before the merge a plan's work lives only in its newest unfinished session's worktree; a gone one means the default.
export function sessionWorktree(sessions, planId) {
  const open = sessions.filter((s) => s.plan === planId && !TERMINAL.includes(s.state));
  const newest = open.reduce((a, s) => (!a || (s.claimed_at ?? '') >= (a.claimed_at ?? '') ? s : a), null);
  return newest?.worktree && existsSync(newest.worktree) ? newest : null;
}

// Gate runs can be chatty, so the cap is generous; past it the run is stopped
// and has no exit status, which reads as UNREAD rather than a guessed state.
const MAX_OUTPUT = 16 * 1024 * 1024;

const bashRunner = (c, o) => runPlanCommand(c, (x) => bashLocal(x, o));

function bashLocal(cmd, { cwd, timeoutMs }) {
  // Own process group, so a timeout reaches the step's children and not only bash.
  const r = spawnSync('bash', ['-c', cmd], {
    cwd, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], detached: true, maxBuffer: MAX_OUTPUT,
  });
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.error?.code === 'ENOBUFS' || r.signal != null;
  if (timedOut) reapGroup(r.pid);
  let stderr = r.stderr ? r.stderr.toString() : '';
  if (r.error?.code === 'ENOBUFS') stderr += `\n(output passed ${MAX_OUTPUT} bytes, the run was stopped)\n`;
  return { exit: r.status, timedOut, stdout: r.stdout ? r.stdout.toString() : '', stderr };
}

function writeTaskLog(dir, id, r) {
  // An id is plan text, so a slash or dots in it must not escape the log dir.
  const name = String(id).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  writeFileSync(path.join(dir, `${name}.log`),`--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}\n`);
}

const USAGE = [
  'usage: bun scripts/plan-closeout.mjs --readiness <plan.md> [--cwd <dir>] [--registry <path>] [--timeout-s <n>] [--log <dir>] [--evidence <log>]',
  '       bun scripts/plan-closeout.mjs --audit [--registry <path>]',
].join('\n');

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode };
  const allowed = mode === '--readiness' ? ['--cwd', '--registry', '--timeout-s', '--log', '--evidence'] :mode === '--audit' ? ['--registry'] : null;
  if (!allowed) return null;
  if (mode === '--readiness') {
    opts.plan = rest.shift();
    if (!opts.plan || opts.plan.startsWith('--')) return null;
  }
  while (rest.length) {
    const flag = rest.shift();
    const value = rest.shift();
    if (!allowed.includes(flag) || value === undefined) return null;
    opts[flag] = value;
  }
  if (opts['--timeout-s'] !== undefined && !(Number(opts['--timeout-s']) > 0)) return null;
  return opts;
}

function readinessCli(opts) {
  const planFile = path.resolve(opts.plan);
  let text;
  try {
    text = readFileSync(planFile, 'utf8');
    extractFrontmatter(text);
  } catch (e) {
    console.error(`cannot read plan ${planFile}: ${e.message}`);
    return 2;
  }
  let cwd = opts['--cwd'] ? path.resolve(opts['--cwd']) : defaultCwd(planFile);
  let reg = null;
  try {
    reg = opts['--cwd'] ? null : readRegistry(opts);
  } catch (e) {
    console.error(`registry not read, default cwd kept: ${e.message}`);
  }
  const s = reg && sessionWorktree(reg.sessions, path.basename(planFile, '.md'));
  if (s) {
    cwd = path.resolve(s.worktree);
    console.log(`readiness cwd: ${cwd} (worktree of unfinished session ${s.session} in ${reg.file})`);
  }
  const timeoutMs = Number(opts['--timeout-s'] ?? 300) * 1000;
  const logDir = opts['--log'] ? path.resolve(opts['--log']) : null;
  if (logDir) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch (e) {
      console.error(`cannot create log dir ${logDir}: ${e.message}`);
      return 2;
    }
  }
  const onOutput = logDir ? (id, r) => writeTaskLog(logDir, id, r) : undefined;
  const tasks = rereadAtMain(taskReadiness(text, { run: bashRunner, cwd, timeoutMs, onOutput }), { sessions: reg?.sessions, planId: path.basename(planFile, '.md'), cwd, run: bashRunner, timeoutMs });
  const openNow = openNowRows(extractFrontmatter(text).body);
  for (const t of tasks) {
    console.log(`${t.id}\t${t.state}\t${t.skipIf}${t.missing ? `\tmissing: ${t.missing.join(', ')}` : ''}`);
    if (t.state !== 'OPEN' && t.state !== 'UNREAD') continue;
    const lines = t.tail?.length ? t.tail : ['(no output)'];
    for (const l of lines) console.log(`    ${t.id}> ${l}`);
  }
  if (logDir) console.log(`log: ${logDir}`);
  if (opts['--evidence']) {
    const file = path.resolve(opts['--evidence']);
    try {
      writeFileSync(file, evidenceLog(tasks));
    } catch (e) {
      console.error(`cannot write evidence log ${file}: ${e.message}`);
      return 2;
    }
    console.log(`evidence: ${file}`);
  }
  console.log(`open NOW follow-ups: ${openNow}`);
  const boxes = openStepBoxes(text);
  console.log(`open step boxes: ${boxes.length}`);
  if (boxes.length) {
    for (const b of boxes.slice(0, BOXES_SHOWN)) console.log(`    line ${b.line} (${b.task}): ${b.text}`);
    console.log(`    tick from evidence: ${tickCommand(opts.plan)}`);
  }
  const other = otherOpenBoxes(text);
  console.log(`other open boxes: ${other.length} (outside task sections; tick by hand with evidence, not counted)`);
  for (const b of other.slice(0, BOXES_SHOWN)) console.log(`    line ${b.line}: ${b.text}`);
  // The issue key is relative to the checkout holding the plan, not to the skip_if cwd.
  const top = spawnSync('git', ['-C', path.dirname(planFile), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const issue = issueSyncState({ planFile: opts.plan, planText: text, repoRoot: top.status === 0 ? top.stdout.trim() : defaultCwd(planFile) });
  console.log(`issue sync: ${issue.state} (${issue.detail})`);
  if (issue.fix) console.log(`    fix: ${issue.fix}`);
  const issueDrift = ['DRIFT', 'MISSING', 'UNREADABLE'].includes(issue.state) ? 1 : 0;
  const v = readinessVerdict({ tasks, openNow, openBoxes: boxes.length, issueDrift, issueUnchecked: issue.state === 'NOT-CHECKED' });
  console.log(`readiness: ${v.verdict}${v.asserted ? ` (${v.asserted} asserted)` : ''}`);
  return v.exit;
}

function readRegistry(opts) {
  const file = opts['--registry'] ? path.resolve(opts['--registry']) : path.join(repoRoot, 'pr.registry.json');
  try {
    return { file, sessions: (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).sessions : null) ?? [] };
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

function auditCli(opts) {
  const planStatusOf = (s) => {
    const file = planFileOf(s, repoRoot);
    return existsSync(file) ? planStatus(readFileSync(file, 'utf8')) : null;
  };
  const { sessions } = readRegistry(opts);
  const rows = auditCloseout({ sessions, planStatusOf });
  // A plan file that cannot be found is unread, not debt: sessions claimed before `repo` was recorded
  // point at this repository, so counting them would bury the real debt under false rows.
  // An unreadable plan recorded with plan_missing is counted once; a readable file still wins.
  const missing = new Set(sessions.filter(planMissingOf).map((s) => s.plan));
  const debt = rows.filter((r) => r.status !== null);
  const unread = rows.filter((r) => r.status === null && !missing.has(r.plan));
  const noFile = rows.length - debt.length - unread.length;
  for (const r of debt) console.log(`${r.plan}\t${r.status}\t${r.sessions.join(',')}\t${r.repo ?? repoRoot}`);
  console.log(`closeout debt: ${debt.length} plan(s)`);
  if (noFile) console.log(`no plan file: ${noFile} plan(s) recorded with plan_missing in the registry`);
  if (unread.length) {
    console.log(`not read: ${unread.length} plan file(s) not found; re-claim the session with --repo <repository> to record where its plan lives`);
    for (const r of unread) console.log(`  ${r.plan}\t${r.repo ?? repoRoot}`);
  }
  return 0;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(opts.mode === '--readiness' ? readinessCli(opts) : auditCli(opts));
}
