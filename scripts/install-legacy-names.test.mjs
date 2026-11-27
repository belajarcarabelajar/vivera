// scripts/install-legacy-names.test.mjs
//
// The skills were renamed on 2026-11-26 (super-ultra-code-plan and sucp-* became vivera and vivera-*, and
// the master file "Super Ultra Code Plan Implementation.md" became VIVERA.md). An install made under the old
// names must not stay orphaned: --check reports each of the installer's own old entries as [stale], --update
// and --uninstall remove them, and anything of the user's under an old name stays. Driven through install.sh
// (and install.ps1 when PowerShell is present), never through internal functions.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const OLD_PACKAGE = 'super-ultra-code-plan';
const OLD_MASTER = 'Super Ultra Code Plan Implementation.md';
// Old phase name -> the new one, as renamed in commit a49bdba.
const OLD_PHASES = {
  'sucp-rules': 'vivera-rules',
  'sucp-brainstorm': 'vivera-brainstorm',
  'sucp-plan': 'vivera-plan',
  'sucp-overnight': 'vivera-overnight',
  'sucp-tdd-debug': 'vivera-tdd',
  'sucp-verify-deliver': 'vivera-ship',
  'sucp-debt-sweep': 'vivera-sweep',
};
const OLD_NAMES = [OLD_PACKAGE, ...Object.keys(OLD_PHASES)];
// The non-failing line --check prints, after the path, for an edited copy --update keeps under an old name.
const KEPT_WARN = '(an edited copy under the old name; kept, delete it when you no longer need it)';
const CLAUDE = '.claude/skills';
const AGENTS = '.agents/skills';
const AI = '.config/ai';
const ONLY = ['--only', 'ai-config,agents,claude'];
const PACKAGE_LINKS = {
  'SKILL.md': OLD_MASTER,
  templates: 'templates',
  examples: 'examples',
  'mermaid.config.json': 'mermaid.config.json',
  'mermaid.dark.config.json': 'mermaid.dark.config.json',
  'require-exit-code.mjs': '.claude/hooks/require-exit-code.mjs',
  'require-progress-meter.mjs': '.claude/hooks/require-progress-meter.mjs',
};

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

// cmp and diff are on PATH because copy mode compares content with them.
function sandbox() {
  const sb = makeSandbox({ tools: ['git', 'bun'] });
  open.push(sb);
  for (const tool of ['cmp', 'diff']) fs.symlinkSync(Bun.which(tool), path.join(sb.bin, tool));
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const lstat = (sb, rel) => fs.lstatSync(at(sb, rel), { throwIfNoEntry: false });
const exists = (sb, rel) => lstat(sb, rel) !== undefined;
const write = (sb, rel, text) => {
  fs.mkdirSync(path.dirname(at(sb, rel)), { recursive: true });
  fs.writeFileSync(at(sb, rel), text);
};
const link = (sb, target, rel) => {
  fs.mkdirSync(path.dirname(at(sb, rel)), { recursive: true });
  fs.symlinkSync(target, at(sb, rel));
};
const oldEntries = (sb, dir) => (fs.existsSync(at(sb, dir)) ? fs.readdirSync(at(sb, dir)).filter((n) => OLD_NAMES.includes(n) || n === OLD_MASTER).sort() : []);

// The shapes an install made before the rename left on this machine, all pointing at the old paths of the
// checkout (dangling now), plus a skill of the user's own whose name only starts like an old one.
//   a) ~/.claude/skills/sucp-*: directory symlinks into the checkout
//   b) <skills>/super-ultra-code-plan/: a real directory of per-file links (some still resolve), no marker
//   c) ~/.agents/skills/sucp-*: real directories holding SKILL.md and references links, no marker
//   d) ~/.config/ai/<old master>: a file link into the checkout
function legacyLinks(sb) {
  const repo = sb.repo;
  for (const old of Object.keys(OLD_PHASES)) {
    link(sb, path.join(repo, 'skills', old), `${CLAUDE}/${old}`);
    link(sb, path.join(repo, 'skills', old, 'SKILL.md'), `${AGENTS}/${old}/SKILL.md`);
    link(sb, path.join(repo, 'skills', old, 'references'), `${AGENTS}/${old}/references`);
  }
  for (const base of [CLAUDE, AGENTS]) {
    for (const [name, target] of Object.entries(PACKAGE_LINKS)) link(sb, path.join(repo, target), `${base}/${OLD_PACKAGE}/${name}`);
  }
  link(sb, path.join(repo, OLD_MASTER), `${AI}/${OLD_MASTER}`);
  for (const base of [CLAUDE, AGENTS]) write(sb, `${base}/sucp-mine/SKILL.md`, 'my own skill');
}

function legacyPaths(sb) {
  const out = [at(sb, `${AI}/${OLD_MASTER}`)];
  for (const base of [CLAUDE, AGENTS]) for (const name of OLD_NAMES) out.push(at(sb, `${base}/${name}`));
  return out;
}

describe('install.sh: an install made under the old skill names (link mode)', () => {
  test('--check lists every old entry of the installer as [stale] and is not CURRENT; the user\'s sucp-mine is not listed', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'), { recursive: true });
    expect(sb.run(ONLY).status).toBe(0);
    legacyLinks(sb);
    const r = sb.run(['--check', ...ONLY]);
    expect(r.status).toBe(1);
    const missing = legacyPaths(sb).filter((p) => !r.stdout.includes(`[stale] ${p} (`));
    expect(missing).toEqual([]);
    expect(r.stdout).not.toContain('sucp-mine');
    expect(r.stdout).not.toContain('check: CURRENT');
  });

  test('--update removes every old entry, installs vivera and vivera-*, keeps sucp-mine, and --check is then CURRENT', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'), { recursive: true });
    legacyLinks(sb);
    const r = sb.run(['--update', ...ONLY]);
    expect(r.status).toBe(0);
    expect({ claude: oldEntries(sb, CLAUDE), agents: oldEntries(sb, AGENTS), ai: oldEntries(sb, AI) }).toEqual({ claude: [], agents: [], ai: [] });
    for (const base of [CLAUDE, AGENTS]) {
      expect(fs.existsSync(at(sb, `${base}/vivera/SKILL.md`))).toBe(true);
      for (const phase of Object.values(OLD_PHASES)) expect(fs.existsSync(at(sb, `${base}/${phase}/SKILL.md`))).toBe(true);
      expect(fs.readFileSync(at(sb, `${base}/sucp-mine/SKILL.md`), 'utf8')).toBe('my own skill');
    }
    expect(fs.existsSync(at(sb, `${AI}/VIVERA.md`))).toBe(true);
    // The links of the old package that still resolved went with it: nothing of the checkout is touched.
    expect(fs.existsSync(path.join(sb.repo, 'templates'))).toBe(true);
    const check = sb.run(['--check', ...ONLY]);
    expect(check.stdout).toContain('check: CURRENT');
    expect(check.status).toBe(0);
  });

  test('--uninstall removes the old entries too and keeps sucp-mine', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'), { recursive: true });
    expect(sb.run(ONLY).status).toBe(0);
    legacyLinks(sb);
    const r = sb.run(['--uninstall', ...ONLY]);
    expect(r.status).toBe(0);
    expect(legacyPaths(sb).filter((p) => fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }))).toEqual([]);
    for (const base of [CLAUDE, AGENTS]) expect(fs.readFileSync(at(sb, `${base}/sucp-mine/SKILL.md`), 'utf8')).toBe('my own skill');
  });

  test('--dry-run of --update and of --uninstall names the old entries and changes nothing', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'), { recursive: true });
    expect(sb.run(ONLY).status).toBe(0);
    legacyLinks(sb);
    const before = sb.snapshot();
    for (const mode of ['--update', '--uninstall']) {
      const r = sb.run([mode, '--dry-run', ...ONLY]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`[DRY-RUN] Would prune ${at(sb, `${AGENTS}/${OLD_PACKAGE}`)}`);
      expect(r.stdout).toContain(`[DRY-RUN] Would prune ${at(sb, `${CLAUDE}/sucp-rules`)}`);
      expect(sb.snapshot()).toEqual(before);
    }
  });

  test('an old name that is not the installer\'s stays: a real SKILL.md, a link elsewhere, a real master file, a file the user added', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'), { recursive: true });
    write(sb, `${AGENTS}/sucp-plan/SKILL.md`, 'my plan skill');
    write(sb, 'elsewhere/sucp-rules/SKILL.md', 'another checkout');
    link(sb, at(sb, 'elsewhere/sucp-rules'), `${CLAUDE}/sucp-rules`);
    write(sb, `${AI}/${OLD_MASTER}`, 'my notes');
    link(sb, path.join(sb.repo, 'skills/sucp-tdd-debug/SKILL.md'), `${AGENTS}/sucp-tdd-debug/SKILL.md`);
    write(sb, `${AGENTS}/sucp-tdd-debug/notes.txt`, 'keep me');
    const r = sb.run(['--update', ...ONLY]);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(at(sb, `${AGENTS}/sucp-plan/SKILL.md`), 'utf8')).toBe('my plan skill');
    expect(fs.readlinkSync(at(sb, `${CLAUDE}/sucp-rules`))).toBe(at(sb, 'elsewhere/sucp-rules'));
    expect(fs.readFileSync(at(sb, `${AI}/${OLD_MASTER}`), 'utf8')).toBe('my notes');
    expect(exists(sb, `${AGENTS}/sucp-tdd-debug/SKILL.md`)).toBe(false);
    expect(fs.readFileSync(at(sb, `${AGENTS}/sucp-tdd-debug/notes.txt`), 'utf8')).toBe('keep me');
    expect(r.stdout).toContain(`[PRUNED] link removed from ${at(sb, `${AGENTS}/sucp-tdd-debug`)}`);
    expect(sb.run(['--check', ...ONLY]).stdout).toContain('check: CURRENT');
  });
});

// A copy-mode install made under the old names: the current installer's copy, renamed, carries the same
// per-entry records the old one wrote. The master file's sidecar records the old file name.
function renameToOld(sb, base, { dir = (d) => path.join(sb.home, d), marker = '.vivera-managed' } = {}) {
  fs.renameSync(dir(`${base}/vivera`), dir(`${base}/${OLD_PACKAGE}`));
  for (const [old, now] of Object.entries(OLD_PHASES)) fs.renameSync(dir(`${base}/${now}`), dir(`${base}/${old}`));
  const sidecar = (name) => dir(`${AI}/${name}${marker}`);
  if (fs.existsSync(dir(`${AI}/VIVERA.md`))) {
    fs.renameSync(dir(`${AI}/VIVERA.md`), dir(`${AI}/${OLD_MASTER}`));
    const text = fs.readFileSync(sidecar('VIVERA.md'), 'utf8').replace('entry VIVERA.md ', `entry ${OLD_MASTER} `);
    fs.rmSync(sidecar('VIVERA.md'));
    fs.writeFileSync(sidecar(OLD_MASTER), text);
  }
}

describe('install.sh: an install made under the old skill names (copy mode)', () => {
  test('--update --copy prunes the untouched old copies, keeps an edited one with a KEEP line, and --check --copy is then CURRENT', () => {
    const sb = sandbox();
    const only = ['--copy', '--only', 'ai-config,agents'];
    expect(sb.run(only).status).toBe(0);
    renameToOld(sb, AGENTS);
    fs.appendFileSync(at(sb, `${AGENTS}/sucp-plan/SKILL.md`), 'my edit\n');
    const stale = sb.run(['--check', ...only]);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain(`[stale] ${at(sb, `${AGENTS}/${OLD_PACKAGE}`)} (`);
    expect(stale.stdout).toContain(`[stale] ${at(sb, `${AI}/${OLD_MASTER}`)} (`);
    const r = sb.run(['--update', ...only]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${at(sb, `${AGENTS}/sucp-plan`)} (modified copy of a skill this checkout no longer has)`);
    expect(oldEntries(sb, AGENTS)).toEqual(['sucp-plan']);
    expect(oldEntries(sb, AI)).toEqual([]);
    expect(exists(sb, `${AI}/${OLD_MASTER}.vivera-managed`)).toBe(false);
    expect(fs.readFileSync(at(sb, `${AGENTS}/sucp-plan/SKILL.md`), 'utf8')).toEndWith('my edit\n');
    fs.rmSync(at(sb, `${AGENTS}/sucp-plan`), { recursive: true });
    expect(sb.run(['--check', ...only]).stdout).toContain('check: CURRENT');
  });

  test('an edited copy --update kept under an old name is a [warn] line, and --check --copy is CURRENT with it still there', () => {
    const sb = sandbox();
    const only = ['--copy', '--only', 'ai-config,agents'];
    expect(sb.run(only).status).toBe(0);
    renameToOld(sb, AGENTS);
    fs.appendFileSync(at(sb, `${AGENTS}/sucp-plan/SKILL.md`), 'my edit\n');
    fs.appendFileSync(at(sb, `${AI}/${OLD_MASTER}`), 'my edit\n');
    expect(sb.run(['--update', ...only]).status).toBe(0);
    expect({ agents: oldEntries(sb, AGENTS), ai: oldEntries(sb, AI) }).toEqual({ agents: ['sucp-plan'], ai: [OLD_MASTER] });
    const r = sb.run(['--check', ...only]);
    for (const p of [`${AGENTS}/sucp-plan`, `${AI}/${OLD_MASTER}`]) {
      expect(r.stdout).toContain(`[warn] ${at(sb, p)} ${KEPT_WARN}`);
      expect(r.stdout).not.toContain(`[stale] ${at(sb, p)}`);
    }
    expect(r.stdout).toContain('check: CURRENT');
    expect(r.status).toBe(0);
  });

  test('an edited vivera-* copy the checkout no longer has stays [stale]: the [warn] line is for the old names only', () => {
    const sb = sandbox();
    const only = ['--copy', '--only', 'agents'];
    expect(sb.run(only).status).toBe(0);
    fs.cpSync(at(sb, `${AGENTS}/vivera-plan`), at(sb, `${AGENTS}/vivera-gone`), { recursive: true });
    fs.appendFileSync(at(sb, `${AGENTS}/vivera-gone/SKILL.md`), 'my edit\n');
    expect(sb.run(['--update', ...only]).stdout).toContain(`[KEEP] ${at(sb, `${AGENTS}/vivera-gone`)} (`);
    const r = sb.run(['--check', ...only]);
    expect(r.stdout).toContain(`[stale] ${at(sb, `${AGENTS}/vivera-gone`)} (`);
    expect(r.stdout).not.toContain('[warn] ' + at(sb, `${AGENTS}/vivera-gone`));
    expect(r.status).toBe(1);
  });
});

const pwsh = Bun.which('pwsh') ?? Bun.which('powershell');

describe.skipIf(!pwsh)('install.ps1: a copy install made under the old skill names', () => {
  function ps(sb, args) {
    const r = Bun.spawnSync([pwsh, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(sb.repo, 'install.ps1'), ...args], {
      cwd: sb.root,
      env: { PATH: process.env.PATH, USERPROFILE: sb.home, HOME: path.join(sb.root, 'pshome'), POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', DOTNET_CLI_TELEMETRY_OPTOUT: '1', VIVERA_NOW: '20260101T000000Z' },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }
  const only = ['-Only', 'ai-config,agents'];
  const setup = () => {
    const sb = sandbox();
    fs.copyFileSync(path.join(import.meta.dir, '..', 'install.ps1'), path.join(sb.repo, 'install.ps1'));
    expect(ps(sb, only).code).toBe(0);
    renameToOld(sb, AGENTS);
    return sb;
  };

  test('-Check reports them, -Update prunes the untouched ones and keeps an edited one, then -Check is CURRENT', () => {
    const sb = setup();
    fs.appendFileSync(at(sb, `${AGENTS}/sucp-plan/SKILL.md`), 'my edit\n');
    const stale = ps(sb, ['-Check', ...only]);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain(`[stale] ${at(sb, `${AGENTS}/${OLD_PACKAGE}`)} (`);
    expect(stale.out).toContain(`[stale] ${at(sb, `${AI}/${OLD_MASTER}`)} (`);
    const r = ps(sb, ['-Update', ...only]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(r.out).toContain(`[KEEP] ${at(sb, `${AGENTS}/sucp-plan`)} (modified copy of a skill this checkout no longer has)`);
    expect(oldEntries(sb, AGENTS)).toEqual(['sucp-plan']);
    expect(oldEntries(sb, AI)).toEqual([]);
    fs.rmSync(at(sb, `${AGENTS}/sucp-plan`), { recursive: true });
    expect(ps(sb, ['-Check', ...only]).out).toContain('check: CURRENT');
  });

  test('-Check reports an edited copy -Update kept under an old name as a [warn] line and is CURRENT', () => {
    const sb = setup();
    fs.appendFileSync(at(sb, `${AGENTS}/sucp-plan/SKILL.md`), 'my edit\n');
    fs.appendFileSync(at(sb, `${AI}/${OLD_MASTER}`), 'my edit\n');
    expect(ps(sb, ['-Update', ...only]).code).toBe(0);
    expect({ agents: oldEntries(sb, AGENTS), ai: oldEntries(sb, AI) }).toEqual({ agents: ['sucp-plan'], ai: [OLD_MASTER] });
    const r = ps(sb, ['-Check', ...only]);
    for (const p of [`${AGENTS}/sucp-plan`, `${AI}/${OLD_MASTER}`]) {
      expect(r.out).toContain(`[warn] ${at(sb, p)} ${KEPT_WARN}`);
      expect(r.out).not.toContain(`[stale] ${at(sb, p)}`);
    }
    expect(r.out).toContain('check: CURRENT');
    expect(r.code).toBe(0);
  });

  test('-Check keeps an edited vivera-* copy the checkout no longer has as [stale]', () => {
    const sb = setup();
    fs.cpSync(at(sb, `${AGENTS}/sucp-plan`), at(sb, `${AGENTS}/vivera-gone`), { recursive: true });
    fs.appendFileSync(at(sb, `${AGENTS}/vivera-gone/SKILL.md`), 'my edit\n');
    expect(ps(sb, ['-Update', ...only]).code).toBe(0);
    const r = ps(sb, ['-Check', ...only]);
    expect(r.out).toContain(`[stale] ${at(sb, `${AGENTS}/vivera-gone`)} (`);
    expect(r.out).not.toContain('[warn] ' + at(sb, `${AGENTS}/vivera-gone`));
    expect(r.code).toBe(1);
  });

  test('-Uninstall removes them too', () => {
    const sb = setup();
    const r = ps(sb, ['-Uninstall', ...only]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect({ agents: oldEntries(sb, AGENTS), ai: oldEntries(sb, AI) }).toEqual({ agents: [], ai: [] });
  });
});

describe('a link into the old ai-skills repo under the old master name', () => {
  // Before vivera the skills lived in a repo named ai-skills, whose master file had the old name. Such a link
  // is the installer's own, so --update removes it rather than moving it aside as a foreign file.
  test('--update removes it without a .vivera-bak backup, and --check is then CURRENT', () => {
    const sb = sandbox();
    const old = `/x/ai-skills/${OLD_MASTER}`;
    link(sb, old, `${AI}/${OLD_MASTER}`);
    link(sb, old, `${CLAUDE}/${OLD_PACKAGE}/SKILL.md`);
    const r = sb.run(['--update', ...ONLY]);
    expect(r.status).toBe(0);
    const backups = [AI, CLAUDE, `${CLAUDE}/${OLD_PACKAGE}`]
      .filter((d) => fs.existsSync(at(sb, d)))
      .flatMap((d) => fs.readdirSync(at(sb, d)).filter((n) => n.includes('.vivera-bak')).map((n) => `${d}/${n}`));
    expect(backups).toEqual([]);
    expect(oldEntries(sb, AI)).toEqual([]);
    expect(oldEntries(sb, CLAUDE)).toEqual([]);
    expect(sb.run(['--check', ...ONLY]).stdout).toContain('check: CURRENT');
  });
});
