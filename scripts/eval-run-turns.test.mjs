// scripts/eval-run-turns.test.mjs
//
// Multi-turn scenarios through the real runner, with a stub claude: each call is
// logged, the prompt (minus a leading "/<skill> ") names the stream it prints, and
// the prompt "1" also writes a file, so turn 1 can leave the fixture unchanged and
// turn 2 can change it.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.join(import.meta.dir, 'eval-run.mjs');

const STUB = `#!/bin/sh
log="@LOG@"
prompt=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-p" ]; then prompt="$a"; fi
  prev="$a"
done
{ echo "RUN"; for a in "$@"; do echo "ARG $a"; done; echo "IDENT $(git config user.name) <$(git config user.email)>"; } >> "$log"
case "$prompt" in
  /*) prompt="\${prompt#* }" ;;
esac
if [ "$prompt" = "1" ]; then echo hello > greeting.txt; fi
cat "@STREAMS@/$prompt.jsonl"
`;

const result = (final, cost) => JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: cost, usage: { input_tokens: 1 }, result: final });

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(scenarios) {
  const root = fs.mkdtempSync('/tmp/eval-turns-');
  dirs.push(root);
  const scenDir = path.join(root, 'evals', 'scenarios');
  const fixDir = path.join(root, 'evals', 'fixtures', 'tiny');
  const streams = path.join(root, 'streams');
  for (const d of [scenDir, fixDir, streams]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(fixDir, 'math.mjs'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(streams, 'build it.jsonl'), `${result('Design:\n1. Approve\n2. Change', 0.3)}\n`);
  fs.writeFileSync(path.join(streams, '1.jsonl'), `${result('Done. bun test exit 0.', 0.2)}\n`);
  for (const s of scenarios) {
    fs.writeFileSync(path.join(scenDir, `${s.id}.json`), JSON.stringify({
      behaviour: `behaviour of ${s.id}`, fixture: 'tiny', max_turns: 4, permission_mode: 'dontAsk', ...s,
    }));
  }
  const stub = path.join(root, 'claude-stub.sh');
  fs.writeFileSync(stub, STUB.replace('@LOG@', path.join(root, 'stub.log')).replace('@STREAMS@', streams), { mode: 0o755 });
  return { root, scenDir, log: path.join(root, 'stub.log'), stub, out: path.join(root, 'out.json') };
}

function run(ctx, ...args) {
  const env = { ...process.env, EVAL_CLAUDE_BIN: ctx.stub, EVAL_TMP_ROOT: path.join(ctx.root, 'runs') };
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', ctx.scenDir, '--no-sandbox', '--repeat', '1', '--out', ctx.out, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 60_000,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

// The ARG lines of each logged claude call.
const calls = (ctx) => fs.readFileSync(ctx.log, 'utf8').split('RUN\n').filter(Boolean)
  .map((block) => block.split('\n').filter((l) => l.startsWith('ARG ')).map((l) => l.slice(4)));
const after = (args, flag) => args[args.indexOf(flag) + 1];

const TWO_TURNS = {
  id: 'two-turns',
  turns: [
    { prompt: 'build it', assertions: [{ type: 'final_options', min: 2 }, { type: 'fixture_unchanged' }] },
    { prompt: '1', assertions: [{ type: 'fixture_changed' }] },
  ],
  assertions: [{ type: 'gate_count', max: 1 }, { type: 'file_exists', path: 'greeting.txt' }],
};

describe('multi-turn scenarios', () => {
  test('turn 1 starts a session with the invoke, turn 2 resumes it with the bare answer', () => {
    const ctx = setup([TWO_TURNS]);
    const r = run(ctx);
    expect(r.code).toBe(0);
    const [first, second] = calls(ctx);
    expect(calls(ctx)).toHaveLength(2);
    expect(after(first, '-p')).toBe('/super-ultra-code-plan build it');
    expect(after(second, '-p')).toBe('1');
    const id = after(first, '--session-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(after(second, '--resume')).toBe(id);
    expect([...first, ...second]).not.toContain('--no-session-persistence');
  });

  test('per-turn assertions read the files as each turn left them, and costs add up', () => {
    const ctx = setup([TWO_TURNS]);
    expect(run(ctx).code).toBe(0);
    const s = JSON.parse(fs.readFileSync(ctx.out, 'utf8')).scenarios[0];
    expect(s.pass).toBe(true);
    expect(s.results.map((x) => x.type)).toEqual(['gate_count', 'file_exists', 'turn 1: final_options', 'turn 1: fixture_unchanged', 'turn 2: fixture_changed']);
    expect(s.cost).toBeCloseTo(0.5, 6);
  });

  test('the second turn gets the budget the first one left', () => {
    const ctx = setup([TWO_TURNS]);
    run(ctx);
    const [first, second] = calls(ctx);
    expect(Number(after(first, '--max-budget-usd')) - Number(after(second, '--max-budget-usd'))).toBeCloseTo(0.3, 6);
  });

  test('the agent commits as the fixture identity, since the sandbox gives it no git config', () => {
    const ctx = setup([TWO_TURNS]);
    run(ctx);
    expect(fs.readFileSync(ctx.log, 'utf8').match(/^IDENT .*$/gm)).toEqual(['IDENT eval <eval@local>', 'IDENT eval <eval@local>']);
  });

  test('a single-prompt scenario keeps --no-session-persistence and no session id', () => {
    const ctx = setup([{ id: 'one', prompt: 'build it', assertions: [{ type: 'final_options', min: 2 }] }]);
    expect(run(ctx).code).toBe(0);
    const [only] = calls(ctx);
    expect(only).toContain('--no-session-persistence');
    expect(only).not.toContain('--session-id');
  });

  test('a scenario with both prompt and turns, or one turn, is refused', () => {
    for (const bad of [{ ...TWO_TURNS, id: 'both', prompt: 'x' }, { ...TWO_TURNS, id: 'single', turns: [{ prompt: 'build it' }] }]) {
      const ctx = setup([bad]);
      const r = run(ctx);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/prompt or turns|at least two turns/);
    }
  });
});
