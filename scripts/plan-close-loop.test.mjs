// scripts/plan-close-loop.test.mjs
//
// The due list and kept-open records (AC-3): a fixture registry with landed
// plans in temp repositories, the CLI spawned with VIVERA_CLOSEOUT_STATE in a
// temp dir. skip_if commands are "true", "false" and "exit 1", run for real.

import './lib/local-runner-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Namespace imports, so a missing export fails its own test instead of the whole file.
import * as loop from './plan-close-loop.mjs';
import * as state from './lib/closeout-state.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-close-loop.mjs');
const DAY = 24 * 60 * 60 * 1000;

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  delete process.env.VIVERA_CLOSEOUT_STATE;
});
const tmp = (p) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};

const planOf = (id, status, tasks) => [
  '---',
  'schema: ultra-plan/v1',
  `plan_id: ${id}`,
  `status: ${status}`,
  'tasks:',
  ...tasks.flatMap((t) => [`  - id: ${t.id}`, '    depends_on: []', `    skip_if: ${JSON.stringify(t.skipIf)}`]),
  '---',
  '',
  `# ${id}`,
  '',
  ...tasks.flatMap((t) => [`### Task ${t.id}: work`, ...t.body, '']),
].join('\n');

// ready: its only gap is an open box of a DONE task, so it is READY once ticked.
const PLANS = {
  ready: planOf('ready', 'Verification', [
    { id: 'T1', skipIf: 'true', body: ['- [ ] Step 1: run it'] },
    { id: 'T2', skipIf: 'false', body: ['- [x] Step 1: did it'] },
  ]),
  failing: planOf('failing', 'Verification', [{ id: 'T1', skipIf: 'exit 1', body: ['- [x] Step 1: a'] }]),
  // The open box belongs to a task with no check command, so it blocks.
  unticked: planOf('unticked', 'Verification', [
    { id: 'T1', skipIf: 'true', body: ['- [x] Step 1: a'] },
    { id: 'T2', skipIf: 'false', body: ['- [ ] Step 1: b'] },
  ]),
  done: planOf('done', 'Complete', [{ id: 'T1', skipIf: 'true', body: ['- [x] Step 1: a'] }]),
};

function fixture({ plans = PLANS, extraSessions = [] } = {}) {
  const repo = tmp('plan-close-loop-repo-');
  const planDir = path.join(repo, 'docs', 'code-plan', 'plans');
  mkdirSync(planDir, { recursive: true });
  for (const [id, text] of Object.entries(plans)) writeFileSync(path.join(planDir, `${id}.md`), text);
  const sessions = [
    ...Object.keys(plans).map((id) => ({ session: `s-${id}`, plan: id, state: 'merged', repo })),
    ...extraSessions.map((s) => ({ repo, ...s })),
  ];
  const registry = path.join(tmp('plan-close-loop-reg-'), 'pr.registry.json');
  writeFileSync(registry, JSON.stringify({ sessions }, null, 2));
  const stateDir = tmp('plan-close-loop-state-');
  const planFile = (id) => path.join(planDir, `${id}.md`);
  return { repo, registry, stateDir, planFile };
}

function cli(fx, args) {
  const r = Bun.spawnSync(['bun', script, ...args], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, VIVERA_CLOSEOUT_STATE: fx.stateDir },
  });
  return { out: r.stdout.toString(), err: r.stderr.toString(), exit: r.exitCode };
}
const due = (fx) => cli(fx, ['--due', '--registry', fx.registry, '--timeout-s', '30']);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const verdictRows = (out) => out.split('\n').filter((l) => /^[A-Z-]+\t/.test(l)).map((l) => l.split('\t').slice(0, 2));

test('due: of three landed plans only the one READY after ticking DONE-task boxes is due, exit 10', () => {
  const fx = fixture();
  const { out, err, exit } = due(fx);
  assert.equal(exit, 10, out + err);
  assert.deepEqual(verdictRows(out).filter(([v]) => v === 'READY'), [['READY', 'ready']]);
  assert.match(out, new RegExp(`^READY\tready\t${fx.repo}\tasserted=1 tickable=1$`, 'm'));
  assert.match(out, /^NOT-READY\tfailing\t/m);
  assert.match(out, /^NOT-READY\tunticked\t/m);
  assert.doesNotMatch(out, /\tdone\t/);
  assert.match(out, /^due: 1 plan\(s\) READY$/m);
});

test('due: no READY plan exits 0', () => {
  const fx = fixture({ plans: { failing: PLANS.failing } });
  const { out, exit } = due(fx);
  assert.equal(exit, 0, out);
  assert.match(out, /^due: 0 plan\(s\) READY$/m);
});

test('due: a kept-open record at the same hash suppresses the plan, an edited plan is listed again', () => {
  const fx = fixture();
  const k = cli(fx, ['--keep-open', 'ready', '--reason', 'waiting on a live check', '--registry', fx.registry]);
  assert.equal(k.exit, 0, k.out + k.err);
  const kept = readJson(path.join(fx.stateDir, 'kept-open.json'));
  assert.equal(kept.ready.reason, 'waiting on a live check');
  assert.match(kept.ready.hash, /^[0-9a-f]{8}$/);
  assert.ok(!Number.isNaN(Date.parse(kept.ready.at)));

  const first = due(fx);
  assert.equal(first.exit, 0, first.out + first.err);
  assert.match(first.out, /^skipped\tready\tkept-open$/m);
  assert.doesNotMatch(first.out, /^READY\t/m);

  writeFileSync(fx.planFile('ready'), PLANS.ready + '\nA note added after the keep-open answer.\n');
  const second = due(fx);
  assert.equal(second.exit, 10, second.out + second.err);
  assert.match(second.out, /^READY\tready\t/m);
});

const priorDue = (fx, openedAt) => writeFileSync(path.join(fx.stateDir, 'due.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  plans: [{ plan: 'ready', repo: fx.repo, file: fx.planFile('ready'), hash: 'deadbeef', verdict: 'READY', asserted: 1, tickable: 1,
    pending_pr: { number: 7, repo: 'owner/repo', opened_at: new Date(openedAt).toISOString() } }],
}));

test('due: a close-out PR younger than 7 days skips the plan, and the record survives the next run', () => {
  const fx = fixture();
  priorDue(fx, Date.now() - DAY);
  for (const run of [1, 2]) {
    const { out, err, exit } = due(fx);
    assert.equal(exit, 0, `run ${run}: ${out}${err}`);
    assert.match(out, /^skipped\tready\tcloseout PR #7 open$/m, `run ${run}`);
  }
  const cache = readJson(path.join(fx.stateDir, 'due.json'));
  const kept = cache.plans.find((p) => p.plan === 'ready');
  assert.equal(kept.pending_pr.number, 7);
  // The session-start note counts READY entries, so a skipped plan must not read as due.
  assert.equal(kept.verdict, 'PR-OPEN');
  assert.match(kept.hash, /^[0-9a-f]{8}$/);
  assert.notEqual(kept.hash, 'deadbeef');
  assert.equal(cache.plans.filter((p) => p.verdict === 'READY').length, 0);
});

test('due: a missing plan file keeps the open close-out PR record', () => {
  const fx = fixture();
  priorDue(fx, Date.now() - DAY);
  rmSync(fx.planFile('ready'));
  due(fx);
  const entry = readJson(path.join(fx.stateDir, 'due.json')).plans.find((p) => p.plan === 'ready');
  assert.equal(entry.verdict, 'NO-FILE');
  assert.equal(entry.pending_pr?.number, 7);
});

test('due: a missing registry exits 2 and leaves due.json alone', () => {
  const fx = fixture();
  priorDue(fx, Date.now() - DAY);
  const before = readFileSync(path.join(fx.stateDir, 'due.json'));
  const { err, exit } = cli(fx, ['--due', '--registry', path.join(fx.stateDir, 'nosuch.json')]);
  assert.equal(exit, 2);
  assert.match(err, /nosuch\.json/);
  assert.ok(readFileSync(path.join(fx.stateDir, 'due.json')).equals(before));
});

test('due: a close-out PR older than 7 days is listed as PR-STALE', () => {
  const fx = fixture();
  priorDue(fx, Date.now() - 8 * DAY);
  const { out, err } = due(fx);
  assert.match(out, /^PR-STALE\tready\t/m, out + err);
  assert.match(out, /^due: 0 plan\(s\) READY$/m);
  const entry = readJson(path.join(fx.stateDir, 'due.json')).plans.find((p) => p.plan === 'ready');
  assert.equal(entry.verdict, 'PR-STALE');
  assert.equal(entry.pending_pr.number, 7);
});

test('due: due.json matches the spec schema', () => {
  const fx = fixture();
  due(fx);
  const cache = readJson(path.join(fx.stateDir, 'due.json'));
  assert.deepEqual(Object.keys(cache).sort(), ['generated_at', 'plans']);
  assert.ok(!Number.isNaN(Date.parse(cache.generated_at)));
  for (const p of cache.plans) {
    assert.deepEqual(Object.keys(p).sort(), ['asserted', 'file', 'hash', 'pending_pr', 'plan', 'repo', 'tickable', 'verdict']);
  }
  assert.equal(cache.plans.filter((p) => p.verdict === 'READY').length, 1);
  const ready = cache.plans.find((p) => p.plan === 'ready');
  assert.deepEqual(ready, {
    plan: 'ready', repo: fx.repo, file: fx.planFile('ready'), hash: ready.hash, verdict: 'READY', asserted: 1, tickable: 1, pending_pr: null,
  });
  assert.match(ready.hash, /^[0-9a-f]{8}$/);
});

test('due: plan files and the registry stay byte-identical', () => {
  const fx = fixture();
  const before = Object.keys(PLANS).map((id) => readFileSync(fx.planFile(id)));
  const reg = readFileSync(fx.registry);
  due(fx);
  Object.keys(PLANS).forEach((id, i) => assert.ok(readFileSync(fx.planFile(id)).equals(before[i]), id));
  assert.ok(readFileSync(fx.registry).equals(reg));
});

test('due: a landed plan whose file is missing is reported as NO-FILE, not fatal', () => {
  const fx = fixture({ extraSessions: [{ session: 's-gone', plan: 'gone', state: 'merged' }] });
  const { out, exit } = due(fx);
  assert.equal(exit, 10, out);
  assert.match(out, /^NO-FILE\tgone\t/m);
});

test('keep-open: an unknown plan exits 2 naming it and writes nothing', () => {
  const fx = fixture();
  const { err, exit } = cli(fx, ['--keep-open', 'ready', 'nosuch', '--reason', 'x', '--registry', fx.registry]);
  assert.equal(exit, 2);
  assert.match(err, /nosuch/);
  assert.equal(existsSync(path.join(fx.stateDir, 'kept-open.json')), false);
});

test('keep-open: a missing --reason is a usage error', () => {
  const fx = fixture();
  assert.equal(cli(fx, ['--keep-open', 'ready', '--registry', fx.registry]).exit, 2);
});

test('state: a corrupt file reads as empty and is copied to .bak before the next write', () => {
  const dir = tmp('plan-close-loop-state-');
  process.env.VIVERA_CLOSEOUT_STATE = dir;
  assert.equal(state.stateDir(), dir);
  assert.deepEqual(state.readKept(), {});
  writeFileSync(path.join(dir, 'kept-open.json'), '{ not json');
  assert.deepEqual(state.readKept(), {});
  state.writeKept({ a: { hash: '00000000', at: 'now', reason: 'r' } });
  assert.equal(readFileSync(path.join(dir, 'kept-open.json.bak'), 'utf8'), '{ not json');
  assert.equal(state.readKept().a.reason, 'r');
  // A good file is not backed up, so the .bak keeps the corrupt copy.
  state.writeKept({});
  assert.equal(readFileSync(path.join(dir, 'kept-open.json.bak'), 'utf8'), '{ not json');
  writeFileSync(path.join(dir, 'due.json'), '[]x');
  assert.deepEqual(state.readDue().plans, []);
});

test('dueList: open boxes of DONE tasks are tickable, not blocking', () => {
  const sessions = [{ session: 's', plan: 'ready', state: 'merged', repo: '/r' }];
  const measure = (text) => [{ id: 'T1', state: 'DONE' }, { id: 'T2', state: 'DONE-ASSERTED' }];
  const r = loop.dueList({ sessions, readPlan: () => ({ file: '/r/p.md', text: PLANS.ready }), measure, kept: {}, prior: {}, now: Date.now() });
  assert.deepEqual(r.plans.map((p) => [p.plan, p.verdict, p.asserted, p.tickable]), [['ready', 'READY', 1, 1]]);
  assert.deepEqual(r.skipped, []);
});
