// scripts/lib/graphify-status.mjs
//
// Classifies a directory for the graphify hooks and commands: not in a git
// repository, opted out, without a graph, or with a graph that is fresh or
// stale against the last commit.
//
// The graph always lives in the main checkout, so a linked worktree reads the
// graph its main checkout built instead of reporting itself as unregistered.
// Callers run inside hooks, so this never throws: any git failure is not-git.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const GIT_TIMEOUT_MS = 5000;

function gitOut(gitBin, cwd, args) {
  const r = spawnSync(gitBin, ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0) return null;
  return r.stdout.replace(/\r?\n$/, '');
}

export function graphPathFor(mainRoot) {
  return path.join(mainRoot, 'graphify-out', 'graph.json');
}

function classify(dir, gitBin) {
  const root = gitOut(gitBin, dir, ['rev-parse', '--show-toplevel']);
  if (!root) return { kind: 'not-git', dir };
  const commonDir = gitOut(gitBin, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return { kind: 'not-git', dir };
  // Bare repositories and separate git dirs have no checkout next to the
  // common dir, so the current checkout is the only place a graph can be.
  const mainRoot = commonDir.endsWith('/.git') ? path.dirname(commonDir) : root;

  if (gitOut(gitBin, mainRoot, ['config', '--get', 'graphify.register']) === 'never') {
    return { kind: 'opted-out', dir, root, mainRoot };
  }

  const graphPath = graphPathFor(mainRoot);
  let graphStat = null;
  try {
    graphStat = statSync(graphPath);
  } catch {}
  if (!graphStat?.isFile()) return { kind: 'unregistered', dir, root, mainRoot, graphPath };

  const ct = gitOut(gitBin, mainRoot, ['log', '-1', '--format=%ct']);
  const headCommitMs = ct ? Number(ct) * 1000 : null;
  const graphMtimeMs = graphStat.mtimeMs;
  return {
    kind: 'registered',
    dir,
    root,
    mainRoot,
    graphPath,
    graphMtimeMs,
    headCommitMs,
    stale: headCommitMs !== null && graphMtimeMs < headCommitMs,
    worktree: root !== mainRoot,
  };
}

export function graphifyStatus(dir, { gitBin = 'git' } = {}) {
  try {
    return classify(dir, gitBin);
  } catch {
    return { kind: 'not-git', dir };
  }
}
