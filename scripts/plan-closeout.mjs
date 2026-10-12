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
// runs each task's `skip_if` (never `run[]`) with a timeout. `--audit` lists
// plans whose sessions all landed while the plan file never reached Complete.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planStatus, loadConfig, issueKey } from './plan-issue-sync.mjs';
import { planFreshness } from './plan-publish.mjs';
import { extractFrontmatter, parseUltraPlanYaml, classifySkipIf, reapGroup } from './ultra-plan-runner.mjs';

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
  configPath = path.join(repoRoot, 'plan.issues.json'),
  publishConfig,
  freshness = planFreshness,
}) {
  const planFile = path.join(repoRoot, 'docs', 'code-plan', 'plans', `${planSlug}.md`);
  if (!existsSync(planFile)) {
    return { skipped: `no plan file at ${planFile} (a one-task change has no plan file)`, gaps: [] };
  }

  const status = planStatus(readFileSync(planFile, 'utf8'));
  const planPath = issueKey(repoRoot, planFile);
  const skipped = [];
  let entry = null;
  let project = null;
  let configError = null;

  if (!existsSync(configPath)) {
    skipped.push(`plan.issues.json not found at ${configPath}, issue not checked`);
  } else {
    try {
      const cfg = loadConfig(configPath);
      // defer: local record only, upgrade when a closed-by-hand reopen is observed after a merge
      entry = cfg.issues?.[planPath] ?? null;
      if (entry) project = Object.keys(cfg.projects).find((k) => cfg.projects[k] === entry.repo) ?? null;
      else skipped.push('plan has no issue record, nothing to close');
    } catch (e) {
      configError = e.message;
    }
  }

  const gaps = closeoutGaps({ status, entry, planPath, project });
  // A corrupt file must fail the gate; skipping here would let it pass silently.
  if (configError) gaps.push({ code: 'CONFIG_UNREADABLE', message: configError, fix: `repair ${configPath}` });

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

const STATES = ['DONE', 'OPEN', 'UNREAD', 'UNPROVEN'];

export function readinessVerdict({ tasks, openNow = 0 }) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  if (counts.OPEN > 0 || counts.UNREAD > 0 || openNow > 0) return { verdict: 'NOT-READY', exit: 1, counts };
  // A plan with no tasks measured nothing, so READY would recommend Complete without evidence.
  if (tasks.length === 0 || counts.UNPROVEN > 0) return { verdict: 'NEEDS-HUMAN', exit: 3, counts };
  return { verdict: 'READY', exit: 0, counts };
}

export function taskReadiness(planText, { run, cwd, timeoutMs }) {
  const { frontmatter } = extractFrontmatter(planText);
  const { tasks } = parseUltraPlanYaml(frontmatter);
  return tasks.map((t) => {
    const skipIf = typeof t.skip_if === 'string' ? t.skip_if : '';
    const kind = classifySkipIf(skipIf);
    // No command means no machine proof, so a human has to judge the task.
    if (kind === 'empty' || kind === 'sentinel') return { id: t.id, state: 'UNPROVEN', skipIf };
    const r = run(skipIf, { cwd, timeoutMs });
    const state = r.timedOut ? 'UNREAD' : r.exit === 0 ? 'DONE' : 'OPEN';
    return { id: t.id, state, skipIf };
  });
}

export function openNowRows(body) {
  let n = 0;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/`/g, '').trim());
    // Plans annotate the class and state cells ("`NOW` bila sempat"), so only the leading word decides.
    if (cells.some((c) => /^NOW\b/.test(c)) && cells.some((c) => /^OPEN\b/.test(c))) n++;
  }
  return n;
}

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
    rows.push({ plan, status: status ?? null, sessions: group.map((s) => s.session), repo: landed.repo ?? null });
  }
  return rows;
}

function bashRunner(cmd, { cwd, timeoutMs }) {
  // Own process group, so a timeout reaches the step's children and not only bash.
  const r = spawnSync('bash', ['-c', cmd], { cwd, timeout: timeoutMs, stdio: 'ignore', detached: true });
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal != null;
  if (timedOut) reapGroup(r.pid);
  return { exit: r.status, timedOut };
}

const USAGE = [
  'usage: bun scripts/plan-closeout.mjs --readiness <plan.md> [--cwd <dir>] [--timeout-s <n>]',
  '       bun scripts/plan-closeout.mjs --audit [--registry <path>]',
].join('\n');

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode };
  const allowed = mode === '--readiness' ? ['--cwd', '--timeout-s'] : mode === '--audit' ? ['--registry'] : null;
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

function defaultCwd(planFile) {
  const dir = path.dirname(planFile);
  if (dir.endsWith(path.join('docs', 'code-plan', 'plans'))) return path.resolve(dir, '..', '..', '..');
  return process.cwd();
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
  const cwd = opts['--cwd'] ? path.resolve(opts['--cwd']) : defaultCwd(planFile);
  const timeoutMs = Number(opts['--timeout-s'] ?? 300) * 1000;
  const tasks = taskReadiness(text, { run: bashRunner, cwd, timeoutMs });
  const openNow = openNowRows(extractFrontmatter(text).body);
  for (const t of tasks) console.log(`${t.id}\t${t.state}\t${t.skipIf}`);
  console.log(`open NOW follow-ups: ${openNow}`);
  const v = readinessVerdict({ tasks, openNow });
  console.log(`readiness: ${v.verdict}`);
  return v.exit;
}

function auditCli(opts) {
  const registryPath = opts['--registry'] ? path.resolve(opts['--registry']) : path.join(repoRoot, 'pr.registry.json');
  const registry = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : { sessions: [] };
  const planStatusOf = (s) => {
    const file = path.join(s.repo ?? repoRoot, 'docs', 'code-plan', 'plans', `${s.plan}.md`);
    return existsSync(file) ? planStatus(readFileSync(file, 'utf8')) : null;
  };
  const rows = auditCloseout({ sessions: registry.sessions ?? [], planStatusOf });
  // A plan file that cannot be found is unread, not debt: sessions claimed before `repo` was recorded
  // point at this repository, so counting them would bury the real debt under false rows.
  const debt = rows.filter((r) => r.status !== null);
  const unread = rows.filter((r) => r.status === null);
  for (const r of debt) console.log(`${r.plan}\t${r.status}\t${r.sessions.join(',')}\t${r.repo ?? repoRoot}`);
  console.log(`closeout debt: ${debt.length} plan(s)`);
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
