#!/usr/bin/env bun
// scripts/plan-issue-sync.mjs
//
// One-way mirror from a plan file to a GitHub issue.
//
// The Obsidian mirror already exists and is one-way for a reason: the project
// repository is the source of truth and every other copy is derived state. This
// adds the second derived copy, with the same rule. A plan is authored once, in
// the repository's language, and the issue body is that same text. Nothing is
// ever read back from GitHub into the plan, and an issue comment is a discussion
// about the plan, never an edit to it.
//
// Why this is a separate script rather than a flag on plan-publish.mjs: the two
// mirrors have different failure surfaces. The vault mirror is a file write on
// this machine, and it is idempotent by comparing a `source_hash` recorded in
// the note's own frontmatter. A GitHub issue is a network call to somebody
// else's API, and it is idempotent by remembering the issue number. Mixing them
// would mean one plan's local write and one plan's network call share an exit
// code, and "exit 1" would not say which failed.
//
//   bun scripts/plan-issue-sync.mjs <plan.md>...        create or sync
//   bun scripts/plan-issue-sync.mjs --check <plan.md>   report, never write
//   bun scripts/plan-issue-sync.mjs --status             table, always exit 0
//   bun test scripts/plan-issue-sync.test.mjs
//
// The issue number lives in `plan.issues.json`, NOT in the plan's frontmatter.
// That is load-bearing. The vault mirror hashes the entire plan text, so writing
// an issue number into the plan would change `source_hash` and immediately make
// every vault mirror stale. Deriving the link from a sidecar keeps the plan byte
// stable, which is the same reason a review verdict belongs in the plan and
// never in the mirror.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(rootDir, 'plan.issues.json');

// A registry entry with no `repo` is a planning-only plan: a Spike, or a Bounded
// task too small for a file. Those are deliberately not issues, and refusing to
// guess a repository is the whole point of the mapping below.
export const OPEN_STATUSES = ['Draft', 'Approved', 'InProgress', 'Verification'];
export const CLOSED_STATUS = 'Complete';

// ---------- gh adapter ----------

// ONE seam, not two. An earlier draft had a `runWithInput` helper that shelled
// out directly for body writes while the injected runner handled everything
// else, which meant the end-to-end tests silently exercised the REAL gh binary
// for creates. A second seam is a second thing a test does not cover.
//
// So the injected runner takes (args, input). The default implementation is the
// only place that spawns, and it decides everything about the real invocation:
//   * `--json` only where gh supports it. `gh issue view` and `gh issue list`
//     take it; `gh issue create` and `gh issue edit` do NOT, and passing it
//     there fails with "unknown flag: --json" against every real gh.
//   * the plan body goes on STDIN via `--body-file -`. On argv it hits ARG_MAX
//     and goes through the shell's quoting rules, so the bytes stop being
//     identical to the plan, which is the entire premise of the mirror.
//   * a create/edit prints a bare URL, not JSON, and the URL is the only thing
//     worth keeping from it.
const JSON_CAPABLE = new Set(['issue view', 'issue list', 'pr view', 'pr list']);

export function ghRunner(bin = process.env.GH_BIN || 'gh') {
  return function run(args, input = undefined) {
    const wantsJson = JSON_CAPABLE.has(args.slice(0, 2).join(' ')) && !args.includes('--json');
    const r = spawnSync(bin, wantsJson ? [...args, '--json', 'number', 'url', 'state'] : args, {
      encoding: 'utf8',
      input,
      maxBuffer: 32 * 1024 * 1024,
    });
    const out = (r.stdout || '').trim();
    if (r.error) return { ok: false, status: null, out, err: r.error.message };
    if (r.status !== 0) {
      return { ok: false, status: r.status, out, err: firstLine(r.stderr || out) };
    }
    const url = out.match(/https:\/\/\S+/)?.[0] ?? null;
    let data = null;
    if (wantsJson && out) {
      try { data = JSON.parse(out); } catch { data = null; }
    }
    return { ok: true, status: 0, out, url, data };
  };
}

function firstLine(s) {
  return (s || '').trim().split('\n')[0] || 'no output';
}

// ---------- config ----------

export function loadConfig(configPath = DEFAULT_CONFIG) {
  if (!existsSync(configPath)) {
    // A MISSING FILE IS THE FRESH-CLONE CASE, NOT A BROKEN MACHINE: this file
    // is machine-local state (gitignored, so untracked), and the tracked
    // plan.issues.example.json is the template a new machine copies. The
    // original message stays the first line, so anything matching the old text
    // still matches; the rest tells the reader what to do instead of only what
    // is missing. The file is never created implicitly: a repository map is
    // hand-edited state, and guessing one would file plans in the wrong repo.
    const example = path.join(rootDir, 'plan.issues.example.json');
    throw new Error(
      `missing plan/issue config: ${configPath}. `
      + `${path.basename(configPath)} is machine-local and untracked (gitignored), so a fresh clone does not have it. `
      + `Copy the tracked template plan.issues.example.json over it (${example}) `
      + 'and edit the copied projects to real owner/repo values '
      + '(at minimum {"version":1,"projects":{}}) before syncing.',
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`cannot parse ${configPath}: ${e.message}`);
  }
  if (!cfg || typeof cfg !== 'object') throw new Error(`${configPath} is not a JSON object`);
  if (cfg.version !== 1) throw new Error(`${configPath} has unsupported version ${JSON.stringify(cfg.version)}`);
  if (!cfg.projects || typeof cfg.projects !== 'object' || Array.isArray(cfg.projects)) {
    throw new Error(`${configPath} is missing a "projects" object mapping project name to owner/repo`);
  }
  for (const [name, value] of Object.entries(cfg.projects)) {
    if (typeof value !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(value)) {
      throw new Error(`${configPath}: projects["${name}"] must be "owner/repo", got ${JSON.stringify(value)}`);
    }
  }
  if (cfg.issues !== undefined && (typeof cfg.issues !== 'object' || Array.isArray(cfg.issues))) {
    throw new Error(`${configPath} has an "issues" field that is not an object`);
  }
  return { version: 1, projects: cfg.projects, issues: cfg.issues ?? {} };
}

export function saveConfig(cfg, configPath = DEFAULT_CONFIG) {
  mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ version: 1, projects: cfg.projects, issues: cfg.issues }, null, 2)}\n`, 'utf8');
  return configPath;
}

// ---------- plan reading ----------

export function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: text };
  return { frontmatter: text.slice(3, end), body: text.slice(end + 4) };
}

export function planStatus(text) {
  const { frontmatter } = splitFrontmatter(text);
  const m = frontmatter.match(/^status:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

export function planId(text, planPath) {
  const { frontmatter } = splitFrontmatter(text);
  const m = frontmatter.match(/^plan_id:\s*(.+)$/m);
  if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  return path.basename(planPath).replace(/\.md$/, '');
}

// The key is the plan's path relative to its repository root, so the same plan
// resolves to the same entry from any working directory, and a worktree of the
// same repository resolves to the same entry as the root checkout. A bare
// basename would collide across projects.
export function issueKey(repoRoot, planPath) {
  const root = path.resolve(repoRoot);
  const full = path.resolve(planPath);
  const rel = path.relative(root, full);
  if (rel.startsWith('..')) {
    throw new Error(`plan ${full} is not inside ${root}; a key relative to the repository root cannot be computed`);
  }
  return rel.split(path.sep).join('/');
}

export function hashOf(text) {
  // FNV-1a. This is a change detector, not a security primitive: it only has to
  // answer "is this byte-identical to what the issue body was built from".
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------- the issue body ----------

// The body IS the plan. A summary would drift from the plan the moment the plan
// changed, and then the issue would be a second source of truth that is quietly
// out of date. A machine-readable trailer carries what a reader needs to find
// the source and to tell whether this copy is current.
// Field-name prefixes, not bare positional values. A bare `key=<value>` is
// indistinguishable from a value that happens to contain `key=`, and the
// prefixes are what make the trailer readable to a human scanning the raw issue.
export function issueBody(planText, { planId: id, key, sourcePath, status, generatedBy }) {
  const trailer = [
    '---',
    '',
    `<!-- plan-sync: plan_id=${id} | key=${key} | source=${sourcePath} | status=${status ?? 'unknown'} | hash=${hashOf(planText)} | by=${generatedBy ?? 'plan-issue-sync'} -->`,
    '',
  ].join('\n');
  return `${planText.replace(/\s*$/, '')}\n${trailer}`;
}

export function parseTrailer(body) {
  const m = (body || '').match(/<!--\s*plan-sync:\s*plan_id=(.*?)\s*\|\s*key=(.*?)\s*\|\s*source=(.*?)\s*\|\s*status=(.*?)\s*\|\s*hash=(.*?)\s*\|\s*by=(.*?)\s*-->/);
  if (!m) return null;
  return {
    plan_id: m[1].trim(),
    key: m[2].trim(),
    source: m[3].trim(),
    status: m[4].trim(),
    hash: m[5].trim(),
    by: m[6].trim(),
  };
}

// ---------- the action decision ----------

// This is the deterministic half. Everything above reads state; everything below
// decides; only the executor talks to GitHub. The decision is a pure function of
// (recorded entry, plan text, plan status), which is what makes "run it twice"
// safe and what makes a test able to assert the whole matrix without a network.
export function deriveAction({ entry, planText, status, key, id, repo }) {
  const wanted = issueBody(planText, { planId: id, key, sourcePath: entry?.source ?? null, status, generatedBy: repo });

  if (!entry || !entry.number) {
    return { kind: 'create', title: id, body: wanted, hash: hashOf(planText), repo };
  }

  const changed = [];
  if (entry.hash !== hashOf(planText)) changed.push('body');
  const shouldClose = status === CLOSED_STATUS;
  const isClosed = entry.state === 'closed';
  if (shouldClose !== isClosed) changed.push('state');

  if (changed.length === 0) {
    // The real no-op. Reported as its own kind so `--status` and `--check` can
    // tell "already current" apart from "dry run wrote nothing", which is the
    // same distinction plan-publish.mjs draws with `skipped`.
    return { kind: 'current', number: entry.number, url: entry.url, repo };
  }
  if (changed.length === 2) {
    return {
      kind: 'update-and-state',
      number: entry.number,
      url: entry.url,
      title: id,
      body: wanted,
      hash: hashOf(planText),
      close: shouldClose,
      repo,
    };
  }
  if (changed[0] === 'body') {
    return { kind: 'update-body', number: entry.number, url: entry.url, title: id, body: wanted, hash: hashOf(planText), repo };
  }
  return { kind: 'update-state', number: entry.number, url: entry.url, close: shouldClose, repo };
}

// ---------- executor ----------

// gh 2.102.0 (2026-09-30) removed `gh issue edit --state`; open/close are now
// dedicated subcommands. Keeping the mapping in one place means a future gh flag
// change is a one-line fix here rather than a hunt through every call site.
function setIssueState(action, run) {
  return action.close
    ? run(['issue', 'close', String(action.number), '--repo', action.repo])
    : run(['issue', 'reopen', String(action.number), '--repo', action.repo]);
}

export function applyAction(action, run) {  switch (action.kind) {
    case 'current':
      return { ok: true, skipped: true, number: action.number, url: action.url };
    case 'create': {
      // `gh issue create` has no --json, so the URL comes from stdout.
      const r = run(['issue', 'create', '--repo', action.repo, '--title', action.title, '--body-file', '-'], action.body);
      if (!r.ok) return { ok: false, error: r.err };
      const number = r.url ? Number(r.url.split('/').pop()) || null : null;
      return { ok: true, created: true, number, url: r.url };
    }
    case 'update-body': {
      // Title and body in ONE call. Two calls would mean two chances to
      // half-apply, and GitHub records each as a separate timeline event.
      const r = run(['issue', 'edit', String(action.number), '--repo', action.repo, '--title', action.title, '--body-file', '-'], action.body);
      if (!r.ok) return { ok: false, error: r.err };
      return { ok: true, number: action.number, url: r.url ?? action.url };
    }
    case 'update-state': {
      const r = setIssueState(action, run);
      if (!r.ok) return { ok: false, error: r.err };
      return { ok: true, number: action.number, url: r.url ?? action.url, closed: action.close };
    }
    case 'update-and-state': {
      // gh 2.102.0 (2026-09-30) removed `gh issue edit --state`, so title+body and
      // the state transition are now necessarily two calls. The edit goes first: if
      // it fails we return without touching the state, so a failed sync leaves the
      // previous body and the previous open/closed state consistent with each other
      // rather than half-applied in the other order.
      const e = run(['issue', 'edit', String(action.number), '--repo', action.repo, '--title', action.title, '--body-file', '-'], action.body);
      if (!e.ok) return { ok: false, error: e.err };
      const r = setIssueState(action, run);
      if (!r.ok) return { ok: false, error: r.err };
      return { ok: true, number: action.number, url: r.url ?? action.url, closed: action.close };
    }
    default:
      throw new Error(`unknown action kind: ${action.kind}`);
  }
}

// ---------- per-plan sync ----------

export function syncOne(cfg, { planPath, repoRoot, run, dryRun = false, project: projectOverride = null }) {
  const full = path.resolve(planPath);
  if (!existsSync(full)) throw new Error(`plan file not found: ${full}`);
  const planText = readFileSync(full, 'utf8');

  // An explicit project name wins over the directory name, because a worktree
  // directory is named after the branch, not after the project it belongs to.
  const project = projectOverride ?? path.basename(path.resolve(repoRoot || rootDir));
  const repo = cfg.projects[project];
  if (!repo) {
    throw new Error(
      `no GitHub repository is configured for project "${project}". `
      + `Add "projects": {"${project}": "owner/repo"} to ${DEFAULT_CONFIG}. `
      + 'A plan is not filed under a guessed repository, because a plan published to the wrong repository is worse than one that is not published.',
    );
  }

  const key = issueKey(repoRoot || rootDir, full);
  const id = planId(planText, full);
  const status = planStatus(planText);
  if (!status) {
    throw new Error(`${full} has no "status:" in its frontmatter, so its issue state cannot be derived. Publish the plan through the runner first, or state the status explicitly.`);
  }

  const entry = cfg.issues[key] ?? null;
  const action = deriveAction({ entry, planText, status, key, id, repo });

  if (action.kind === 'current') {
    return { key, action: 'current', number: action.number, url: action.url, repo, status, written: false };
  }
  if (dryRun) {
    return { key, action: action.kind, number: action.number ?? null, url: action.url ?? null, repo, status, written: false, dryRun: true };
  }

  const result = applyAction(action, run);
  if (!result.ok) throw new Error(`${key}: ${action.kind} failed: ${result.error}`);

  const next = {
    ...cfg.issues,
    [key]: {
      number: result.number ?? action.number ?? null,
      url: result.url ?? action.url ?? null,
      hash: action.hash ?? entry?.hash ?? null,
      state: result.closed ? 'closed' : (status === CLOSED_STATUS ? 'closed' : 'open'),
      status,
      repo,
      synced_at: new Date().toISOString(),
    },
  };
  return { key, action: action.kind, number: next[key].number, url: next[key].url, repo, status, written: true, cfg: { ...cfg, issues: next } };
}

// ---------- CLI ----------

const USAGE = `usage:
  bun scripts/plan-issue-sync.mjs <plan.md>...          create or sync the issue
  bun scripts/plan-issue-sync.mjs --check <plan.md>...  report only, never writes
  bun scripts/plan-issue-sync.mjs --status              table of every entry, always exit 0
  bun scripts/plan-issue-sync.mjs --project <name>      the project whose repo is used (default: repo dir name)

  --repo-root <path>   repository root the key is computed relative to
  --config <path>      config file (default plan.issues.json)
  --dry-run            print the action, write nothing, including the config`;

function parseArgs(argv) {
  const opts = { plans: [], check: false, status: false, dryRun: false, project: null, repoRoot: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--repo-root') opts.repoRoot = argv[++i];
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else opts.plans.push(a);
  }
  return opts;
}

function projectRootFor(opts) {
  if (opts.repoRoot) return opts.repoRoot;
  // The plan's own repository: walk up from the plan until a .git entry appears.
  // `git rev-parse` would be the obvious answer and is deliberately not used, so
  // this script stays pure and testable outside a checkout.
  if (opts.plans.length === 0) return rootDir;
  let dir = path.dirname(path.resolve(opts.plans[0]));
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.dirname(path.resolve(opts.plans[0]));
    dir = up;
  }
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`❌ ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const configPath = opts.config || process.env.PLAN_ISSUES_CONFIG || DEFAULT_CONFIG;

  if (opts.status) {
    let cfg;
    try {
      cfg = loadConfig(configPath);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      return 1;
    }
    const keys = Object.keys(cfg.issues);
    if (keys.length === 0) {
      console.log('No plan issues recorded yet.');
      return 0;
    }
    console.log('key                                          issue  state    status');
    for (const [k, v] of Object.entries(cfg.issues)) {
      console.log(`${k.padEnd(44)} ${String(v.number ?? '-').padEnd(6)} ${String(v.state ?? '-').padEnd(8)} ${v.status ?? '-'}`);
    }
    return 0;
  }

  if (opts.plans.length === 0) {
    console.error(`❌ no plan files given\n\n${USAGE}`);
    return 2;
  }

  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    return 1;
  }

  const run = ghRunner();
  const repoRoot = projectRootFor(opts);
  let next = cfg;
  let failed = 0;
  let drifted = 0;

  for (const plan of opts.plans) {
    try {
      const res = syncOne(cfg, {
        planPath: plan,
        repoRoot,
        run,
        project: opts.project,
        dryRun: opts.check || opts.dryRun,
      });

      if (res.action === 'current') {
        console.log(`⏭️  CURRENT   ${res.key} -> ${res.repo}#${res.number}`);
      } else if (res.dryRun) {
        drifted++;
        const verb = opts.check ? 'DRIFT' : 'DRY-RUN';
        console.log(`${opts.check ? '❌' : '🔍'} ${verb.padEnd(9)} ${res.key} would ${res.action} on ${res.repo}${res.number ? `#${res.number}` : ''} (status ${res.status})`);
      } else {
        console.log(`✅ ${res.action.padEnd(17)} ${res.key} -> ${res.repo}#${res.number}`);
      }
      if (res.cfg) next = res.cfg;
    } catch (e) {
      failed++;
      console.error(`❌ ${plan}: ${e.message}`);
    }
  }

  if (!opts.check && !opts.dryRun && next !== cfg) {
    saveConfig(next, configPath);
  }
  if (opts.check) {
    if (drifted > 0) {
      console.error(`\n❌ ${drifted} plan(s) drifted from their GitHub issue. Fix: bun scripts/plan-issue-sync.mjs <plan.md>`);
      return 1;
    }
    console.log('\n✅ Every plan issue matches its source plan.');
    return 0;
  }
  return failed ? 1 : 0;
}

const isMain = process.argv[1] && process.argv[1].endsWith('plan-issue-sync.mjs');
if (isMain) process.exit(main(process.argv.slice(2)));
