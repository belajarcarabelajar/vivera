// Regression tests for the 2026-11-05 script audit (plan 2026-11-05-audit-fixes,
// task T5). One test per behaviour; each names the audit finding it pins.
// Secrets below are assembled at run time so the repository secret gate does
// not see a complete credential literal in this file.
import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatePlan } from './ultra-plan-runner.mjs';
import { staleStatusCandidates } from './plan-lifecycle-audit.mjs';
import { redact } from './lib/redact.mjs';
import * as graphifySync from './graphify-sync.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

// ---------- finding 16: runner numbers are validated ----------

const planWith = (defaults, step = {}) => ({
  schema: 'ultra-plan/v1',
  defaults,
  tasks: [{ id: 'T1', depends_on: [], run: [{ cmd: 'true', ...step }] }],
});

test('defaults.step_timeout_s that is zero, negative, non-numeric or over a day is a validation error naming the field', () => {
  for (const bad of [0, -1, '120', Number.NaN, Number.POSITIVE_INFINITY, 86401]) {
    const { errors } = validatePlan(planWith({ step_timeout_s: bad }), null);
    assert.ok(errors.some((e) => e.includes('defaults.step_timeout_s')),
      `step_timeout_s=${bad} passed validation: ${JSON.stringify(errors)}`);
  }
  const { errors } = validatePlan(planWith({ step_timeout_s: 120 }), null);
  assert.ok(!errors.some((e) => e.includes('step_timeout_s')), JSON.stringify(errors));
});

test('defaults.retry_transient_max outside the integers 0..10 is a validation error naming the field', () => {
  for (const bad of [-1, 1.5, 11, '2', null]) {
    const { errors } = validatePlan(planWith({ retry_transient_max: bad }), null);
    assert.ok(errors.some((e) => e.includes('defaults.retry_transient_max')),
      `retry_transient_max=${bad} passed validation: ${JSON.stringify(errors)}`);
  }
  for (const ok of [0, 10]) {
    const { errors } = validatePlan(planWith({ retry_transient_max: ok }), null);
    assert.ok(!errors.some((e) => e.includes('retry_transient_max')), JSON.stringify(errors));
  }
});

test('run[].retry outside the integers 0..10 is a validation error naming the task and step', () => {
  for (const bad of [-1, 2.5, 11, '1', true]) {
    const { errors } = validatePlan(planWith({}, { retry: bad }), null);
    assert.ok(errors.some((e) => e.includes('task T1 run[0] retry')),
      `retry=${bad} passed validation: ${JSON.stringify(errors)}`);
  }
  const { errors } = validatePlan(planWith({}, { retry: 3 }), null);
  assert.ok(!errors.some((e) => e.includes('retry')), JSON.stringify(errors));
});

// Audit 2026-11-09 r228-1--regresi-2: the per-step key overrides the default, so it gets the same ceiling.
test('run[].timeout_s over a day is a validation error naming the task and step', () => {
  for (const bad of [0, -1, '60', 86401, 3000000]) {
    const { errors } = validatePlan(planWith({}, { timeout_s: bad }), null);
    assert.ok(errors.some((e) => e.includes('task T1 run[0] timeout_s')),
      `timeout_s=${bad} passed validation: ${JSON.stringify(errors)}`);
  }
  const { errors } = validatePlan(planWith({}, { timeout_s: 86400 }), null);
  assert.ok(!errors.some((e) => e.includes('timeout_s')), JSON.stringify(errors));
});

// ---------- finding 116: a task id with regex syntax never throws ----------

test('a task id outside [A-Za-z0-9._-] is a validation error, not a SyntaxError', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 'T1(', depends_on: [], run: [{ cmd: 'true' }] }] };
  const body = '### Task T1(: x\n\n```mermaid\nflowchart TD\n  A --> B\n```\n';
  let result;
  assert.doesNotThrow(() => { result = validatePlan(plan, body); });
  assert.ok(result.errors.some((e) => e.includes('T1(') && e.includes('A-Za-z0-9._-')),
    JSON.stringify(result.errors));
});

test('a numeric task id from YAML (id: 1) is not rejected by the id rule', () => {
  const plan = { schema: 'ultra-plan/v1', tasks: [{ id: 1, depends_on: [], run: [{ cmd: 'true' }] }] };
  const { errors } = validatePlan(plan, '### Task 1: x\n');
  assert.ok(!errors.some((e) => e.includes('A-Za-z0-9._-')), JSON.stringify(errors));
});

// ---------- finding 42: the body Complete check is linear ----------

const draftWithLine = (line) => ['---', 'schema: ultra-plan/v1', 'status: Draft', '---', '', '# P', '', line, ''].join('\n');
const contradicted = (line) => (staleStatusCandidates(draftWithLine(line))?.signals ?? []).includes('CONTRADICTED');

// Timed in a child with a kill timeout: the super-linear pattern this pins would
// otherwise hang the whole test file instead of failing one test.
test('a 10,000-space status line is judged in under 50 ms', () => {
  const src = `import { staleStatusCandidates } from ${JSON.stringify(path.join(ROOT, 'scripts', 'plan-lifecycle-audit.mjs'))};
const text = ['---', 'status: Draft', '---', '', 'status' + ' '.repeat(10000) + 'x', ''].join('\\n');
const t0 = performance.now();
const c = staleStatusCandidates(text);
console.log(JSON.stringify({ ms: performance.now() - t0, hit: (c?.signals ?? []).includes('CONTRADICTED') }));`;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 3000 });
  assert.equal(r.signal, null, 'the check ran past the 3 s kill timeout');
  const { ms, hit } = JSON.parse(r.stdout.trim());
  assert.equal(hit, false);
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});

test('every Complete spelling still reads as CONTRADICTED and near misses do not', () => {
  for (const line of ['- **Status:** Complete', '**Status**: Complete', 'Status: Complete', '* status: `Complete`',
    '+ **Status** : **Complete**', '  status complete']) {
    assert.ok(contradicted(line), `missed: ${line}`);
  }
  for (const line of ['Status: Completed', 'Status: Complete soon', 'status: Draft', '-Status: Complete', 'the status is Complete']) {
    assert.ok(!contradicted(line), `false hit: ${line}`);
  }
});

// ---------- finding 19: prefixed secret names and two bare key shapes ----------

test('a secret name with a prefix such as ANTHROPIC_API_KEY or DB_PASSWORD is masked', () => {
  for (const s of ['ANTHROPIC_API_KEY=x', 'TELEGRAM_BOT_TOKEN=x', 'DB_PASSWORD=x', 'my-client-secret: shh']) {
    const r = redact(s);
    assert.equal(r.text, '[REDACTED:generic-secret-assignment]', `${s} -> ${r.text}`);
  }
});

// Audit 2026-11-09 r228-1--regresi-1: the prefix lookbehind also refused a start right after `--`.
test('a secret passed as a CLI flag such as --password=x or --token=x is masked', () => {
  for (const flag of ['--password=x', '--token=x', '--api-key=x', '--client-secret=x', '-passwd=x', '--db-password=x']) {
    const r = redact(`mysql ${flag} -h db`);
    assert.ok(!/=x\b/.test(r.text) && r.counts['generic-secret-assignment'] === 1, `${flag} -> ${r.text}`);
  }
  assert.equal(redact('a-password=x').text, '[REDACTED:generic-secret-assignment]');
});

test('a 64 KB run of hyphen-led words is redacted in under 50 ms', () => {
  const src = `import { redact } from ${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'redact.mjs'))};
const text = '--ab-'.repeat(13000) + 'x';
const t0 = performance.now();
redact(text);
console.log(JSON.stringify({ ms: performance.now() - t0 }));`;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.signal, null, 'redact ran past the 5 s kill timeout');
  assert.ok(JSON.parse(r.stdout.trim()).ms < 50, r.stdout);
});

// The label prefix group must not make the pattern retry at every hyphen of a
// long run (review of this branch: 64 KB of "a-" took 1.4 s, main 0.6 ms).
test('a 64 KB run of hyphenated words is redacted in under 50 ms', () => {
  const src = `import { redact } from ${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'redact.mjs'))};
const text = 'ab-'.repeat(32000) + 'x';
const t0 = performance.now();
redact(text);
console.log(JSON.stringify({ ms: performance.now() - t0 }));`;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.signal, null, 'redact ran past the 5 s kill timeout');
  const { ms } = JSON.parse(r.stdout.trim());
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});

test('a bare Anthropic key is masked', () => {
  const key = ['sk', 'ant', 'api03', 'Abc123Def456Ghi789Jkl0'].join('-');
  const r = redact(`see ${key} here`);
  assert.equal(r.text, 'see [REDACTED:anthropic-api-key] here');
});

test('a bare Telegram bot token is masked', () => {
  const token = `${'12345' + '6789'}:${'AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr'}`;
  const r = redact(`bot ${token} end`);
  assert.equal(r.text, 'bot [REDACTED:telegram-bot-token] end');
});

// ---------- finding 64: the first backup of the day is kept ----------

test('a second sync on the same day keeps the first backup and reports it', () => {
  const out = tmpDir('graphify-backup-');
  const graph = path.join(out, 'graph.json');
  fs.writeFileSync(graph, '{"v":1}');
  const { writeSyncBackup } = graphifySync;
  assert.equal(typeof writeSyncBackup, 'function', 'graphify-sync.mjs exports no writeSyncBackup');
  const first = writeSyncBackup(out, graph, '2026-11-05');
  assert.equal(first.kept, false);
  fs.writeFileSync(graph, '{"v":2}');
  const second = writeSyncBackup(out, graph, '2026-11-05');
  assert.equal(second.kept, true);
  assert.equal(second.dir, first.dir);
  assert.equal(fs.readFileSync(path.join(first.dir, 'graph.json'), 'utf8'), '{"v":1}');
});

// ---------- finding 198: sync.sh never clobbers a local edit ----------

const FILE_NAME = 'Super Ultra Code Plan Implementation.md';

function syncSandbox(destContent) {
  const tmp = tmpDir('sync-sh-');
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'sync.sh'), path.join(repo, 'scripts', 'sync.sh'));
  fs.writeFileSync(path.join(repo, FILE_NAME), 'repo version\n');
  const dest = path.join(home, '.config', 'ai', FILE_NAME);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (destContent === 'symlink') fs.symlinkSync(path.join(repo, FILE_NAME), dest);
  else if (destContent !== undefined) fs.writeFileSync(dest, destContent);
  const run = (...args) => spawnSync('bash', [path.join(repo, 'scripts', 'sync.sh'), ...args],
    { encoding: 'utf8', env: { ...process.env, HOME: home } });
  return { dest, run };
}
const out = (r) => `${r.stdout}${r.stderr}`;

test('sync.sh link refuses to replace a local file that differs, pointing to pull or --force', () => {
  const s = syncSandbox('my edits\n');
  const r = s.run('link');
  assert.equal(r.status, 1, out(r));
  assert.ok(out(r).includes('pull') && out(r).includes('--force'), out(r));
  assert.ok(!fs.lstatSync(s.dest).isSymbolicLink());
  assert.equal(fs.readFileSync(s.dest, 'utf8'), 'my edits\n');
});

test('sync.sh push refuses to overwrite a local file that differs', () => {
  const s = syncSandbox('my edits\n');
  const r = s.run('push');
  assert.equal(r.status, 1, out(r));
  assert.ok(out(r).includes('pull') && out(r).includes('--force'), out(r));
  assert.equal(fs.readFileSync(s.dest, 'utf8'), 'my edits\n');
});

test('sync.sh link and push with --force replace a local file that differs', () => {
  const a = syncSandbox('my edits\n');
  assert.equal(a.run('link', '--force').status, 0);
  assert.ok(fs.lstatSync(a.dest).isSymbolicLink());
  const b = syncSandbox('my edits\n');
  assert.equal(b.run('push', '--force').status, 0);
  assert.equal(fs.readFileSync(b.dest, 'utf8'), 'repo version\n');
});

test('sync.sh link over an identical local file still links', () => {
  const s = syncSandbox('repo version\n');
  assert.equal(s.run('link').status, 0);
  assert.ok(fs.lstatSync(s.dest).isSymbolicLink());
});

test('sync.sh push onto the symlink reports it is linked and exits 0', () => {
  const s = syncSandbox('symlink');
  const r = s.run('push');
  assert.equal(r.status, 0, out(r));
  assert.ok(/linked/i.test(r.stdout), out(r));
  assert.ok(fs.lstatSync(s.dest).isSymbolicLink());
});
