// scripts/install-uninstall.test.mjs
//
// What `install.sh --uninstall` does: it removes the links the installer made (state ok or
// ours-stale), puts the newest backup back where it was, leaves anything that is not a Vivera link
// alone, and removes only the directories it emptied, never a harness root. Sprite agents are a
// later task and are not asserted here. The sandbox fixes VIVERA_NOW, so every backup name ends in
// 20260101T000000Z.

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './lib/install-sandbox.mjs';

const WORKTREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = 'Super Ultra Code Plan Implementation.md';
const STAMP = '20260101T000000Z';
const PKG = '.agents/skills/super-ultra-code-plan';

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox(opts = { tools: ['git', 'bun'] }) {
  const sb = makeSandbox(opts);
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const write = (sb, rel, text) => {
  fs.mkdirSync(path.dirname(at(sb, rel)), { recursive: true });
  fs.writeFileSync(at(sb, rel), text);
};
const link = (sb, target, rel) => {
  fs.mkdirSync(path.dirname(at(sb, rel)), { recursive: true });
  fs.symlinkSync(target, at(sb, rel));
};
const stat = (sb, rel) => fs.lstatSync(at(sb, rel), { throwIfNoEntry: false });
const isLink = (sb, rel) => stat(sb, rel)?.isSymbolicLink() === true;
const exists = (sb, rel) => stat(sb, rel) !== undefined;
const backups = (sb) => sb.snapshot().filter((line) => line.split('|')[0].includes('.vivera-bak-'));
const kinds = (sb) => sb.snapshot().map((line) => line.split('|')[1]);
const uninstall = (sb, ...args) => sb.run(['--uninstall', ...args]);

// The number of links a bare install makes: ai-config's one, plus the agents package (master file,
// one per phase skill, templates, examples, two mermaid configs).
function linkCount(sb) {
  const phases = fs.readdirSync(path.join(sb.repo, 'skills')).filter((n) => n.startsWith('sucp-')).length;
  return 1 + phases + 5;
}

describe('uninstall: removing links and directories', () => {
  test('install then --uninstall on a bare HOME leaves no link, no file, and no package or phase directory', () => {
    const sb = sandbox();
    expect(sb.run([]).status).toBe(0);
    expect(kinds(sb)).toContain('l');
    const r = uninstall(sb);
    expect(r.status).toBe(0);
    const left = sb.snapshot();
    expect(left.filter((line) => ['l', 'f'].includes(line.split('|')[1]))).toEqual([]);
    for (const line of left) {
      const name = path.basename(line.split('|')[0]);
      expect(name === 'super-ultra-code-plan' || name.startsWith('sucp-')).toBe(false);
    }
    expect(r.stdout).toContain(`[REMOVED] ${at(sb, `${PKG}/SKILL.md`)}`);
    expect(r.stdout).toContain(`==> Vivera uninstalled: ${linkCount(sb)} link(s) removed, 0 restored, 0 kept`);
  });

  test('the skills directory of a package goes with it, and nothing above it', () => {
    const sb = sandbox();
    sb.run([]);
    uninstall(sb);
    expect(exists(sb, '.agents/skills')).toBe(false);
    expect(exists(sb, '.agents')).toBe(true);
    expect(exists(sb, '.config/ai')).toBe(true);
  });

  test('an unrelated file beside the package survives, and so does the skills directory that holds it', () => {
    const sb = sandbox();
    sb.run([]);
    write(sb, '.agents/skills/mine/NOTES.md', 'keep');
    const r = uninstall(sb);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(at(sb, '.agents/skills/mine/NOTES.md'), 'utf8')).toBe('keep');
    expect(exists(sb, '.agents/skills')).toBe(true);
    expect(exists(sb, PKG)).toBe(false);
  });

  test('a file the user put inside the package directory keeps that directory in place', () => {
    const sb = sandbox();
    sb.run([]);
    write(sb, `${PKG}/extra.md`, 'mine');
    expect(uninstall(sb).status).toBe(0);
    expect(fs.readFileSync(at(sb, `${PKG}/extra.md`), 'utf8')).toBe('mine');
    expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(false);
  });

  test('a dangling link into the old ai-skills repo is removed as one of ours', () => {
    const sb = sandbox();
    link(sb, `/x/ai-skills/${MASTER}`, `.config/ai/${MASTER}`);
    const r = uninstall(sb);
    expect(r.status).toBe(0);
    expect(exists(sb, `.config/ai/${MASTER}`)).toBe(false);
    expect(r.stdout).toContain(`[REMOVED] ${at(sb, `.config/ai/${MASTER}`)}`);
    expect(r.stdout).toContain('1 link(s) removed, 0 restored, 0 kept');
  });

  test('ai-config removes only its one link and keeps its directory', () => {
    const sb = sandbox();
    sb.run([]);
    write(sb, '.config/ai/other.md', 'mine');
    uninstall(sb);
    expect(exists(sb, `.config/ai/${MASTER}`)).toBe(false);
    expect(fs.readFileSync(at(sb, '.config/ai/other.md'), 'utf8')).toBe('mine');
  });

  test('a second --uninstall changes nothing and exits 0', () => {
    const sb = sandbox();
    sb.run([]);
    uninstall(sb);
    const after = sb.snapshot();
    const r = uninstall(sb);
    expect(r.status).toBe(0);
    expect(sb.snapshot()).toEqual(after);
    expect(r.stdout).toContain('0 link(s) removed, 0 restored, 0 kept');
    expect(r.stdout).not.toContain('[REMOVED]');
  });
});

describe('uninstall: backups', () => {
  test('a foreign file that install backed up is restored with its content, and no backup is left', () => {
    const sb = sandbox();
    write(sb, `${PKG}/SKILL.md`, 'mine');
    expect(sb.run([]).status).toBe(0);
    expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(true);
    const r = uninstall(sb);
    expect(r.status).toBe(0);
    expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(false);
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`), 'utf8')).toBe('mine');
    expect(backups(sb)).toEqual([]);
    expect(r.stdout).toContain(`[REMOVED] ${at(sb, `${PKG}/SKILL.md`)}`);
    expect(r.stdout).toContain(`[RESTORED] ${at(sb, `${PKG}/SKILL.md`)} from ${at(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)}`);
    expect(r.stdout).toContain(`${linkCount(sb)} link(s) removed, 1 restored, 0 kept`);
    expect(exists(sb, PKG)).toBe(true);
  });

  test('with two backups the newest is restored and the older one stays', () => {
    const sb = sandbox();
    write(sb, `${PKG}/SKILL.md`, 'mine');
    write(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`, 'older backup');
    expect(sb.run([]).status).toBe(0);
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}-1`), 'utf8')).toBe('mine');
    expect(uninstall(sb).status).toBe(0);
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`), 'utf8')).toBe('mine');
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`), 'utf8')).toBe('older backup');
    expect(backups(sb).length).toBe(1);
  });

  test('a later UTC stamp beats an earlier one, and suffix -10 beats -2', () => {
    const sb = sandbox();
    sb.run([]);
    write(sb, `${PKG}/SKILL.md.vivera-bak-20250101T000000Z-3`, 'old stamp');
    write(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}-2`, 'two');
    write(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}-10`, 'ten');
    expect(uninstall(sb).status).toBe(0);
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`), 'utf8')).toBe('ten');
    expect(backups(sb).length).toBe(2);
  });

  test('a name that only looks like a backup is not restored', () => {
    const sb = sandbox();
    sb.run([]);
    write(sb, `${PKG}/SKILL.md.vivera-bak-notes`, 'not a stamp');
    uninstall(sb);
    expect(exists(sb, `${PKG}/SKILL.md`)).toBe(false);
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md.vivera-bak-notes`), 'utf8')).toBe('not a stamp');
  });

  test('a backed up live link is restored as a link, and a backed up directory as a directory', () => {
    const sb = sandbox();
    write(sb, 'other.md', 'theirs');
    link(sb, at(sb, 'other.md'), `.config/ai/${MASTER}`);
    write(sb, `${PKG}/templates/notes.md`, 'keep me');
    expect(sb.run([]).status).toBe(0);
    expect(uninstall(sb).status).toBe(0);
    expect(fs.readlinkSync(at(sb, `.config/ai/${MASTER}`))).toBe(at(sb, 'other.md'));
    expect(fs.readFileSync(at(sb, `${PKG}/templates/notes.md`), 'utf8')).toBe('keep me');
    expect(backups(sb)).toEqual([]);
  });

  test('ai-config restores its backup the same way', () => {
    const sb = sandbox();
    write(sb, `.config/ai/${MASTER}`, 'my master');
    sb.run([]);
    const r = uninstall(sb);
    expect(fs.readFileSync(at(sb, `.config/ai/${MASTER}`), 'utf8')).toBe('my master');
    expect(r.stdout).toContain(`[RESTORED] ${at(sb, `.config/ai/${MASTER}`)}`);
  });
});

describe('uninstall: what is not ours', () => {
  test('a foreign live link and a real file at link spots survive, and each prints [KEEP]', () => {
    const sb = sandbox();
    sb.run([]);
    write(sb, 'other.md', 'theirs');
    fs.rmSync(at(sb, `${PKG}/templates`));
    fs.symlinkSync(at(sb, 'other.md'), at(sb, `${PKG}/templates`));
    fs.rmSync(at(sb, `${PKG}/examples`));
    write(sb, `${PKG}/examples`, 'my own file');
    const r = uninstall(sb);
    expect(r.status).toBe(0);
    expect(fs.readlinkSync(at(sb, `${PKG}/templates`))).toBe(at(sb, 'other.md'));
    expect(fs.readFileSync(at(sb, `${PKG}/examples`), 'utf8')).toBe('my own file');
    expect(fs.readFileSync(at(sb, 'other.md'), 'utf8')).toBe('theirs');
    expect(r.stdout).toContain(`[KEEP] ${at(sb, `${PKG}/templates`)} (not a vivera link)`);
    expect(r.stdout).toContain(`[KEEP] ${at(sb, `${PKG}/examples`)} (not a vivera link)`);
    expect(r.stdout).toContain(`${linkCount(sb) - 2} link(s) removed, 0 restored, 2 kept`);
    expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(false);
  });

  test('a foreign file is never restored over, and never removed, when nothing of ours is there', () => {
    const sb = sandbox();
    write(sb, `${PKG}/SKILL.md`, 'mine');
    write(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`, 'older backup');
    const before = sb.snapshot();
    const r = uninstall(sb);
    expect(r.status).toBe(0);
    expect(sb.snapshot()).toEqual(before);
    expect(r.stdout).toContain('[KEEP]');
    expect(r.stdout).toContain('0 link(s) removed, 0 restored, 1 kept');
  });
});

describe('uninstall: dry run, selection, and harness roots', () => {
  test('--dry-run prints what it would remove and restore, and changes nothing', () => {
    const sb = sandbox();
    write(sb, `${PKG}/SKILL.md`, 'mine');
    sb.run([]);
    const before = sb.snapshot();
    const r = uninstall(sb, '--dry-run');
    expect(r.status).toBe(0);
    expect(sb.snapshot()).toEqual(before);
    expect(r.stdout).toContain(`[DRY-RUN] Would remove ${at(sb, `${PKG}/SKILL.md`)}`);
    expect(r.stdout).toContain(`[DRY-RUN] Would restore ${at(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)}`);
    expect(r.stdout).not.toContain('[REMOVED]');
  });

  test('--only claude removes the claude package and leaves agents and ai-config linked', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'));
    expect(sb.run([]).status).toBe(0);
    expect(isLink(sb, '.claude/skills/super-ultra-code-plan/SKILL.md')).toBe(true);
    const r = uninstall(sb, '--only', 'claude');
    expect(r.status).toBe(0);
    expect(exists(sb, '.claude/skills')).toBe(false);
    expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(true);
    expect(isLink(sb, `.config/ai/${MASTER}`)).toBe(true);
    expect(r.stdout).toContain(`${linkCount(sb) - 1} link(s) removed, 0 restored, 0 kept`);
  });

  test('--skip agents leaves the agents package and removes the rest', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'));
    sb.run([]);
    const r = uninstall(sb, '--skip', 'agents');
    expect(r.status).toBe(0);
    expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(true);
    expect(isLink(sb, '.claude/skills/super-ultra-code-plan/SKILL.md')).toBe(false);
    expect(isLink(sb, `.config/ai/${MASTER}`)).toBe(false);
  });

  test('a harness root survives: ~/.claude and ~/.gemini/config stay although the skills inside them go', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'));
    fs.mkdirSync(at(sb, '.gemini'));
    expect(sb.run([]).status).toBe(0);
    expect(isLink(sb, '.gemini/config/skills/super-ultra-code-plan/SKILL.md')).toBe(true);
    expect(uninstall(sb).status).toBe(0);
    expect(exists(sb, '.claude')).toBe(true);
    expect(exists(sb, '.gemini')).toBe(true);
    expect(exists(sb, '.gemini/config')).toBe(true);
    expect(exists(sb, '.gemini/config/skills')).toBe(false);
    expect(exists(sb, '.claude/skills')).toBe(false);
  });

  test('--tier minimal works with no tool on PATH', () => {
    const sb = sandbox({ tools: [] });
    expect(sb.run(['--tier', 'minimal']).status).toBe(0);
    const r = uninstall(sb, '--tier', 'minimal');
    expect(r.status).toBe(0);
    expect(kinds(sb).filter((k) => k !== 'd')).toEqual([]);
    expect(r.stdout).toContain(`${linkCount(sb)} link(s) removed`);
  });
});

describe('uninstall: the script itself', () => {
  test('never removes a directory recursively', () => {
    const text = fs.readFileSync(path.join(WORKTREE, 'scripts/install/uninstall.sh'), 'utf8');
    expect(/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/.test(text)).toBe(false);
    expect(text).toContain('rmdir');
  });
});

// ---- First-use walkthrough: what the closing lines say after a copy install or without bun ----------

// Copy mode compares content with cmp and diff, which the sandbox PATH does not carry by default.
function copySandbox() {
  const sb = sandbox();
  for (const tool of ['cmp', 'diff']) fs.symlinkSync(Bun.which(tool), path.join(sb.bin, tool));
  return sb;
}

const SPRITE_MARKER = '# Generated by scripts/gen-sprite-agents.mjs';
const summaryOf = (r) => r.stdout.split('\n').find((l) => l.startsWith('==> Vivera uninstall'));
const keptNumber = (line) => Number(line.match(/(\d+) kept$/)[1]);
const keptForBun = (r) => r.stdout.split('\n').filter((l) => l.startsWith('[KEEP] ') && l.includes('(bun not found;'));

describe('uninstall: a kept sprite dir is counted, and the dry run says what the real run does', () => {
  function installedWithoutBun() {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'));
    expect(sb.run([]).status).toBe(0);
    expect(fs.readdirSync(at(sb, '.claude/agents')).length).toBeGreaterThan(0);
    fs.rmSync(path.join(sb.bin, 'bun'));
    return sb;
  }

  test('without bun the kept sprite dir is in the kept number of the summary', () => {
    const sb = installedWithoutBun();
    const r = uninstall(sb);
    expect(r.status).toBe(0);
    const dir = at(sb, '.claude/agents');
    expect(r.stdout).toContain(`[KEEP] ${dir} (bun not found; remove the files that carry the line "${SPRITE_MARKER}" by hand)`);
    // Every link was removed, so the one thing kept is the sprite dir.
    expect(keptForBun(r).length).toBe(1);
    expect(keptNumber(summaryOf(r))).toBe(1);
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
  });

  test('--dry-run without bun prints the [KEEP] line the real run prints, not "Would remove", and counts it', () => {
    const sb = installedWithoutBun();
    const before = sb.snapshot();
    const dry = uninstall(sb, '--dry-run');
    expect(dry.status).toBe(0);
    const dir = at(sb, '.claude/agents');
    expect(dry.stdout).not.toContain(`Would remove the generated sprite agents from ${dir}`);
    expect(dry.stdout).toContain(`[KEEP] ${dir} (bun not found; remove the files that carry the line "${SPRITE_MARKER}" by hand)`);
    expect(keptNumber(summaryOf(dry))).toBe(1);
    expect(sb.snapshot()).toEqual(before);

    const real = uninstall(sb);
    expect(keptForBun(real)).toEqual(keptForBun(dry));
    expect(keptNumber(summaryOf(real))).toBe(keptNumber(summaryOf(dry)));
  });

  test('with bun nothing changes: the dry run still says it would remove the sprite agents and keeps none', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, '.claude'));
    expect(sb.run([]).status).toBe(0);
    const dry = uninstall(sb, '--dry-run');
    expect(dry.stdout).toContain(`[DRY-RUN] Would remove the generated sprite agents from ${at(sb, '.claude/agents')}`);
    expect(keptNumber(summaryOf(dry))).toBe(0);
  });
});

describe('uninstall: wording after a copy install', () => {
  test('a modified copy says it stays and what replaces it, and --update --copy does exactly that', () => {
    const sb = copySandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const modified = at(sb, `${PKG}/mermaid.config.json`);
    fs.appendFileSync(modified, '\nmine');
    const r = sb.run(['--copy', '--uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `[KEEP] ${modified} (modified copy: it stays as it is; ./install.sh --update --copy replaces it after backing yours up)`,
    );
    expect(fs.readFileSync(modified, 'utf8').endsWith('\nmine')).toBe(true);

    // The sentence is true: the update puts the user's file in a backup and writes a fresh copy.
    const update = sb.run(['--update', '--copy']);
    expect(update.status).toBe(0);
    const bak = backups(sb).map((l) => l.split('|')[0]).filter((p) => p.endsWith(`mermaid.config.json.vivera-bak-${STAMP}`));
    expect(bak.length).toBe(1);
    expect(fs.readFileSync(path.join(sb.home, bak[0]), 'utf8').endsWith('\nmine')).toBe(true);
    expect(fs.readFileSync(modified, 'utf8').endsWith('\nmine')).toBe(false);
  });

  test('copies are not called links in the summary, and a link install keeps its wording', () => {
    const sb = copySandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const dry = sb.run(['--copy', '--uninstall', '--dry-run']);
    expect(summaryOf(dry)).toMatch(/^==> Vivera uninstall dry run: \d+ link\(s\) or copy\/copies would be removed, 0 restored, 0 kept$/);
    const r = sb.run(['--copy', '--uninstall']);
    expect(summaryOf(r)).toMatch(/^==> Vivera uninstalled: \d+ link\(s\) or copy\/copies removed, 0 restored, 0 kept$/);

    const links = sandbox();
    expect(links.run([]).status).toBe(0);
    expect(summaryOf(uninstall(links))).toBe(`==> Vivera uninstalled: ${linkCount(links)} link(s) removed, 0 restored, 0 kept`);
  });
});
