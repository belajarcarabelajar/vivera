// scripts/closeout-hooks-install.test.mjs
//
// Guards for the installer that adds the close-out SessionStart note to a
// Claude Code settings file shared with every other tool. A second add must
// not duplicate the entry, neighbours (graphify and foreign hooks) must
// survive add and remove, and an unparseable file must be left alone.
//
// Every test uses a temp settings file; CLI spawns also point HOME at a temp
// dir so a broken --settings parse can never reach the real ~/.claude.

import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addEntries, removeEntries, checkEntries, parseArgs } from './closeout-hooks-install.mjs';

const SCRIPT = path.join(import.meta.dir, 'closeout-hooks-install.mjs');
const HOOK = path.join(import.meta.dir, 'hooks', 'closeout-session-start.mjs');
const BUN = '/opt/bun/bin/bun';

const roots = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-hooks-install-'));
  roots.push(root);
  const home = path.join(root, 'home');
  mkdirSync(home);
  return { root, home, settings: path.join(root, 'settings.json') };
}

/** Settings already holding the graphify hooks and a foreign SessionStart hook. */
function neighbours() {
  const g = (script) => ({ type: 'command', command: `"${BUN}" "/v/scripts/hooks/graphify-${script}.mjs"`, timeout: 10 });
  return {
    model: 'opus',
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: '/usr/local/bin/other-start.sh' }] },
        { hooks: [g('session-start')] },
      ],
      SubagentStart: [{ hooks: [g('session-start')] }],
      PreToolUse: [{ matcher: '^(Grep|Glob|Read|Bash|mcp__graphify__.*)$', hooks: [g('search-nudge')] }],
    },
  };
}

function run(sb, ...args) {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home },
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const ours = (file) => ({ type: 'command', command: `"${BUN}" "${file}"`, timeout: 10 });

describe('addEntries', () => {
  test('adds one SessionStart entry and no SubagentStart entry', () => {
    const out = addEntries({}, '/v/scripts/hooks/closeout-session-start.mjs', BUN);
    expect(out).toEqual({ hooks: { SessionStart: [{ hooks: [ours('/v/scripts/hooks/closeout-session-start.mjs')] }] } });
  });

  test('adding twice equals adding once, appended after the neighbours', () => {
    const once = addEntries(neighbours(), '/v/scripts/hooks/closeout-session-start.mjs', BUN);
    expect(addEntries(once, '/v/scripts/hooks/closeout-session-start.mjs', BUN)).toEqual(once);
    expect(once.hooks.SessionStart).toHaveLength(3);
    expect(once.hooks.SessionStart.slice(0, 2)).toEqual(neighbours().hooks.SessionStart);
    expect(once.hooks.SubagentStart).toEqual(neighbours().hooks.SubagentStart);
  });

  test('replaces an entry left at another checkout path', () => {
    const old = addEntries(neighbours(), '/old/scripts/hooks/closeout-session-start.mjs', BUN);
    const out = addEntries(old, '/v/scripts/hooks/closeout-session-start.mjs', BUN);
    expect(out).toEqual(addEntries(neighbours(), '/v/scripts/hooks/closeout-session-start.mjs', BUN));
  });
});

describe('removeEntries', () => {
  test('add then remove is a round trip that keeps graphify and foreign hooks', () => {
    const added = addEntries(neighbours(), '/v/scripts/hooks/closeout-session-start.mjs', BUN);
    expect(removeEntries(added)).toEqual(neighbours());
  });
});

describe('checkEntries', () => {
  test('ok only with a matcherless entry running this hook file that exists', () => {
    expect(checkEntries(addEntries(neighbours(), HOOK, BUN), HOOK).ok).toBe(true);
    expect(checkEntries(neighbours(), HOOK).ok).toBe(false);
    expect(checkEntries(addEntries({}, '/old/scripts/hooks/closeout-session-start.mjs', BUN), HOOK).ok).toBe(false);
    const missingFile = '/nowhere/scripts/hooks/closeout-session-start.mjs';
    expect(checkEntries(addEntries({}, missingFile, BUN), missingFile).ok).toBe(false);
  });
});

describe('parseArgs', () => {
  test('takes exactly one mode and an optional --settings value', () => {
    expect(parseArgs(['--add']).mode).toBe('add');
    expect(parseArgs(['--remove', '--settings', '/x.json'])).toMatchObject({ mode: 'remove', settings: '/x.json' });
    expect(parseArgs(['--add', '--check']).error).toBeDefined();
    expect(parseArgs([]).error).toBeDefined();
    expect(parseArgs(['--settings']).error).toBeDefined();
    expect(parseArgs(['--bogus']).error).toBeDefined();
  });
});

describe('CLI', () => {
  test('--check on a missing settings file exits 1; --add creates it; --check then exits 0', () => {
    const sb = sandbox();
    expect(run(sb, '--check', '--settings', sb.settings).code).toBe(1);
    expect(run(sb, '--add', '--settings', sb.settings).code).toBe(0);
    const written = JSON.parse(readFileSync(sb.settings, 'utf8'));
    expect(written.hooks.SessionStart).toEqual([{ hooks: [{ ...ours(HOOK), command: `"${process.execPath}" "${HOOK}"` }] }]);
    expect(run(sb, '--check', '--settings', sb.settings).code).toBe(0);
  });

  test('--add twice leaves one entry and writes nothing the second time', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify(neighbours()));
    expect(run(sb, '--add', '--settings', sb.settings).code).toBe(0);
    const first = readFileSync(sb.settings, 'utf8');
    const second = run(sb, '--add', '--settings', sb.settings);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('nothing written');
    expect(readFileSync(sb.settings, 'utf8')).toBe(first);
    const own = JSON.parse(first).hooks.SessionStart.filter((e) => JSON.stringify(e).includes('/scripts/hooks/closeout-'));
    expect(own).toHaveLength(1);
  });

  test('--remove keeps the neighbours and --check then exits 1', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify(neighbours()));
    run(sb, '--add', '--settings', sb.settings);
    expect(run(sb, '--remove', '--settings', sb.settings).code).toBe(0);
    expect(JSON.parse(readFileSync(sb.settings, 'utf8'))).toEqual(neighbours());
    expect(run(sb, '--check', '--settings', sb.settings).code).toBe(1);
  });

  test('--remove on a missing settings file exits 0 and creates nothing', () => {
    const sb = sandbox();
    expect(run(sb, '--remove', '--settings', sb.settings).code).toBe(0);
    expect(existsSync(sb.settings)).toBe(false);
  });

  test('an unparseable settings file is left byte-identical and the run exits 1', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, '{"hooks": {,}');
    for (const mode of ['--add', '--remove', '--check']) {
      expect(run(sb, mode, '--settings', sb.settings).code).toBe(1);
      expect(readFileSync(sb.settings, 'utf8')).toBe('{"hooks": {,}');
    }
  });

  test('a bad argument exits 2 and touches nothing', () => {
    const sb = sandbox();
    expect(run(sb, '--add', '--remove', '--settings', sb.settings).code).toBe(2);
    expect(existsSync(sb.settings)).toBe(false);
    expect(existsSync(path.join(sb.home, '.claude'))).toBe(false);
  });
});
