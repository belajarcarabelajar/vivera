// scripts/install-targets.test.mjs
//
// Which harnesses install.sh installs into: the target table in scripts/install/targets.sh, harness
// detection (a dir under HOME or a CLI on PATH), and the --only / --skip flags. Every run uses the
// sandbox from scripts/lib/install-sandbox.mjs; a CLI is faked by dropping an executable into its bin dir.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { assertSandbox, makeSandbox } from './lib/install-sandbox.mjs';

const MASTER = 'Super Ultra Code Plan Implementation.md';
const IDS = [
  'ai-config',
  'agents',
  'antigravity',
  'antigravity-cli',
  'antigravity-builtin',
  'opencode',
  'claude',
  'codex',
  'cursor',
  'copilot',
];
const PKG = 'super-ultra-code-plan';
const BUILTIN = '.gemini/antigravity-cli/builtin/skills';

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox() {
  const sb = makeSandbox({ tools: ['git', 'bun'] });
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const mkdir = (sb, rel) => fs.mkdirSync(at(sb, rel), { recursive: true });
const exists = (sb, rel) => fs.existsSync(at(sb, rel));
const isLink = (sb, rel) => fs.lstatSync(at(sb, rel), { throwIfNoEntry: false })?.isSymbolicLink() === true;
const entries = (sb, rel = '.') => fs.readdirSync(at(sb, rel)).sort();
const spriteCount = (sb, rel) => fs.readdirSync(at(sb, rel)).filter((f) => f.endsWith('.md')).length;
const crewSize = (sb) => JSON.parse(fs.readFileSync(path.join(sb.repo, 'agents/crew.json'), 'utf8')).length;

// A CLI that exists on PATH and does nothing: the detection rules only ask whether it is there.
function fake(sb, name) {
  const file = path.join(sb.bin, name);
  fs.writeFileSync(file, '#!/bin/sh\necho fake\n');
  fs.chmodSync(file, 0o755);
}

const installed = (sb, skillsRoot) => isLink(sb, `${skillsRoot}/${PKG}/SKILL.md`);

// Calls one function of the target table in a clean shell with the sandbox env.
function table(sb, fn, ...args) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const script =
    'REPO_DIR="$1"; shift; . "$REPO_DIR/scripts/install/lib.sh"; . "$REPO_DIR/scripts/install/targets.sh"; "$@"';
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), '-c', script, '_', sb.repo, fn, ...args], {
    cwd: sb.home,
  });
  return { status: r.exitCode, out: r.stdout.toString().trim() };
}

describe('detection', () => {
  test('targets: a bare HOME gets only ai-config and agents', () => {
    const sb = sandbox();
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(entries(sb)).toEqual(['.agents', '.config']);
    expect(entries(sb, '.config')).toEqual(['ai']);
    const placed = r.stdout.split('\n').filter((l) => /^\[OK\] (Linked|Already|Repointed)/.test(l));
    expect(placed.length).toBe(2);
    for (const line of placed) {
      expect(line.includes(`${sb.home}/.config/ai/`) || line.includes(`${sb.home}/.agents/skills/`)).toBe(true);
    }
  });

  test('targets: ~/.claude adds the Claude Code package and the sprites', () => {
    const sb = sandbox();
    mkdir(sb, '.claude');
    expect(sb.run([]).status).toBe(0);
    expect(installed(sb, '.claude/skills')).toBe(true);
    expect(spriteCount(sb, '.claude/agents')).toBe(crewSize(sb));
    expect(exists(sb, '.config/opencode')).toBe(false);
    expect(exists(sb, '.gemini')).toBe(false);
  });

  test('targets: an agy on PATH adds antigravity and antigravity-cli but not the builtin dir', () => {
    const sb = sandbox();
    fake(sb, 'agy');
    expect(sb.run([]).status).toBe(0);
    expect(installed(sb, '.gemini/config/skills')).toBe(true);
    expect(installed(sb, '.gemini/antigravity-cli/skills')).toBe(true);
    expect(exists(sb, BUILTIN)).toBe(false);
    expect(exists(sb, '.gemini/skills')).toBe(false);
  });

  test('targets: the Antigravity builtin skills dir pulls in antigravity-cli and antigravity as well', () => {
    const sb = sandbox();
    mkdir(sb, BUILTIN);
    expect(sb.run([]).status).toBe(0);
    expect(installed(sb, BUILTIN)).toBe(true);
    expect(installed(sb, '.gemini/antigravity-cli/skills')).toBe(true);
    expect(installed(sb, '.gemini/config/skills')).toBe(true);
  });

  // Gemini CLI stopped serving consumer accounts on 2026-06-18 and Antigravity CLI replaced it, so a
  // `gemini` on PATH is no longer a harness: it adds nothing, and ~/.gemini/skills is never written.
  test('targets: a gemini on PATH is not a harness, and gemini-cli is not a target id', () => {
    const sb = sandbox();
    fake(sb, 'gemini');
    expect(sb.run([]).status).toBe(0);
    expect(exists(sb, '.gemini')).toBe(false);

    const withDir = sandbox();
    fake(withDir, 'gemini');
    mkdir(withDir, '.gemini');
    expect(withDir.run([]).status).toBe(0);
    expect(exists(withDir, '.gemini/skills')).toBe(false);
    expect(entries(withDir, '.gemini')).toEqual(['config']);

    const named = sandbox();
    const r = named.run(['--only', 'gemini-cli']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown target: gemini-cli');
    expect(named.snapshot()).toEqual([]);
  });

  test('targets: ~/.config/opencode adds the OpenCode package and the sprites', () => {
    const sb = sandbox();
    mkdir(sb, '.config/opencode');
    expect(sb.run([]).status).toBe(0);
    expect(installed(sb, '.config/opencode/skills')).toBe(true);
    expect(spriteCount(sb, '.config/opencode/agents')).toBe(crewSize(sb));
    expect(exists(sb, '.claude')).toBe(false);
  });
});

describe('--only and --skip', () => {
  test('targets: --only opencode on a bare HOME installs OpenCode and nothing else', () => {
    const sb = sandbox();
    const r = sb.run(['--only', 'opencode']);
    expect(r.status).toBe(0);
    expect(installed(sb, '.config/opencode/skills')).toBe(true);
    expect(spriteCount(sb, '.config/opencode/agents')).toBe(crewSize(sb));
    expect(entries(sb)).toEqual(['.config']);
    expect(entries(sb, '.config')).toEqual(['opencode']);
  });

  for (const args of [['--only', 'claude,agents'], ['--only=claude,agents'], ['--only', 'claude', '--only', 'agents']]) {
    test(`targets: ${args.join(' ')} installs exactly claude and agents, forcing claude on a bare HOME`, () => {
      const sb = sandbox();
      const r = sb.run(args);
      expect(r.status).toBe(0);
      expect(installed(sb, '.claude/skills')).toBe(true);
      expect(spriteCount(sb, '.claude/agents')).toBe(crewSize(sb));
      expect(installed(sb, '.agents/skills')).toBe(true);
      expect(entries(sb)).toEqual(['.agents', '.claude']);
    });
  }

  test('targets: --skip agents leaves only ai-config, and skip wins over only', () => {
    const sb = sandbox();
    expect(sb.run(['--skip', 'agents']).status).toBe(0);
    expect(entries(sb)).toEqual(['.config']);
    expect(isLink(sb, `.config/ai/${MASTER}`)).toBe(true);

    const both = sandbox();
    const r = both.run(['--only', 'agents', '--skip', 'agents']);
    expect(r.status).toBe(0);
    expect(both.snapshot()).toEqual([]);
    expect(r.stdout).not.toContain(`${both.home}/.agents`);
  });

  test('targets: an unknown id exits 2 naming it and every valid id, before any output', () => {
    for (const flag of ['--only', '--skip']) {
      const sb = sandbox();
      const r = sb.run([flag, 'nope']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Unknown target: nope');
      for (const id of IDS) expect(r.stderr).toContain(id);
      expect(r.stderr).toContain('Usage:');
      expect(r.stdout).toBe('');
      expect(sb.snapshot()).toEqual([]);
    }
  });

  test('targets: a missing or empty value exits 2', () => {
    for (const args of [['--only'], ['--skip'], ['--only='], ['--skip=']]) {
      const sb = sandbox();
      const r = sb.run(args);
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
      expect(r.stdout).toBe('');
      expect(sb.snapshot()).toEqual([]);
    }
  });

  // Changed in T17: codex has no skills dir of its own, but its sprite agents are rendered.
  test('targets: --only codex succeeds, says its skills come from ~/.agents/skills, and renders only its sprites', () => {
    const sb = sandbox();
    const r = sb.run(['--only', 'codex']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[INFO] codex: no skills target of its own (its skills come from ~/.agents/skills)');
    expect(entries(sb)).toEqual(['.codex']);
    expect(entries(sb, '.codex')).toEqual(['agents']);
  });

  test('targets: --dry-run --only claude prints only Claude Code lines and writes nothing', () => {
    const sb = sandbox();
    const before = sb.snapshot();
    const r = sb.run(['--dry-run', '--only', 'claude']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${sb.home}/.claude/skills/${PKG}`);
    expect(r.stdout).toContain(`Would render the sprite agents into: ${sb.home}/.claude/agents`);
    for (const other of ['/.config/ai', '/.agents/', '/.gemini', '/.config/opencode']) {
      expect(r.stdout).not.toContain(`${sb.home}${other}`);
    }
    expect(sb.snapshot()).toEqual(before);
  });

  test('targets: -h documents --only, --skip and the valid ids', () => {
    const sb = sandbox();
    const r = sb.run(['-h']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--only');
    expect(r.stdout).toContain('--skip');
    for (const id of IDS) expect(r.stdout).toContain(id);
  });
});

describe('table', () => {
  test('targets: the table lists the ids in order, and each skills dir is distinct', () => {
    const sb = sandbox();
    expect(table(sb, 'target_ids').out.split('\n')).toEqual(IDS);
    const dirs = [];
    for (const id of IDS) {
      const dir = table(sb, 'target_skills_dir', id).out;
      const kind = table(sb, 'target_kind', id).out;
      if (['codex', 'cursor', 'copilot'].includes(id)) {
        expect({ id, dir, kind }).toEqual({ id, dir: '', kind: 'none' });
      } else {
        expect(kind).toBe(id === 'ai-config' ? 'file' : 'package');
        expect(dir.startsWith(`${sb.home}/`)).toBe(true);
        dirs.push(dir);
      }
    }
    expect(dirs.length).toBe(7);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  // dir: a directory under HOME that signals the harness; tool: a CLI on PATH that does.
  const DETECT = {
    antigravity: { dir: '.gemini', tool: 'agy' },
    'antigravity-cli': { dir: '.gemini/antigravity-cli', tool: 'agy' },
    'antigravity-builtin': { dir: BUILTIN },
    opencode: { dir: '.config/opencode', tool: 'opencode' },
    claude: { dir: '.claude' },
    codex: { dir: '.codex', tool: 'codex' },
    cursor: { dir: '.cursor', tool: 'cursor-agent' },
    copilot: { dir: '.copilot', tool: 'copilot' },
  };

  test('targets: ai-config and agents are always detected, every other harness only by its dir or CLI', () => {
    const bare = sandbox();
    for (const id of ['ai-config', 'agents']) expect(table(bare, 'target_detected', id).status).toBe(0);
    for (const [id, how] of Object.entries(DETECT)) {
      expect({ id, status: table(bare, 'target_detected', id).status }).toEqual({ id, status: 1 });
      if (how.dir) {
        const sb = sandbox();
        mkdir(sb, how.dir);
        expect({ id, by: 'dir', status: table(sb, 'target_detected', id).status }).toEqual({ id, by: 'dir', status: 0 });
      }
      if (how.tool) {
        const sb = sandbox();
        fake(sb, how.tool);
        expect({ id, by: 'tool', status: table(sb, 'target_detected', id).status }).toEqual({ id, by: 'tool', status: 0 });
      }
    }
  });
});

// package_entries (lib.sh) and target_entries (targets.sh) are the one place that knows which links a
// target makes, so install, check, update and uninstall all read the same list.
describe('entries', () => {
  // The entry lines of one target as [desired, dest] pairs, read through a clean bash with the
  // variables install.sh would have set.
  function entryLines(sb, id) {
    assertSandbox(sb.env);
    const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
    const script =
      'REPO_DIR="$1"; MASTER_FILE="$1/Super Ultra Code Plan Implementation.md"; DRY_RUN=false; TIER=standard; ' +
      '. "$1/scripts/install/lib.sh"; . "$1/scripts/install/targets.sh"; target_entries "$2"';
    const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), '-c', script, '_', sb.repo, id], {
      cwd: sb.home,
    });
    expect(r.exitCode).toBe(0);
    return r.stdout
      .toString()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\t'));
  }
  const phaseDirs = (sb) => fs.readdirSync(path.join(sb.repo, 'skills')).filter((n) => n.startsWith('sucp-')).sort();

  test('targets: entries of the agents target are SKILL.md, every phase skill, then four package links', () => {
    const sb = sandbox();
    const lines = entryLines(sb, 'agents');
    const phases = phaseDirs(sb);
    expect(phases.length).toBeGreaterThan(0);
    expect(lines.length).toBe(5 + phases.length);
    const pkg = at(sb, `.agents/skills/${PKG}`);
    const master = path.join(sb.repo, MASTER);
    expect(lines[0]).toEqual([master, `${pkg}/SKILL.md`]);
    expect(lines.slice(1, 1 + phases.length)).toEqual(
      phases.map((n) => [path.join(sb.repo, 'skills', n, 'SKILL.md'), at(sb, `.agents/skills/${n}/SKILL.md`)]),
    );
    expect(lines.slice(1 + phases.length)).toEqual([
      [path.join(sb.repo, 'templates'), `${pkg}/templates`],
      [path.join(sb.repo, 'examples'), `${pkg}/examples`],
      [path.join(sb.repo, 'mermaid.config.json'), `${pkg}/mermaid.config.json`],
      [path.join(sb.repo, 'mermaid.dark.config.json'), `${pkg}/mermaid.dark.config.json`],
    ]);
  });

  test('targets: every package target keeps its links under its package dir or its sibling phase dirs', () => {
    const sb = sandbox();
    const phases = new Set(phaseDirs(sb));
    for (const id of ['agents', 'antigravity', 'antigravity-cli', 'antigravity-builtin', 'opencode', 'claude']) {
      const dir = table(sb, 'target_skills_dir', id).out;
      const siblings = path.dirname(dir);
      const lines = entryLines(sb, id);
      expect({ id, count: lines.length }).toEqual({ id, count: 5 + phases.size });
      for (const [desired, dest] of lines) {
        expect(fs.existsSync(desired)).toBe(true);
        const underPackage = dest.startsWith(`${dir}/`);
        const underPhase = dest.startsWith(`${siblings}/sucp-`) && phases.has(path.basename(path.dirname(dest)));
        expect({ id, dest, ok: underPackage || underPhase }).toEqual({ id, dest, ok: true });
      }
    }
  });

  test('targets: ai-config has exactly one entry, the master file, and codex has none', () => {
    const sb = sandbox();
    expect(entryLines(sb, 'ai-config')).toEqual([[path.join(sb.repo, MASTER), at(sb, `.config/ai/${MASTER}`)]]);
    for (const id of ['codex', 'cursor', 'copilot']) expect(entryLines(sb, id)).toEqual([]);
  });

  test('targets: a path with spaces survives the TAB split intact', () => {
    const sb = sandbox();
    for (const [desired, dest] of entryLines(sb, 'ai-config')) {
      expect(desired).toContain(' ');
      expect(dest).toContain(' ');
      expect(desired.endsWith(MASTER)).toBe(true);
      expect(dest.endsWith(MASTER)).toBe(true);
    }
  });
});
