#!/usr/bin/env bun
// scripts/docs-drift.mjs
//
// Does the live docs site match main? The docs build stamps
// <base>/docs/version.json with {"commit": "<40-char sha>", "built_at": "..."}.
// This script reads that stamp and lists the commits after it that touch a docs
// input (DOCS_INPUTS, which the docs-deploy workflow also uses as its paths
// filter). It never runs git fetch: fetch first, and read the ref it names.
//
// Usage:
//   bun scripts/docs-drift.mjs [--ref origin/main] [--url <base>]
//   bun scripts/docs-drift.mjs --expect <sha> [--url <base>]
//
// Default mode lists docs-input commits in <live>..<ref>. --expect compares the
// stamp's commit with <sha> only and needs no git history (CI checks out depth 1).
//
// Exit 0 in sync (or stamp equals --expect), 1 drift, a different stamp, or no
// stamp (404, or an answer that is not a valid stamp), 2 usage error, network
// error (fetch failure or any other non-200 answer), unresolvable ref, or a
// live commit the local repo does not have (run git fetch).

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const DEFAULT_URL = 'https://vivera.belajarcarabelajar.com';
export const DEFAULT_REF = 'origin/main';
const FETCH_TIMEOUT_MS = 15_000;
const USAGE = 'usage: bun scripts/docs-drift.mjs [--ref <ref>] [--url <base>] [--expect <sha>]';
const SHA = /^[0-9a-f]{40}$/;

// GitHub Actions paths-filter globs. sourceFiles() in scripts/lib/docs-gen-files.mjs
// reads page sources from apps/docs/pages.json; the test checks they are all here.
export const DOCS_INPUTS = [
  '.github/workflows/docs-deploy.yml',
  'README.md',
  'apps/docs/**',
  'bun.lock',
  'diagrams/**',
  'docs/graphify-integration.md',
  'docs/guide/**',
  'docs/vivera-glossary.md',
  'package.json',
  'scripts/docs-gen.mjs',
  'scripts/docs-remote.sh',
  'scripts/docs-site-check.mjs',
  'scripts/lib/docs-gen-*.mjs',
  'scripts/lib/docs-include.mjs',
].sort();

// Glob magic on every entry: plain git pathspecs let * cross a slash, which the
// workflow's paths filter does not.
export function toPathspecs(inputs) {
  return inputs.map((p) => `:(glob)${p}`);
}

class UsageError extends Error {}
class NetError extends Error {}
class NoStamp extends Error {}

export function parseArgs(args) {
  const opts = { ref: DEFAULT_REF, url: DEFAULT_URL, expect: null, help: false };
  const take = (i, flag) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('-')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--ref') opts.ref = take(i++, a);
    else if (a === '--url') opts.url = take(i++, a);
    else if (a === '--expect') opts.expect = take(i++, a).toLowerCase();
    else throw new UsageError(`unknown argument: ${a}`);
  }
  let base;
  try {
    base = new URL(opts.url);
  } catch {
    throw new UsageError(`not a URL: ${opts.url}`);
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new UsageError(`not an http(s) URL: ${opts.url}`);
  opts.url = base.href.replace(/\/+$/, '');
  if (opts.expect !== null && !/^[0-9a-f]{7,40}$/.test(opts.expect)) throw new UsageError(`--expect needs a hex commit sha: ${opts.expect}`);
  return opts;
}

async function readStamp(fetchImpl, base) {
  const url = `${base}/docs/version.json`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store', redirect: 'follow' });
  } catch (e) {
    throw new NetError(`${url}: fetch failed (${e?.message ?? e})`);
  }
  if (res.status === 404) throw new NoStamp(`${url} answered 404`);
  if (res.status !== 200) throw new NetError(`${url} answered HTTP ${res.status}`);
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new NoStamp(`${url} is not JSON`);
  }
  const commit = typeof body?.commit === 'string' ? body.commit.toLowerCase() : '';
  if (!SHA.test(commit)) throw new NoStamp(`${url} has no 40-character commit sha`);
  return { commit, builtAt: typeof body.built_at === 'string' ? body.built_at : '?' };
}

function git(root, args) {
  // root is the explicit target, so an inherited GIT_DIR (set inside git hooks)
  // must not redirect these reads to another repository.
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', detail: (r.error?.message ?? r.stderr ?? '').trim() };
}

export async function main(args, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const root = deps.root ?? path.resolve(import.meta.dir, '..');
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  let opts;
  try {
    opts = parseArgs(args);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`docs-drift: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }

  let stamp;
  try {
    stamp = await readStamp(fetchImpl, opts.url);
  } catch (e) {
    if (e instanceof NoStamp) {
      err(`docs-drift: the live site has no stamp (${e.message}); it predates the stamped build or the deploy failed`);
      return 1;
    }
    if (e instanceof NetError) {
      err(`docs-drift: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const live = stamp.commit;

  if (opts.expect !== null) {
    if (live.startsWith(opts.expect)) {
      out(`docs-drift: live ${live.slice(0, 12)} equals the expected commit`);
      return 0;
    }
    out(`docs-drift: live ${live.slice(0, 12)} differs from the expected ${opts.expect.slice(0, 12)}`);
    return 1;
  }

  const head = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${opts.ref}^{commit}`]);
  if (!head.ok) {
    err(`docs-drift: ref ${opts.ref} does not resolve to a commit in ${root} (run git fetch?)`);
    return 2;
  }
  if (!git(root, ['cat-file', '-e', `${live}^{commit}`]).ok) {
    err(`docs-drift: live commit ${live} is not in the local repo; run git fetch and try again`);
    return 2;
  }
  const refName = `${opts.ref} (${head.stdout.trim().slice(0, 12)})`;
  const log = git(root, ['log', '--format=%h %as %s', `${live}..${head.stdout.trim()}`, '--', ...toPathspecs(DOCS_INPUTS)]);
  if (!log.ok) {
    err(`docs-drift: git log failed: ${log.detail}`);
    return 2;
  }
  const commits = log.stdout.split('\n').filter(Boolean);
  if (commits.length === 0) {
    out(`docs-drift: in sync: live ${live.slice(0, 12)} (built ${stamp.builtAt}) has every docs-input commit on ${refName}`);
    return 0;
  }
  out(`docs-drift: live ${live.slice(0, 12)} (built ${stamp.builtAt}) is ${commits.length} docs-input commit(s) behind ${refName}:`);
  for (const c of commits) out(`  ${c}`);
  return 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`docs-drift: internal error: ${e?.stack ?? e}`);
      process.exit(2);
    },
  );
}
