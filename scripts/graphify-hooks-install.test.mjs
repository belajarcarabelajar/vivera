// scripts/graphify-hooks-install.test.mjs
//
// Guards for the installer that adds the graphify hooks to a Claude Code
// settings file. The file it edits is the user's global settings, shared with
// every other tool, so the properties under test are the ones whose failure is
// silent: a second install must not duplicate entries, foreign hooks and keys
// must survive both install and uninstall, and a file it cannot parse must be
// left byte-for-byte alone.
//
// Every test uses a temporary settings file and a temporary hooks directory.
// The CLI runs with HOME pointed at a temp directory, so a broken --settings
// parse can never reach the real ~/.claude.

import { test, expect, describe, beforeAll, afterAll, spyOn } from 'bun:test';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  copyFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MATCHER,
  isOurs,
  installEntries,
  uninstallEntries,
  checkEntries,
  parseArgs,
  main,
} from './graphify-hooks-install.mjs';

const SCRIPT = path.join(import.meta.dir, 'graphify-hooks-install.mjs');
const BUN = '/opt/bun/bin/bun';

const roots = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A temp root with `<root>/scripts/hooks` holding the two stub hook scripts. */
function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'graphify-hooks-install-'));
  roots.push(root);
  const hooksDir = path.join(root, 'scripts', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(path.join(hooksDir, 'graphify-session-start.mjs'), '// stub\n');
  writeFileSync(path.join(hooksDir, 'graphify-search-nudge.mjs'), '// stub\n');
  const home = path.join(root, 'home');
  mkdirSync(home);
  return { root, hooksDir, home, settings: path.join(root, 'settings.json') };
}

/** Settings that already carry a foreign SessionStart and PreToolUse hook. */
function foreignSettings() {
  return {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-start.sh' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard.sh', timeout: 5 }] }],
    },
  };
}

function runAt(script, sb, ...args) {
  const r = Bun.spawnSync([process.execPath, script, ...args], {
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home },
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function run(sb, ...args) {
  return runAt(SCRIPT, sb, ...args);
}

describe('installEntries', () => {
  test('adds the three entries with the documented shape', () => {
    const hooksDir = '/repo/scripts/hooks';
    const out = installEntries({}, hooksDir, BUN);
    const start = { type: 'command', command: `"${BUN}" "${hooksDir}/graphify-session-start.mjs"`, timeout: 10 };
    const nudge = { type: 'command', command: `"${BUN}" "${hooksDir}/graphify-search-nudge.mjs"`, timeout: 10 };
    expect(out.hooks.SessionStart).toEqual([{ hooks: [start] }]);
    expect(out.hooks.SubagentStart).toEqual([{ hooks: [start] }]);
    expect(out.hooks.PreToolUse).toEqual([{ matcher: '^(Grep|Glob|Read|Bash|mcp__graphify__.*)$', hooks: [nudge] }]);
    expect(MATCHER).toBe('^(Grep|Glob|Read|Bash|mcp__graphify__.*)$');
  });

  test('installing twice equals installing once', () => {
    const once = installEntries(foreignSettings(), '/repo/scripts/hooks', BUN);
    const twice = installEntries(once, '/repo/scripts/hooks', BUN);
    expect(twice).toEqual(once);
  });

  test('keeps foreign hooks and every other key, appending ours after them', () => {
    const out = installEntries(foreignSettings(), '/repo/scripts/hooks', BUN);
    expect(out.model).toBe('opus');
    expect(out.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(out.hooks.SessionStart[0]).toEqual(foreignSettings().hooks.SessionStart[0]);
    expect(out.hooks.SessionStart).toHaveLength(2);
    expect(out.hooks.PreToolUse[0]).toEqual(foreignSettings().hooks.PreToolUse[0]);
    expect(out.hooks.PreToolUse).toHaveLength(2);
  });

  test('does not mutate its input', () => {
    const input = foreignSettings();
    installEntries(input, '/repo/scripts/hooks', BUN);
    expect(input).toEqual(foreignSettings());
  });

  test('replaces an entry left by an older install at another path', () => {
    const old = installEntries(foreignSettings(), '/old/checkout/scripts/hooks', BUN);
    const out = installEntries(old, '/repo/scripts/hooks', BUN);
    expect(out).toEqual(installEntries(foreignSettings(), '/repo/scripts/hooks', BUN));
  });

  test('refuses a hooks dir whose commands would not be recognised as ours', () => {
    expect(() => installEntries({}, '/tmp/elsewhere', BUN)).toThrow(/scripts\/hooks/);
  });
});

describe('isOurs', () => {
  test('matches on the scripts/hooks/graphify- path, including Windows separators', () => {
    expect(isOurs({ hooks: [{ command: '"bun" "/a/scripts/hooks/graphify-search-nudge.mjs"' }] })).toBe(true);
    expect(isOurs({ hooks: [{ command: '"C:\\bun.exe" "C:\\a\\scripts\\hooks\\graphify-session-start.mjs"' }] })).toBe(true);
    expect(isOurs({ hooks: [{ command: '/usr/local/bin/graphify-other.sh' }] })).toBe(false);
    expect(isOurs({ hooks: [{ type: 'http', url: 'https://example.com' }] })).toBe(false);
  });
});

describe('uninstallEntries', () => {
  test('removes ours and leaves foreign hooks, so install then uninstall is a round trip', () => {
    const installed = installEntries(foreignSettings(), '/repo/scripts/hooks', BUN);
    expect(uninstallEntries(installed)).toEqual(foreignSettings());
  });

  test('keeps an event key that was already empty before it ran', () => {
    const settings = { hooks: { SubagentStart: [], Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
    expect(uninstallEntries(settings)).toEqual(settings);
  });

  test('drops the hooks key it emptied', () => {
    expect(uninstallEntries(installEntries({ model: 'opus' }, '/repo/scripts/hooks', BUN))).toEqual({ model: 'opus' });
  });
});

describe('checkEntries', () => {
  test('names all three entries before install and nothing after', () => {
    const sb = sandbox();
    const before = checkEntries(foreignSettings(), sb.hooksDir);
    expect(before.ok).toBe(false);
    expect(before.missing.join('\n')).toMatch(/SessionStart/);
    expect(before.missing.join('\n')).toMatch(/SubagentStart/);
    expect(before.missing.join('\n')).toMatch(/PreToolUse/);
    const after = checkEntries(installEntries(foreignSettings(), sb.hooksDir, BUN), sb.hooksDir);
    expect(after).toEqual({ ok: true, missing: [] });
  });

  test('names a missing hook script file', () => {
    const sb = sandbox();
    unlinkSync(path.join(sb.hooksDir, 'graphify-search-nudge.mjs'));
    const r = checkEntries(installEntries({}, sb.hooksDir, BUN), sb.hooksDir);
    expect(r.ok).toBe(false);
    expect(r.missing.join('\n')).toMatch(/graphify-search-nudge\.mjs/);
  });
});

describe('parseArgs', () => {
  // `bun script -- --install` already drops the `--`, so only a direct call
  // reaches this branch; `bun run` wrappers and other launchers may not drop it.
  test('ignores a leading -- argument', () => {
    expect(parseArgs(['--', '--install', '--settings', '/x.json'])).toMatchObject({ mode: 'install', settings: '/x.json' });
  });

  test('rejects two modes at once', () => {
    expect(parseArgs(['--install', '--check']).error).toMatch(/exactly one/);
  });
});

describe('CLI', () => {
  test('--help prints usage and exits 0', () => {
    const r = run(sandbox(), '--help');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--install/);
  });

  test('no mode exits 2 with usage', () => {
    const r = run(sandbox());
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/--install/);
  });

  test('--install writes the entries, keeps foreign hooks, and backs up the old file', () => {
    const sb = sandbox();
    const original = `${JSON.stringify(foreignSettings(), null, 2)}\n`;
    writeFileSync(sb.settings, original);
    const r = run(sb, '--', '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(r.code).toBe(0);
    const text = readFileSync(sb.settings, 'utf8');
    expect(text).toBe(`${JSON.stringify(installEntries(foreignSettings(), sb.hooksDir, process.execPath), null, 2)}\n`);
    expect(readFileSync(`${sb.settings}.bak`, 'utf8')).toBe(original);
  });

  test('--install twice leaves the same file as once', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify(foreignSettings()));
    expect(run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir).code).toBe(0);
    const once = readFileSync(sb.settings, 'utf8');
    expect(run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir).code).toBe(0);
    expect(readFileSync(sb.settings, 'utf8')).toBe(once);
  });

  test('a second install that changes nothing keeps the first backup', () => {
    const sb = sandbox();
    const original = JSON.stringify(foreignSettings());
    writeFileSync(sb.settings, original);
    expect(run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir).code).toBe(0);
    expect(run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir).code).toBe(0);
    expect(readFileSync(`${sb.settings}.bak`, 'utf8')).toBe(original);
  });

  test('--install refuses a hooks dir outside scripts/hooks and writes nothing', () => {
    const sb = sandbox();
    const original = JSON.stringify(foreignSettings());
    writeFileSync(sb.settings, original);
    const r = run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.root);
    expect(r.code).toBe(1);
    expect(readFileSync(sb.settings, 'utf8')).toBe(original);
  });

  test('--check exits 1 naming what is missing before install and 0 after', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify(foreignSettings()));
    const before = run(sb, '--check', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(before.code).toBe(1);
    expect(before.stdout + before.stderr).toMatch(/SubagentStart/);
    expect(run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir).code).toBe(0);
    expect(run(sb, '--check', '--settings', sb.settings, '--hooks-dir', sb.hooksDir).code).toBe(0);
  });

  test('--uninstall removes ours and leaves the foreign hooks', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify(foreignSettings()));
    expect(run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir).code).toBe(0);
    expect(run(sb, '--uninstall', '--settings', sb.settings, '--hooks-dir', sb.hooksDir).code).toBe(0);
    expect(JSON.parse(readFileSync(sb.settings, 'utf8'))).toEqual(foreignSettings());
  });

  test('--dry-run prints the resulting JSON and writes nothing', () => {
    const sb = sandbox();
    const original = JSON.stringify(foreignSettings());
    writeFileSync(sb.settings, original);
    const r = run(sb, '--install', '--dry-run', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(installEntries(foreignSettings(), sb.hooksDir, process.execPath));
    expect(readFileSync(sb.settings, 'utf8')).toBe(original);
    expect(existsSync(`${sb.settings}.bak`)).toBe(false);
  });

  test('refuses a settings file that is not valid JSON and writes nothing', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, '{ "hooks": ');
    const r = run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(r.code).toBe(1);
    expect(readFileSync(sb.settings, 'utf8')).toBe('{ "hooks": ');
    expect(existsSync(`${sb.settings}.bak`)).toBe(false);
  });

  test('refuses a settings file whose hooks is not an object', () => {
    const sb = sandbox();
    const original = JSON.stringify({ hooks: [] });
    writeFileSync(sb.settings, original);
    const r = run(sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(r.code).toBe(1);
    expect(readFileSync(sb.settings, 'utf8')).toBe(original);
  });

  test('a missing settings file: --check exits 1 and --install creates it with its parent dir', () => {
    const sb = sandbox();
    const target = path.join(sb.root, 'fresh', '.claude', 'settings.json');
    expect(run(sb, '--check', '--settings', target, '--hooks-dir', sb.hooksDir).code).toBe(1);
    expect(run(sb, '--install', '--settings', target, '--hooks-dir', sb.hooksDir).code).toBe(0);
    expect(checkEntries(JSON.parse(readFileSync(target, 'utf8')), sb.hooksDir).ok).toBe(true);
  });
});

// Session worktrees are deleted after merge, so a default install from one
// would leave every later Claude Code session pointing at a vanished hooks dir.
describe('linked worktree guard', () => {
  const ISOLATED_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const savedEnv = {};
  let fx;

  function git(cwd, ...args) {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args], {
      env: { ...process.env, ...ISOLATED_ENV },
    });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  }

  /** A main checkout and a `git worktree add` worktree, each with stub hook scripts. */
  function worktreeFixture() {
    // realpath so paths compare equal to what git prints for --show-toplevel.
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'graphify-hooks-worktree-')));
    roots.push(base);
    const mainRoot = path.join(base, 'main');
    const wtRoot = path.join(base, 'wt');
    mkdirSync(mainRoot);
    git(mainRoot, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(mainRoot, 'a.txt'), 'a\n');
    git(mainRoot, 'add', 'a.txt');
    git(mainRoot, 'commit', '-q', '-m', 'init');
    git(mainRoot, 'worktree', 'add', '-q', '-b', 'side', wtRoot);
    for (const root of [mainRoot, wtRoot]) {
      const hooks = path.join(root, 'scripts', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(path.join(hooks, 'graphify-session-start.mjs'), '// stub\n');
      writeFileSync(path.join(hooks, 'graphify-search-nudge.mjs'), '// stub\n');
    }
    // The CLI finds its repository from its own path, so a copy inside the
    // worktree behaves exactly as a checkout of the script there would.
    for (const rel of ['graphify-hooks-install.mjs', 'lib/atomic-write.mjs', 'lib/graphify-status.mjs']) {
      const dest = path.join(wtRoot, 'scripts', rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(import.meta.dir, rel), dest);
    }
    return {
      mainRoot,
      mainScripts: path.join(mainRoot, 'scripts'),
      wtScripts: path.join(wtRoot, 'scripts'),
      wtCli: path.join(wtRoot, 'scripts', 'graphify-hooks-install.mjs'),
    };
  }

  /** Runs main in process with its output captured instead of printed. */
  function callMain(argv, scriptsDir) {
    const out = [];
    const err = [];
    const log = spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    const error = spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    const write = spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    try {
      return { code: main(argv, { scriptsDir }), stdout: out.join('\n'), stderr: err.join('\n') };
    } finally {
      log.mockRestore();
      error.mockRestore();
      write.mockRestore();
    }
  }

  beforeAll(() => {
    for (const [k, v] of Object.entries(ISOLATED_ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    fx = worktreeFixture();
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('CLI: the default hooks dir inside a linked worktree is refused with exit 1 and the settings file unchanged', () => {
    const sb = sandbox();
    const original = JSON.stringify(foreignSettings());
    writeFileSync(sb.settings, original);
    const r = runAt(fx.wtCli, sb, '--install', '--settings', sb.settings);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`main checkout ${fx.mainRoot}`);
    expect(r.stderr).toContain(`\`bun run graphify:hooks --install\` from ${fx.mainRoot}`);
    expect(r.stderr).toContain('--hooks-dir');
    expect(readFileSync(sb.settings, 'utf8')).toBe(original);
    expect(existsSync(`${sb.settings}.bak`)).toBe(false);
  });

  test('the default hooks dir inside a linked worktree is refused without creating a missing settings file', () => {
    const sb = sandbox();
    const target = path.join(sb.root, 'fresh', '.claude', 'settings.json');
    const r = callMain(['--install', '--settings', target], fx.wtScripts);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(fx.mainRoot);
    expect(existsSync(path.join(sb.root, 'fresh'))).toBe(false);
  });

  test('CLI: an explicit --hooks-dir from a linked worktree installs', () => {
    const sb = sandbox();
    const r = runAt(fx.wtCli, sb, '--install', '--settings', sb.settings, '--hooks-dir', sb.hooksDir);
    expect(r.code).toBe(0);
    expect(checkEntries(JSON.parse(readFileSync(sb.settings, 'utf8')), sb.hooksDir).ok).toBe(true);
  });

  test('the main checkout default hooks dir installs, unlike a linked worktree', () => {
    const sb = sandbox();
    const r = callMain(['--install', '--settings', sb.settings], fx.mainScripts);
    expect(r.code).toBe(0);
    const installed = JSON.parse(readFileSync(sb.settings, 'utf8'));
    expect(checkEntries(installed, path.join(fx.mainScripts, 'hooks')).ok).toBe(true);
  });

  test('--install --dry-run with the default hooks dir inside a linked worktree still prints the JSON', () => {
    const sb = sandbox();
    const r = callMain(['--install', '--dry-run', '--settings', sb.settings], fx.wtScripts);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(installEntries({}, path.join(fx.wtScripts, 'hooks'), process.execPath));
    expect(existsSync(sb.settings)).toBe(false);
  });

  test('--uninstall with the default hooks dir inside a linked worktree still removes the entries', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify(installEntries(foreignSettings(), path.join(fx.wtScripts, 'hooks'), BUN)));
    expect(callMain(['--uninstall', '--settings', sb.settings], fx.wtScripts).code).toBe(0);
    expect(JSON.parse(readFileSync(sb.settings, 'utf8'))).toEqual(foreignSettings());
  });

  test('--check with the default hooks dir inside a linked worktree still checks that dir', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify(installEntries({}, path.join(fx.wtScripts, 'hooks'), BUN)));
    expect(callMain(['--check', '--settings', sb.settings], fx.wtScripts).code).toBe(0);
  });
});
