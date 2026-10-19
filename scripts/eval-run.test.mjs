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
// so a test can see both an unchanged and a changed fixture. The runner scrubs the
// child env, so the stub's own paths are baked in by setup instead of passed as env.
const STUB = `#!/bin/sh
log="@LOG@"
prompt=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-p" ]; then prompt="$a"; fi
  prev="$a"
done
{
  echo "RUN"
  echo "CWD $(pwd)"
  for a in "$@"; do echo "ARG $a"; done
  echo "ENV memory=$CLAUDE_CODE_DISABLE_AUTO_MEMORY mcp=$ENABLE_CLAUDEAI_MCP_SERVERS"
  echo "TMPDIR $TMPDIR"
  env | cut -d= -f1 | sort | sed 's/^/ENVKEY /'
  echo "SKILL $(ls .claude/skills/sucp-rules/SKILL.md 2>/dev/null)"
  echo "AGENTS $(ls .claude/agents | wc -l)"
  echo "COMMITS $(git log --format=%an:%ae | tr '\\n' ' ')"
} >> "$log"
case "$prompt" in
  /*) prompt="\${prompt#* }" ;;
esac
case "$prompt" in
  hang) sleep 60 & echo $! > "$log.grandchild"; sleep 60; exit 0 ;;
  write:*) prompt="\${prompt#write:}"; echo hello > greeting.txt ;;
esac
cat "@STREAMS@/$prompt.jsonl"
`;

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(scenarios, { mcp = false } = {}) {
  // Outside $HOME on purpose: the runner refuses a scratch root under it (home rules leak in).
  const root = fs.mkdtempSync('/tmp/eval-run-');
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
  const streams = path.join(root, 'streams');
  fs.cpSync(STREAMS, streams, { recursive: true });
  fs.writeFileSync(stub, STUB.replace('@LOG@', path.join(root, 'stub.log')).replace('@STREAMS@', streams), { mode: 0o755 });
  return { root, scenDir, log: path.join(root, 'stub.log'), tmpRoot: path.join(root, 'runs'), stub };
}

function run(ctx, ...args) {
  const env = { ...process.env, EVAL_CLAUDE_BIN: ctx.stub, EVAL_TMP_ROOT: ctx.tmpRoot, ...ctx.env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  // The real sandbox hides /tmp, where the stub lives; sandbox tests use a fake bwrap instead.
  const sandbox = ctx.sandbox ? [] : ['--no-sandbox'];
  const r = spawnSync(process.execPath, [SCRIPT, '--scenarios', ctx.scenDir, ...sandbox, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const stubLog = (ctx) => (fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8') : '');
const SUCP = 'super-ultra-code-plan';
const promptArg = (ctx) => stubLog(ctx).match(/^ARG -p\nARG (.*)$/m)?.[1];
const argLines = (...args) => args.map((a) => `ARG ${a}`).join('\n');
const DEFAULT_ALLOWED = 'Read,Edit,Write,Glob,Grep,Agent,Skill,TodoWrite,Bash(bun test*),Bash(bun add *),Bash(bun install*),'
  + 'Bash(bun run test*),Bash(git status*),Bash(git diff*),'
  + 'Bash(git log*),Bash(git show*),Bash(git add *),Bash(git commit *),Bash(git switch *),Bash(git checkout -b *),Bash(git branch*),'
  + 'Bash(git rev-parse*),Bash(ls*),Bash(cat *),Bash(rg *),Bash(wc *),Bash(head *),Bash(tail *),'
  + 'Bash(echo *),Bash(printf *),Bash(sed -n *),Bash(grep *),Bash(pwd*),Bash(which *),Bash(bun --version*)';
const DISALLOWED = 'Bash(rm *),Bash(git push*),Bash(git -C * push*),Bash(gh *),Bash(curl *),Bash(wget *)';
const cwdOf = (ctx) => stubLog(ctx).match(/^CWD (.*)$/m)?.[1];
// A killed process may linger as a zombie until its new parent reaps it; that counts as gone.
const gone = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] === 'Z';
  } catch {
    return true;
  }
};
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
    // budget_usd is accepted and ignored: a per-scenario figure the model can see changes its behaviour.
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', max_turns: 6, budget_usd: 0.5, assertions: GATE }]);
    expect(run(ctx, '--out', path.join(ctx.root, 'o.json')).code).toBe(0);
    const log = stubLog(ctx);
    expect(log).toContain(argLines(
      '-p', '/super-ultra-code-plan ask', '--output-format', 'stream-json', '--verbose', '--max-turns', '6', '--permission-mode', 'dontAsk',
      '--allowedTools', [DEFAULT_ALLOWED, ...['add', 'commit', 'status', 'diff', 'log', 'show', 'switch', 'branch', 'rev-parse']
        .map((sub) => `Bash(git -C ${cwdOf(ctx)} ${sub}*)`)].join(','), '--disallowedTools', DISALLOWED,
      '--no-session-persistence', '--max-budget-usd', '2.00', '--setting-sources', 'project,local',
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
    expect(stubLog(ctx)).toContain(argLines('--max-budget-usd', '0.10'));
  });

  test('a run past the timeout is killed with its whole process group', async () => {
    const ctx = setup([{ id: 'hung', prompt: 'hang', assertions: GATE }]);
    ctx.env = { EVAL_SCENARIO_TIMEOUT_S: '1' };
    const r = run(ctx, '--out', path.join(ctx.root, 'o.json'));
    const pid = Number(fs.readFileSync(`${ctx.log}.grandchild`, 'utf8'));
    for (let i = 0; i < 20 && !gone(pid); i++) await Bun.sleep(100);
    expect([r.code, gone(pid)]).toEqual([1, true]);
    expect(r.out).toMatch(/hung\s+FAIL\s+run: timed out after 1 s/);
  });

  test('a killed run with no result event records cost null and is charged its ceiling', () => {
    const ctx = setup([{ id: 'a-hung', prompt: 'hang', assertions: GATE }, { id: 'b-next', prompt: 'ask', assertions: GATE }]);
    ctx.env = { EVAL_SCENARIO_TIMEOUT_S: '1' };
    const out = path.join(ctx.root, 'o.json');
    run(ctx, '--budget-usd', '2.5', '--out', out);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).scenarios[0]).toMatchObject({ id: 'a-hung', cost: null, timed_out: true });
    expect(stubLog(ctx)).toContain(argLines('--max-budget-usd', '0.50'));
  });

  test('each fixture sits at a neutral numbered path that never names the scenario', () => {
    const ctx = setup([{ id: 'git-secret-probe', prompt: 'ask', assertions: GATE }]);
    const r = run(ctx, '--keep', '--out', path.join(ctx.root, 'o.json'));
    const cwd = cwdOf(ctx);
    expect([r.code, cwd.endsWith(`${path.sep}01${path.sep}project`), cwd.includes('git-secret-probe')]).toEqual([0, true, false]);
    expect(r.out).toMatch(/git-secret-probe\s+PASS.*fixture=\S*01\/project/);
  });

  test('a scenario without budget_usd runs under the ceiling', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', budget_usd: undefined, assertions: GATE }]);
    expect(run(ctx, '--budget-usd', '1.5', '--out', path.join(ctx.root, 'o.json')).code).toBe(0);
    expect(stubLog(ctx)).toContain(argLines('--max-budget-usd', '1.50'));
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
    const command = 'rm -rf planted-target';
    fs.writeFileSync(path.join(streams, 'deny.jsonl'), [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'denied' }] } },
      { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 1 }, result: 'stopped',
        permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command } }] },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const out = path.join(ctx.root, 'o.json');
    const r = run(ctx, '--out', out);
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

  test('--keep writes the raw stream beside the kept fixture and prints its path; without it nothing is written', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    const out = path.join(ctx.root, 'o.json');
    const r = run(ctx, '--keep', '--out', out);
    const file = path.join(ctx.tmpRoot, JSON.parse(fs.readFileSync(out, 'utf8')).runId, 'gate-a.stream.jsonl');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/gate-a\s+PASS.*stream=\S*gate-a\.stream\.jsonl/);
    expect(fs.readFileSync(file, 'utf8')).toBe(fs.readFileSync(path.join(STREAMS, 'ask.jsonl'), 'utf8'));
    expect(fs.existsSync(path.join(path.dirname(file), 'gate-a', 'gate-a.stream.jsonl'))).toBe(false);
    const bare = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    const rb = run(bare, '--out', path.join(bare.root, 'o.json'));
    expect([rb.code, rb.out.includes('stream='), fs.existsSync(bare.tmpRoot) && fs.readdirSync(bare.tmpRoot).length]).toEqual([0, false, 0]);
  });

  test('the claude child gets a scrubbed env with TMPDIR at the scratch root', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    ctx.env = { TINYFISH_API_KEY: 'x', CLOUDFLARE_API_TOKEN: 'x', GITHUB_TOKEN: 'x', SOME_SECRET: 'x', LANG: 'C.UTF-8' };
    expect(run(ctx, '--out', path.join(ctx.root, 'o.json')).code).toBe(0);
    const keys = [...stubLog(ctx).matchAll(/^ENVKEY (.*)$/gm)].map((m) => m[1]);
    const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR', 'XDG_RUNTIME_DIR',
      'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'PWD', 'SHLVL', '_', 'OLDPWD'];
    expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
    expect(keys).toContain('LANG');
    expect(stubLog(ctx)).toContain(`TMPDIR ${ctx.tmpRoot}\n`);
  });

  test('a scratch root inside the home directory is refused before any run, and the default sits in /tmp', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    ctx.tmpRoot = path.join(os.homedir(), '.cache', 'tmp', `eval-run-refused-${process.pid}-${Date.now()}`);
    const r = run(ctx, '--out', path.join(ctx.root, 'o.json'));
    expect({ code: r.code, home: r.err.includes('home'), log: stubLog(ctx), made: fs.existsSync(ctx.tmpRoot) }).toEqual({ code: 2, home: true, log: '', made: false });
    ctx.tmpRoot = undefined;
    expect(run(ctx, '--out', path.join(ctx.root, 'o.json')).code).toBe(0);
    expect(cwdOf(ctx).startsWith('/tmp/vivera-eval/')).toBe(true);
  });

  test('usage errors exit 2', () => {
    const ctx = setup([{ id: 'gate-a', prompt: 'ask', assertions: GATE }]);
    expect(run(ctx, '--bogus').code).toBe(2);
    expect(run(ctx, '--only', 'nope').code).toBe(2);
    expect(run(ctx, '--budget-usd', 'lots').code).toBe(2);
  });
});
