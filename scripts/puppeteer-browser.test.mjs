// scripts/puppeteer-browser.test.mjs
//
// Tests for the puppeteer browser resolver shared by render-diagrams.sh and
// validate-skill.mjs. The resolver is driven with an injected env, exists and
// which; the CLI is run against a temp HOME and a temp PATH, so no browser runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { resolvePuppeteerBrowser } from './puppeteer-browser.mjs';

const HOME = '/home/u';
const DEFAULT_CACHE = '/home/u/.cache/puppeteer';
const onPath = (map) => (name) => map[name] ?? null;
const existing = (...paths) => (p) => paths.includes(p);

test('an already set PUPPETEER_EXECUTABLE_PATH wins and nothing is injected', () => {
  const got = resolvePuppeteerBrowser({
    env: { HOME, PUPPETEER_EXECUTABLE_PATH: '/opt/my-chrome' },
    exists: existing(),
    which: onPath({ chromium: '/usr/bin/chromium' }),
  });
  assert.equal(got, null);
});

test('a present puppeteer cache means the bundled browser is used and nothing is injected', () => {
  const got = resolvePuppeteerBrowser({
    env: { HOME },
    exists: existing(DEFAULT_CACHE),
    which: onPath({ chromium: '/usr/bin/chromium' }),
  });
  assert.equal(got, null);
});

test('a missing cache with chromium on PATH injects the chromium path', () => {
  const got = resolvePuppeteerBrowser({
    env: { HOME },
    exists: existing(),
    which: onPath({ chromium: '/usr/bin/chromium', 'google-chrome': '/usr/bin/google-chrome' }),
  });
  assert.equal(got, '/usr/bin/chromium');
});

test('a missing cache picks the first browser in the documented order', () => {
  const got = resolvePuppeteerBrowser({
    env: { HOME },
    exists: existing(),
    which: onPath({ 'google-chrome': '/usr/bin/google-chrome', 'google-chrome-stable': '/usr/bin/google-chrome-stable' }),
  });
  assert.equal(got, '/usr/bin/google-chrome-stable');
});

test('a missing cache with no browser on PATH injects nothing', () => {
  const got = resolvePuppeteerBrowser({ env: { HOME }, exists: existing(), which: onPath({}) });
  assert.equal(got, null);
});

test('PUPPETEER_CACHE_DIR replaces the default cache location', () => {
  const which = onPath({ chromium: '/usr/bin/chromium' });
  const custom = { HOME, PUPPETEER_CACHE_DIR: '/srv/pptr' };
  // The default cache exists but the configured one does not, so the system browser is used.
  assert.equal(resolvePuppeteerBrowser({ env: custom, exists: existing(DEFAULT_CACHE), which }), '/usr/bin/chromium');
  assert.equal(resolvePuppeteerBrowser({ env: custom, exists: existing('/srv/pptr'), which }), null);
});

// ---------- CLI, the entry point render-diagrams.sh reads ----------

const CLI = path.join(import.meta.dirname, 'puppeteer-browser.mjs');

function runCli(extraEnv) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-browser-'));
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'chromium'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { PATH: bin, HOME: path.join(scratch, 'home'), ...extraEnv(scratch) };
  try {
    const r = spawnSync(process.execPath, [CLI], { env, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, bin };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('CLI prints the absolute path of the system browser when the cache is missing', () => {
  const r = runCli(() => ({}));
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr },
    { status: 0, stdout: `${path.join(r.bin, 'chromium')}\n`, stderr: '' });
});

test('CLI prints nothing when PUPPETEER_EXECUTABLE_PATH is already set', () => {
  const r = runCli(() => ({ PUPPETEER_EXECUTABLE_PATH: '/opt/my-chrome' }));
  assert.deepEqual({ status: r.status, stdout: r.stdout }, { status: 0, stdout: '' });
});

// ---------- render-diagrams.sh wiring ----------

// The stub mmdc writes the browser it was handed into each SVG text node, so the
// published SVGs show what both the batch path and the hero path received. A batch
// call (an .md output) fails so the shared renderer falls back to one call per block.
const STUB_MMDC = `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$out" in ""|*.md) exit 1 ;; esac
printf '<svg xmlns="http://www.w3.org/2000/svg"><p>browser=%s</p></svg>' "$PUPPETEER_EXECUTABLE_PATH" > "$out"
`;

test('render-diagrams.sh hands the system browser to every mmdc call when the cache is missing', () => {
  const root = path.join(import.meta.dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-render-'));
  try {
    const tree = path.join(scratch, 'tree');
    const put = (rel, body, mode) => {
      fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
      fs.writeFileSync(path.join(tree, rel), body, mode ? { mode } : undefined);
    };
    for (const rel of [
      'scripts/render-diagrams.sh', 'scripts/mermaid-batch.mjs', 'scripts/validate-lib.mjs', 'scripts/puppeteer-browser.mjs',
      'mermaid.config.json', 'mermaid.dark.config.json', 'puppeteer-config.json', 'docs/diagrams-src/lifecycle.mmd',
    ]) put(rel, fs.readFileSync(path.join(root, rel)));
    put('page.md', '# Page\n\n```mermaid\nflowchart LR\n  A --> B\n```\n');
    const stub = path.join(scratch, 'stub');
    const browsers = path.join(scratch, 'browsers');
    fs.mkdirSync(stub);
    fs.mkdirSync(browsers);
    fs.writeFileSync(path.join(stub, 'mmdc'), STUB_MMDC, { mode: 0o755 });
    fs.writeFileSync(path.join(browsers, 'chromium'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = {
      PATH: [stub, browsers, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      HOME: path.join(scratch, 'home'),
    };
    const r = spawnSync('bash', [path.join(tree, 'scripts', 'render-diagrams.sh')], { cwd: tree, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const seen = (name) => fs.readFileSync(path.join(tree, 'diagrams', name), 'utf8').match(/browser=([^<]*)/)[1];
    const want = path.join(browsers, 'chromium');
    assert.deepEqual(
      { block: seen('page-block1.svg'), hero: seen('lifecycle.svg'), heroDark: seen('lifecycle-dark.svg') },
      { block: want, hero: want, heroDark: want },
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
