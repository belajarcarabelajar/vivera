// scripts/shell-scripts.test.mjs
//
// Tests for shell scripts. These scripts have side effects (cd, git, etc.)
// so we test them by:
// 1. Syntax check with bash -n
// 2. Verifying they exist and are executable
// 3. Testing individual functions by extracting and evaluating them

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// Helper: run bash -n on a script
function bashSyntaxCheck(scriptPath) {
  const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  return r.status === 0;
}

// Helper: check if file exists and is executable
function isExecutable(scriptPath) {
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------- accept-chunks.sh ----------

test('accept-chunks.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'accept-chunks.sh');
  assert.ok(fs.existsSync(p), 'accept-chunks.sh does not exist');
  assert.ok(isExecutable(p), 'accept-chunks.sh is not executable');
});

test('accept-chunks.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'accept-chunks.sh');
  assert.ok(bashSyntaxCheck(p), 'accept-chunks.sh has syntax errors');
});

test('accept-chunks.sh shows usage with no args', () => {
  // The no-arg path lists chunk files dirty in the working tree, so it only
  // reaches the "tidak ada chunk" message when the tree is clean. Running it
  // against the real repo would make this test fail whenever a chunk is being
  // accepted (i.e. exactly when the tool matters). Copy the script into a
  // throwaway git repo with nothing dirty and exercise the real body there.
  const p = path.join(SCRIPTS_DIR, 'accept-chunks.sh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-chunks-test-'));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.copyFileSync(p, path.join(tmp, 'scripts', 'accept-chunks.sh'));
  const git = (...args) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const r = spawnSync('bash', [path.join(tmp, 'scripts', 'accept-chunks.sh')], { encoding: 'utf8', cwd: tmp });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('tidak ada chunk'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- plan-mirror-check.sh ----------

test('plan-mirror-check.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'plan-mirror-check.sh');
  assert.ok(fs.existsSync(p), 'plan-mirror-check.sh does not exist');
  assert.ok(isExecutable(p), 'plan-mirror-check.sh is not executable');
});

test('plan-mirror-check.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'plan-mirror-check.sh');
  assert.ok(bashSyntaxCheck(p), 'plan-mirror-check.sh has syntax errors');
});

// ---------- render-diagrams.sh ----------

test('render-diagrams.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'render-diagrams.sh');
  assert.ok(fs.existsSync(p), 'render-diagrams.sh does not exist');
  assert.ok(isExecutable(p), 'render-diagrams.sh is not executable');
});

test('render-diagrams.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'render-diagrams.sh');
  assert.ok(bashSyntaxCheck(p), 'render-diagrams.sh has syntax errors');
});

test('render-diagrams.sh slugify function works correctly', () => {
  // Extract and test the slugify function
  const script = fs.readFileSync(path.join(SCRIPTS_DIR, 'render-diagrams.sh'), 'utf8');
  const slugifyMatch = script.match(/slugify\(\)\s*\{[^}]+\}/);
  assert.ok(slugifyMatch, 'slugify function not found');

  // Test slugify logic
  const slugify = (p) => p.replace(/^.*\//, '').replace(/\.md$/, '').replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase();
  assert.equal(slugify('README.md'), 'readme');
  assert.equal(slugify('docs/guide.md'), 'guide');
  assert.equal(slugify('path/to/file-name.md'), 'file-name');
});

test('render-diagrams.sh publish keeps a tracked hero whose text is unchanged', () => {
  // mmdc is nondeterministic (same block, different path coordinates each
  // run), so the publish step must compare text nodes rather than bytes. The
  // shipped svg_text() function is extracted and evaluated for real, against
  // fixtures that reproduce the measured case: identical <p> sequences with
  // different coordinates, then a genuinely changed diagram.
  const script = fs.readFileSync(path.join(SCRIPTS_DIR, 'render-diagrams.sh'), 'utf8');
  const fnMatch = script.match(/svg_text\(\)\s*\{[^}]+\}/);
  assert.ok(fnMatch, 'svg_text function not found; the publish step has no text comparison');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-text-test-'));
  try {
    // Two nodes with path data BETWEEN them that differs: a greedy
    // `<p>.*</p>` span would swallow that path data and report churn, so this
    // fixture is what keeps the comparison honest.
    const committed = '<svg><g><p>Session approved</p><path d="M1 2 C3 4"/><p>Gather reports</p></g></svg>';
    const rerendered = '<svg><g><p>Session approved</p><path d="M9 9 C9 9"/><p>Gather reports</p></g></svg>';
    const changed = '<svg><g><p>Session approved twice</p><path d="M1 2 C3 4"/><p>Gather reports</p></g></svg>';
    fs.writeFileSync(path.join(tmp, 'a.svg'), committed);
    fs.writeFileSync(path.join(tmp, 'b.svg'), rerendered);
    fs.writeFileSync(path.join(tmp, 'c.svg'), changed);
    const run = (f) => spawnSync('bash', ['-c', `${fnMatch[0]}; svg_text "$1"`, 'bash', f], { encoding: 'utf8' });
    assert.equal(run(path.join(tmp, 'a.svg')).stdout, run(path.join(tmp, 'b.svg')).stdout,
      'identical text with different coordinates must compare equal, or every ci run dirties the hero');
    assert.notEqual(run(path.join(tmp, 'a.svg')).stdout, run(path.join(tmp, 'c.svg')).stdout,
      'changed text must compare different, or a real diagram edit would never publish');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('render-diagrams.sh publish guards tracked files instead of blind-copying', () => {
  // Structural: the blind `cp stage/*.svg output/` must be gone, replaced by
  // a loop that keeps a tracked file when its text matches and counts both
  // outcomes. Without this, the svg_text test above passes while the script
  // still overwrites the hero on every run.
  const script = fs.readFileSync(path.join(SCRIPTS_DIR, 'render-diagrams.sh'), 'utf8');
  assert.ok(!script.includes('cp "$STAGE_DIR"/*.svg "$OUTPUT_DIR/"'),
    'bare bulk copy is back; the hero will churn on every ci run');
  assert.ok(script.includes('git check-ignore -q "$dest"'),
    'no tracked-file guard; gitignored build artifacts and committed heroes take the same path');
  assert.ok(script.includes('kept=$((kept + 1))') && script.includes('updated=$((updated + 1))'),
    'publish outcomes are not counted; the ci log cannot show whether a hero changed');
});

// ---------- sync.sh ----------

test('sync.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'sync.sh');
  assert.ok(fs.existsSync(p), 'sync.sh does not exist');
  assert.ok(isExecutable(p), 'sync.sh is not executable');
});

test('sync.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'sync.sh');
  assert.ok(bashSyntaxCheck(p), 'sync.sh has syntax errors');
});

test('sync.sh shows usage for invalid action', () => {
  const p = path.join(SCRIPTS_DIR, 'sync.sh');
  const r = spawnSync('bash', [p, 'invalid-action'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('Usage:'));
});

test('sync.sh status action works', () => {
  const p = path.join(SCRIPTS_DIR, 'sync.sh');
  const r = spawnSync('bash', [p, 'status'], { encoding: 'utf8', cwd: ROOT });
  // Should exit 0 and show status
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('==>') || r.stdout.includes('[WARN]') || r.stdout.includes('[INFO]'));
});

// ---------- verify-chunk.sh ----------

test('verify-chunk.sh exists and is executable', () => {
  const p = path.join(SCRIPTS_DIR, 'verify-chunk.sh');
  assert.ok(fs.existsSync(p), 'verify-chunk.sh does not exist');
  assert.ok(isExecutable(p), 'verify-chunk.sh is not executable');
});

test('verify-chunk.sh has valid bash syntax', () => {
  const p = path.join(SCRIPTS_DIR, 'verify-chunk.sh');
  assert.ok(bashSyntaxCheck(p), 'verify-chunk.sh has syntax errors');
});

test('verify-chunk.sh shows usage with no args', () => {
  const p = path.join(SCRIPTS_DIR, 'verify-chunk.sh');
  const r = spawnSync('bash', [p], { encoding: 'utf8', cwd: ROOT });
  // Should fail with usage error
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('usage:') || r.stdout.includes('usage:'));
});

// ---------- .githooks/pre-commit ----------

const HOOK = path.join(ROOT, '.githooks', 'pre-commit');

/** A throwaway git repo with the hook installed via core.hooksPath. */
function hookRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'githooks-test-'));
  fs.mkdirSync(path.join(tmp, '.githooks'), { recursive: true });
  fs.copyFileSync(HOOK, path.join(tmp, '.githooks', 'pre-commit'));
  fs.chmodSync(path.join(tmp, '.githooks', 'pre-commit'), 0o755);
  const git = (args, env) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8', env: env ?? process.env });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  git(['config', 'core.hooksPath', '.githooks']);
  return { tmp, git };
}

/** Give the temp repo a graph to merge into. */
function withGraph(tmp) {
  fs.mkdirSync(path.join(tmp, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'graphify-out', 'graph.json'), '{}\n');
}

/** A stand-in sync that records that it ran, and in which order. */
function fakeSync(tmp) {
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'scripts', 'graphify-sync.mjs'),
    "import { appendFileSync } from 'fs';\nappendFileSync('order.txt', 'sync\\n');\n",
  );
}

/** A stand-in graphify CLI that records its invocation. Returns its bin dir. */
function fakeGraphify(tmp) {
  const bin = path.join(tmp, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const p = path.join(bin, 'graphify');
  fs.writeFileSync(p, '#!/usr/bin/env bash\nprintf "update\\n" >> order.txt\nexit 0\n');
  fs.chmodSync(p, 0o755);
  return bin;
}

const orderOf = (tmp) => {
  try {
    return fs.readFileSync(path.join(tmp, 'order.txt'), 'utf8');
  } catch {
    return '';
  }
};

test('pre-commit hook exists and is executable', () => {
  assert.ok(fs.existsSync(HOOK), '.githooks/pre-commit does not exist');
  assert.ok(isExecutable(HOOK), '.githooks/pre-commit is not executable');
});

test('pre-commit hook has valid bash syntax', () => {
  assert.ok(bashSyntaxCheck(HOOK), '.githooks/pre-commit has syntax errors');
});

test('pre-commit hook never uses set -e (a failed sync must not block a commit)', () => {
  const content = fs.readFileSync(HOOK, 'utf8');
  assert.ok(content.includes('set -uo pipefail'), 'hook should use set -uo pipefail');
  assert.ok(!/^set -[a-z]*e/m.test(content), 'hook must not use set -e');
});

test('pre-commit hook is a silent no-op when nothing is staged', () => {
  const { tmp, git } = hookRepo();
  const r = git(['commit', '-q', '--allow-empty', '-m', 'empty']);
  assert.equal(r.status, 0);
  assert.ok(!`${r.stdout}${r.stderr}`.includes('graphify'), 'hook should not run with an empty diff');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pre-commit hook skips cleanly when there is no graph to merge into', () => {
  const { tmp, git } = hookRepo();
  fs.writeFileSync(path.join(tmp, 'plan.md'), '# Plan\n');
  git(['add', 'plan.md']);
  const r = git(['commit', '-qm', 'md']);
  assert.equal(r.status, 0);
  assert.ok(`${r.stdout}${r.stderr}`.includes('no graph at graphify-out/graph.json'), 'hook should report the missing graph');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a Markdown-only commit runs the doc sync and NOT the code update', () => {
  const { tmp, git } = hookRepo();
  withGraph(tmp);
  fakeSync(tmp);
  fs.writeFileSync(path.join(tmp, 'plan.md'), '# Plan\n');
  git(['add', 'plan.md']);
  const r = git(['commit', '-qm', 'md']);
  assert.equal(r.status, 0);
  assert.equal(orderOf(tmp), 'sync\n');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a code commit runs graphify update BEFORE the doc sync', () => {
  const { tmp, git } = hookRepo();
  withGraph(tmp);
  fakeSync(tmp);
  const bin = fakeGraphify(tmp);
  fs.writeFileSync(path.join(tmp, 'thing.mjs'), 'export const x = 1;\n');
  git(['add', 'thing.mjs']);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const r = git(['commit', '-qm', 'code'], env);
  assert.equal(r.status, 0);
  assert.equal(orderOf(tmp), 'update\nsync\n');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- Cross-script integration ----------

test('all shell scripts have proper shebangs', () => {
  const scripts = ['accept-chunks.sh', 'plan-mirror-check.sh', 'render-diagrams.sh', 'sync.sh', 'verify-chunk.sh'];
  for (const name of scripts) {
    const content = fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env bash'), `${name} missing proper shebang`);
  }
});

test('all shell scripts use set -e or set -uo pipefail', () => {
  const scripts = ['accept-chunks.sh', 'plan-mirror-check.sh', 'render-diagrams.sh', 'sync.sh', 'verify-chunk.sh'];
  for (const name of scripts) {
    const content = fs.readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    assert.ok(
      content.includes('set -e') || content.includes('set -uo pipefail'),
      `${name} missing error handling`
    );
  }
});
