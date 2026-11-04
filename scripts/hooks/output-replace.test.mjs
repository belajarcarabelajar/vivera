import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.join(import.meta.dir, 'output-replace.mjs');
const ROOT = mkdtempSync(path.join(tmpdir(), 'output-replace-test-'));
const MARKER = /\[\.\.\. (\d+) bytes omitted; full output \((\d+) bytes\) saved at (.+?); read it with Read offset and limit \.\.\.\]/g;

let caseNo = 0;
let dirs;

beforeEach(() => {
  caseNo += 1;
  const base = path.join(ROOT, `case-${caseNo}`);
  dirs = { state: path.join(base, 'state'), scratch: path.join(base, 'scratch') };
  mkdirSync(dirs.state, { recursive: true });
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function run(input, env = {}) {
  const proc = Bun.spawnSync([process.execPath, HOOK], {
    stdin: Buffer.from(JSON.stringify(input)),
    env: {
      ...process.env,
      VIVERA_HOOK_STATE_DIR: dirs.state,
      VIVERA_HOOK_SCRATCH_DIR: dirs.scratch,
      ...env,
    },
  });
  const stdout = proc.stdout.toString();
  return { exitCode: proc.exitCode, stdout, json: stdout.trim() ? JSON.parse(stdout) : null };
}

function bash(stdout, stderr = '', extra = {}) {
  return {
    session_id: 'sess-1',
    tool_use_id: 'toolu_01',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'make' },
    tool_response: { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false, ...extra },
  };
}

function mcp(blocks) {
  return {
    session_id: 'sess-1',
    tool_use_id: 'toolu_02',
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__srv__fetch',
    tool_input: {},
    tool_response: blocks,
  };
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const savedPath = (sid, tid) => path.join(dirs.scratch, 'tool-output', sid, `${tid}.txt`);
const markers = (s) => [...s.matchAll(MARKER)];

describe('output-replace threshold', () => {
  test('4,096 bytes of Bash output pass through untouched', () => {
    const r = run(bash('a'.repeat(4000), 'b'.repeat(96)));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('4,097 bytes of Bash output are replaced with head, marker and tail', () => {
    const out = 'h'.repeat(1024) + 'm'.repeat(2049) + 't'.repeat(1024);
    const r = run(bash(out));
    expect(r.exitCode).toBe(0);
    const value = r.json.hookSpecificOutput.updatedToolOutput;
    expect(value.stdout.startsWith('h'.repeat(1024) + '\n[...')).toBe(true);
    expect(value.stdout.endsWith('...]\n' + 't'.repeat(1024))).toBe(true);
    const [m] = markers(value.stdout);
    expect(Number(m[1])).toBe(2049);
    expect(Number(m[2])).toBe(4097);
    expect(m[3]).toBe(savedPath('sess-1', 'toolu_01'));
  });

  test('a tool other than Bash or MCP is ignored', () => {
    const input = { ...bash('x'.repeat(9000)), tool_name: 'Read' };
    expect(run(input).stdout).toBe('');
  });
});

describe('output-replace Bash shape', () => {
  test('the output has exactly the PostToolUse keys and the four Bash fields', () => {
    const r = run(bash('x'.repeat(5000), 'warn\n'));
    expect(Object.keys(r.json)).toEqual(['hookSpecificOutput']);
    expect(Object.keys(r.json.hookSpecificOutput).sort()).toEqual(['hookEventName', 'updatedToolOutput']);
    expect(r.json.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const value = r.json.hookSpecificOutput.updatedToolOutput;
    expect(Object.keys(value).sort()).toEqual(['interrupted', 'isImage', 'stderr', 'stdout']);
    expect(value.isImage).toBe(false);
    expect(value.interrupted).toBe(false);
    expect(value.stderr).toBe('warn\n');
  });

  test('interrupted true is preserved', () => {
    const r = run(bash('x'.repeat(5000), '', { interrupted: true }));
    expect(r.json.hookSpecificOutput.updatedToolOutput.interrupted).toBe(true);
  });

  test('isImage true is left untouched', () => {
    const r = run(bash('x'.repeat(9000), '', { isImage: true }));
    expect(r.stdout).toBe('');
  });

  test('300 KB of output becomes a replacement under 2,600 bytes', () => {
    const out = 'line of build output\n'.repeat(15000);
    const r = run(bash(out));
    const value = r.json.hookSpecificOutput.updatedToolOutput;
    expect(bytes(value.stdout) + bytes(value.stderr)).toBeLessThan(2600);
    expect(value.stdout.startsWith(out.slice(0, 1024))).toBe(true);
    expect(value.stdout.endsWith(out.slice(-1024))).toBe(true);
    expect(Number(markers(value.stdout)[0][2])).toBe(bytes(out));
  });

  test('a big stderr gets its own head and tail and a small stdout stays as is', () => {
    const err = 'E'.repeat(1024) + 'e'.repeat(8000) + 'Z'.repeat(1024);
    const r = run(bash('ok\n', err));
    const value = r.json.hookSpecificOutput.updatedToolOutput;
    expect(value.stdout).toBe('ok\n');
    expect(value.stderr.startsWith('E'.repeat(1024) + '\n[...')).toBe(true);
    expect(value.stderr.endsWith('Z'.repeat(1024))).toBe(true);
    const [m] = markers(value.stderr);
    expect(Number(m[1])).toBe(8000);
    expect(Number(m[2])).toBe(3 + bytes(err));
  });

  test('when no field alone is over the trigger the marker is appended to stdout once', () => {
    const out = 'o'.repeat(3000);
    const err = 'e'.repeat(3000);
    const r = run(bash(out, err));
    const value = r.json.hookSpecificOutput.updatedToolOutput;
    expect(value.stderr).toBe(err);
    expect(value.stdout.startsWith(out)).toBe(true);
    expect(markers(value.stdout).length).toBe(1);
    expect(markers(value.stderr).length).toBe(0);
    expect(Number(markers(value.stdout)[0][2])).toBe(6000);
  });

  test('a multibyte character is never split at the head or tail cut', () => {
    const out = 'a' + 'é'.repeat(3000) + '中'.repeat(1001);
    const r = run(bash(out));
    const text = r.json.hookSpecificOutput.updatedToolOutput.stdout;
    expect(text.includes('�')).toBe(false);
    const [head, rest] = text.split('\n[...');
    const tail = rest.slice(rest.indexOf('...]\n') + 5);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(bytes(head)).toBeLessThanOrEqual(1024);
    expect(bytes(head)).toBeGreaterThan(1020);
    expect(bytes(tail)).toBeLessThanOrEqual(1024);
    expect(bytes(tail)).toBeGreaterThan(1020);
  });
});

describe('output-replace saved file in the scratch dir', () => {
  test('the scratch file holds the original stdout byte for byte', () => {
    const out = 'first\n' + 'é'.repeat(4000) + '\nlast';
    run(bash(out));
    expect(readFileSync(savedPath('sess-1', 'toolu_01'), 'utf8')).toBe(out);
  });

  test('the scratch file holds stdout, a stderr separator line, then stderr', () => {
    const out = 'o'.repeat(5000) + '\n';
    const err = 'boom\n';
    run(bash(out, err));
    expect(readFileSync(savedPath('sess-1', 'toolu_01'), 'utf8')).toBe(`${out}--- stderr ---\n${err}`);
  });

  test('a save failure leaves the original output alone', () => {
    writeFileSync(path.join(ROOT, `case-${caseNo}`, 'scratch'), 'not a dir');
    const r = run(bash('x'.repeat(9000)));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  for (const [label, sid, tid] of [
    ['a session_id with a slash', 'a/b', 'toolu_01'],
    ['a session_id with dot dot', '..', 'toolu_01'],
    ['an empty session_id', '', 'toolu_01'],
    ['a tool_use_id with dot dot', 'sess-1', '..x'],
    ['a missing tool_use_id', 'sess-1', undefined],
  ]) {
    test(`${label} gives no output and writes nothing`, () => {
      const input = { ...bash('x'.repeat(9000)), session_id: sid, tool_use_id: tid };
      const r = run(input);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
      expect(existsSync(path.join(dirs.scratch, 'tool-output'))).toBe(false);
    });
  }

  test('the kill switch gives no output', () => {
    writeFileSync(path.join(dirs.state, 'context-hooks-off'), '');
    const r = run(bash('x'.repeat(9000)));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('output-replace MCP shape', () => {
  test('big MCP text blocks become one text block and the scratch file joins them with a newline', () => {
    const a = 'A'.repeat(3000);
    const b = 'B'.repeat(3000);
    const r = run(mcp([{ type: 'text', text: a }, { type: 'text', text: b }]));
    const value = r.json.hookSpecificOutput.updatedToolOutput;
    expect(r.json.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(value.length).toBe(1);
    expect(Object.keys(value[0]).sort()).toEqual(['text', 'type']);
    expect(value[0].type).toBe('text');
    expect(value[0].text.startsWith('A'.repeat(1024) + '\n[...')).toBe(true);
    expect(value[0].text.endsWith('B'.repeat(1024))).toBe(true);
    expect(Number(markers(value[0].text)[0][2])).toBe(6001);
    expect(readFileSync(savedPath('sess-1', 'toolu_02'), 'utf8')).toBe(`${a}\n${b}`);
  });

  test('small MCP text passes through untouched', () => {
    expect(run(mcp([{ type: 'text', text: 'x'.repeat(4096) }])).stdout).toBe('');
  });

  test('MCP output with an image block is left untouched', () => {
    const r = run(mcp([
      { type: 'text', text: 'x'.repeat(9000) },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ]));
    expect(r.stdout).toBe('');
  });

  test('an MCP response that is not an array is ignored', () => {
    const input = { ...mcp([]), tool_response: { content: 'x'.repeat(9000) } };
    expect(run(input).stdout).toBe('');
  });
});
