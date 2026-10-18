// scripts/lib/registry-sync.mjs
//
// The parts of the PR registry CLI that talk to git and GitHub. They live apart
// from scripts/pr-registry.mjs so the registry logic there stays pure and
// testable without a repository; everything here reads the outside world first
// and then records it through the same compare-and-swap save path.
//
//   reconcile [--dry-run] [--stale-days N] [--close-stale]
//   claim ... --worktree
//   open <session> --title <t> --body-file <f> [--draft]

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { loadRegistry, mutateRegistry, setPr } from '../pr-registry.mjs';

const DAY_MS = 86400000;
const LIVE_STATES = ['isolated', 'active', 'verified', 'open'];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  const err = r.error ? r.error.message : (r.stderr || '').trim();
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err };
}

// owner/repo from an origin URL: https://host/o/r(.git), ssh://git@host/o/r(.git)
// or the scp-like git@host:o/r(.git). Anything else is null, never a guess.
export function parseRemote(url) {
  const m = /^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^@\s/]+@[^:\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const isWorkTree = (p) => existsSync(p) && run('git', ['-C', p, 'rev-parse', '--show-toplevel']).out === realpathSync(p);

// Which repository a session belongs to. Never a guess: a legacy session with no
// `repo` once fell back to this repository and matched an unrelated PR with the
// same number, which would have recorded it as merged.
export function resolveRepoPath(session, rootDir) {
  if (session.repo) return { path: session.repo };
  const parts = path.resolve(session.worktree).split(path.sep);
  for (let i = parts.length - 2; i > 0; i--) {
    if (!parts[i].endsWith('-wt')) continue;
    const sibling = [...parts.slice(0, i), parts[i].slice(0, -3)].join(path.sep);
    if (isWorkTree(sibling)) return { path: sibling };
    break;
  }
  // The main checkout, not a linked worktree of it, names the `-wt` directory.
  const common = run('git', ['-C', rootDir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = common.ok ? path.dirname(common.out) : rootDir;
  const wt = path.resolve(session.worktree);
  for (const dir of [`${main}-wt`, path.join(path.dirname(main), 'ai-skills-wt')]) {
    if (wt.startsWith(`${dir}${path.sep}`)) return { path: rootDir };
  }
  return { error: `no repo recorded and none derivable from worktree ${session.worktree}` };
}

function resolveSlug(repoPath, cache) {
  if (!cache.has(repoPath)) {
    const r = run('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    const slug = r.ok ? parseRemote(r.out) : null;
    cache.set(repoPath, slug ? { slug } : { error: `cannot resolve owner/repo for ${repoPath}: ${r.ok ? `unrecognised origin ${r.out}` : r.err}` });
  }
  return cache.get(repoPath);
}

function readPr(slug, pr) {
  const r = run('gh', ['pr', 'view', String(pr), '-R', slug, '--json', 'state,mergedAt,closedAt,headRefName']);
  if (!r.ok) return { error: `gh pr view ${pr} -R ${slug} failed: ${r.err}` };
  try {
    return { pr: JSON.parse(r.out) };
  } catch {
    return { error: `gh pr view ${pr} -R ${slug} printed no JSON: ${r.out}` };
  }
}

// Re-checked at write time: a session that finished, or (for a stale close)
// gained a PR, since the read keeps what it has now.
export function applyReconcile(registry, facts) {
  const apply = (s) => {
    const fact = facts.get(s.session);
    if (!fact || !LIVE_STATES.includes(s.state) || (fact.stale && s.pr)) return s;
    return { ...s, ...fact.patch };
  };
  return { ...registry, sessions: registry.sessions.map(apply) };
}

// Reads first, then writes once. The mutation only replays facts already read,
// so mutateRegistry can re-apply it on a conflict without calling GitHub again.
export function reconcile({ registryPath, rootDir, flags }) {
  const staleDays = flags['stale-days'] === undefined ? 7 : Number(flags['stale-days']);
  if (!Number.isFinite(staleDays) || staleDays < 0) throw new Error(`--stale-days must be a non-negative number, got ${flags['stale-days']}`);
  const dryRun = flags['dry-run'] === true;
  const closeStale = flags['close-stale'] === true;
  const now = new Date();
  const live = loadRegistry(registryPath).sessions.filter((s) => LIVE_STATES.includes(s.state));
  const facts = new Map();
  const counts = { merged: 0, closed: 0, stale: 0, skipped: 0 };
  const lines = [];
  const slugs = new Map();

  for (const s of live) {
    if (!s.pr) {
      const age = now - Date.parse(s.claimed_at ?? '');
      if (age > staleDays * DAY_MS) {
        counts.stale++;
        lines.push(`stale ${s.session} claimed ${s.claimed_at}, no PR${closeStale ? ' -> closed' : ' (pass --close-stale to close)'}`);
        if (closeStale) facts.set(s.session, { patch: { state: 'closed', closed_at: now.toISOString() }, stale: true });
      }
      continue;
    }
    const where = resolveRepoPath(s, rootDir);
    const repo = where.error ? where : resolveSlug(where.path, slugs);
    const read = repo.error ? repo : readPr(repo.slug, s.pr);
    if (!read.error && read.pr.headRefName !== s.branch) read.error = `branch mismatch: registry ${s.branch}, GitHub ${read.pr.headRefName}`;
    if (read.error) {
      counts.skipped++;
      lines.push(`skipped ${s.session} (PR #${s.pr}): ${read.error}`);
      continue;
    }
    const { state, mergedAt, closedAt } = read.pr;
    if (state === 'MERGED') {
      counts.merged++;
      lines.push(`merged ${s.session} (PR #${s.pr} on ${repo.slug}) at ${mergedAt}`);
      facts.set(s.session, { patch: { state: 'merged', merged_at: mergedAt } });
    } else if (state === 'CLOSED') {
      counts.closed++;
      lines.push(`closed ${s.session} (PR #${s.pr} on ${repo.slug}) at ${closedAt}`);
      facts.set(s.session, { patch: { state: 'closed', closed_at: closedAt } });
    } else if (state !== 'OPEN') {
      counts.skipped++;
      lines.push(`skipped ${s.session} (PR #${s.pr}): unexpected GitHub state ${JSON.stringify(state)}`);
    }
  }

  if (facts.size > 0 && !dryRun) {
    mutateRegistry((registry) => applyReconcile(registry, facts), { registryPath });
  }
  for (const l of lines) console.log(dryRun ? `[dry run] ${l}` : l);
  if (dryRun) console.log('dry run: nothing written');
  console.log(`reconciled ${live.length}: merged ${counts.merged}, closed ${counts.closed}, stale ${counts.stale}, skipped ${counts.skipped}`);
  return counts.skipped > 0 ? 1 : 0;
}

const real = (p) => (existsSync(p) ? realpathSync(p) : path.resolve(p));

// `git worktree list --porcelain` prints one block per worktree: a `worktree`
// line, then `HEAD`, then `branch refs/heads/<name>` unless detached.
function hasWorktree(repo, worktree, branch) {
  const r = run('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
  if (!r.ok) return false;
  return r.out.split(/\n\s*\n/).some((block) => {
    const wt = /^worktree (.+)$/m.exec(block);
    return wt && real(wt[1]) === real(worktree) && block.split('\n').includes(`branch refs/heads/${branch}`);
  });
}

export function setupWorktree(session, repoRoot) {
  const repo = session.repo ?? path.resolve(repoRoot);
  if (existsSync(session.worktree) && hasWorktree(repo, session.worktree, session.branch)) {
    console.log(`${session.worktree} is already a worktree on ${session.branch}; skipping`);
    return 0;
  }
  // After a crash the folder can be gone while the branch survives; prune drops
  // the stale entry and the add then reuses the branch instead of `-b`.
  const branchExists = run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${session.branch}`]).ok;
  const add = branchExists
    ? ['worktree', 'add', session.worktree, session.branch]
    : ['worktree', 'add', session.worktree, '-b', session.branch, `origin/${session.base}`];
  for (const step of [['worktree', 'prune'], ['fetch', 'origin', session.base], add]) {
    const r = run('git', ['-C', repo, ...step]);
    console.log(`${r.ok ? 'ok' : 'FAILED'}: git ${step.join(' ')} (in ${repo})`);
    if (!r.ok) {
      console.error(r.err);
      return 1;
    }
    for (const out of [r.out, r.err]) if (out) console.log(`  ${out.replace(/\n/g, '\n  ')}`);
  }
  return 0;
}

export function openPr({ registryPath, rootDir, positional, flags }) {
  const [id] = positional;
  if (!id || !flags.title || !flags['body-file']) throw new Error('open needs <session> --title <t> --body-file <f> [--draft]');
  // gh runs inside the session repository, so a relative path must be fixed
  // against the caller's directory first.
  const bodyFile = path.resolve(process.cwd(), flags['body-file']);
  if (!existsSync(bodyFile)) {
    console.error(`❌ --body-file ${bodyFile} does not exist`);
    return 2;
  }
  const s = loadRegistry(registryPath).sessions.find((x) => x.session === id);
  if (!s) throw new Error(`no slot for session "${id}"; claim it first`);
  if (s.state === 'open' && s.pr) {
    console.log(`${s.session} is already open as PR #${s.pr}; nothing to do`);
    return 0;
  }
  if (s.state !== 'verified') {
    throw new Error(`session "${s.session}" is ${s.state}; open needs a verified session, so run the local checks and the diff audit first`);
  }
  const cwd = s.repo ?? rootDir;
  const push = run('git', ['-C', cwd, 'push', '-u', 'origin', s.branch]);
  console.log(`${push.ok ? 'ok' : 'FAILED'}: git push -u origin ${s.branch} (in ${cwd})`);
  if (!push.ok) {
    console.error(push.err);
    return 1;
  }
  const args = ['pr', 'create', '--base', s.base, '--head', s.branch, '--title', flags.title, '--body-file', bodyFile];
  if (flags.draft === true) args.push('--draft');
  const r = run('gh', args, { cwd });
  if (!r.ok) {
    console.error(r.err);
    return 1;
  }
  const m = /\/pull\/(\d+)/.exec(r.out);
  if (!m) throw new Error(`gh pr create printed no PR URL: ${r.out}`);
  const { result } = mutateRegistry((registry) => setPr(registry, s.session, Number(m[1])), { registryPath });
  console.log(r.out);
  console.log(`✅ recorded PR #${result.session.pr} for ${result.session.session} (${result.session.state})`);
  return 0;
}
