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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.github', 'workflows');
const PLATFORMS = path.join(DIR, 'platforms.yml');

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

describe('every workflow is dispatch-only', () => {
  test('the directory holds the known workflows, platforms.yml among them', () => {
    expect(workflowFiles()).toEqual(expect.arrayContaining(['ci.yml', 'release.yml', 'platforms.yml']));
  });

  for (const file of workflowFiles()) {
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
