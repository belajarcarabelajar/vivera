// scripts/hooks/output-cap.test.mjs
//
// Guards for the PreToolUse hook that denies a full Read of a file over the
// 16,384 byte cap. The hook is spawned the way Claude Code runs it (one JSON
// object on stdin, decision JSON or nothing on stdout) with its state and
// scratch dirs pointed into a temp dir, so the kill switch and error log never
// touch the real ~/.local/state/vivera.

import { test, expect, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.join(import.meta.dir, 'output-cap.mjs');
const CAP = 16384;
const tempDirs = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), `output-cap-${tag}-`)));
  tempDirs.push(d);
  return d;
}

// One temp dir per test: state and scratch dirs live inside it next to the
// files the Read targets.
function fixture(tag) {
  const root = tempDir(tag);
  const stateDir = path.join(root, 'state');
  const scratchDir = path.join(root, 'scratch');
  const work = path.join(root, 'work');
  mkdirSync(work);
  return { root, stateDir, scratchDir, work };
}

function fileOfSize(dir, name, bytes) {
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes, 0x61));
  return file;
}

function runHook(fx, stdin) {
  const r = Bun.spawnSync([process.execPath, HOOK], {
    stdin: Buffer.from(stdin),
    env: { ...process.env, VIVERA_HOOK_STATE_DIR: fx.stateDir, VIVERA_HOOK_SCRATCH_DIR: fx.scratchDir },
  });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function readEvent(cwd, toolInput, toolName = 'Read') {
  return JSON.stringify({
    session_id: 'test-session',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

function expectSilent(r) {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('');
}

function denyReason(r) {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toMatch(/^[^\n]+\n?$/);
  const out = JSON.parse(r.stdout);
  expect(Object.keys(out)).toEqual(['hookSpecificOutput']);
  expect(Object.keys(out.hookSpecificOutput)).toEqual([
    'hookEventName',
    'permissionDecision',
    'permissionDecisionReason',
  ]);
  expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  expect(typeof reason).toBe('string');
  expect(reason).not.toContain(String.fromCodePoint(0x2014));
  return reason;
}

test('a full Read of a 16,385 byte file is denied with the size, the cap, and three bounded alternatives', () => {
  const fx = fixture('over');
  const file = fileOfSize(fx.work, 'big.txt', CAP + 1);
  const reason = denyReason(runHook(fx, readEvent(fx.work, { file_path: file })));
  expect(reason).toBe(
    `${file} is 16385 bytes, over the 16384 byte cap for one full Read. Use one of: ` +
      `Read with offset and limit (for example limit 200); a bounded command such as ` +
      `rg -n '<pattern>' ${file} or sed -n '1,200p' ${file}; wc -c or head first to see its shape.`,
  );
  expect(reason).toContain('16385 bytes');
  expect(reason).toContain('16384');
  expect(reason).toContain('offset and limit');
  expect(reason).toContain('rg -n');
  expect(reason).toContain('wc -c');
});

test('a full Read of a file exactly at the 16,384 byte cap is allowed', () => {
  const fx = fixture('at');
  const file = fileOfSize(fx.work, 'edge.txt', CAP);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file })));
});

test('a Read over the cap with offset set is allowed, including offset 0', () => {
  const fx = fixture('offset');
  const file = fileOfSize(fx.work, 'big.txt', CAP * 4);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file, offset: 100 })));
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file, offset: 0 })));
});

test('a Read over the cap with limit set is allowed', () => {
  const fx = fixture('limit');
  const file = fileOfSize(fx.work, 'big.txt', CAP * 4);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file, limit: 200 })));
});

test('a Read over the cap with pages set is allowed', () => {
  const fx = fixture('pages');
  const file = fileOfSize(fx.work, 'big.txt', CAP * 4);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file, pages: '1-3' })));
});

test('a full Read of a png over the cap is allowed', () => {
  const fx = fixture('png');
  const file = fileOfSize(fx.work, 'big.png', 40 * 1024);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file })));
});

test('a full Read of an uppercase .PNG over the cap is allowed', () => {
  const fx = fixture('png-upper');
  const file = fileOfSize(fx.work, 'SHOT.PNG', 40 * 1024);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file })));
});

test('a full Read of a pdf over the cap is allowed', () => {
  const fx = fixture('pdf');
  const file = fileOfSize(fx.work, 'paper.pdf', CAP * 4);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file })));
});

test('every specially rendered extension over the cap is allowed', () => {
  const fx = fixture('special');
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'pdf', 'ipynb']) {
    const file = fileOfSize(fx.work, `big.${ext}`, CAP + 1);
    expectSilent(runHook(fx, readEvent(fx.work, { file_path: file })));
  }
});

test('a full Read of a .txt over the cap is still denied', () => {
  const fx = fixture('txt');
  const file = fileOfSize(fx.work, 'notes.txt', 40 * 1024);
  expect(denyReason(runHook(fx, readEvent(fx.work, { file_path: file })))).toContain(`${file} is 40960 bytes`);
});

test('a file whose name only ends in png without a dot is still denied', () => {
  const fx = fixture('no-dot');
  const file = fileOfSize(fx.work, 'notapng', CAP + 1);
  denyReason(runHook(fx, readEvent(fx.work, { file_path: file })));
});

test('a Read of a missing file is allowed', () => {
  const fx = fixture('missing');
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: path.join(fx.work, 'nope.txt') })));
});

test('a Read of a directory is allowed even when its stat size is over the cap', () => {
  const fx = fixture('dir');
  const dir = path.join(fx.work, 'sub');
  mkdirSync(dir);
  // An empty directory stats at about 4 KB, under the cap, so it would pass
  // even without the regular-file check; long entry names grow it past 16 KB.
  for (let i = 0; i < 2000 && statSync(dir).size <= CAP; i++) {
    writeFileSync(path.join(dir, `${'entry-name-padding-'.repeat(4)}${i}`), '');
  }
  expect(statSync(dir).size).toBeGreaterThan(CAP);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: dir })));
});

test('a relative file_path over the cap is resolved against the input cwd and denied', () => {
  const fx = fixture('relative');
  const file = fileOfSize(fx.work, 'big.txt', CAP + 1);
  const reason = denyReason(runHook(fx, readEvent(fx.work, { file_path: 'big.txt' })));
  expect(reason.startsWith(`${file} is 16385 bytes`)).toBe(true);
});

test('a tool other than Read is ignored even for a file over the cap', () => {
  const fx = fixture('other-tool');
  const file = fileOfSize(fx.work, 'big.txt', CAP + 1);
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file }, 'Edit')));
  expectSilent(runHook(fx, readEvent(fx.work, { command: `cat ${file}` }, 'Bash')));
});

test('the kill switch file turns the deny off', () => {
  const fx = fixture('kill');
  const file = fileOfSize(fx.work, 'big.txt', CAP + 1);
  mkdirSync(fx.stateDir, { recursive: true });
  writeFileSync(path.join(fx.stateDir, 'context-hooks-off'), '');
  expectSilent(runHook(fx, readEvent(fx.work, { file_path: file })));
});

test('malformed stdin exits 0 and prints nothing', () => {
  const fx = fixture('malformed');
  for (const input of ['', '{not json', 'null', '[]', '42']) expectSilent(runHook(fx, input));
});
