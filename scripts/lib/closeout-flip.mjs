// scripts/lib/closeout-flip.mjs
//
// The Complete flip behind plan-close-loop.mjs --flip, run only after the
// owner's Close plan answer. Committed plans go out as one close-out pull
// request per repository from a temporary worktree at origin/<base>, so nothing
// lands on main without the owner's merge; gitignored plans are edited in place.
// The issue sync runs only once the pull request exists, so a failed push never
// closes an issue for a flip that did not happen.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractFrontmatter } from '../ultra-plan-runner.mjs';
import { markDone } from '../plan-mark-done.mjs';
import { readinessVerdict, openNowRows, openStepBoxes, evidenceLog } from './plan-readiness.mjs';
import { hashOf } from './plan-issue-render.mjs';
import { readDue, writeDue } from './closeout-state.mjs';

const closeoutScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plan-closeout.mjs');
const TASK_ROW = /^([^\s\t][^\t]*)\t(DONE-ASSERTED|DONE|OPEN|UNREAD|UNPROVEN)(?:\t|$)/;

// The readiness CLI with --cwd, so skip_if runs against the checkout being flipped, not the session worktree.
export function cwdMeasure({ timeoutS = 300 } = {}) {
  return (_text, cwd, file) => {
    const r = spawnSync(process.execPath, [closeoutScript, '--readiness', file, '--cwd', cwd, '--timeout-s', String(timeoutS)], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env,
    });
    if (r.error || ![0, 1, 3].includes(r.status)) throw new Error(`readiness exit ${r.status}`);
    return r.stdout.split('\n').map((l) => l.match(TASK_ROW)).filter(Boolean).map((m) => ({ id: m[1], state: m[2] }));
  };
}

const localDate = (now) => {
  const d = new Date(now);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
};

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

function flipOne(plan, file, cwd, measure) {
  if (!existsSync(file)) return { reason: `no plan file at ${file}` };
  const text = readFileSync(file, 'utf8');
  try {
    return { ...flipText(text, measure(text, cwd, file)), before: text };
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

const failed = (r) => `exit ${r.code}: ${String(r.stderr || r.stdout || '').trim().split('\n').pop()}`;

export function flipRepo({ repoRoot, plans, deps, now = Date.now() }) {
  const { git, gh, sync, measure } = deps;
  const result = { pr: null, flipped: [], skipped: [] };
  const skip = (plan, reason) => result.skipped.push({ plan, reason });
  const ignored = [];
  const tracked = [];
  for (const p of plans) (git(['check-ignore', '-q', p.file], { cwd: repoRoot }).code === 0 ? ignored : tracked).push(p);

  for (const { plan, file } of ignored) {
    const r = flipOne(plan, file, repoRoot, measure);
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

  const date = localDate(now);
  const branch = `closeout/${date}`;
  const wt = path.join(process.env.VIVERA_CLOSEOUT_WT_ROOT || path.join(homedir(), '.cache', 'tmp'), `vivera-closeout-${date}-${path.basename(repoRoot)}`);
  let created = false;
  // A worktree kept by an earlier failed push is picked up again, so a retry pushes its commit.
  if (existsSync(wt)) {
    const on = run(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
    if (on.code !== 0 || on.stdout.trim() !== branch) return { ...result, error: `${wt} exists and is not a worktree on ${branch}`, worktree: wt };
  } else {
    const exists = run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
    const add = run(exists ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, `origin/${base}`]);
    if (add.code !== 0) return { ...result, error: `git worktree add failed (${failed(add)})` };
    created = !exists;
  }
  const drop = () => {
    run(['worktree', 'remove', '--force', wt]);
    if (created) run(['branch', '-D', branch]);
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
    const r = flipOne(plan, file, repoRoot, measure);
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
  const add = run(['add', '--', ...rows.map((r) => r.rel)], wt);
  if (add.code !== 0) return { ...result, error: `git add failed (${failed(add)})`, worktree: wt };
  if (run(['diff', '--cached', '--quiet'], wt).code !== 0) {
    const commit = run(['commit', '-q', '-m', `docs(plans): close out ${n} finished plan(s)`], wt);
    if (commit.code !== 0) return { ...result, error: `git commit failed (${failed(commit)})`, worktree: wt };
  }
  const push = run(['push', '-u', 'origin', branch], wt);
  if (push.code !== 0) return { ...result, error: `git push failed (${failed(push)})`, worktree: wt };

  const body = rows.map((r) => `- ${r.plan}: READY (asserted ${r.asserted}, ticked ${r.ticked})`).join('\n') + '\n';
  const pr = gh(['pr', 'create', '--repo', slug, '--base', base, '--head', branch, '--title', `Close out ${n} finished plan(s)`, '--body-file', '-'], { input: body });
  const url = pr.code === 0 ? String(pr.stdout).match(/https:\/\/\S+\/pull\/(\d+)/) : null;
  if (!url) {
    const open = /already exists/i.test(String(pr.stderr ?? '') + String(pr.stdout ?? '')) ? `; a pull request from ${branch} is already open, merge or close it first` : '';
    return { ...result, error: `gh pr create failed (${failed(pr)})${open}`, worktree: wt };
  }
  result.pr = { number: Number(url[1]), url: url[0] };
  result.flipped.push(...rows.map((r) => r.plan));

  const config = publishConfig(repoRoot, wt);
  const env = { ...process.env, ...(config ? { PLAN_PUBLISH_CONFIG: config.file } : {}) };
  const syncFailed = rows.filter((r) => sync(path.join(wt, r.rel), { env, repoRoot }).code !== 0).map((r) => r.plan);
  if (config) rmSync(config.dir, { recursive: true, force: true });
  // Recorded even when a sync failed, or the next --due would offer the plan again and open a second PR.
  recordPending(repoRoot, rows, { number: result.pr.number, repo: slug, opened_at: new Date(now).toISOString() });
  if (syncFailed.length) result.error = `sync failed for ${syncFailed.join(', ')}`;
  // --force because skip_if commands ran in the worktree and may have left untracked files.
  run(['worktree', 'remove', '--force', wt]);
  return result;
}
