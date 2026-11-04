// scripts/lib/settings-hooks.test.mjs
//
// The library behind every installer that edits a Claude Code settings file.
// Fixtures are literal settings objects and temp files, never ~/.claude.

import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isOwned,
  validateSettings,
  installEntries,
  uninstallEntries,
  hookCommand,
  readSettings,
  writeSettings,
} from './settings-hooks.mjs';

const MARKS = ['/scripts/hooks/output-cap', '/scripts/hooks/state-block'];
const EVENTS = ['PreToolUse', 'PostToolUse'];

const cmd = (command) => ({ type: 'command', command, timeout: 10 });
const capEntry = { matcher: '^Read$', hooks: [cmd('"bun" "/repo/scripts/hooks/output-cap.mjs"')] };
const bashCapEntry = { matcher: '^Bash$', hooks: [cmd('"bun" "/repo/scripts/hooks/output-cap.mjs" --bash')] };
const stateEntry = { hooks: [cmd('"bun" "/repo/scripts/hooks/state-block.mjs"')] };
const foreignEntry = { matcher: 'Bash', hooks: [cmd('python3 /home/u/.claude/hooks/rm-tmp-guard.py')] };

function foreignSettings() {
  return {
    model: 'opus',
    hooks: {
      PreToolUse: [structuredClone(foreignEntry)],
      Stop: [{ hooks: [cmd('/usr/local/bin/notify')] }],
    },
  };
}

const dirs = [];
function tempDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'settings-hooks-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('isOwned', () => {
  test('matches any of several owner marks', () => {
    expect(isOwned(capEntry, MARKS)).toBe(true);
    expect(isOwned(stateEntry, MARKS)).toBe(true);
    expect(isOwned(foreignEntry, MARKS)).toBe(false);
  });

  test('normalises Windows separators in the command', () => {
    const win = { hooks: [cmd('"C:\\bun.exe" "C:\\repo\\scripts\\hooks\\state-block.mjs"')] };
    expect(isOwned(win, MARKS)).toBe(true);
  });

  test('ignores hooks without a string command and entries without hooks', () => {
    expect(isOwned({ hooks: [{ type: 'http', url: 'https://example.com/scripts/hooks/output-cap' }] }, MARKS)).toBe(false);
    expect(isOwned({}, MARKS)).toBe(false);
    expect(isOwned(null, MARKS)).toBe(false);
  });
});

describe('validateSettings', () => {
  test('refuses a non-object, a non-object hooks, and a non-array listed event', () => {
    expect(() => validateSettings([], EVENTS)).toThrow(/not a JSON object/);
    expect(() => validateSettings({ hooks: [] }, EVENTS)).toThrow(/`hooks`/);
    expect(() => validateSettings({ hooks: { PostToolUse: {} } }, EVENTS)).toThrow(/hooks\.PostToolUse/);
  });

  test('leaves events outside the list alone', () => {
    expect(() => validateSettings({ hooks: { Stop: 'odd' } }, EVENTS)).not.toThrow();
    expect(() => validateSettings({}, EVENTS)).not.toThrow();
  });
});

describe('installEntries', () => {
  const fresh = { PreToolUse: [capEntry, bashCapEntry], PostToolUse: [stateEntry] };

  test('appends every fresh entry of an event and keeps foreign entries first', () => {
    const out = installEntries(foreignSettings(), fresh, EVENTS, MARKS);
    expect(out.hooks.PreToolUse).toEqual([foreignEntry, capEntry, bashCapEntry]);
    expect(out.hooks.PostToolUse).toEqual([stateEntry]);
    expect(out.hooks.Stop).toEqual(foreignSettings().hooks.Stop);
    expect(out.model).toBe('opus');
  });

  test('replaces our old entries instead of adding a second set', () => {
    const once = installEntries(foreignSettings(), fresh, EVENTS, MARKS);
    const twice = installEntries(once, fresh, EVENTS, MARKS);
    expect(twice).toEqual(once);
    const moved = { PreToolUse: [cmdEntry('/new/scripts/hooks/output-cap.mjs')], PostToolUse: [stateEntry] };
    expect(installEntries(once, moved, EVENTS, MARKS).hooks.PreToolUse).toEqual([foreignEntry, moved.PreToolUse[0]]);
  });

  test('does not mutate its input or share objects with fresh', () => {
    const input = foreignSettings();
    const out = installEntries(input, fresh, EVENTS, MARKS);
    expect(input).toEqual(foreignSettings());
    out.hooks.PreToolUse[1].matcher = 'changed';
    expect(capEntry.matcher).toBe('^Read$');
  });

  test('refuses a fresh entry no owner mark recognises', () => {
    expect(() => installEntries({}, { PreToolUse: [foreignEntry] }, EVENTS, MARKS)).toThrow(/owner mark/);
  });

  test('refuses malformed settings', () => {
    expect(() => installEntries({ hooks: { PreToolUse: 'x' } }, fresh, EVENTS, MARKS)).toThrow(/hooks\.PreToolUse/);
  });
});

function cmdEntry(file) {
  return { hooks: [cmd(`"bun" "${file}"`)] };
}

describe('an entry mixing a foreign hook with one of ours', () => {
  const guard = cmd('/usr/local/bin/guard.sh');
  const oldCap = cmd('"bun" "/old/scripts/hooks/output-cap.mjs"');
  const mixed = () => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [guard, oldCap] }] } });

  test('install keeps the foreign hook under its matcher and appends the fresh entry', () => {
    const out = installEntries(mixed(), { PreToolUse: [capEntry] }, EVENTS, MARKS);
    expect(out.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [guard] }, capEntry]);
  });

  test('uninstall keeps the foreign hook under its matcher', () => {
    expect(uninstallEntries(mixed(), EVENTS, MARKS)).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [guard] }] } });
  });

  test('an entry holding only our hooks is still removed whole', () => {
    const ours = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [oldCap, cmd('"bun" "/r/scripts/hooks/state-block.mjs"')] }] } };
    expect(uninstallEntries(ours, EVENTS, MARKS)).toEqual({});
    expect(installEntries(ours, { PreToolUse: [capEntry] }, EVENTS, MARKS).hooks.PreToolUse).toEqual([capEntry]);
  });
});

describe('uninstallEntries', () => {
  test('removes only our entries and restores the foreign settings', () => {
    const installed = installEntries(foreignSettings(), { PreToolUse: [capEntry], PostToolUse: [stateEntry] }, EVENTS, MARKS);
    expect(uninstallEntries(installed, EVENTS, MARKS)).toEqual(foreignSettings());
  });

  test('drops the hooks key it emptied, but not a foreign empty list', () => {
    const installed = installEntries({ model: 'x' }, { PreToolUse: [capEntry], PostToolUse: [stateEntry] }, EVENTS, MARKS);
    expect(uninstallEntries(installed, EVENTS, MARKS)).toEqual({ model: 'x' });
    const foreignEmpty = { hooks: { PostToolUse: [] } };
    expect(uninstallEntries(foreignEmpty, EVENTS, MARKS)).toEqual(foreignEmpty);
  });

  test('refuses malformed settings', () => {
    expect(() => uninstallEntries('nope', EVENTS, MARKS)).toThrow(/not a JSON object/);
  });
});

describe('hookCommand', () => {
  test('quotes the runtime and the file, then appends args separated by spaces', () => {
    expect(hookCommand('/usr/bin/bun', '/r/scripts/hooks/x.mjs')).toEqual({
      type: 'command',
      command: '"/usr/bin/bun" "/r/scripts/hooks/x.mjs"',
      timeout: 10,
    });
    expect(hookCommand('/usr/bin/bun', '/r/x.mjs', ['--bash', '--quiet'], 5)).toEqual({
      type: 'command',
      command: '"/usr/bin/bun" "/r/x.mjs" --bash --quiet',
      timeout: 5,
    });
  });
});

describe('readSettings and writeSettings', () => {
  test('a missing file reads as an empty object', () => {
    const target = path.join(tempDir(), 'settings.json');
    expect(readSettings(target)).toEqual({ exists: false, before: null, settings: {} });
  });

  test('an unparsable file throws', () => {
    const target = path.join(tempDir(), 'settings.json');
    writeFileSync(target, '{ "a": 1, }');
    expect(() => readSettings(target)).toThrow();
  });

  test('identical bytes write nothing, so the one generation backup survives', () => {
    const target = path.join(tempDir(), 'settings.json');
    writeFileSync(target, '{}\n');
    writeFileSync(`${target}.bak`, 'older\n');
    const { before } = readSettings(target);
    const mtime = statSync(target).mtimeMs;
    expect(writeSettings(target, '{}\n', before)).toBe(false);
    expect(readFileSync(`${target}.bak`, 'utf8')).toBe('older\n');
    expect(statSync(target).mtimeMs).toBe(mtime);
  });

  test('changed bytes are written with the previous content in .bak', () => {
    const target = path.join(tempDir(), 'settings.json');
    writeFileSync(target, '{}\n');
    expect(writeSettings(target, '{"a":1}\n', '{}\n')).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(`${target}.bak`, 'utf8')).toBe('{}\n');
  });

  test('a missing parent directory is created', () => {
    const target = path.join(tempDir(), 'nested', '.claude', 'settings.json');
    expect(writeSettings(target, '{}\n', null)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.bak`)).toBe(false);
  });
});
