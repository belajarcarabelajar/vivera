// scripts/install-tier.test.mjs
//
// The --tier flag of install.sh and the tier-aware prerequisite checks in
// scripts/install/prereq.sh. Every run uses the sandbox from
// scripts/lib/install-sandbox.mjs (temp HOME, PATH of symlinks to a named tool
// list), so "bun is missing" is true on the PATH the installer sees.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './lib/install-sandbox.mjs';
import { parseTierTable, requiredAt, TIERS } from './lib/prereq.mjs';

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = 'Super Ultra Code Plan Implementation.md';
const SKIP_SPRITES = '[SKIP] sprite agents: tier minimal needs no bun';
const SKIP_HOOKS = '[SKIP] git hooks: tier minimal needs no git';
const rows = parseTierTable(fs.readFileSync(path.join(WORKTREE, 'scripts/install/tiers.tsv'), 'utf8'));
const has = (tool) => Bun.which(tool) !== null;
const HAS_GH_AND_TGREP = has('gh') && has('tgrep');

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox(opts) {
  const sb = makeSandbox(opts);
  open.push(sb);
  return sb;
}

const isLink = (sb, rel) => fs.lstatSync(path.join(sb.home, rel), { throwIfNoEntry: false })?.isSymbolicLink() === true;

test('tier: minimal with no git and no bun links the skills but skips sprites and git hooks', () => {
  const sb = sandbox({ tools: [] });
  fs.mkdirSync(path.join(sb.home, '.claude'));
  const r = sb.run(['--tier', 'minimal']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(SKIP_SPRITES);
  expect(r.stdout).toContain(SKIP_HOOKS);
  expect(isLink(sb, `.config/ai/${MASTER}`)).toBe(true);
  expect(isLink(sb, '.agents/skills/super-ultra-code-plan/SKILL.md')).toBe(true);
  expect(isLink(sb, '.claude/skills/super-ultra-code-plan/SKILL.md')).toBe(true);
  expect(fs.existsSync(path.join(sb.home, '.config/opencode/agents'))).toBe(false);
  expect(fs.existsSync(path.join(sb.home, '.claude/agents'))).toBe(false);
});

test('tier: minimal with the --tier=minimal form and --dry-run prints both skips and writes nothing', () => {
  const sb = sandbox({ tools: ['git', 'bun'] });
  const r = sb.run(['--tier=minimal', '--dry-run']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(SKIP_SPRITES);
  expect(r.stdout).toContain(SKIP_HOOKS);
  expect(sb.snapshot()).toEqual([]);
});

for (const tier of ['standard', 'full']) {
  test(`tier: --tier ${tier} with no git and no bun exits 1 with Missing prerequisite`, () => {
    const sb = sandbox({ tools: [] });
    const r = sb.run(['--tier', tier]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Missing prerequisite');
    expect(sb.snapshot()).toEqual([]);
  });
}

test('tier: the default tier is standard, so a missing tgrep only warns', () => {
  const sb = sandbox({ tools: ['git', 'bun'] });
  const r = sb.run([]);
  expect(r.status).toBe(0);
  expect(r.stderr).toContain("optional tool 'tgrep' not found");
});

test('tier: --tier=full is parsed as full, so a missing gh stops the run with exit 1 and not 2', () => {
  const sb = sandbox({ tools: ['git', 'bun'] });
  const r = sb.run(['--tier=full', '--dry-run']);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Missing prerequisite: 'gh'");
});

test.skipIf(!HAS_GH_AND_TGREP)('tier: --tier full without gh exits 1 naming gh', () => {
  const sb = sandbox({ tools: ['git', 'bun', 'tgrep'] });
  const r = sb.run(['--tier', 'full']);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Missing prerequisite: 'gh'");
});

test.skipIf(!HAS_GH_AND_TGREP)('tier: --tier=full --dry-run with gh and tgrep present is accepted and exits 0', () => {
  const sb = sandbox({ tools: ['git', 'bun', 'gh', 'tgrep'] });
  const r = sb.run(['--tier=full', '--dry-run']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('[DRY-RUN]');
  expect(r.stdout).toContain('Prerequisite verified: gh');
});

test.skipIf(!HAS_GH_AND_TGREP)('tier: --tier full with gh and tgrep present installs and exits 0', () => {
  const sb = sandbox({ tools: ['git', 'bun', 'gh', 'tgrep'] });
  const r = sb.run(['--tier', 'full']);
  expect(r.status).toBe(0);
  expect(isLink(sb, `.config/ai/${MASTER}`)).toBe(true);
});

// For each tier and each checked tool: every tool the tier requires is on PATH except the one under
// test, which is removed. The run must fail exactly when requiredAt (the T02 library, read from the
// same tiers.tsv) says that tool is required. --dry-run keeps the runs cheap; the prerequisite code
// path is the same.
for (const tier of TIERS) {
  test(`tier: prerequisite failures match requiredAt at ${tier}`, () => {
    const required = requiredAt(rows, tier);
    let ran = 0;
    for (const tool of ['git', 'bun', 'gh', 'tgrep']) {
      if (!rows.some((r) => r.tool === tool) || !has(tool)) continue;
      const others = required.filter((t) => t !== tool);
      if (!others.every(has)) continue;
      const sb = sandbox({ tools: others });
      const r = sb.run(['--tier', tier, '--dry-run']);
      expect({ tier, tool, status: r.status }).toEqual({ tier, tool, status: required.includes(tool) ? 1 : 0 });
      // The hard-failure line, not just any mention: an optional-tool warning also quotes the name.
      if (r.status === 1) expect(r.stderr).toContain(`Missing prerequisite: '${tool}'`);
      else expect(r.stderr).not.toContain('Missing prerequisite');
      ran += 1;
    }
    // git and bun always exist here (bun runs this file), so at least those two combinations ran.
    expect(ran).toBeGreaterThanOrEqual(2);
  });
}

test('tier: an unknown argument exits 2 with the usage on stderr and writes nothing', () => {
  const sb = sandbox({ tools: ['git', 'bun'] });
  const r = sb.run(['--bogus']);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('Unknown argument: --bogus');
  expect(r.stderr).toContain('Usage:');
  expect(sb.snapshot()).toEqual([]);
});

test('tier: an invalid tier value exits 2 naming the value', () => {
  const sb = sandbox({ tools: ['git', 'bun'] });
  const r = sb.run(['--tier', 'bogus']);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('Invalid tier: bogus');
  expect(r.stderr).toContain('Usage:');
  expect(sb.snapshot()).toEqual([]);
});

test('tier: --tier with no value exits 2', () => {
  const sb = sandbox({ tools: ['git', 'bun'] });
  const r = sb.run(['--tier']);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('Invalid tier');
  expect(sb.snapshot()).toEqual([]);
});

test('tier: -h lists --tier on stdout and exits 0', () => {
  const sb = sandbox({ tools: [] });
  const r = sb.run(['-h']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('Usage:');
  expect(r.stdout).toContain('--tier');
});

// The installer is split by responsibility (T04). The mode flags are accepted by the parser but are
// not in the usage text and answer "not implemented yet" until T07 to T09 replace the stubs; those
// tasks rewrite this block.
describe('modes', () => {
  for (const mode of ['check', 'update', 'uninstall']) {
    test(`modes: --${mode} exits 2 as not implemented yet and writes nothing`, () => {
      const sb = sandbox({ tools: ['git', 'bun'] });
      const r = sb.run([`--${mode}`]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`${mode} is not implemented yet`);
      expect(sb.snapshot()).toEqual([]);
    });
  }

  test('modes: a second mode flag exits 2 asking to choose one', () => {
    const sb = sandbox({ tools: ['git', 'bun'] });
    const r = sb.run(['--check', '--update']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Choose one of --check, --update, --uninstall');
    expect(r.stderr).toContain('Usage:');
    expect(sb.snapshot()).toEqual([]);
  });

  test('modes: the usage text does not mention the unimplemented mode flags yet', () => {
    const sb = sandbox({ tools: [] });
    const r = sb.run(['-h']);
    expect(r.status).toBe(0);
    for (const flag of ['--check', '--update', '--uninstall']) expect(r.stdout).not.toContain(flag);
  });

  test('modes: install.sh is split into the expected files and each stays within 500 lines', () => {
    const dir = path.join(WORKTREE, 'scripts/install');
    const parts = fs.readdirSync(dir).filter((f) => f.endsWith('.sh')).sort();
    expect(parts).toEqual(['check.sh', 'lib.sh', 'prereq.sh', 'targets.sh', 'uninstall.sh', 'update.sh']);
    for (const file of ['install.sh', ...parts.map((f) => `scripts/install/${f}`)]) {
      const lines = fs.readFileSync(path.join(WORKTREE, file), 'utf8').split('\n').length - 1;
      expect({ file, ok: lines <= 500 }).toEqual({ file, ok: true });
    }
  });
});
