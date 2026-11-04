// scripts/context-hooks-install.test.mjs
//
// The context hooks installer against temp settings files, a temp HOME, and a
// temp --hooks-dir holding stub hook scripts. Never touches ~/.claude.

import { test, expect, describe, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { installEntries, checkEntries, main } from './context-hooks-install.mjs';
import { installEntries as installGraphify, checkEntries as checkGraphify } from './graphify-hooks-install.mjs';

const SCRIPT = path.join(import.meta.dir, 'context-hooks-install.mjs');
const BUN = process.execPath;

const roots = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'context-hooks-install-'));
  roots.push(root);
  const hooksDir = path.join(root, 'scripts', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const f of ['output-cap.mjs', 'output-replace.mjs', 'session-journal.mjs']) writeFileSync(path.join(hooksDir, f), '// stub\n');
  const home = path.join(root, 'home');
  mkdirSync(home);
  return { root, hooksDir, home, settings: path.join(root, 'settings.json') };
}

function run(sb, ...args) {
  const r = Bun.spawnSync([BUN, SCRIPT, ...args], { env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const install = (sb, ...extra) => run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir, ...extra);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** A foreign guard hook plus the graphify entries, as on the owner's machine. */
function foreignSettings() {
  const base = {
    model: 'opus',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard.sh', timeout: 5 }] }] },
  };
  return installGraphify(base, '/main/scripts/hooks', BUN);
}

function expectedHooks(hooksDir) {
  const hook = (file, tail = '') => ({ type: 'command', command: `"${BUN}" "${hooksDir}/${file}"${tail}`, timeout: 10 });
  return {
    PreToolUse: [{ matcher: '^Read$', hooks: [hook('output-cap.mjs')] }],
    PostToolUse: [
      { matcher: '^(Bash|mcp__.*)$', hooks: [hook('output-replace.mjs')] },
      { matcher: '^(Edit|Write|NotebookEdit)$', hooks: [hook('session-journal.mjs', ' record')] },
    ],
    PostToolUseFailure: [{ matcher: '^Bash$', hooks: [hook('session-journal.mjs', ' record')] }],
    SessionStart: [{ matcher: 'compact', hooks: [hook('session-journal.mjs', ' inject')] }],
  };
}

describe('install', () => {
  test('writes the five entries with the documented shape into a new file', () => {
    const sb = sandbox();
    const r = install(sb);
    expect(r.code).toBe(0);
    expect(readJson(sb.settings)).toEqual({ hooks: expectedHooks(sb.hooksDir) });
    expect(existsSync(`${sb.settings}.bak`)).toBe(false);
    expect(Object.values(readJson(sb.settings).hooks).flat()).toHaveLength(5);
  });

  test('reinstall is idempotent: no duplicates, identical bytes, nothing written', () => {
    const sb = sandbox();
    expect(install(sb).code).toBe(0);
    const bytes = readFileSync(sb.settings, 'utf8');
    const mtime = statSync(sb.settings).mtimeMs;
    const r = install(sb);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing written');
    expect(readFileSync(sb.settings, 'utf8')).toBe(bytes);
    expect(statSync(sb.settings).mtimeMs).toBe(mtime);
    expect(existsSync(`${sb.settings}.bak`)).toBe(false);
  });

  test('graphify entries and a foreign hook survive install and uninstall', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, `${JSON.stringify(foreignSettings(), null, 2)}\n`);
    expect(install(sb).code).toBe(0);
    const installed = readJson(sb.settings);
    expect(installed.hooks.PreToolUse[0].hooks[0].command).toBe('/usr/local/bin/guard.sh');
    expect(checkGraphify(installed, '/main/scripts/hooks').missing.filter((m) => !m.startsWith('hook script'))).toEqual([]);
    expect(readJson(`${sb.settings}.bak`)).toEqual(foreignSettings());
    expect(run(sb, '--uninstall', '--settings', sb.settings).code).toBe(0);
    expect(readJson(sb.settings)).toEqual(foreignSettings());
  });

  test('a foreign hook sharing an entry with one of ours survives install and uninstall', () => {
    const sb = sandbox();
    const guard = { type: 'command', command: '/usr/local/bin/guard.sh', timeout: 5 };
    const ours = { type: 'command', command: `"${BUN}" "/old/scripts/hooks/output-replace.mjs"`, timeout: 10 };
    writeFileSync(sb.settings, `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [guard, ours] }] } })}\n`);
    expect(install(sb).code).toBe(0);
    const installed = readJson(sb.settings);
    expect(installed.hooks.PostToolUse).toEqual([{ matcher: 'Bash', hooks: [guard] }, ...expectedHooks(sb.hooksDir).PostToolUse]);
    expect(run(sb, '--uninstall', '--settings', sb.settings).code).toBe(0);
    expect(readJson(sb.settings)).toEqual({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [guard] }] } });
  });

  test('a hooks dir that no owner mark recognises is refused', () => {
    expect(() => installEntries({}, '/tmp/elsewhere', BUN)).toThrow(/owner mark/);
  });
});

describe('malformed settings', () => {
  for (const [name, text] of [
    ['invalid JSON', '{ "hooks": { , }\n'],
    ['a non-array event list', '{ "hooks": { "PostToolUseFailure": {} } }\n'],
    ['a non-object file', '[]\n'],
  ]) {
    test(`${name} is refused with exit 1 and left untouched`, () => {
      const sb = sandbox();
      writeFileSync(sb.settings, text);
      for (const mode of ['--install', '--uninstall']) {
        const r = run(sb, mode, '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('refused');
        expect(readFileSync(sb.settings, 'utf8')).toBe(text);
        expect(existsSync(`${sb.settings}.bak`)).toBe(false);
      }
    });
  }
});

describe('uninstall', () => {
  test('removes only our entries and deletes the keys it emptied', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, '{ "model": "x", "hooks": { "Stop": [] } }\n');
    expect(install(sb).code).toBe(0);
    expect(run(sb, '--uninstall', '--settings', sb.settings).code).toBe(0);
    expect(readJson(sb.settings)).toEqual({ model: 'x', hooks: { Stop: [] } });
  });

  test('a missing settings file is a no-op with exit 0', () => {
    const sb = sandbox();
    const r = run(sb, '--uninstall', '--settings', sb.settings);
    expect(r.code).toBe(0);
    expect(existsSync(sb.settings)).toBe(false);
  });
});

describe('check', () => {
  test('exits 0 after install and 1 with a missing line per entry before it', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, '{}\n');
    const before = run(sb, '--check', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(before.code).toBe(1);
    expect(before.stdout.split('\n').filter((l) => l.startsWith('missing:'))).toHaveLength(5);
    expect(install(sb).code).toBe(0);
    const after = run(sb, '--check', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(after.code).toBe(0);
    expect(after.stdout).toContain('installed');
  });

  test('a wrong mode argument, a wrong matcher, or a missing script fails the check', () => {
    const hooksDir = sandbox().hooksDir;
    const good = installEntries({}, hooksDir, BUN);
    expect(checkEntries(good, hooksDir)).toEqual({ ok: true, missing: [] });

    const wrongMode = structuredClone(good);
    wrongMode.hooks.SessionStart[0].hooks[0].command = wrongMode.hooks.SessionStart[0].hooks[0].command.replace(' inject', ' record');
    expect(checkEntries(wrongMode, hooksDir).missing).toEqual([expect.stringContaining('SessionStart')]);

    const wrongMatcher = structuredClone(good);
    wrongMatcher.hooks.PreToolUse[0].matcher = 'Grep';
    expect(checkEntries(wrongMatcher, hooksDir).missing).toEqual([expect.stringContaining('PreToolUse entry with matcher ^Read$')]);

    unlinkSync(path.join(hooksDir, 'output-replace.mjs'));
    expect(checkEntries(good, hooksDir).missing).toEqual([`hook script ${path.join(hooksDir, 'output-replace.mjs')}`]);
  });

  test('a missing settings file fails the check', () => {
    const sb = sandbox();
    const r = run(sb, '--check', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('missing: settings file');
  });
});

describe('dry run', () => {
  test('prints the result and writes nothing', () => {
    const sb = sandbox();
    const r = install(sb, '--dry-run');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hooks: expectedHooks(sb.hooksDir) });
    expect(existsSync(sb.settings)).toBe(false);
  });
});

describe('usage', () => {
  for (const args of [[], ['--install', '--check'], ['--frobnicate'], ['--install', '--settings'], ['--check', '--hooks-dir', '--dry-run']]) {
    test(`exit 2 for ${JSON.stringify(args)}`, () => {
      const r = run(sandbox(), ...args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('usage:');
    });
  }

  test('-h prints usage with exit 0', () => {
    const r = run(sandbox(), '-h');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--uninstall');
  });
});

describe('linked worktree guard', () => {
  function git(cwd, ...args) {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  }

  function worktreeScripts() {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'context-hooks-worktree-')));
    roots.push(base);
    const mainRoot = path.join(base, 'main');
    mkdirSync(mainRoot);
    git(mainRoot, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(mainRoot, 'a.txt'), 'a\n');
    git(mainRoot, 'add', 'a.txt');
    git(mainRoot, 'commit', '-q', '-m', 'init');
    git(mainRoot, 'worktree', 'add', '-q', '-b', 'side', path.join(base, 'wt'));
    // git -C on a missing directory fails, which the guard reads as not-git.
    const scripts = path.join(base, 'wt', 'scripts');
    mkdirSync(path.join(scripts, 'hooks'), { recursive: true });
    return { base, scripts };
  }

  function quietMain(argv, scriptsDir) {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      return { code: main(argv, { scriptsDir }), stderr: err.mock.calls.flat().join('\n') };
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  }

  test('the default hooks dir inside a linked worktree is refused and the file kept', () => {
    const fx = worktreeScripts();
    const settings = path.join(fx.base, 'settings.json');
    writeFileSync(settings, '{}\n');
    const r = quietMain(['--install', '--settings', settings], fx.scripts);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('linked git worktree');
    expect(readFileSync(settings, 'utf8')).toBe('{}\n');
  });

  test('an explicit --hooks-dir from a linked worktree installs', () => {
    const fx = worktreeScripts();
    const sb = sandbox();
    const r = quietMain(['--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir], fx.scripts);
    expect(r.code).toBe(0);
    expect(checkEntries(readJson(sb.settings), sb.hooksDir).ok).toBe(true);
  });
});
