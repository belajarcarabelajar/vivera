import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkRunnerContract, keyPaths, missingKeys, unreadKeys, contractPaths } from './check-runner-contract.mjs';
import { extractFrontmatter, parseUltraPlanYaml } from './ultra-plan-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'check-runner-contract.mjs');

test('keyPaths drops array indices so a bracket path compares equal', () => {
  const found = [...keyPaths({ tasks: [{ id: 'T1', run: [{ cmd: 'x' }] }] })];
  assert.ok(found.includes('tasks.id'));
  assert.ok(found.includes('tasks.run.cmd'));
  assert.ok(!found.some((p) => /\.\d+\./.test(p)), found.join(' | '));
});

// The noise floor, measured before the reverse comparison was narrowed. Pinned
// so a future loosening of the rule fails here instead of quietly on the tree:
// raw set difference against the contract names six paths per artifact, and
// five of them are container prefixes or a key the runner reaches THROUGH the
// parent the contract already names. See the narrowing comment in the checker.
const RAW_FLOOR = ['defaults', 'tasks', 'tasks.files.create', 'tasks.files.modify', 'tasks.files.test', 'version'];
const NARROWED_FLOOR = ['version'];

function realArtifacts() {
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'implementation-plan-template.md'), 'utf8');
  const master = fs.readFileSync(path.join(ROOT, 'Super Ultra Code Plan Implementation.md'), 'utf8');
  const fenced = master.match(/```\n---\nschema: ultra-plan\/v1[\s\S]*?\n---\n/);
  assert.ok(fenced, 'the master skill lost its fenced plan header, the negative control cannot run');
  return [
    ['templates/implementation-plan-template.md', tpl],
    ['the master skill plan header template', fenced[0].replace(/^```[^\n]*\n/, '')],
  ];
}

test('NEGATIVE CONTROL: raw keying over both real artifacts floors at six paths', () => {
  for (const [name, text] of realArtifacts()) {
    const parsed = parseUltraPlanYaml(extractFrontmatter(text).frontmatter);
    const raw = [...keyPaths(parsed)].filter((p) => !contractPaths().includes(p)).sort();
    assert.deepEqual(raw, RAW_FLOOR, `${name}: the raw extra-key set moved`);
  }
});

test('NEGATIVE CONTROL: the narrowed reverse rule leaves one finding on each real artifact', () => {
  // `version` is a REAL artifact-only key: nothing in ultra-plan-runner.mjs
  // reads it. It is reported as a warning, not silenced, and NOT fixed here,
  // because the two artifacts belong to other chunks.
  for (const [name, text] of realArtifacts()) {
    const parsed = parseUltraPlanYaml(extractFrontmatter(text).frontmatter);
    assert.deepEqual(unreadKeys(parsed), NARROWED_FLOOR, `${name}: narrowed findings changed`);
  }
});

test('an artifact-only key is reported, and `version` is reported on the real tree', () => {
  const { problems, warnings } = checkRunnerContract();
  assert.deepEqual(problems, [], 'the forward direction regressed');
  assert.ok(warnings.length > 0, 'a real artifact-only key exists and was not reported');
  const reported = warnings.join('\n');
  assert.match(reported, /version/);
  // Both artifacts carry it, so both must be named: one warning that does not
  // say which file would leave the reader to grep for it.
  assert.match(reported, /templates\/implementation-plan-template\.md/);
  assert.match(reported, /the master skill plan header template/);
  // Warnings must not smuggle the reverse check into the error path.
  assert.ok(!problems.some((p) => /version/.test(p)), 'the artifact-only key was escalated to an error');
});

test('a runner key missing from an artifact is still an ERROR, not a warning', () => {
  // The forward direction keeps its severity. Only the unowned half is a warning.
  const plan = { schema: 'ultra-plan/v1', status: 'Draft', tasks: [{ id: 'T1', run: [{ cmd: 'x' }] }] };
  const gaps = missingKeys(plan);
  assert.ok(gaps.includes('tasks.files'), gaps.join(' | '));
  assert.ok(gaps.includes('defaults.retry_if'), gaps.join(' | '));
  assert.ok(!gaps.includes('tasks.run.cmd'), 'a present runner key must not be reported');

  // And a key that is absent rather than merely undefined must be reported:
  // `Object.entries` walks an `undefined` value as a present key, so setting it
  // to undefined would have passed here without deleting it.
  const withoutKey = { ...plan, tasks: [{ id: 'T1', run: [{ cmd: 'x' }] }] };
  assert.ok(missingKeys(withoutKey).includes('tasks.idempotency_key'));
  const setToUndefined = { ...plan, tasks: [{ ...plan.tasks[0], idempotency_key: undefined }] };
  assert.ok(!missingKeys(setToUndefined).includes('tasks.idempotency_key'),
    'an explicitly undefined key is still a declared key');
});

test('unreadKeys is index-insensitive and ignores the container prefixes', () => {
  const plan = {
    schema: 'ultra-plan/v1',
    tasks: [
      { id: 'T1', run: [{ cmd: 'a', retry: 0, mystery: 1 }] },
      { id: 'T2', run: [{ cmd: 'b', retry: 0, mystery: 2 }] },
    ],
  };
  const unread = unreadKeys(plan);
  assert.deepEqual(unread, ['tasks.run.mystery']);
  assert.ok(!unread.some((p) => /\.\d+\./.test(p)), unread.join(' | '));
  // A prefix the runner reaches through (`tasks.files` names `tasks.files.create`)
  // and a bare container (`tasks`) are both covered, not reported.
  const withFiles = unreadKeys({ tasks: [{ files: { create: ['a'], modify: [], test: ['b'] }, run: [] }] });
  assert.deepEqual(withFiles, []);
});

test('the repository as it stands satisfies the runner contract', () => {
  const { problems, total } = checkRunnerContract();
  assert.deepEqual(problems, []);
  assert.ok(total > 0, 'the contract key list is empty, so this test proves nothing');
});

test('the CLI exits 0 and names the key count on a clean tree', () => {
  const r = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all \d+ keys the runner reads/);
});

test('the CLI exits 0 but PRINTS the artifact-only keys it cannot refuse', () => {
  // Warning, not error, and this is the whole argument in one test: the real
  // tree carries a documented key the runner does not read (`version`), and the
  // check refuses to hold the repository hostage to a plan field whose removal
  // is another chunk's call. It still has to be VISIBLE, loudly, every run.
  const r = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'an artifact-only key must not fail the gate');
  assert.match(r.stdout, /declared but no runner contract key reads/);
  assert.match(r.stdout, /version/);
  assert.match(r.stdout, /WARN/);
});

test('the CLI exits 1 when a documented key disappears from the template', () => {
  // The negative control. A check that cannot fail is not a check, and the
  // first draft of this one grepped for key names in prose and therefore passed
  // a template whose `run:` had been renamed.
  const tpl = path.join(ROOT, 'templates', 'implementation-plan-template.md');
  const original = fs.readFileSync(tpl, 'utf8');
  try {
    fs.writeFileSync(tpl, original.replace(/^(\s*)run:/gm, '$1disabled_run:'));
    const r = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 1, 'renaming run: in the template must fail the check');
    assert.match(r.stderr, /tasks\.run\b/);
  } finally {
    fs.writeFileSync(tpl, original);
  }
  // And the tree is clean again, which is the half that matters: a negative
  // control that leaves the repo modified proves nothing about the next run.
  const after = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(after.status, 0, after.stdout + after.stderr);
});

test('the CLI stays fast enough to use as a plan skip_if', () => {
  // It exists as a separate entry point precisely because validate-skill.mjs
  // renders Mermaid through a headless browser. A plan step that shells into
  // that on every re-run times out, which is what happened when skip_if grepped
  // validate-skill's output for a literal key count.
  const started = Date.now();
  const r = spawnSync('bun', [CLI], { cwd: ROOT, encoding: 'utf8' });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0);
  assert.ok(elapsed < 15_000, `check took ${elapsed}ms, too slow to sit in a skip_if`);
});
