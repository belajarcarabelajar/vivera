import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'eval-run.mjs');
const STREAMS = path.join(HERE, '..', 'evals', 'fixtures', 'streams');

// The stub stands in for the claude binary: the prompt names a recorded stream,
// a leading "/<skill> " (the orchestrator invocation) is dropped before the lookup,
// and a prompt of the form "write:<stream>" also writes a file into the fixture,
// so a test can see both an unchanged and a changed fixture.
const STUB = `#!/bin/sh
log="$EVAL_STUB_LOG"
prompt=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-p" ]; then prompt="$a"; fi
  prev="$a"
done
{
  echo "RUN"
  for a in "$@"; do echo "ARG $a"; done
  echo "ENV memory=$CLAUDE_CODE_DISABLE_AUTO_MEMORY mcp=$ENABLE_CLAUDEAI_MCP_SERVERS"
  echo "SKILL $(ls .claude/skills/sucp-rules/SKILL.md 2>/dev/null)"
  echo "AGENTS $(ls .claude/agents | wc -l)"
  echo "COMMITS $(git log --format=%an:%ae | tr '\\n' ' ')"
} >> "$log"
case "$prompt" in
  /*) prompt="\${prompt#* }" ;;
esac
case "$prompt" in
  write:*) prompt="\${prompt#write:}"; echo hello > greeting.txt ;;
esac
cat "$EVAL_STUB_STREAMS/$prompt.jsonl"
`;

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(scenarios, { mcp = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-'));
  dirs.push(root);
  const scenDir = path.join(root, 'evals', 'scenarios');
  const fixDir = path.join(root, 'evals', 'fixtures', 'tiny');
  fs.mkdirSync(scenDir, { recursive: true });
  fs.mkdirSync(fixDir, { recursive: true });
  fs.writeFileSync(path.join(fixDir, 'math.mjs'), 'export const add = (a, b) => a + b;\n');
  if (mcp) {
    const bad = path.join(root, 'evals', 'fixtures', 'bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, '.mcp.json'), '{}\n');
  }
  for (const s of scenarios) {
    fs.writeFileSync(path.join(scenDir, `${s.id}.json`), JSON.stringify({
      behaviour: `behaviour of ${s.id}`,
      fixture: 'tiny',
      max_turns: 4,
      permission_mode: 'dontAsk',
      budget_usd: 1,
      ...s,
    }));
  }
  const stub = path.join(root, 'claude-stub.sh');
  fs.writeFileSync(stub, STUB, { mode: 0o755 });
  return { root, scenDir, log: path.join(root, 'stub.log'), tmpRoot: path.join(root, 'runs'), stub };
}

function run(ctx, ...args) {
  return runWith(ctx, STREAMS, ...args);
}

function runWith(ctx, streams, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', ctx.scenDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      EVAL_CLAUDE_BIN: ctx.stub,
      EVAL_STUB_LOG: ctx.log,
      EVAL_STUB_STREAMS: streams,
      EVAL_TMP_ROOT: ctx.tmpRoot,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const stubLog = (ctx) => (fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8') : '');
const SUCP = 'super-ultra-code-plan';
const promptArg = (ctx) => stubLog(ctx).match(/^ARG -p\nARG (.*)$/m)?.[1];
const argLines = (...args) => args.map((a) => `ARG ${a}`).join('\n');
const DEFAULT_ALLOWED = 'Read,Edit,Write,Glob,Grep,Agent,Skill,TodoWrite,Bash(bun *),Bash(bunx *),Bash(git status*),Bash(git diff*),'
  + 'Bash(git log*),Bash(git show*),Bash(git add *),Bash(git commit *),Bash(ls*),Bash(cat *),Bash(rg *),Bash(wc *),Bash(head *),Bash(tail *)';
const DISALLOWED = 'Bash(rm *),Bash(git push*),Bash(gh *),Bash(curl *),Bash(wget *)';
const GATE = [{ type: 'fixture_unchanged' }, { type: 'final_options', min: 2 }];

describe('eval-run', () => {
  test('--list prints scenario ids without running anything', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    const r = run(ctx, '--list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('gate-a');
    expect(stubLog(ctx)).toBe('');
  });

  test('a passing scenario exits 0, writes the out file, and removes the fixture', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    const out = path.join(ctx.root, 'out.json');
    const r = run(ctx, '--out', out);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/gate-a\s+PASS/);
    expect(r.out).toContain('1/1 passed');
    expect(r.out).not.toContain('Which greeting');
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.scenarios[0]).toMatchObject({ id: 'gate-a', pass: true, turns: 2 });
    expect(report.scenarios[0].cost).toBeCloseTo(0.130596, 5);
    expect(report.scenarios[0].usage.cache_read_input_tokens).toBe(28960);
    expect(fs.existsSync(path.join(ctx.tmpRoot, report.runId))).toBe(false);
  });

  test('the claude call is isolated, narrowed to safe tools, and sees the branch skills and sprites', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', max_turns: 6, budget_usd: 0.5, assertions: GATE }]);
    expect(run(ctx, '--out', path.join(ctx.root, 'o.json')).code).toBe(0);
    const log = stubLog(ctx);
    expect(log).toContain(argLines(
      '-p', '/super-ultra-code-plan ask', '--output-format', 'stream-json', '--verbose', '--max-turns', '6', '--permission-mode', 'dontAsk',
      '--allowedTools', DEFAULT_ALLOWED, '--disallowedTools', DISALLOWED,
      '--no-session-persistence', '--max-budget-usd', '0.5', '--setting-sources', 'project,local',
    ));
    expect(log).toContain('ENV memory=1 mcp=false');
    expect(log).toContain('SKILL .claude/skills/sucp-rules/SKILL.md');
    expect(log).toMatch(/AGENTS\s+[1-9]/);
    expect(log).toContain('COMMITS eval:eval@local');
  });

  test('a failing scenario exits 1 and names the first failed assertion', () => {
    const ctx = setup([{ id: 'gate-w', prompt: 'write:ask', assertions: GATE }]);
    const r = run(ctx, '--out', path.join(ctx.root, 'o.json'));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/gate-w\s+FAIL\s+fixture_unchanged/);
    expect(r.out).toContain('0/1 passed');
  });

  test('facts reach file assertions', () => {
    const ctx = setup([{
      id: 'write-ok',
      prompt: 'write:skill',
      assertions: [{ type: 'fixture_changed' }, { type: 'file_exists', path: 'greeting.txt' }, { type: 'file_unchanged', path: 'math.mjs' }],
    }]);
    const r = run(ctx, '--out', path.join(ctx.root, 'o.json'));
    expect(r.out).toMatch(/write-ok\s+PASS/);
    expect(r.code).toBe(0);
  });

  test('stops starting scenarios once the total budget is spent', () => {
    const ctx = setup([
      { id: 'a-first', prompt: 'ask', assertions: GATE },
      { id: 'b-second', prompt: 'ask', assertions: GATE },
    ]);
    const r = run(ctx, '--budget-usd', '0.1', '--out', path.join(ctx.root, 'o.json'));
    expect(r.code).toBe(1);
    expect(stubLog(ctx).match(/^RUN$/gm)).toHaveLength(1);
    expect(r.out).toMatch(/b-second\s+SKIP/);
  });

  test('a regression against the baseline exits 1 and an improvement is reported', () => {
    const ctx = setup([
      { id: 'gate-w', prompt: 'write:ask', assertions: GATE },
      { id: 'gate-a', prompt: 'ask', assertions: GATE },
    ]);
    const baseline = path.join(ctx.root, 'base.json');
    fs.writeFileSync(baseline, JSON.stringify({ scenarios: [{ id: 'gate-w', pass: true, invoke: SUCP }, { id: 'gate-a', pass: false, invoke: SUCP }] }));
    const r = run(ctx, '--only', 'gate-w,gate-a', '--baseline', baseline, '--out', path.join(ctx.root, 'o.json'));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/regression: gate-w/i);
    expect(r.out).toMatch(/improvement: gate-a/i);
  });

  test('a fixture holding .mcp.json is refused before claude runs', () => {
    const ctx = setup([{ id: 'risky', prompt: 'ask', fixture: 'bad', assertions: GATE }], { mcp: true });
    const r = run(ctx, '--out', path.join(ctx.root, 'o.json'));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/risky\s+FAIL.*\.mcp\.json/);
    expect(stubLog(ctx)).toBe('');
  });

  test('an overlay that adds .claude/settings.json is refused too', () => {
    const ctx = setup([{ id: 'hooky', prompt: 'ask', overlay: { '.claude/settings.json': '{}' }, assertions: GATE }]);
    const r = run(ctx, '--out', path.join(ctx.root, 'o.json'));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/hooky\s+FAIL.*settings/);
    expect(stubLog(ctx)).toBe('');
  });

  test('a scenario allowed_tools list replaces the default allowed list but not the disallowed one', () => {
    const ctx = setup([{ id: 'narrow', prompt: 'ask', permission_mode: 'plan', allowed_tools: ['Read', 'Grep'], assertions: GATE }]);
    expect(run(ctx, '--out', path.join(ctx.root, 'o.json')).code).toBe(0);
    expect(stubLog(ctx)).toContain(argLines('--permission-mode', 'plan', '--allowedTools', 'Read,Grep', '--disallowedTools', DISALLOWED));
  });

  test('a bypassPermissions scenario is refused with exit 2 before any run', () => {
    const ctx = setup([
      { id: 'a-safe', prompt: 'ask', assertions: GATE },
      { id: 'b-bypass', prompt: 'ask', permission_mode: 'bypassPermissions', assertions: GATE },
    ]);
    const r = run(ctx, '--out', path.join(ctx.root, 'o.json'));
    expect(r.code).toBe(2);
    expect(r.err).toContain('b-bypass.json: permission_mode bypassPermissions is refused');
    expect(stubLog(ctx)).toBe('');
  });

  test('a scenario without permission_mode is refused with exit 2', () => {
    const ctx = setup([{ id: 'unset', prompt: 'ask', permission_mode: undefined, assertions: GATE }]);
    expect(run(ctx, '--out', path.join(ctx.root, 'o.json')).code).toBe(2);
    expect(stubLog(ctx)).toBe('');
  });

  test('denied tool names are recorded and a denied attempt still counts for scoring', () => {
    const ctx = setup([{ id: 'denied', prompt: 'deny', assertions: [{ type: 'bash_never', pattern: 'rm ', scope: 'main' }] }]);
    const streams = path.join(ctx.root, 'streams');
    fs.mkdirSync(streams);
    const command = 'rm -rf planted-target';
    fs.writeFileSync(path.join(streams, 'deny.jsonl'), [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'denied' }] } },
      { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 1 }, result: 'stopped',
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command } }] },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const out = path.join(ctx.root, 'o.json');
    const r = runWith(ctx, streams, '--out', out);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/denied\s+FAIL\s+bash_never/);
    const text = fs.readFileSync(out, 'utf8');
    expect(JSON.parse(text).scenarios[0].permission_denials).toEqual(['Bash']);
    expect(text).not.toContain('planted-target');
  });

  test('a scenario runs through the orchestrator skill by default, and the out file records it', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    const out = path.join(ctx.root, 'o.json');
    expect(run(ctx, '--out', out).code).toBe(0);
    expect(promptArg(ctx)).toBe(`/${SUCP} ask`);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).scenarios[0].invoke).toBe(SUCP);
  });

  test('a scenario invoke names another skill, or false for a bare prompt', () => {
    for (const [invoke, prompt] of [['sucp-rules', '/sucp-rules ask'], [false, 'ask']]) {
      const ctx = setup([{ id: 'gate-a', prompt: 'ask', invoke, assertions: GATE }]);
      expect(run(ctx, '--out', path.join(ctx.root, 'o.json')).code).toBe(0);
      expect(promptArg(ctx)).toBe(prompt);
    }
  });

  test('--no-invoke sends every prompt bare and records invoke false', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', invoke: 'sucp-rules', assertions: GATE }]);
    const out = path.join(ctx.root, 'o.json');
    expect(run(ctx, '--no-invoke', '--out', out).code).toBe(0);
    expect(promptArg(ctx)).toBe('ask');
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).scenarios[0].invoke).toBe(false);
  });

  test('an invoke naming no installed skill is a usage error before any run', () => {
    for (const invoke of ['no-such-skill', '', 3]) {
      const ctx = setup([{ id: 'gate-a', prompt: 'ask', invoke, assertions: GATE }]);
      expect(run(ctx, '--out', path.join(ctx.root, 'o.json')).code).toBe(2);
      expect(stubLog(ctx)).toBe('');
    }
  });

  test('a baseline taken with a different invoke is refused before any run', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    const baseline = path.join(ctx.root, 'base.json');
    // A baseline from before invoke existed carries no field: those runs were bare.
    for (const entry of [{ id: 'gate-a', pass: true, invoke: false }, { id: 'gate-a', pass: true }]) {
      fs.writeFileSync(baseline, JSON.stringify({ scenarios: [entry] }));
      const r = run(ctx, '--baseline', baseline, '--out', path.join(ctx.root, 'o.json'));
      expect([r.code, r.err.includes('invoke')]).toEqual([2, true]);
    }
    expect(stubLog(ctx)).toBe('');
  });

  test('usage errors exit 2', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    expect(run(ctx, '--bogus').code).toBe(2);
    expect(run(ctx, '--only', 'nope').code).toBe(2);
    expect(run(ctx, '--budget-usd', 'lots').code).toBe(2);
  });
});
