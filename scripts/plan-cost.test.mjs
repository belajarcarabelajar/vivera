import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-cost.mjs');
const PLAN = '2026-10-31-a';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const root = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cost-'));
  dirs.push(d);
  return d;
};
const writeJsonl = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};
// Known prices: claude-opus-5 is $5 per million input tokens and $25 per million output tokens.
const MILLION_IN = { input_tokens: 1000000, output_tokens: 0 };
const TENTH_OUT = { input_tokens: 0, output_tokens: 100000 };
const assistant = (id, usage, content = [], model = 'claude-opus-5') => ({
  type: 'assistant', timestamp: '2026-10-31T00:00:00Z', message: { id, model, usage, content },
});
const bash = (command) => ({ type: 'tool_use', id: `tu-${command.length}`, name: 'Bash', input: { command } });
const claim = (plan) => `cd /x && bun scripts/pr-registry.mjs claim --plan ${plan} --branch b`;

const run = (args) => {
  const r = spawnSync('bun', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (projectsRoot, plan = PLAN) => {
  const r = run(['--plan', plan, '--projects-root', projectsRoot, '--json']);
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
};

describe('plan-cost attribution', () => {
  test('a main transcript that ran pr-registry claim for the plan is counted with its USD', () => {
    const pr = root();
    writeJsonl(path.join(pr, '-home-someone-Proyek-vivera', 's1.jsonl'), [
      assistant('m1', MILLION_IN, [bash(claim(PLAN))]),
    ]);
    const r = json(pr);
    expect(r.plan).toBe(PLAN);
    expect(r.mainTranscripts).toBe(1);
    expect(r.subagentRuns).toBe(0);
    expect(r.usd).toBe(5);
    expect(r.estimate).toBe(true);
  });

  test('the --plan=<id> form inside quotes also matches, and pr-registry without .mjs too', () => {
    const pr = root();
    writeJsonl(path.join(pr, '-mnt-disk-vivera-wt-sad-book', 's1.jsonl'), [
      assistant('m1', MILLION_IN, [bash(`bash -lc "pr-registry claim --plan=${PLAN}"`)]),
    ]);
    expect(json(pr).mainTranscripts).toBe(1);
  });

  test('a plan id that is a prefix of the claimed id does not match', () => {
    const pr = root();
    writeJsonl(path.join(pr, '-home-someone-Proyek-vivera', 's1.jsonl'), [
      assistant('m1', MILLION_IN, [bash(claim(`${PLAN}b`))]),
    ]);
    const r = json(pr);
    expect(r.mainTranscripts).toBe(0);
    expect(r.usd).toBeNull();
  });

  test('claim text outside a Bash tool input does not match', () => {
    const pr = root();
    writeJsonl(path.join(pr, '-home-someone-Proyek-vivera', 's1.jsonl'), [
      { type: 'user', message: { role: 'user', content: claim(PLAN) } },
      assistant('m1', MILLION_IN, [{ type: 'text', text: claim(PLAN) }]),
      assistant('m2', MILLION_IN, [{ type: 'tool_use', id: 't1', name: 'Write', input: { command: claim(PLAN) } }]),
    ]);
    expect(json(pr).mainTranscripts).toBe(0);
  });

  test('a claim from a session in an unrelated project dir is counted', () => {
    const pr = root();
    writeJsonl(path.join(pr, '-home-someone-Proyek-other', 's1.jsonl'), [
      assistant('m1', MILLION_IN, [bash(claim(PLAN))]),
    ]);
    const r = json(pr);
    expect(r.mainTranscripts).toBe(1);
    expect(r.usd).toBe(5);
  });

  test('subagent transcripts of a matched session are added', () => {
    const pr = root();
    const dir = path.join(pr, '-home-someone-Proyek-vivera');
    writeJsonl(path.join(dir, 's1.jsonl'), [assistant('m1', MILLION_IN, [bash(claim(PLAN))])]);
    writeJsonl(path.join(dir, 's1', 'subagents', 'agent-abc.jsonl'), [assistant('a1', TENTH_OUT)]);
    // A subagent of an unmatched session stays out.
    writeJsonl(path.join(dir, 's2.jsonl'), [assistant('m9', MILLION_IN)]);
    writeJsonl(path.join(dir, 's2', 'subagents', 'agent-zzz.jsonl'), [assistant('a9', TENTH_OUT)]);
    const r = json(pr);
    expect(r.mainTranscripts).toBe(1);
    expect(r.subagentRuns).toBe(1);
    expect(r.usd).toBe(7.5);
  });

  test('a message id present in two matched transcripts is paid once', () => {
    const pr = root();
    const dir = path.join(pr, '-home-someone-Proyek-vivera');
    writeJsonl(path.join(dir, 's1.jsonl'), [assistant('m1', MILLION_IN, [bash(claim(PLAN))])]);
    writeJsonl(path.join(dir, 's2.jsonl'), [assistant('m1', MILLION_IN, [bash(claim(PLAN))])]);
    const r = json(pr);
    expect(r.mainTranscripts).toBe(2);
    expect(r.usd).toBe(5);
  });

  test('a matched transcript that also claimed another plan counts as shared', () => {
    const pr = root();
    const dir = path.join(pr, '-home-someone-Proyek-vivera');
    writeJsonl(path.join(dir, 's1.jsonl'), [
      assistant('m1', MILLION_IN, [bash(claim(PLAN))]),
      assistant('m2', TENTH_OUT, [bash(claim('2026-10-31-other'))]),
    ]);
    writeJsonl(path.join(dir, 's2.jsonl'), [assistant('m3', MILLION_IN, [bash(claim(PLAN))])]);
    const r = json(pr);
    expect(r.mainTranscripts).toBe(2);
    expect(r.shared).toBe(1);
  });

  test('calls from a model without a price are reported, never counted as zero', () => {
    const pr = root();
    writeJsonl(path.join(pr, '-home-someone-Proyek-vivera', 's1.jsonl'), [
      assistant('m1', MILLION_IN, [bash(claim(PLAN))]),
      assistant('m2', MILLION_IN, [], 'mystery-model'),
    ]);
    const r = json(pr);
    expect(r.usd).toBe(5);
    expect(r.unpricedCalls).toBe(1);
    const t = run(['--plan', PLAN, '--projects-root', pr]);
    expect(t.out).toMatch(/unpriced/);
  });
});

describe('plan-cost output', () => {
  test('text output names the counts, USD to 4 decimals, both estimate caveats, and no command text', () => {
    const pr = root();
    const dir = path.join(pr, '-home-someone-Proyek-vivera');
    writeJsonl(path.join(dir, 's1.jsonl'), [assistant('m1', MILLION_IN, [bash(claim(PLAN))])]);
    writeJsonl(path.join(dir, 's1', 'subagents', 'agent-abc.jsonl'), [assistant('a1', TENTH_OUT)]);
    const r = run(['--plan', PLAN, '--projects-root', pr]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(PLAN);
    expect(r.out).toMatch(/main transcripts\s*:?\s*1/);
    expect(r.out).toMatch(/subagent runs\s*:?\s*1/);
    expect(r.out).toContain('7.5000');
    expect(r.out).toContain('(estimate)');
    expect(r.out).toContain('not counted');
    expect(r.out).toContain('also counted');
    expect(r.out).toMatch(/shared:\s*0/);
    expect(r.out).not.toContain('pr-registry');
  });

  test('no matching transcript prints n/a and exits 0', () => {
    const pr = root();
    const r = run(['--plan', PLAN, '--projects-root', pr]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('n/a');
  });

  test('a missing --plan or an unknown flag is a usage error with exit 2', () => {
    expect(run(['--projects-root', root()]).code).toBe(2);
    expect(run(['--plan', PLAN, '--projects-root', root(), '--repo', '/x']).code).toBe(2);
    expect(run(['--plan', PLAN, '--bogus']).code).toBe(2);
    expect(run(['--plan', '']).code).toBe(2);
  });
});
