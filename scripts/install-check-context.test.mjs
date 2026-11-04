// scripts/install-check-context.test.mjs
//
// The machine rows of `install.sh --check` (hooks-path, bun-version) and the `[draft]`
// issue command printed on a problem. The rows never change a count or the exit code; the link rows
// are covered by install-check.test.mjs. Every run uses the sandbox from scripts/lib/install-sandbox.mjs.

import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const CONTEXT_ROW = /^\[[a-z]+\] (hooks-path|bun-version): /;

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox(tools = ['git', 'bun']) {
  const sb = makeSandbox({ tools });
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const rowsOf = (r, name) => r.stdout.split('\n').filter((l) => l.match(CONTEXT_ROW)?.[1] === name);
const tagsOf = (r, name) => rowsOf(r, name).map((l) => l.match(/^\[([a-z]+)\]/)[1]);
const draftLines = (r) => r.stdout.split('\n').filter((l) => l.startsWith('[draft]'));
const sandboxBunVersion = (sb) => Bun.spawnSync([path.join(sb.bin, 'bun'), '--version']).stdout.toString().trim();

function setPackageManager(sb, value) {
  const file = path.join(sb.repo, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.packageManager = value;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// The commands the removed context hooks used to install.
const OLD_HOOK_COMMANDS = {
  PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: '/b/bun /r/scripts/hooks/output-cap.mjs' }] }],
  PostToolUse: [
    { matcher: 'Bash|mcp__.*', hooks: [{ type: 'command', command: '/b/bun /r/scripts/hooks/output-replace.mjs' }] },
    { matcher: 'Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: '/b/bun /r/scripts/hooks/session-journal.mjs record' }] },
  ],
};

test('context rows: hooks-path is [ok] in a vivera git checkout with core.hooksPath .githooks, [warn] without it, and the exit code stays 0', () => {
  const sb = makeSandbox({ tools: ['git', 'bun'], git: true });
  open.push(sb);
  expect(sb.run([]).status).toBe(0);
  const set = sb.run(['--check']);
  expect(set.status).toBe(0);
  expect(set.stdout).toContain('check: CURRENT');
  expect(tagsOf(set, 'hooks-path')).toEqual(['ok']);

  const gitEnv = { HOME: sb.home, PATH: path.dirname(Bun.which('git')), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  expect(Bun.spawnSync([Bun.which('git'), 'config', '--unset', 'core.hooksPath'], { cwd: sb.repo, env: gitEnv }).exitCode).toBe(0);
  const unset = sb.run(['--check']);
  expect(unset.status).toBe(0);
  expect(unset.stdout).toContain('check: CURRENT');
  expect(tagsOf(unset, 'hooks-path')).toEqual(['warn']);
  expect(rowsOf(unset, 'hooks-path')[0]).toContain('.githooks');
  expect(draftLines(unset)).toEqual([]);
});

test('context rows: hooks-path is [skip] when the checkout is not a git repository of its own', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  const r = sb.run(['--check']);
  expect(r.status).toBe(0);
  expect(tagsOf(r, 'hooks-path')).toEqual(['skip']);
});

test('context rows: bun-version is [ok] when the installed bun matches packageManager and [warn] when it does not, with the same exit code', () => {
  const sb = sandbox();
  const version = sandboxBunVersion(sb);
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  setPackageManager(sb, `bun@${version}`);
  expect(sb.run([]).status).toBe(0);
  const same = sb.run(['--check']);
  expect(same.status).toBe(0);
  expect(tagsOf(same, 'bun-version')).toEqual(['ok']);

  setPackageManager(sb, 'bun@0.0.1');
  const other = sb.run(['--check']);
  expect(other.status).toBe(0);
  expect(other.stdout).toContain('check: CURRENT');
  expect(tagsOf(other, 'bun-version')).toEqual(['warn']);
  expect(rowsOf(other, 'bun-version')[0]).toContain(version);
  expect(rowsOf(other, 'bun-version')[0]).toContain('bun@0.0.1');
});

test('context rows: with no bun and no git every machine row is [skip] and the check stays CURRENT', () => {
  const sb = sandbox([]);
  expect(sb.run(['--tier', 'minimal']).status).toBe(0);
  const r = sb.run(['--check', '--tier', 'minimal']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('check: CURRENT');
  expect(tagsOf(r, 'hooks-path')).toEqual(['skip']);
  expect(tagsOf(r, 'bun-version')).toEqual(['skip']);
});

test('no context-hooks row', () => {
  const withBun = sandbox();
  // A settings file naming the old hooks must not bring the row back either. It goes in before the
  // install because ~/.claude makes Claude Code a detected target.
  fs.mkdirSync(at(withBun, '.claude'), { recursive: true });
  fs.writeFileSync(at(withBun, '.claude/settings.json'), JSON.stringify({ hooks: OLD_HOOK_COMMANDS }));
  expect(withBun.run([]).status).toBe(0);
  const r = withBun.run(['--check']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('check: CURRENT');
  expect(tagsOf(r, 'bun-version').length).toBe(1);
  expect(r.stdout.split('\n').filter((l) => l.includes('context-hooks'))).toEqual([]);

  const noBun = sandbox([]);
  expect(noBun.run(['--tier', 'minimal']).status).toBe(0);
  const bare = noBun.run(['--check', '--tier', 'minimal']);
  expect(bare.status).toBe(0);
  expect(tagsOf(bare, 'bun-version')).toEqual(['skip']);
  expect(bare.stdout.split('\n').filter((l) => l.includes('context-hooks'))).toEqual([]);
});

test('context rows: a problem prints a [draft] gh issue create command that install.sh never runs, and the command is ready to paste', () => {
  const sb = sandbox();
  const marker = path.join(sb.root, 'gh-args');
  fs.writeFileSync(path.join(sb.bin, 'gh'), `#!/bin/sh\nprintf '%s\\0' "$@" > '${marker}'\n`, { mode: 0o755 });
  const r = sb.run(['--check']);
  expect(r.status).toBe(1);
  const problems = Number(r.stdout.match(/^check: (\d+) problem\(s\)$/m)[1]);
  expect(problems).toBeGreaterThan(5);
  expect(fs.existsSync(marker)).toBe(false);

  const command = draftLines(r).find((l) => l.startsWith('[draft] gh issue create '));
  expect(command).toBeDefined();
  expect(command).not.toContain(sb.home);
  // Control: the drafted line, run by hand against the fake gh, reaches it with the expected arguments.
  const ran = Bun.spawnSync(['/usr/bin/env', '-i', `PATH=${sb.bin}`, Bun.which('bash'), '-c', command.slice('[draft] '.length)]);
  expect(ran.exitCode).toBe(0);
  const args = fs.readFileSync(marker, 'utf8').split('\0').slice(0, -1);
  expect(args.slice(0, 6)).toEqual(['issue', 'create', '--repo', 'belajarcarabelajar/vivera', '--title', `install check: ${problems} problem(s)`]);
  expect(args[6]).toBe('--body');
  const body = args[7];
  const uname = Bun.spawnSync([Bun.which('uname'), '-s']).stdout.toString().trim();
  expect(body).toContain(`OS: ${uname}`);
  expect(body).toContain(`bun: ${sandboxBunVersion(sb)}`);
  expect(body).toMatch(/^harnesses detected: ai-config agents/m);
  expect(body).toContain('[missing] ~/.agents/skills/super-ultra-code-plan/SKILL.md');
  expect(body).not.toContain(sb.home);
  // The draft sits after the rows and before the verdict.
  const lines = r.stdout.split('\n');
  expect(lines.indexOf(command)).toBeLessThan(lines.findIndex((l) => l.startsWith('check: ')));
});

test('context rows: a CURRENT check prints no [draft] lines', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  const r = sb.run(['--check']);
  expect(r.status).toBe(0);
  expect(draftLines(r)).toEqual([]);
});
