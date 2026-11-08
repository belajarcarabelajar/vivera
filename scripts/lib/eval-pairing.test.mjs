import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { advisorUsage, pairingMismatch } from './eval-pairing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'eval-run.mjs');
const ADVISOR_STREAM = path.join(HERE, '..', '..', 'evals', 'fixtures', 'streams', 'advisor.jsonl');
const readStream = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// The shape seen on Claude Code 2.1.319 (plan 2026-11-08-advisor-eval, T1): a server_tool_use block
// named advisor in an assistant message, and the advisor's model as its own modelUsage entry.
describe('advisorUsage', () => {
  test('counts one main-session advisor call and splits cost by model', () => {
    const events = readStream(ADVISOR_STREAM);
    const result = events.find((e) => e.type === 'result');
    expect(advisorUsage(events, result)).toEqual({
      advisor_calls: 1,
      advisor_subagents: 0,
      'cost_usd:claude-sonnet-5-5': 0.0336775,
      'cost_usd:claude-opus-5-5': 0.087584,
    });
  });

  // stream-json forwards only some subagent events, so a subagent's advisor call never shows as a
  // block; the hand-back the parent receives lists the tools the subagent used (seen on 2.1.319).
  test('counts subagents whose hand-back lists the advisor, not advisor blocks of other tools', () => {
    const handBack = (tools) => ({
      type: 'user', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text', text: `  <tools-used-before-summary>${tools}</tools-used-before-summary>\n  report` }] }] },
    });
    const events = [
      handBack('Bash, advisor'),
      handBack('Read, Grep'),
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'server_tool_use', name: 'web_search', input: {} }] } },
    ];
    expect(advisorUsage(events, null)).toEqual({ advisor_calls: 0, advisor_subagents: 1 });
  });

  test('a run without the advisor records zero calls', () => {
    expect(advisorUsage([{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }], { modelUsage: {} })).toEqual({ advisor_calls: 0, advisor_subagents: 0 });
  });
});

describe('pairingMismatch', () => {
  const scenarios = [{ id: 'a' }, { id: 'b' }];

  test('a baseline entry without the fields means the default model and no advisor', () => {
    const baseline = new Map([['a', { model: null, advisor: null }]]);
    expect(pairingMismatch(baseline, scenarios, { model: null, advisor: null })).toBeNull();
    expect(pairingMismatch(baseline, scenarios, { model: 'sonnet', advisor: 'opus' }))
      .toBe('baseline model/advisor differs for 1 scenario(s), first a: baseline default/none, this run sonnet/opus');
  });

  test('matching pairings compare', () => {
    const baseline = new Map([['a', { model: 'sonnet', advisor: 'opus' }], ['b', { model: 'sonnet', advisor: 'opus' }]]);
    expect(pairingMismatch(baseline, scenarios, { model: 'sonnet', advisor: 'opus' })).toBeNull();
  });
});

// CLI: a stub stands in for claude, logs its arguments, and prints the advisor stream.
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync('/tmp/eval-pairing-');
  dirs.push(root);
  const scenDir = path.join(root, 'evals', 'scenarios');
  const fixDir = path.join(root, 'evals', 'fixtures', 'tiny');
  fs.mkdirSync(scenDir, { recursive: true });
  fs.mkdirSync(fixDir, { recursive: true });
  fs.writeFileSync(path.join(fixDir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(scenDir, 'gate-a.json'), JSON.stringify({
    id: 'gate-a', behaviour: 'b', fixture: 'tiny', max_turns: 4, permission_mode: 'dontAsk', invoke: false, prompt: 'ask',
    assertions: [{ type: 'fixture_unchanged' }, { type: 'final_options', min: 2 }],
  }));
  const log = path.join(root, 'stub.log');
  const stub = path.join(root, 'claude-stub.sh');
  fs.writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do echo "ARG $a" >> "${log}"; done\ncat "${ADVISOR_STREAM}"\n`, { mode: 0o755 });
  return { root, scenDir, log, stub };
}

function run(ctx, ...args) {
  const env = { ...process.env, EVAL_CLAUDE_BIN: ctx.stub, EVAL_TMP_ROOT: path.join(ctx.root, 'runs') };
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', ctx.scenDir, '--no-sandbox', '--repeat', '1', ...args], { encoding: 'utf8', env, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const args = (ctx) => (fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8') : '');

describe('eval-run --model and --advisor', () => {
  test('passes both flags to claude and records them with the advisor calls', () => {
    const ctx = setup();
    const out = path.join(ctx.root, 'out.json');
    const r = run(ctx, '--model', 'sonnet', '--advisor', 'opus', '--out', out);
    expect(r.code).toBe(0);
    expect(args(ctx)).toContain('ARG --model\nARG sonnet\n');
    expect(args(ctx)).toContain('ARG --advisor\nARG opus\n');
    const [s] = JSON.parse(fs.readFileSync(out, 'utf8')).scenarios;
    expect(s.model).toBe('sonnet');
    expect(s.advisor).toBe('opus');
    expect(s.usage.advisor_calls).toBe(1);
    expect(s.usage['cost_usd:claude-opus-5-5']).toBeCloseTo(0.087584, 6);
    expect(r.out).toContain('advisor_calls=1');
  });

  test('without the flags claude gets neither and the record says null', () => {
    const ctx = setup();
    const out = path.join(ctx.root, 'out.json');
    expect(run(ctx, '--out', out).code).toBe(0);
    expect(args(ctx)).not.toContain('ARG --model');
    expect(args(ctx)).not.toContain('ARG --advisor');
    const [s] = JSON.parse(fs.readFileSync(out, 'utf8')).scenarios;
    expect(s.model).toBeNull();
    expect(s.advisor).toBeNull();
  });

  test('a flag without a value is a usage error', () => {
    const ctx = setup();
    const r = run(ctx, '--advisor');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--advisor needs a value');
  });

  test('a baseline made with another pairing is refused before any run', () => {
    const ctx = setup();
    const base = path.join(ctx.root, 'base.json');
    fs.writeFileSync(base, JSON.stringify({ scenarios: [{ id: 'gate-a', invoke: false, pass: true }] }));
    const r = run(ctx, '--model', 'sonnet', '--baseline', base);
    expect(r.code).toBe(2);
    expect(r.err).toContain('baseline model/advisor differs');
    expect(args(ctx)).toBe('');
  });
});
