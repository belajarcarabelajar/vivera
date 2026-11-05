// scripts/audit-registry-fixes.test.mjs
//
// Regression tests for the 2026-11-05 audit of the PR registry, the issue sync
// and the plan publisher. Every git repository here is a throwaway in a temp dir;
// gh is either a fake script on PATH or an injected `run`, never the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claimSlot, loadRegistry } from './pr-registry.mjs';
import { findExistingIssue } from './plan-issue-sync.mjs';
import { issueBody } from './lib/plan-issue-render.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REGISTRY_CLI = path.join(HERE, 'pr-registry.mjs');
const PUBLISH_CLI = path.join(HERE, 'plan-publish.mjs');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  VIVERA_WORKTREE_ROOT: '',
};

function git(cwd, ...args) {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...GIT_ENV } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

function cli(script, args, env = {}) {
  const r = Bun.spawnSync(['bun', script, ...args], { env: { ...process.env, ...GIT_ENV, ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const tmp = (tag) => mkdtempSync(path.join(tmpdir(), `audit-fix-${tag}-`));
const entry = (over = {}) => ({
  session: 'w1', plan: 'p', branch: 'p/w1', worktree: '/x/repo-wt/w1', repo: '/x/repo',
  base: 'main', state: 'isolated', pr: null, depends_on: [], claimed_at: new Date().toISOString(), ...over,
});

// ---------- claim ----------

test('a re-claim of a session id that names another plan is refused with both plans', () => {
  const registry = { version: 1, sessions: [entry({ repo: path.resolve('/x/repo') })] };
  assert.throws(
    () => claimSlot(registry, { plan: 'other-plan', session: 'w1', repoRoot: '/x/repo' }),
    (e) => /"w1"/.test(e.message) && /\bp\b/.test(e.message) && /other-plan/.test(e.message),
  );
});

test('a re-claim naming the same plan through its raw spelling is still idempotent', () => {
  const first = claimSlot({ version: 1, sessions: [] }, { plan: 'My Plan', session: 'w1', repoRoot: '/x/repo' });
  const again = claimSlot(first.registry, { plan: 'My Plan', session: 'w1', repoRoot: '/x/repo' });
  assert.equal(again.created, false);
});

// ---------- ref names from the registry ----------

function registryWith(over) {
  const dir = tmp('load');
  const file = path.join(dir, 'pr.registry.json');
  writeFileSync(file, JSON.stringify({ version: 1, sessions: [entry(over)] }));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const [field, value] of [
  ['branch', '--upload-pack=touch /tmp/x'],
  ['branch', 'p/../w1'],
  ['branch', 'p/w1.lock'],
  ['branch', 'p/w 1'],
  ['branch', '/p/w1'],
  ['base', '-main'],
  ['base', 'main;rm'],
]) {
  test(`loadRegistry refuses ${field} ${JSON.stringify(value)} before it can reach git`, () => {
    const r = registryWith({ [field]: value });
    try {
      assert.throws(() => loadRegistry(r.file), (e) => e.message.includes(field) && e.message.includes(value));
    } finally { r.cleanup(); }
  });
}

test('loadRegistry accepts ordinary branch and base names', () => {
  const r = registryWith({ branch: '2026-11-05-audit-fixes/audit_scripts.v2', base: 'release/1.4' });
  try {
    assert.equal(loadRegistry(r.file).sessions[0].branch, '2026-11-05-audit-fixes/audit_scripts.v2');
  } finally { r.cleanup(); }
});

// ---------- open: PR created, record failed ----------

test('open prints the PR URL and the recovery command when recording the PR fails', () => {
  const dir = tmp('open');
  try {
    const registry = path.join(dir, 'pr.registry.json');
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    // The fake gh breaks the registry between the create and the record.
    writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '{' > '${registry}'\necho "https://github.com/acme/widgets/pull/77"\n`);
    chmodSync(path.join(bin, 'gh'), 0o755);
    const origin = path.join(dir, 'origin.git');
    const repo = path.join(dir, 'repo');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'init', '-q', '-b', 'main', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'seed');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'branch', 'p/w1');
    const body = path.join(dir, 'body.md');
    writeFileSync(body, 'body\n');
    writeFileSync(registry, JSON.stringify({ version: 1, sessions: [entry({ repo, worktree: `${dir}/repo-wt/w1`, state: 'verified' })] }));
    const r = cli(REGISTRY_CLI, ['open', 'w1', '--registry', registry, '--title', 'T', '--body-file', body], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.code, 1, r.out + r.err);
    const all = r.out + r.err;
    assert.match(all, /https:\/\/github\.com\/acme\/widgets\/pull\/77/);
    assert.match(all, /bun scripts\/pr-registry\.mjs pr w1 --number 77/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- reconcile: origin URL with credentials ----------

test('reconcile masks the userinfo of an unrecognised origin URL', () => {
  const dir = tmp('mask');
  try {
    const repo = path.join(dir, 'repo');
    git(dir, 'init', '-q', '-b', 'main', repo);
    git(repo, 'remote', 'add', 'origin', 'https://someone:s3cr3t-token@example.com/lonely');
    const registry = path.join(dir, 'pr.registry.json');
    writeFileSync(registry, JSON.stringify({ version: 1, sessions: [entry({ repo, worktree: `${dir}/repo-wt/w1`, state: 'open', pr: 5 })] }));
    const r = cli(REGISTRY_CLI, ['reconcile', '--registry', registry, '--dry-run']);
    const all = r.out + r.err;
    assert.match(all, /unrecognised origin https:\/\/\*\*\*@example\.com\/lonely/, all);
    assert.ok(!all.includes('s3cr3t-token'), all);
    assert.ok(!all.includes('someone'), all);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- issue sync: adopt only the running account's issue ----------

const TITLE = '2026-10-01-add-pr';
const KEY = 'docs/code-plan/plans/2026-10-01-add-pr.md';
const PLAN_TEXT = `---\nplan_id: ${TITLE}\nstatus: Draft\n---\n# Add PR\n`;
const BODY = issueBody(PLAN_TEXT, { planId: TITLE, key: KEY, sourcePath: null, status: 'Draft', generatedBy: 'u/r' });

function ghFake({ author = 'owner', login = 'owner', userOk = true } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    const verb = args.slice(0, 2).join(' ');
    if (verb === 'issue list') {
      return { ok: true, out: JSON.stringify([{ number: 5, title: TITLE, url: 'https://github.com/u/r/issues/5', state: 'OPEN', author: { login: author } }]) };
    }
    if (verb === 'issue view') return { ok: true, out: JSON.stringify({ body: BODY }) };
    if (verb === 'api user') return userOk ? { ok: true, out: login } : { ok: false, err: 'gh: not logged in' };
    return { ok: false, err: `unexpected gh ${args.join(' ')}` };
  };
  run.calls = calls;
  return run;
}
const lookup = (run) => findExistingIssue(run, { repo: 'u/r', title: TITLE, key: KEY, planId: TITLE });

test('the issue lookup asks gh for the author of each issue', () => {
  const run = ghFake();
  lookup(run);
  assert.match(run.calls[0], /^issue list .*--json \S*author/);
});

test('an issue with this plan trailer filed by the running account is adopted', () => {
  const run = ghFake();
  assert.equal(lookup(run).number, 5);
  assert.ok(run.calls.includes('api user --jq .login'), run.calls.join('\n'));
});

test('an issue with a copied plan trailer filed by another account is refused', () => {
  assert.throws(() => lookup(ghFake({ author: 'stranger', login: 'owner' })),
    (e) => /#5\b/.test(e.message) && /stranger/.test(e.message) && /owner/.test(e.message)
      && /Nothing was created and nothing was written/.test(e.message));
});

test('the lookup refuses to adopt when the running account cannot be read', () => {
  assert.throws(() => lookup(ghFake({ userOk: false })), /not logged in/);
});

// ---------- plan-publish: a written but unstaged mirror ----------

function publishFixture() {
  const base = tmp('publish');
  const vault = path.join(base, 'vault');
  mkdirSync(vault, { recursive: true });
  git(vault, 'init', '-q', '-b', 'main');
  const projectRoot = path.join(base, 'proj');
  const plansDir = path.join(projectRoot, 'docs', 'code-plan', 'plans');
  mkdirSync(plansDir, { recursive: true });
  const config = path.join(base, 'plans.publish.json');
  const writeConfig = (stageInVault) => writeFileSync(config, JSON.stringify({
    vault,
    destDirTemplate: '01 - Projects/{project}/plans',
    indexTemplate: '01 - Projects/{project}/index.md',
    stageInVault,
    projects: [{ name: 'demo', root: projectRoot, mirror: true }],
  }));
  const plan = path.join(plansDir, '2026-09-26-example-plan.md');
  writeFileSync(plan, '# Example Plan\n\nSome body text.\n');
  const run = (...args) => cli(PUBLISH_CLI, [plan, ...args], { PLAN_PUBLISH_CONFIG: config });
  const status = () => git(vault, 'status', '--porcelain', '--untracked-files=all');
  return { writeConfig, run, status, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('an unchanged mirror that was written but never staged is staged on the next run', () => {
  const f = publishFixture();
  try {
    f.writeConfig(false);
    assert.equal(f.run().code, 0);
    assert.match(f.status(), /^\?\? /, 'precondition: the mirror is on disk, untracked');
    f.writeConfig(true);
    const r = f.run();
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /SKIPPED-IDEMPOTENT/);
    assert.match(r.out, /staged in vault/);
    assert.match(f.status(), /^A {2}/, f.status());
  } finally { f.cleanup(); }
});

test('a dry run over an unstaged unchanged mirror stages nothing', () => {
  const f = publishFixture();
  try {
    f.writeConfig(false);
    assert.equal(f.run().code, 0);
    f.writeConfig(true);
    assert.equal(f.run('--dry-run').code, 0);
    assert.match(f.status(), /^\?\? /, f.status());
  } finally { f.cleanup(); }
});

test('an unchanged mirror that is already staged is not reported as staged again', () => {
  const f = publishFixture();
  try {
    f.writeConfig(true);
    assert.equal(f.run().code, 0);
    const r = f.run();
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(!/staged in vault/.test(r.out), r.out);
  } finally { f.cleanup(); }
});
