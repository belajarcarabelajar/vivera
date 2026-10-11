// scripts/install-matrix.test.mjs
//
// The installer across its whole surface: a tree from `git archive` (no .git), no network, --dry-run
// purity over every mode x copy x tier x HOME state, a read-only HOME, idempotence and prerequisites
// per tier, and a home with every harness present. Every run uses the sandbox from
// scripts/lib/install-sandbox.mjs, and each test builds its own, so a failure names one case.
//
// Tier full needs gh and tgrep on this machine; where they are absent its cases are left out.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSandbox, makeSandbox } from './lib/install-sandbox.mjs';
import { loadTierTable, requiredAt, TIERS } from './lib/prereq.mjs';

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = 'Super Ultra Code Plan Implementation.md';
const PKG = '.agents/skills/super-ultra-code-plan';
const SLOW = 120_000;

const has = (tool) => Bun.which(tool) !== null;
const FULL_OK = has('gh') && has('tgrep');
const TOOLS_ALL = FULL_OK ? ['git', 'bun', 'gh', 'tgrep'] : ['git', 'bun'];
const TIERS_HERE = FULL_OK ? TIERS : TIERS.filter((t) => t !== 'full');
const rows = loadTierTable();

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox({ tools = ['git', 'bun'], compare = false } = {}) {
  const sb = makeSandbox({ tools });
  open.push(sb);
  // Copy mode compares content with cmp and diff, which the sandbox PATH does not carry by default.
  if (compare) for (const t of ['cmp', 'diff']) fs.symlinkSync(Bun.which(t), path.join(sb.bin, t));
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const exists = (sb, rel) => fs.existsSync(at(sb, rel));
const backupsUnder = (sb) => sb.snapshot(sb.root).filter((l) => l.split('|')[0].includes('.vivera-bak-'));
const shim = (sb, name) => {
  const file = path.join(sb.bin, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
};

// Runs <dir>/install.sh the way sb.run does, but from another tree than the sandbox's own copy.
function runFrom(sb, dir, args) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), path.join(dir, 'install.sh'), ...args], {
    cwd: sb.home,
    timeout: 60_000,
  });
  return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe('tarball tree (no .git)', () => {
  test('matrix: a tree from git archive HEAD installs from where it is, is CURRENT, and a second run changes nothing', () => {
    // HEAD at run time is what is archived, so this covers the installer as last committed.
    const sb = sandbox();
    shim(sb, 'graphify');
    const archive = path.join(sb.root, 'archive');
    fs.mkdirSync(archive);
    const made = Bun.spawnSync(['bash', '-c', 'set -o pipefail; git -C "$1" archive HEAD | tar -x -C "$2"', '_', WORKTREE, archive]);
    expect(made.exitCode).toBe(0);
    expect(fs.existsSync(path.join(archive, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(archive, 'install.sh'))).toBe(true);
    fs.symlinkSync(path.join(WORKTREE, 'node_modules'), path.join(archive, 'node_modules'));

    const first = runFrom(sb, archive, []);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('[SKIP] Not a git checkout of its own; skipping core.hooksPath');
    expect(fs.readlinkSync(at(sb, `${PKG}/SKILL.md`))).toBe(path.join(archive, MASTER));
    const links = sb.snapshot().filter((l) => l.split('|')[1] === 'l');
    expect(links.length).toBeGreaterThan(5);
    expect(links.every((l) => l.split('|')[2].startsWith('<ROOT>/archive/'))).toBe(true);

    const check = runFrom(sb, archive, ['--check']);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('check: CURRENT');

    const before = sb.snapshot();
    expect(runFrom(sb, archive, []).status).toBe(0);
    expect(sb.snapshot()).toEqual(before);
  }, SLOW);
});

describe('offline', () => {
  test('matrix: the installer holds no network call: no curl, wget, ssh, nc or git fetch, pull or clone', () => {
    const files = ['install.sh'];
    for (const f of fs.readdirSync(path.join(WORKTREE, 'scripts/install'))) {
      if (f.endsWith('.sh')) files.push(`scripts/install/${f}`);
    }
    expect(files.length).toBeGreaterThan(6);
    const network = /\b(curl|wget|ssh|nc)\b|git\s+(fetch|pull|clone)\b/;
    // The one allowed line only PRINTS the official Bun install command as advice when bun is missing.
    const advice = 'hint="curl -fsSL https://bun.sh/install | bash   (the installer needs unzip; on Alpine it also needs libstdc++)"';
    const hits = [];
    for (const file of files) {
      fs.readFileSync(path.join(WORKTREE, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (network.test(line) && !(file === 'scripts/install/prereq.sh' && line.trim() === advice)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  test('matrix: with no curl and no wget on PATH every mode succeeds', () => {
    const sb = sandbox();
    for (const tool of ['curl', 'wget']) expect(fs.existsSync(path.join(sb.bin, tool))).toBe(false);
    for (const args of [[], ['--update'], ['--check'], ['--uninstall']]) {
      const r = sb.run(args);
      expect({ args, status: r.status }).toEqual({ args, status: 0 });
    }
  });
});

describe('dry-run purity', () => {
  const states = {
    bare: () => {},
    installed: (sb) => expect(sb.run([]).status).toBe(0),
    'a foreign file at a link spot': (sb) => {
      fs.mkdirSync(at(sb, PKG), { recursive: true });
      fs.writeFileSync(at(sb, `${PKG}/SKILL.md`), 'mine');
    },
    'a dangling ai-skills link': (sb) => {
      fs.mkdirSync(at(sb, '.config/ai'), { recursive: true });
      fs.symlinkSync(`/x/ai-skills/${MASTER}`, at(sb, `.config/ai/${MASTER}`));
    },
  };

  for (const [name, setup] of Object.entries(states)) {
    test(`matrix: --dry-run writes nothing in any mode, copy mode or tier, from a home that is ${name}`, () => {
      const sb = sandbox({ tools: TOOLS_ALL, compare: true });
      setup(sb);
      const home = sb.snapshot();
      const repo = sb.snapshot(sb.repo);
      let runs = 0;
      for (const mode of [[], ['--update'], ['--uninstall']]) {
        for (const copy of [[], ['--copy']]) {
          for (const tier of TIERS_HERE) {
            const args = ['--dry-run', ...mode, '--tier', tier, ...copy];
            const r = sb.run(args);
            expect({ args, status: r.status, stderr: r.status === 0 ? '' : r.stderr }).toEqual({ args, status: 0, stderr: '' });
            expect({ args, home: JSON.stringify(sb.snapshot()) === JSON.stringify(home) }).toEqual({ args, home: true });
            expect({ args, repo: JSON.stringify(sb.snapshot(sb.repo)) === JSON.stringify(repo) }).toEqual({ args, repo: true });
            runs += 1;
          }
        }
      }
      expect(runs).toBe(6 * TIERS_HERE.length);
    }, SLOW);
  }
});

describe('read-only HOME', () => {
  // Makes the home read-only for fn, then restores it, even when fn throws.
  function readOnly(sb, fn) {
    const chmod = Bun.which('chmod');
    Bun.spawnSync([chmod, '-R', 'a-w', sb.home]);
    try {
      // Control: a write would fail here, so an unchanged snapshot means the installer wrote nothing.
      expect(() => fs.writeFileSync(at(sb, 'probe'), 'x')).toThrow();
      fn();
    } finally {
      Bun.spawnSync([chmod, '-R', 'u+w', sb.home]);
    }
  }

  test('matrix: install and update on a read-only bare HOME fail with a message and leave nothing behind', () => {
    const sb = sandbox();
    readOnly(sb, () => {
      for (const args of [[], ['--update']]) {
        const r = sb.run(args);
        expect({ args, failed: r.status !== 0 }).toEqual({ args, failed: true });
        expect(r.stderr.trim().length).toBeGreaterThan(0);
        expect(sb.snapshot()).toEqual([]);
      }
    });
  });

  test('matrix: uninstall on a read-only installed HOME fails with a message and removes nothing', () => {
    const sb = sandbox();
    expect(sb.run([]).status).toBe(0);
    const installed = sb.snapshot();
    readOnly(sb, () => {
      const r = sb.run(['--uninstall']);
      expect(r.status).not.toBe(0);
      expect(r.stderr.trim().length).toBeGreaterThan(0);
      expect(sb.snapshot()).toEqual(installed);
    });
  });

  test('matrix: --check still works on a read-only HOME and exits by its own rules (characterization)', () => {
    const bare = sandbox();
    readOnly(bare, () => {
      expect(bare.run(['--check']).status).toBe(1);
      expect(bare.snapshot()).toEqual([]);
    });
    const installed = sandbox();
    expect(installed.run([]).status).toBe(0);
    const before = installed.snapshot();
    readOnly(installed, () => {
      const r = installed.run(['--check']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('check: CURRENT');
      expect(installed.snapshot()).toEqual(before);
    });
  });
});

describe('idempotence per tier', () => {
  for (const tier of TIERS_HERE) {
    for (const copy of [false, true]) {
      test(`matrix: tier ${tier}, ${copy ? 'copy' : 'link'} mode: a second install changes nothing, check is CURRENT, uninstall leaves only directories`, () => {
        const sb = sandbox({ tools: tier === 'minimal' ? [] : TOOLS_ALL, compare: copy });
        const flags = ['--tier', tier, ...(copy ? ['--copy'] : [])];
        expect(sb.run(flags).status).toBe(0);
        const first = sb.snapshot();
        expect(first.length).toBeGreaterThan(0);
        expect(sb.run(flags).status).toBe(0);
        expect(sb.snapshot()).toEqual(first);

        const check = sb.run([...flags, '--check']);
        expect(check.status).toBe(0);
        expect(check.stdout).toContain('check: CURRENT');

        const un = sb.run([...flags, '--uninstall']);
        expect(un.status).toBe(0);
        const left = sb.snapshot().filter((l) => l.split('|')[1] !== 'd');
        expect(left).toEqual([]);
        expect(backupsUnder(sb)).toEqual([]);
      }, SLOW);
    }
  }
});

describe('prerequisites per tier', () => {
  for (const tier of TIERS_HERE) {
    for (const missing of ['git', 'bun']) {
      test(`matrix: tier ${tier} without ${missing}: install fails exactly when the tier requires it; check and uninstall still work`, () => {
        const sb = sandbox({ tools: TOOLS_ALL });
        expect(sb.run(['--tier', tier]).status).toBe(0);
        fs.rmSync(path.join(sb.bin, missing));
        const required = requiredAt(rows, tier).includes(missing);
        const again = sb.run(['--tier', tier]);
        expect(again.status).toBe(required ? 1 : 0);
        if (required) expect(again.stderr).toContain(`Missing prerequisite: '${missing}'`);
        const check = sb.run(['--tier', tier, '--check']);
        expect(check.status).toBe(0);
        expect(check.stdout).toContain('check: CURRENT');
        expect(sb.run(['--tier', tier, '--uninstall']).status).toBe(0);
        expect(exists(sb, `.config/ai/${MASTER}`)).toBe(false);
      }, SLOW);
    }
  }
});

describe('a home with every harness', () => {
  test('matrix: install, check and uninstall succeed, never change the checkout, and make no backup', () => {
    const sb = sandbox();
    for (const dir of ['.claude', '.config/opencode', '.gemini', '.codex', '.cursor', '.copilot']) {
      fs.mkdirSync(at(sb, dir), { recursive: true });
    }
    for (const tool of ['agy', 'gemini']) shim(sb, tool);
    let check = null;
    for (const args of [[], ['--check'], ['--uninstall']]) {
      const repo = sb.snapshot(sb.repo);
      const r = sb.run(args);
      expect({ args, status: r.status }).toEqual({ args, status: 0 });
      expect(sb.snapshot(sb.repo)).toEqual(repo);
      expect(backupsUnder(sb)).toEqual([]);
      if (args[0] === '--check') check = r;
    }
    expect(check.stdout).toContain('check: CURRENT');
    // Harnesses without a skills dir of their own are reported as skipped, not as problems.
    for (const id of ['codex', 'cursor', 'copilot']) expect(check.stdout).toContain(`[skip] ${id}: no skills target`);
  }, SLOW);
});
