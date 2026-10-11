// scripts/install-viadir-links.test.mjs
//
// Two findings of an independent lifecycle review, both about a harness dir that is a symlink into
// another tree (the user's dotfiles, or another live checkout of this repository). H10 in
// install-hardening-ownership.test.mjs covers an EXISTING real file there; these cover what it did not:
//   V1 copy mode writes no real file through a symlinked dir: an ABSENT destination there is left
//      alone like an existing one, so install is idempotent and check, update and uninstall agree
//   V2 link mode still creates absent links there, because links are what check, update and
//      uninstall manage
//   V3 a link that is not the installer's own (live or dangling) behind a symlinked dir is left alone,
//      never moved aside or retargeted; the installer's own links there (ours-stale, ok) behave as ever
// Every run uses the sandbox from scripts/lib/install-sandbox.mjs.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const MASTER = 'Super Ultra Code Plan Implementation.md';
const VIA = 'is reached through a symlinked directory; left alone';
const FOREIGN_VIA = '(behind a symlinked directory; left alone)';
const PACKAGE = 'super-ultra-code-plan';
const ENTRIES = ['SKILL.md', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json'];

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox() {
  const sb = makeSandbox({ tools: ['git', 'bun', 'cmp', 'diff'] });
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const phases = (sb) => fs.readdirSync(path.join(sb.repo, 'skills')).filter((n) => n.startsWith('sucp-')).sort();
const backupsUnder = (sb) => sb.snapshot(sb.root).filter((l) => l.split('|')[0].includes('.vivera-bak-'));
const links = (lines) => lines.filter((l) => l.split('|')[1] === 'l');

// Every destination of one package target, as the installer lists them: the package entries and one
// SKILL.md per phase skill, all in <skills dir>.
function destsIn(sb, skillsRel) {
  const dir = at(sb, skillsRel);
  return [
    ...ENTRIES.map((e) => path.join(dir, PACKAGE, e)),
    ...phases(sb).map((p) => path.join(dir, p, 'SKILL.md')),
  ];
}

function copyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
  } else if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// ~/.claude/skills and ~/.config/opencode are symlinks into a dotfiles tree that holds neither entry.
function dotfiles() {
  const sb = sandbox();
  const dot = path.join(sb.root, 'dotfiles');
  fs.mkdirSync(path.join(dot, 'claude-skills'), { recursive: true });
  fs.mkdirSync(path.join(dot, 'opencode'), { recursive: true });
  fs.mkdirSync(at(sb, '.claude'), { recursive: true });
  fs.mkdirSync(at(sb, '.config'), { recursive: true });
  fs.symlinkSync(path.join(dot, 'claude-skills'), at(sb, '.claude/skills'));
  fs.symlinkSync(path.join(dot, 'opencode'), at(sb, '.config/opencode'));
  const dests = [...destsIn(sb, '.claude/skills'), ...destsIn(sb, '.config/opencode/skills')];
  return { sb, dot, dests };
}

// ~/.claude/skills is a symlink into ANOTHER checkout of this repository: a copy of the payload with
// its real files (the phase skills) and its tracked relative symlinks (the package entries).
function otherCheckout(sb) {
  const other = path.join(sb.root, 'other');
  for (const rel of ['skills', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json', MASTER]) {
    copyTree(path.join(sb.repo, rel), path.join(other, rel));
  }
  fs.mkdirSync(at(sb, '.claude'), { recursive: true });
  fs.symlinkSync(path.join(other, 'skills'), at(sb, '.claude/skills'));
  return { other, pkg: path.join(other, 'skills', PACKAGE), dests: destsIn(sb, '.claude/skills') };
}

describe('V1: copy mode writes nothing through a symlinked harness dir', () => {
  const COPY = ['--copy', '--tier', 'minimal', '--only', 'claude,opencode'];

  test('V1-1: install leaves the dotfiles tree as it was, says so for every entry, and a second run is identical', () => {
    const { sb, dot, dests } = dotfiles();
    const before = sb.snapshot(dot);
    const first = sb.run(COPY);
    expect(first.status).toBe(0);
    expect(sb.snapshot(dot)).toEqual(before);
    for (const dest of dests) expect(first.stdout).toContain(`[SKIP] ${dest} ${VIA}`);
    expect(first.stdout.trim().split('\n').pop()).toBe(
      `==> Vivera finished with ${dests.length} entries left alone (see the [SKIP] lines above)`,
    );
    const second = sb.run(COPY);
    expect(second).toEqual(first);
    expect(sb.snapshot(dot)).toEqual(before);
  });

  test('V1-2: --check --copy reports each absent entry like any other viadir entry', () => {
    const { sb, dot, dests } = dotfiles();
    const before = sb.snapshot(dot);
    expect(sb.run(COPY).status).toBe(0);
    const check = sb.run(['--check', ...COPY]);
    expect(check.status).toBe(1);
    for (const dest of dests) expect(check.stdout).toContain(`[foreign] ${dest} ${FOREIGN_VIA}`);
    expect(check.stdout).toContain(`check: ${dests.length} problem(s)`);
    expect(sb.snapshot(dot)).toEqual(before);
  });

  test('V1-3: --update --copy changes nothing and says the same as install', () => {
    const { sb, dot, dests } = dotfiles();
    const before = sb.snapshot(dot);
    expect(sb.run(COPY).status).toBe(0);
    const update = sb.run(['--update', ...COPY]);
    expect(update.status).toBe(0);
    for (const dest of dests) expect(update.stdout).toContain(`[SKIP] ${dest} ${VIA}`);
    expect(sb.snapshot(dot)).toEqual(before);
    expect(backupsUnder(sb)).toEqual([]);
  });

  test('V1-4: --uninstall --copy has nothing to remove and nothing to keep', () => {
    const { sb, dot } = dotfiles();
    const before = sb.snapshot(dot);
    expect(sb.run(COPY).status).toBe(0);
    const un = sb.run(['--uninstall', ...COPY]);
    expect(un.status).toBe(0);
    expect(un.stdout).not.toContain('[KEEP]');
    expect(un.stdout).not.toContain('[REMOVED]');
    expect(un.stdout).toContain('==> Vivera uninstalled: 0 link(s) removed, 0 restored, 0 kept');
    expect(sb.snapshot(dot)).toEqual(before);
  });
});

describe('V2: link mode still creates absent links through a symlinked harness dir', () => {
  const LINK = ['--tier', 'minimal', '--only', 'claude,opencode'];

  test('V2-1: install makes the links, a second run is Already current, and check, update and uninstall manage them', () => {
    const { sb, dot, dests } = dotfiles();
    const first = sb.run(LINK);
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain('left alone');
    for (const skills of ['.claude/skills', '.config/opencode/skills']) {
      expect(first.stdout).toContain(`[OK] Linked skill package in: ${at(sb, `${skills}/${PACKAGE}`)}`);
    }
    for (const dest of dests) expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(at(sb, `.claude/skills/${PACKAGE}/SKILL.md`))).toBe(path.join(sb.repo, MASTER));
    expect(links(sb.snapshot(dot)).length).toBe(dests.length);

    const placed = sb.snapshot(dot);
    const second = sb.run(LINK);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`[OK] Already current: skill package in: ${at(sb, `.claude/skills/${PACKAGE}`)}`);
    expect(second.stdout).not.toContain('left alone');
    expect(sb.snapshot(dot)).toEqual(placed);

    const check = sb.run(['--check', ...LINK]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('check: CURRENT');
    const update = sb.run(['--update', ...LINK]);
    expect(update.status).toBe(0);
    expect(sb.snapshot(dot)).toEqual(placed);

    const un = sb.run(['--uninstall', ...LINK]);
    expect(un.status).toBe(0);
    expect(links(sb.snapshot(dot))).toEqual([]);
  });
});

describe('V3: a link that is not the installer\'s own, behind a symlinked dir, is left alone', () => {
  const LINK = ['--tier', 'minimal', '--only', 'claude'];

  test('V3-1: live and dangling foreign links of another checkout survive install, update, check and uninstall untouched', () => {
    const sb = sandbox();
    const { other, pkg, dests } = otherCheckout(sb);
    // A link to a drive that is not mounted: foreign too, and never silently replaced.
    fs.rmSync(path.join(pkg, 'examples'));
    fs.symlinkSync('../../gone/examples', path.join(pkg, 'examples'));
    const before = sb.snapshot(other);

    const install = sb.run(LINK);
    expect(install.status).toBe(0);
    expect(sb.snapshot(other)).toEqual(before);
    expect(backupsUnder(sb)).toEqual([]);
    for (const dest of dests) expect(install.stdout).toContain(`[SKIP] ${dest} ${VIA}`);
    expect(install.stdout.trim().split('\n').pop()).toBe(
      `==> Vivera finished with ${dests.length} entries left alone (see the [SKIP] lines above)`,
    );

    const check = sb.run(['--check', ...LINK]);
    expect(check.status).toBe(1);
    for (const dest of dests) expect(check.stdout).toContain(`[foreign] ${dest} ${FOREIGN_VIA}`);
    expect(check.stdout).toContain(`check: ${dests.length} problem(s)`);

    for (const args of [['--update', ...LINK], ['--uninstall', ...LINK]]) {
      expect({ args, status: sb.run(args).status }).toEqual({ args, status: 0 });
      expect(sb.snapshot(other)).toEqual(before);
      expect(backupsUnder(sb)).toEqual([]);
    }
  });

  test('V3-2: an own link there is still repointed or kept, and only the foreign ones stay as they were', () => {
    const sb = sandbox();
    const { other, pkg } = otherCheckout(sb);
    const relink = (name, target) => {
      fs.rmSync(path.join(pkg, name));
      fs.symlinkSync(target, path.join(pkg, name));
    };
    relink('templates', '/nowhere/ai-skills/templates'); // legacy ai-skills link: ours-stale
    relink('examples', path.join(sb.repo, 'templates')); // this checkout, another path: ours-stale
    relink('mermaid.config.json', path.join(sb.repo, 'mermaid.config.json')); // already right: ok
    const before = sb.snapshot(other);

    const install = sb.run(LINK);
    expect(install.status).toBe(0);
    const dest = (name) => at(sb, `.claude/skills/${PACKAGE}/${name}`);
    expect(fs.readlinkSync(path.join(pkg, 'templates'))).toBe(path.join(sb.repo, 'templates'));
    expect(fs.readlinkSync(path.join(pkg, 'examples'))).toBe(path.join(sb.repo, 'examples'));
    expect(fs.readlinkSync(path.join(pkg, 'mermaid.config.json'))).toBe(path.join(sb.repo, 'mermaid.config.json'));
    expect(install.stdout).toContain(`[OK] Repointed: ${dest('templates')} -> ${path.join(sb.repo, 'templates')} (was /nowhere/ai-skills/templates)`);
    expect(install.stdout).toContain(`[OK] Repointed: ${dest('examples')} -> ${path.join(sb.repo, 'examples')} (was ${path.join(sb.repo, 'templates')})`);
    for (const name of ['SKILL.md', 'mermaid.dark.config.json']) {
      expect(install.stdout).toContain(`[SKIP] ${dest(name)} ${VIA}`);
    }
    for (const name of ['templates', 'examples', 'mermaid.config.json']) {
      expect(install.stdout).not.toContain(`[SKIP] ${dest(name)}`);
    }
    // Everything else in the other checkout is byte for byte as it was, and nothing was moved aside.
    const changed = new Set(['templates', 'examples'].map((n) => `skills/${PACKAGE}/${n}`));
    const rest = (lines) => lines.filter((l) => !changed.has(l.split('|')[0]));
    expect(rest(sb.snapshot(other))).toEqual(rest(before));
    expect(backupsUnder(sb)).toEqual([]);
  });

  test('V3-3: control: the same foreign link in an ordinary dir (no symlink on the way) is still moved aside', () => {
    const sb = sandbox();
    const elsewhere = path.join(sb.root, 'elsewhere.md');
    fs.writeFileSync(elsewhere, 'not vivera');
    const skillsDir = at(sb, `.claude/skills/${PACKAGE}`);
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(skillsDir, 'SKILL.md'));
    const install = sb.run(LINK);
    expect(install.status).toBe(0);
    expect(install.stdout).toContain(`[BACKUP] ${path.join(skillsDir, 'SKILL.md')} moved to ${path.join(skillsDir, 'SKILL.md')}.vivera-bak-20260101T000000Z`);
    expect(fs.readlinkSync(path.join(skillsDir, 'SKILL.md'))).toBe(path.join(sb.repo, MASTER));
    expect(fs.readlinkSync(`${path.join(skillsDir, 'SKILL.md')}.vivera-bak-20260101T000000Z`)).toBe(elsewhere);
  });
});
