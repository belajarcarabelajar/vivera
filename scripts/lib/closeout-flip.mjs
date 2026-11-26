// scripts/lib/closeout-flip.mjs
//
// The Complete flip behind plan-close-loop.mjs --flip, run only after the
// owner's Close plan answer. Committed plans go out as one close-out pull
// request per repository from a temporary worktree at origin/<base>, so nothing
// lands on main without the owner's merge; gitignored plans are edited in place.
// The issue sync runs only once the pull request exists, so a failed push never
// closes an issue for a flip that did not happen.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { extractFrontmatter } from '../ultra-plan-runner.mjs';
import { markDone } from '../plan-mark-done.mjs';
import { readinessVerdict, openNowRows, openStepBoxes, evidenceLog } from './plan-readiness.mjs';
import { hashOf } from './plan-issue-render.mjs';
import { readDue, writeDue } from './closeout-state.mjs';
import { localDate } from './eval-run-report.mjs';

// One branch per run, so a second flip opens its own PR instead of colliding with an open one.
function runStamp(now) {
  const d = new Date(now);
  return `${localDate(d)}-${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('')}`;
}

// The last two path segments of the origin URL, which covers https, ssh and the bare fixture paths.
const slugOf = (url) => url.trim().replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('/');

function setComplete(text) {
  const lines = text.split('\n');
  if (lines[0].replace(/\r$/, '') !== '---') return null;
  for (let i = 1; i < lines.length && lines[i].replace(/\r$/, '') !== '---'; i++) {
    if (/^status:/.test(lines[i])) {
      lines[i] = 'status: Complete';
      return lines.join('\n');
    }
  }
  return null;
}

// The verdict dueList gives: open boxes of DONE tasks are ticked here, so they do not block.
function flipText(text, tasks) {
  const { body } = extractFrontmatter(text);
  const done = new Set(tasks.filter((t) => t.state === 'DONE').map((t) => t.id));
  const boxes = openStepBoxes(text);
  const tickable = boxes.filter((b) => done.has(b.task)).length;
  const v = readinessVerdict({ tasks, openNow: openNowRows(body), openBoxes: boxes.length - tickable });
  if (v.verdict !== 'READY') return { reason: v.verdict };
  let ticked = text;
  // A plan of asserted tasks only has no evidence line, and markDone refuses an empty log.
  if (done.size) {
    const r = markDone(text, { logText: evidenceLog(tasks) });
    if (r.error) return { reason: `tick failed: ${r.error.message}` };
    ticked = r.text;
  }
  const out = setComplete(ticked);
  if (out === null) return { reason: 'no status line in the frontmatter' };
  return { text: out, asserted: v.asserted, tickable, ticked: boxes.length - openStepBoxes(out).length };
}

function flipOne(plan, file, measure) {
  if (!existsSync(file)) return { reason: `no plan file at ${file}` };
  const text = readFileSync(file, 'utf8');
  try {
    return { ...flipText(text, measure(text, file)), before: text };
  } catch (e) {
    return { reason: `UNREADABLE (${e.message})` };
  }
}

// Rule B4: plan-publish accepts a plan file only from a configured root or worktree.
function publishConfig(repoRoot, worktree) {
  const source = process.env.VIVERA_PLANS_PUBLISH || path.join(homedir(), 'vivera', 'plans.publish.json');
  let config;
  try {
    config = JSON.parse(readFileSync(source, 'utf8'));
  } catch {
    return null;
  }
  for (const p of config.projects ?? []) {
    if (p.root && path.resolve(p.root) === path.resolve(repoRoot)) p.worktrees = [...(p.worktrees ?? []), worktree];
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'vivera-closeout-publish-'));
  const file = path.join(dir, 'plans.publish.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  return { file, dir };
}

function recordPending(repoRoot, rows, pr) {
  const due = readDue();
  for (const row of rows) {
    const pending_pr = { number: pr.number, repo: pr.repo, opened_at: pr.opened_at };
    const at = due.plans.findIndex((e) => e.plan === row.plan);
    // PR-OPEN, not READY: the main checkout keeps the old hash until the merge, so READY would still read as due.
    const entry = { plan: row.plan, repo: repoRoot, file: row.file, hash: hashOf(row.before), verdict: 'PR-OPEN', asserted: row.asserted, tickable: row.tickable, pending_pr };
    if (at === -1) due.plans.push(entry);
    else due.plans[at] = { ...due.plans[at], verdict: 'PR-OPEN', pending_pr };
  }
  writeDue({ generated_at: due.generated_at ?? new Date(pr.opened_at).toISOString(), plans: due.plans });
}

// A plan with a recorded close-out PR flips again only once that PR is known to be closed unmerged:
// an open one already carries the flip, a merged one means the checkout is behind, an unknown state is not a yes.
function pendingCleared(plans, repoRoot, gh, skip) {
  const due = readDue();
  let cleared = false;
  const go = plans.filter(({ plan }) => {
    const entry = due.plans.find((e) => e.plan === plan && e.pending_pr);
    if (!entry) return true;
    const { number, repo } = entry.pending_pr;
    const v = gh(['pr', 'view', String(number), '--repo', repo, '--json', 'state'], {});
    let state = null;
    try {
      state = v.code === 0 ? JSON.parse(v.stdout).state : null;
    } catch {}
    if (state === 'CLOSED') {
      entry.pending_pr = null;
      cleared = true;
      return true;
    }
    if (state === 'OPEN') skip(plan, `closeout PR #${number} open`);
    else if (state === 'MERGED') skip(plan, `closeout PR #${number} merged; pull ${repoRoot}, then run --due again`);
    else skip(plan, `closeout PR #${number} state unreadable (${v.code === 0 ? `state ${state ?? 'missing'} in gh output` : failed(v)})`);
    return false;
  });
  if (cleared) writeDue(due);
  return go;
}

const failed = (r) => `exit ${r.code}: ${String(r.stderr || r.stdout || '').trim().split('\n').pop()}`;

export function flipRepo({ repoRoot, plans, deps, now = Date.now() }) {
  const { git, gh, sync, measure } = deps;
  const result = { pr: null, flipped: [], skipped: [] };
  const skip = (plan, reason) => result.skipped.push({ plan, reason });
  const ignored = [];
  const tracked = [];
  for (const p of pendingCleared(plans, repoRoot, gh, skip)) (git(['check-ignore', '-q', p.file], { cwd: repoRoot }).code === 0 ? ignored : tracked).push(p);

  for (const { plan, file } of ignored) {
    const r = flipOne(plan, file, measure);
    if (!r.text) {
      skip(plan, r.reason);
      continue;
    }
    writeFileSync(file, r.text);
    result.flipped.push(plan);
    const s = sync(file, { env: { ...process.env }, repoRoot });
    if (s.code !== 0) result.error = `sync failed for ${plan} (exit ${s.code})`;
  }
  if (!tracked.length) return result;

  const run = (args, cwd = repoRoot) => git(args, { cwd });
  const origin = run(['config', '--get', 'remote.origin.url']);
  if (origin.code !== 0) return { ...result, error: 'no origin remote' };
  const slug = slugOf(origin.stdout);
  const head = run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const base = head.code === 0 && head.stdout.trim().startsWith('origin/') ? head.stdout.trim().slice('origin/'.length) : 'main';
  const fetch = run(['fetch', 'origin', base]);
  if (fetch.code !== 0) return { ...result, error: `git fetch origin ${base} failed (${failed(fetch)})` };

  const stamp = runStamp(now);
  const branch = `closeout/${stamp}`;
  const wt = path.join(process.env.VIVERA_CLOSEOUT_WT_ROOT || path.join(homedir(), '.cache', 'tmp'), `vivera-closeout-${stamp}-${path.basename(repoRoot)}`);
  const add = run(['worktree', 'add', '-b', branch, wt, `origin/${base}`]);
  if (add.code !== 0) return { ...result, error: `git worktree add failed (${failed(add)})` };
  let pushed = false;
  // Every exit removes the worktree and the local branch; a failure also deletes a pushed branch with no PR,
  // so a rerun starts clean. --force because a failure before the commit leaves edited plan files there.
  const drop = () => {
    run(['worktree', 'remove', '--force', wt]);
    run(['branch', '-D', branch]);
  };
  const fail = (error) => {
    const del = pushed ? run(['push', 'origin', '--delete', branch]) : null;
    drop();
    return { ...result, error: del && del.code !== 0 ? `${error}; remote branch ${branch} not deleted (${failed(del)})` : error };
  };

  const rows = [];
  for (const { plan, file } of tracked) {
    const rel = path.relative(repoRoot, file);
    const shipped = path.join(wt, rel);
    if (!existsSync(shipped)) {
      skip(plan, `no plan file at ${rel} on origin/${base}`);
      continue;
    }
    // Measured in the main checkout, where --due measured: the temp worktree lacks node_modules and gitignored
    // state, so skip_if would fail there. The ticks land in the worktree copy, so both must hold the same text.
    if (existsSync(file) && hashOf(readFileSync(file, 'utf8')) !== hashOf(readFileSync(shipped, 'utf8'))) {
      skip(plan, `plan differs between ${repoRoot} and origin/${base}; pull, then run --due again`);
      continue;
    }
    const r = flipOne(plan, file, measure);
    if (!r.text) {
      skip(plan, r.reason);
      continue;
    }
    writeFileSync(shipped, r.text);
    rows.push({ ...r, plan, file, rel });
  }
  if (!rows.length) {
    drop();
    return result;
  }

  const n = rows.length;
  const stage = run(['add', '--', ...rows.map((r) => r.rel)], wt);
  if (stage.code !== 0) return fail(`git add failed (${failed(stage)})`);
  const commit = run(['commit', '-q', '-m', `docs(plans): close out ${n} finished plan(s)`], wt);
  if (commit.code !== 0) return fail(`git commit failed (${failed(commit)})`);
  const push = run(['push', '-u', 'origin', branch], wt);
  if (push.code !== 0) return fail(`git push failed (${failed(push)})`);
  pushed = true;

  const body = rows.map((r) => `- ${r.plan}: READY (asserted ${r.asserted}, ticked ${r.ticked})`).join('\n') + '\n';
  const pr = gh(['pr', 'create', '--repo', slug, '--base', base, '--head', branch, '--title', `Close out ${n} finished plan(s)`, '--body-file', '-'], { input: body });
  const url = pr.code === 0 ? String(pr.stdout).match(/https:\/\/\S+\/pull\/(\d+)/) : null;
  if (!url) return fail(`gh pr create failed (${failed(pr)})`);
  result.pr = { number: Number(url[1]), url: url[0] };
  result.flipped.push(...rows.map((r) => r.plan));

  const errors = [];
  let config = null;
  try {
    config = publishConfig(repoRoot, wt);
    const env = { ...process.env, ...(config ? { PLAN_PUBLISH_CONFIG: config.file } : {}) };
    const syncFailed = rows.filter((r) => sync(path.join(wt, r.rel), { env, repoRoot }).code !== 0).map((r) => r.plan);
    if (syncFailed.length) errors.push(`sync failed for ${syncFailed.join(', ')}`);
  } catch (e) {
    errors.push(`sync failed (${e.message})`);
  } finally {
    if (config) rmSync(config.dir, { recursive: true, force: true });
  }
  // Recorded even when a sync failed, or the next --due would offer the plan again and open a second PR.
  try {
    recordPending(repoRoot, rows, { number: result.pr.number, repo: slug, opened_at: new Date(now).toISOString() });
  } catch (e) {
    errors.push(`pending_pr for PR #${result.pr.number} not recorded (${e.message})`);
  } finally {
    // The remote branch backs the PR, so only the local side goes.
    drop();
  }
  if (errors.length) result.error = errors.join('; ');
  return result;
}
