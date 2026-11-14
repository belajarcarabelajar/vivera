// scripts/workflows.test.mjs
//
// Every workflow in .github/workflows is dispatch-only (user policy 2026-09-28, see the header of
// ci.yml), and platforms.yml keeps the shape that makes it a proof on real Windows, macOS and Docker.
// The workflows themselves only run on GitHub, so this checks their structure, not their result.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { DOCS_INPUTS } from './docs-drift.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.github', 'workflows');
const PLATFORMS = path.join(DIR, 'platforms.yml');
const DOCS_DEPLOY = path.join(DIR, 'docs-deploy.yml');
// The one workflow with an automatic trigger: docs-deploy.yml (owner decision 2026-11-15, plan
// 2026-11-15-docs-autodeploy). vivera is public, so standard hosted runners cost no minutes.
const AUTO_TRIGGER = ['docs-deploy.yml'];

// The yaml package parses YAML 1.2 (core schema), so a bare `on:` key stays the string "on". A parser in
// YAML 1.1 mode would turn it into the boolean key `true`; that key is read too, so such a file still has
// its triggers checked instead of looking trigger-free.
function triggerNames(doc) {
  const on = doc?.on ?? doc?.true;
  if (on == null) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
}

const dispatchOnly = (doc) => {
  const names = triggerNames(doc);
  return names.length === 1 && names[0] === 'workflow_dispatch';
};

const workflowFiles = () =>
  fs
    .readdirSync(DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

describe('every workflow but docs-deploy.yml is dispatch-only', () => {
  test('the directory holds the known workflows, platforms.yml among them', () => {
    expect(workflowFiles()).toEqual(expect.arrayContaining(['ci.yml', 'release.yml', 'platforms.yml']));
  });

  for (const file of workflowFiles().filter((f) => !AUTO_TRIGGER.includes(f))) {
    test(`${file} parses and its only trigger is workflow_dispatch`, () => {
      const doc = parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
      expect(Object.keys(doc)).toContain('on');
      expect(triggerNames(doc)).toEqual(['workflow_dispatch']);
    });
  }

  test('the check refuses an automatic trigger added next to workflow_dispatch, in every form `on` takes', () => {
    const ci = parse(fs.readFileSync(path.join(DIR, 'ci.yml'), 'utf8'));
    expect(dispatchOnly(ci)).toBe(true);
    for (const extra of ['push', 'pull_request', 'schedule']) {
      expect(dispatchOnly({ ...ci, on: { ...ci.on, [extra]: null } })).toBe(false);
    }
    expect(dispatchOnly(parse('on: push\n'))).toBe(false);
    expect(dispatchOnly(parse('on: [workflow_dispatch, push]\n'))).toBe(false);
    expect(dispatchOnly(parse('true:\n  push:\n  workflow_dispatch:\n'))).toBe(false);
    expect(dispatchOnly(parse('name: no trigger\n'))).toBe(false);
  });
});

describe('platforms.yml proves the installers on real Windows, macOS and Docker', () => {
  const load = () => parse(fs.readFileSync(PLATFORMS, 'utf8'));

  test('the token can only read the repository', () => {
    expect(load().permissions).toEqual({ contents: 'read' });
  });

  test('windows runs once with pwsh and once with Windows PowerShell, and the PS1 suites get that shell', () => {
    const job = load().jobs?.windows;
    expect(job['runs-on']).toBe('windows-latest');
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.shell).toEqual(expect.arrayContaining(['pwsh', 'powershell']));
    const runs = job.steps.map((s) => s.run ?? '');
    // The suites read process.env.PWSH; an earlier step must export it, or they fall back to whatever is on PATH.
    const exported = runs.findIndex((r) => /"PWSH=\$exe"[^\n]*\$env:GITHUB_ENV/.test(r) && r.includes('PSEdition'));
    const suites = runs.findIndex((r) => r.includes('scripts/install-ps1-run.test.mjs') && r.includes('scripts/install-ps1-hooks.test.mjs')
      && r.includes('scripts/install-ps1-relfiles.test.mjs') && r.includes('scripts/install-ps1-sha256.test.mjs'));
    expect(exported).toBeGreaterThanOrEqual(0);
    expect(suites).toBeGreaterThan(exported);
  });

  test('windows runs install.ps1 from a pwsh prompt, inherited PSModulePath and removed, before the suites', () => {
    const steps = load().jobs?.windows.steps;
    const runs = steps.map((s) => s.run ?? '');
    const prompt = runs.findIndex((r) => r.includes("'./install.ps1', '-Only', 'claude'") && r.includes("'-Check'")
      && r.includes('Remove-Item Env:PSModulePath') && r.includes('Get-Command Get-FileHash')
      && r.includes('Bun.spawnSync') && r.includes('-Relayed'));
    const suites = runs.findIndex((r) => r.includes('scripts/install-ps1-run.test.mjs'));
    expect(prompt).toBeGreaterThanOrEqual(0);
    expect(steps[prompt].shell).toBe('pwsh');
    // Only direct and relayed gate: the control run's exit code must not leak out as the step's.
    expect(steps[prompt].run.trimEnd().endsWith('exit 0')).toBe(true);
    expect(suites).toBeGreaterThan(prompt);
    // A red prompt step must not hide the suites' own results.
    expect(steps[suites].if).toBe('${{ !cancelled() }}');
  });

  test('macos puts /bin/bash first on PATH and asserts it is bash 3.2 before the bash suites run', () => {
    const job = load().jobs?.macos;
    expect(job['runs-on']).toBe('macos-latest');
    const steps = job.steps.map((s) => s.run ?? '');
    const shim = steps.findIndex((r) => r.includes('/bin/bash') && r.includes('GITHUB_PATH'));
    const assert = steps.findIndex((r) => r.includes('BASH_VERSINFO'));
    const suites = steps.findIndex((r) => r.includes('bun test') && r.includes('prereq.test.mjs'));
    expect(shim).toBeGreaterThanOrEqual(0);
    expect(assert).toBeGreaterThan(shim);
    expect(suites).toBeGreaterThan(assert);
    expect(steps.some((r) => r.includes('/bin/bash ./install.sh --dry-run'))).toBe(true);
  });

  test('docker builds the image and runs install.sh --check inside it', () => {
    const job = load().jobs?.docker;
    expect(job['runs-on']).toBe('ubuntu-latest');
    const steps = job.steps.map((s) => s.run ?? '');
    const build = steps.findIndex((r) => /docker build\b/.test(r));
    const run = steps.findIndex((r) => /docker run\b/.test(r) && r.includes('./install.sh --check'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(build);
  });
});

describe('docs-deploy.yml deploys the docs site when a docs input reaches main', () => {
  const load = () => parse(fs.readFileSync(DOCS_DEPLOY, 'utf8'));
  const jobs = () => load().jobs ?? {};
  const runs = (job) => job.steps.map((s) => s.run ?? '');
  const SHA = /@[0-9a-f]{40}$/;

  test('docs-deploy: the only automatic-trigger exception is this file', () => {
    expect(AUTO_TRIGGER).toEqual(['docs-deploy.yml']);
    expect(workflowFiles()).toContain('docs-deploy.yml');
  });

  test('docs-deploy: triggers are push to main filtered to exactly DOCS_INPUTS, plus workflow_dispatch', () => {
    const doc = load();
    expect(triggerNames(doc).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(doc.on.push.branches).toEqual(['main']);
    expect(doc.on.push['paths-ignore']).toBeUndefined();
    expect([...doc.on.push.paths].sort()).toEqual([...DOCS_INPUTS].sort());
  });

  test('docs-deploy: read-only token, one deploy at a time and never cancelled, two jobs with timeouts', () => {
    const doc = load();
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.concurrency.group).toBeTruthy();
    expect(doc.concurrency['cancel-in-progress']).toBe(false);
    expect(Object.keys(jobs()).sort()).toEqual(['build', 'deploy']);
    for (const job of Object.values(jobs())) {
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
      const co = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'));
      expect(co?.with?.['persist-credentials']).toBe(false);
    }
  });

  test('docs-deploy: the build job holds no secret and no environment, builds with --local and uploads the site', () => {
    const build = jobs().build;
    expect(build.environment).toBeUndefined();
    expect(JSON.stringify(build)).not.toContain('secrets.');
    const b = runs(build).findIndex((r) => /scripts\/docs-remote\.sh build --local\b/.test(r));
    expect(b).toBeGreaterThanOrEqual(0);
    const out = build.steps[b].env?.VIVERA_DOCS_OUT;
    expect(out).toBeTruthy();
    const up = build.steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
    expect(up).toBeGreaterThan(b);
    expect(build.steps[up].with.path).toBe(out);
    expect(build.steps[up].with['if-no-files-found']).toBe('error');
  });

  test('docs-deploy: the deploy job needs the build, runs in docs-production, pins every action by commit, and never builds', () => {
    const deploy = jobs().deploy;
    expect([deploy.needs].flat()).toEqual(['build']);
    expect(deploy.environment).toBe('docs-production');
    for (const s of deploy.steps.filter((s) => s.uses)) expect(s.uses).toMatch(SHA);
    const text = runs(deploy).join('\n');
    expect(text).not.toMatch(/bun install|cargo|docs-gen|pagefind|docs-remote\.sh (build|deploy)\b/);
    const dl = deploy.steps.find((s) => String(s.uses ?? '').startsWith('actions/download-artifact@'));
    const up = jobs().build.steps.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@'));
    expect(dl.with.name).toBe(up.with.name);
    expect(dl.with.path).toBe('apps/docs/dist');
  });

  test('docs-deploy: the Cloudflare token is in the env of the ship step only', () => {
    const doc = load();
    const deploy = jobs().deploy;
    const i = runs(deploy).findIndex((r) => /scripts\/docs-remote\.sh ship --local\b/.test(r));
    expect(i).toBeGreaterThanOrEqual(0);
    const ship = deploy.steps[i];
    expect(ship.env.VIVERA_DOCS_CF_TOKEN).toBe('${{ secrets.VIVERA_DOCS_CF_TOKEN }}');
    expect(ship.env.VIVERA_DOCS_DEPLOY_ACK).toBe('I_UNDERSTAND_THIS_CHANGES_LIVE');
    expect(ship.env.CLOUDFLARE_ACCOUNT_ID).toBe('${{ vars.CLOUDFLARE_ACCOUNT_ID }}');
    // No other place in the file may read a secret: not the workflow env, not a job env, not another step.
    const rest = { ...doc, jobs: { ...doc.jobs, deploy: { ...deploy, steps: deploy.steps.filter((_, k) => k !== i) } } };
    expect(JSON.stringify(rest)).not.toContain('secrets.');
  });

  test('docs-deploy: after the ship, the live stamp must equal the pushed commit, with retries', () => {
    const deploy = jobs().deploy;
    const r = runs(deploy);
    const ship = r.findIndex((x) => x.includes('docs-remote.sh ship --local'));
    const drift = r.findIndex((x) => /bun scripts\/docs-drift\.mjs --expect \$\{\{ github\.sha \}\} --attempts [1-9]/.test(x));
    expect(drift).toBeGreaterThan(ship);
  });

  test('docs-deploy: header names the decision date, kill switch and revert', () => {
    const text = fs.readFileSync(DOCS_DEPLOY, 'utf8');
    expect(text).toContain('2026-11-15');
    expect(text).toContain('gh workflow disable docs-deploy.yml');
    expect(text).toContain('git rm .github/workflows/docs-deploy.yml');
  });
});
