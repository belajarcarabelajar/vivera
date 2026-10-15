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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planStatus, loadConfig, issueKey, ISSUES_STORE, resolveProjectRepo, sameRepo } from './plan-issue-sync.mjs';
import { planFreshness } from './plan-publish.mjs';
import { extractFrontmatter, parseUltraPlanYaml, classifySkipIf, reapGroup } from './ultra-plan-runner.mjs';
import { planTaskIds, taskSectionRange, stepLineIndices } from './plan-mark-done.mjs';

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
  const planPath = issueKey(repoRoot, planFile);
  const skipped = [];
  let entry = null;
  let project = null;
  let configError = null;
  let foreign = null;

  if (!existsSync(configPath)) {
    skipped.push(`plan.issues.json not found at ${configPath}, issue not checked`);
  } else {
    try {
      const cfg = loadConfig(configPath);
      // defer: local record only, upgrade when a closed-by-hand reopen is observed after a merge
      entry = cfg.issues?.[planPath] ?? null;
      // The key carries no repository, so a same-named plan elsewhere can own this record.
      // The repository is decided exactly as syncOne decides it, so the gate never
      // flags a record the sync itself would accept.
      let own = null;
      if (entry?.repo) {
        try {
          own = resolveProjectRepo(cfg, repoRoot);
        } catch (e) {
          skipped.push(`repository of ${repoRoot} not resolved (${e.message.split(/\.\s/)[0]}), foreign-record check not run`);
        }
      }
      if (own && !sameRepo(own.repo, entry.repo)) {
        foreign = {
          code: 'ISSUE_OTHER_REPO',
          message: `${planPath} is recorded for ${entry.repo}, but this repository is ${own.repo}; the record belongs to another repository`,
          // syncOne refuses this key under any --project while the foreign record holds it.
          fix: `rename ${planPath} so its key no longer matches the record of ${entry.repo}, then sync the renamed plan`,
        };
        entry = null;
      } else if (own) project = own.project;
      else if (entry) project = Object.keys(cfg.projects).find((k) => cfg.projects[k] === entry.repo) ?? null;
      else skipped.push('plan has no issue record, nothing to close');
    } catch (e) {
      configError = e.message;
    }
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

const OPEN_STEP = /^[ \t]*[-*+][ \t]+\[ \]/;
// Mirrors plan-mark-done's unexported STEP_RE and FENCE_RE, so both tools agree on what a box and a fence are.
const OTHER_BOX = /^[ \t]*[-*+][ \t]+\[ \](?=[ \t]|$)/;
const CODE_FENCE = /^[ \t]*(?:```|~~~)/;
const BOXES_SHOWN = 5;

const tickCommand = (plan) =>
  `bun scripts/ultra-plan-runner.mjs ${plan} --execute > runner.log; bun scripts/plan-mark-done.mjs ${plan} --from runner.log`;

const lineNumbers = (rows) =>
  rows.slice(0, BOXES_SHOWN).map((b) => b.line).join(', ') + (rows.length > BOXES_SHOWN ? ', ...' : '');

// The gate counts only what plan-mark-done can tick, so its printed fix always clears it.
export function openStepBoxes(planText) {
  const lines = planText.split('\n');
  const rows = [];
  for (const task of planTaskIds(planText).ids) {
    const range = taskSectionRange(lines, task);
    if (!range) continue;
    for (const i of stepLineIndices(lines, range.start, range.end)) {
      if (OPEN_STEP.test(lines[i])) rows.push({ line: i + 1, text: lines[i].replace(/\r$/, '').trim(), task });
    }
  }
  return rows.sort((a, b) => a.line - b.line);
}

export function otherOpenBoxes(planText) {
  const lines = planText.split('\n');
  const owned = new Set();
  for (const task of planTaskIds(planText).ids) {
    const range = taskSectionRange(lines, task);
    if (range) for (let i = range.start; i < range.end; i++) owned.add(i);
  }
  let body = planText;
  // checkCloseout runs inside the merge gate, where a malformed plan must still be measured, not throw.
  try {
    ({ body } = extractFrontmatter(planText));
  } catch {}
  // The body is a suffix of the file, so the lines before it give the whole-file offset.
  const offset = lines.length - body.split('\n').length;
  const rows = [];
  let inFence = false;
  for (let i = offset; i < lines.length; i++) {
    // plan-mark-done starts each section outside a fence, so each stretch between task sections does too.
    if (owned.has(i)) {
      inFence = false;
      continue;
    }
    const line = lines[i].replace(/\r$/, '');
    if (CODE_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && OTHER_BOX.test(line)) rows.push({ line: i + 1, text: line.trim() });
  }
  return rows;
}

const STATES = ['DONE', 'OPEN', 'UNREAD', 'UNPROVEN'];

export function readinessVerdict({ tasks, openNow = 0, openBoxes = 0 }) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  if (counts.OPEN > 0 || counts.UNREAD > 0 || openNow > 0 || openBoxes > 0) return { verdict: 'NOT-READY', exit: 1, counts };
  // A plan with no tasks measured nothing, so READY would recommend Complete without evidence.
  if (tasks.length === 0 || counts.UNPROVEN > 0) return { verdict: 'NEEDS-HUMAN', exit: 3, counts };
  return { verdict: 'READY', exit: 0, counts };
}

const TAIL_LINES = 5;
const TAIL_COLS = 200;

// ledgerTrace in ultra-plan-runner.mjs joins and escapes lines into one table
// cell; here each line is printed on its own row, so it gets a plain list.
export function outputTail({ stdout, stderr }) {
  const raw = stderr && String(stderr).trim() ? stderr : (stdout || '');
  const lines = String(raw).replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  return lines.slice(-TAIL_LINES).map((l) => (l.length > TAIL_COLS ? `${l.slice(0, TAIL_COLS)}…` : l));
}

export function taskReadiness(planText, { run, cwd, timeoutMs, onOutput }) {
  const { frontmatter } = extractFrontmatter(planText);
  const { tasks } = parseUltraPlanYaml(frontmatter);
  return tasks.map((t) => {
    const skipIf = typeof t.skip_if === 'string' ? t.skip_if : '';
    const kind = classifySkipIf(skipIf);
    // No command means no machine proof, so a human has to judge the task.
    if (kind === 'empty' || kind === 'sentinel') return { id: t.id, state: 'UNPROVEN', skipIf };
    const r = run(skipIf, { cwd, timeoutMs });
    const state = r.timedOut ? 'UNREAD' : r.exit === 0 ? 'DONE' : 'OPEN';
    if (onOutput) onOutput(t.id, r);
    return { id: t.id, state, skipIf, tail: outputTail(r) };
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

// Gate runs can be chatty, so the cap is generous; past it the run is stopped
// and has no exit status, which reads as UNREAD rather than a guessed state.
const MAX_OUTPUT = 16 * 1024 * 1024;

function bashRunner(cmd, { cwd, timeoutMs }) {
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
  'usage: bun scripts/plan-closeout.mjs --readiness <plan.md> [--cwd <dir>] [--timeout-s <n>] [--log <dir>]',
  '       bun scripts/plan-closeout.mjs --audit [--registry <path>]',
].join('\n');

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode };
  const allowed = mode === '--readiness' ? ['--cwd', '--timeout-s', '--log'] :mode === '--audit' ? ['--registry'] : null;
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
  const tasks = taskReadiness(text, { run: bashRunner, cwd, timeoutMs, onOutput });
  const openNow = openNowRows(extractFrontmatter(text).body);
  for (const t of tasks) {
    console.log(`${t.id}\t${t.state}\t${t.skipIf}`);
    if (t.state !== 'OPEN' && t.state !== 'UNREAD') continue;
    const lines = t.tail?.length ? t.tail : ['(no output)'];
    for (const l of lines) console.log(`    ${t.id}> ${l}`);
  }
  if (logDir) console.log(`log: ${logDir}`);
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
  const v = readinessVerdict({ tasks, openNow, openBoxes: boxes.length });
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
