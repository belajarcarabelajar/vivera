// scripts/install-copy.test.mjs
//
// `install.sh --copy`: every link becomes a copy (cp for a file, cp -RL for a directory), each
// package dir and each phase-skill dir carries a `.vivera-managed` marker (`source=<repo>`), and a
// lone file (ai-config) gets a sidecar `<dest>.vivera-managed`. A managed copy is vivera's own:
// check compares content, update refreshes it, uninstall removes it only while it is still identical
// to its source. An unmanaged real file or directory is the user's and is backed up first.
//
// Copy mode compares content with cmp and diff, which the sandbox PATH does not carry by default, so
// each sandbox here gets symlinks to the real ones.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const MASTER = 'Super Ultra Code Plan Implementation.md';
const PKG = '.agents/skills/super-ultra-code-plan';
const SKILLS = '.agents/skills';
const MARKER = '.vivera-managed';
const STAMP = '20260101T000000Z';

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox({ compare = true } = {}) {
  const sb = makeSandbox({ tools: ['git', 'bun'] });
  open.push(sb);
  if (compare) {
    for (const tool of ['cmp', 'diff']) fs.symlinkSync(Bun.which(tool), path.join(sb.bin, tool));
  }
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const read = (sb, rel) => fs.readFileSync(at(sb, rel), 'utf8');
const exists = (sb, rel) => fs.existsSync(at(sb, rel));
const phases = (sb) => fs.readdirSync(path.join(sb.repo, 'skills')).filter((n) => n.startsWith('sucp-')).sort();
const linkCount = (sb) => sb.snapshot().filter((l) => l.split('|')[1] === 'l').length;
const backups = (sb) => sb.snapshot().filter((l) => l.split('|')[0].includes('.vivera-bak-'));
const listTree = (dir, rel = '') =>
  fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listTree(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]))
    .sort();
function expectSameTree(a, b) {
  const files = listTree(a);
  expect(files.length).toBeGreaterThan(0);
  expect(listTree(b)).toEqual(files);
  for (const f of files) expect(fs.readFileSync(path.join(b, f)).equals(fs.readFileSync(path.join(a, f)))).toBe(true);
}
const reportKinds = (r) => r.stdout.split('\n').filter((l) => /^\[(ok|missing|stale|dangling|foreign)\] /.test(l));

describe('install', () => {
  test('copy: --copy on a bare HOME makes no symlink, marks every package dir, and copies byte for byte', () => {
    const sb = sandbox();
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(linkCount(sb)).toBe(0);
    expect(r.stdout).toContain('[OK] Copied');

    for (const dir of [PKG, ...phases(sb).map((n) => `${SKILLS}/${n}`)]) {
      // Changed in T10d: after `source=` the marker holds one digest line per entry (install-digest.test.mjs).
      expect(read(sb, `${dir}/${MARKER}`).startsWith(`source=${sb.repo}\n`)).toBe(true);
    }
    expect(read(sb, `.config/ai/${MASTER}${MARKER}`).startsWith(`source=${sb.repo}\n`)).toBe(true);

    const master = fs.readFileSync(path.join(sb.repo, MASTER));
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`)).equals(master)).toBe(true);
    expect(fs.readFileSync(at(sb, `.config/ai/${MASTER}`)).equals(master)).toBe(true);
    for (const f of ['mermaid.config.json', 'mermaid.dark.config.json']) {
      expect(fs.readFileSync(at(sb, `${PKG}/${f}`)).equals(fs.readFileSync(path.join(sb.repo, f)))).toBe(true);
    }
    for (const n of phases(sb)) {
      const want = fs.readFileSync(path.join(sb.repo, 'skills', n, 'SKILL.md'));
      expect(fs.readFileSync(at(sb, `${SKILLS}/${n}/SKILL.md`)).equals(want)).toBe(true);
    }
    for (const d of ['templates', 'examples']) expectSameTree(path.join(sb.repo, d), at(sb, `${PKG}/${d}`));
  });

  test('copy: a second --copy leaves the home byte identical and says it is already current', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const first = sb.snapshot();
    expect(first.length).toBeGreaterThan(0);
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(sb.snapshot()).toEqual(first);
    expect(r.stdout).toContain('Already current');
    expect(r.stdout).not.toContain('[BACKUP]');
  });

  test('copy: an unmanaged real directory where templates goes is backed up whole and replaced by a copy', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, `${PKG}/templates`), { recursive: true });
    fs.writeFileSync(at(sb, `${PKG}/templates/stray.md`), 'mine');
    fs.writeFileSync(at(sb, `${PKG}/notes.txt`), 'also mine');
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[BACKUP]');
    expect(read(sb, `${PKG}/templates.vivera-bak-${STAMP}/stray.md`)).toBe('mine');
    expectSameTree(path.join(sb.repo, 'templates'), at(sb, `${PKG}/templates`));
    expect(fs.lstatSync(at(sb, `${PKG}/templates`)).isSymbolicLink()).toBe(false);
    // The package dir itself is not an entry: a stray file in it stays where it was.
    expect(read(sb, `${PKG}/notes.txt`)).toBe('also mine');
    expect(exists(sb, `${PKG}/${MARKER}`)).toBe(true);
  });

  test('copy: a user file where a copy goes is backed up, never overwritten', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.writeFileSync(at(sb, `${PKG}/SKILL.md`), 'mine');
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)).toBe('mine');
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`)).equals(fs.readFileSync(path.join(sb.repo, MASTER)))).toBe(true);
  });

  test('copy: link mode never discards a managed copy the user edited, it moves it aside first', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(at(sb, `${PKG}/SKILL.md`), '\nmy edit\n');
    const edited = read(sb, `${PKG}/SKILL.md`);
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[BACKUP]');
    expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)).toBe(edited);
    expect(fs.lstatSync(at(sb, `${PKG}/SKILL.md`)).isSymbolicLink()).toBe(true);
    // An untouched managed copy beside it is replaced by its link without a backup.
    expect(fs.lstatSync(at(sb, `${PKG}/mermaid.config.json`)).isSymbolicLink()).toBe(true);
    expect(backups(sb).filter((l) => l.includes('mermaid')).length).toBe(0);
  });

  // Changed in T10d: without cmp and diff the copy is now judged by digest, so a copy with the source's
  // bytes is the installer's own and is relinked, while one with other bytes and no record is backed up.
  test('copy: link mode without cmp and diff judges a copy by digest: identical is relinked, unrecorded and different is backed up', () => {
    const identical = sandbox({ compare: false });
    fs.mkdirSync(at(identical, PKG), { recursive: true });
    fs.copyFileSync(path.join(identical.repo, MASTER), at(identical, `${PKG}/SKILL.md`));
    fs.writeFileSync(at(identical, `${PKG}/${MARKER}`), `source=${identical.repo}\n`);
    const r = identical.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('[BACKUP]');
    expect(fs.lstatSync(at(identical, `${PKG}/SKILL.md`)).isSymbolicLink()).toBe(true);

    const sb = sandbox({ compare: false });
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.writeFileSync(at(sb, `${PKG}/SKILL.md`), 'something else');
    fs.writeFileSync(at(sb, `${PKG}/${MARKER}`), `source=${sb.repo}\n`);
    const other = sb.run([]);
    expect(other.status).toBe(0);
    expect(other.stdout).toContain('[BACKUP]');
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`), 'utf8')).toBe('something else');
  });

  test('copy: --copy honors --only and --skip', () => {
    const only = sandbox();
    expect(only.run(['--copy', '--only', 'claude']).status).toBe(0);
    expect(exists(only, `.claude/skills/super-ultra-code-plan/${MARKER}`)).toBe(true);
    expect(exists(only, '.agents')).toBe(false);
    expect(exists(only, '.config')).toBe(false);
    expect(linkCount(only)).toBe(0);

    const skip = sandbox();
    expect(skip.run(['--copy', '--skip', 'agents']).status).toBe(0);
    expect(exists(skip, `.config/ai/${MASTER}`)).toBe(true);
    expect(exists(skip, '.agents')).toBe(false);
  });

  test('copy: --copy without cmp and diff on PATH stops with a missing prerequisite before touching anything', () => {
    const sb = sandbox({ compare: false });
    const r = sb.run(['--copy']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Missing prerequisite: 'cmp'");
    expect(sb.snapshot()).toEqual([]);
  });

  test('copy: step 7 leaves the repo links alone in copy mode and still runs in link mode', () => {
    const sb = sandbox();
    const internal = path.join(sb.repo, 'skills/super-ultra-code-plan/templates');
    fs.rmSync(internal);
    const before = sb.snapshot(path.join(sb.repo, 'skills'));
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[SKIP] internal repo links: copy mode');
    expect(r.stdout).not.toContain('Internal repo skill package symlinks verified.');
    expect(sb.snapshot(path.join(sb.repo, 'skills'))).toEqual(before);
    expect(fs.existsSync(internal)).toBe(false);

    // Control: the same repo copy in link mode puts the link back.
    expect(sb.run([]).status).toBe(0);
    expect(fs.lstatSync(internal).isSymbolicLink()).toBe(true);
  });
});

describe('check and update', () => {
  test('copy: editing a copy makes --check --copy say [stale]; --update --copy restores it; check is then CURRENT', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    expect(sb.run(['--check', '--copy']).stdout).toContain('check: CURRENT');

    const edited = at(sb, `${PKG}/mermaid.config.json`);
    const inDir = at(sb, `${PKG}/templates/${listTree(path.join(sb.repo, 'templates'))[0]}`);
    fs.appendFileSync(edited, '\nedited');
    fs.appendFileSync(inDir, '\nedited');
    const stale = sb.run(['--check', '--copy']);
    expect(stale.status).toBe(1);
    // Changed in T10d: an edit is the user's, so check says so and update moves it aside (it used to
    // overwrite it, "Refreshed", with no backup).
    expect(stale.stdout).toContain(`[stale] ${edited} (copy edited since it was installed; --update moves it aside)`);
    expect(stale.stdout).toContain(`[stale] ${at(sb, `${PKG}/templates`)} (copy edited since it was installed`);
    expect(stale.stdout).toContain('check: 2 problem(s)');

    const upd = sb.run(['--update', '--copy']);
    expect(upd.status).toBe(0);
    expect(upd.stdout).toContain('[BACKUP]');
    expect(exists(sb, `${PKG}/templates.vivera-bak-${STAMP}`)).toBe(true);
    expect(fs.readFileSync(`${edited}.vivera-bak-${STAMP}`, 'utf8').endsWith('\nedited')).toBe(true);
    expect(fs.readFileSync(edited).equals(fs.readFileSync(path.join(sb.repo, 'mermaid.config.json')))).toBe(true);
    expectSameTree(path.join(sb.repo, 'templates'), at(sb, `${PKG}/templates`));
    const after = sb.run(['--check', '--copy']);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('check: CURRENT');
  });

  test('copy: --check --copy on a bare HOME reports every path [missing] and writes nothing', () => {
    const sb = sandbox();
    const r = sb.run(['--check', '--copy']);
    expect(r.status).toBe(1);
    expect(reportKinds(r).length).toBeGreaterThan(5);
    expect(reportKinds(r).every((l) => l.startsWith('[missing]'))).toBe(true);
    expect(sb.snapshot()).toEqual([]);
  });

  test('copy: a link install becomes copies on --copy --update, and back to links on a plain --update, without a backup', () => {
    const sb = sandbox();
    expect(sb.run([]).status).toBe(0);
    const links = sb.snapshot();
    expect(linkCount(sb)).toBeGreaterThan(5);

    const toCopies = sb.run(['--copy', '--update']);
    expect(toCopies.status).toBe(0);
    expect(linkCount(sb)).toBe(0);
    expect(backups(sb)).toEqual([]);
    expect(exists(sb, `${PKG}/${MARKER}`)).toBe(true);
    expect(sb.run(['--check', '--copy']).stdout).toContain('check: CURRENT');

    // A link-mode check sees copies where links are expected.
    const wrongMode = sb.run(['--check']);
    expect(wrongMode.status).toBe(1);
    expect(wrongMode.stdout).toContain('[stale]');
    expect(wrongMode.stdout).toContain('a managed copy; expected a link to');

    const toLinks = sb.run(['--update']);
    expect(toLinks.status).toBe(0);
    expect(backups(sb)).toEqual([]);
    expect(sb.snapshot()).toEqual(links);
    expect(sb.run(['--check']).stdout).toContain('check: CURRENT');
  });

  test('copy: --update --copy prunes a managed phase dir the checkout no longer has, and only that', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.mkdirSync(at(sb, `${SKILLS}/sucp-gone`));
    fs.writeFileSync(at(sb, `${SKILLS}/sucp-gone/SKILL.md`), 'old copy');
    // Changed in T10d: the marker records the digest of what was placed, which is what makes the copy prunable.
    const placed = `sha256:${createHash('sha256').update('old copy').digest('hex')}`;
    fs.writeFileSync(at(sb, `${SKILLS}/sucp-gone/${MARKER}`), `source=${sb.repo}\nentry SKILL.md ${placed}\n`);
    fs.mkdirSync(at(sb, `${SKILLS}/sucp-theirs`));
    fs.writeFileSync(at(sb, `${SKILLS}/sucp-theirs/SKILL.md`), 'user skill');
    const r = sb.run(['--update', '--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[PRUNED] ${at(sb, `${SKILLS}/sucp-gone`)}`);
    expect(exists(sb, `${SKILLS}/sucp-gone`)).toBe(false);
    expect(read(sb, `${SKILLS}/sucp-theirs/SKILL.md`)).toBe('user skill');
    for (const n of phases(sb)) expect(exists(sb, `${SKILLS}/${n}/SKILL.md`)).toBe(true);
  });
});

describe('uninstall', () => {
  test('copy: --copy --uninstall removes identical copies and keeps a modified one', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const modified = at(sb, `${PKG}/mermaid.config.json`);
    fs.appendFileSync(modified, '\nmine');
    fs.writeFileSync(at(sb, `${PKG}/notes.txt`), 'unknown file');

    const r = sb.run(['--copy', '--uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${modified} (modified copy: it stays as it is; ./install.sh --update --copy replaces it after backing yours up)`);
    expect(fs.readFileSync(modified, 'utf8').endsWith('\nmine')).toBe(true);
    expect(exists(sb, `${PKG}/SKILL.md`)).toBe(false);
    expect(exists(sb, `${PKG}/templates`)).toBe(false);
    expect(exists(sb, `${PKG}/examples`)).toBe(false);
    expect(exists(sb, `${PKG}/mermaid.dark.config.json`)).toBe(false);
    expect(read(sb, `${PKG}/notes.txt`)).toBe('unknown file');
    expect(exists(sb, `.config/ai/${MASTER}`)).toBe(false);
    expect(exists(sb, `.config/ai/${MASTER}.vivera-managed`)).toBe(false);
    for (const n of phases(sb)) expect(exists(sb, `${SKILLS}/${n}`)).toBe(false);
    // The kept copy stays managed, so a later --update refreshes it instead of treating it as foreign.
    expect(exists(sb, `${PKG}/${MARKER}`)).toBe(true);
  });

  test('copy: --copy --uninstall of untouched copies leaves only the files that were not ours', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.writeFileSync(at(sb, `${PKG}/notes.txt`), 'unknown file');
    const r = sb.run(['--copy', '--uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('[KEEP]');
    const left = new Set(sb.snapshot().map((l) => l.split('|')[0]));
    expect(left).toEqual(new Set(['.agents', SKILLS, PKG, `${PKG}/notes.txt`, '.config', '.config/ai']));
  });

  test('copy: --copy --uninstall --dry-run removes nothing and says what it would do', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const before = sb.snapshot();
    const r = sb.run(['--copy', '--uninstall', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[DRY-RUN] Would remove');
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('dry run, usage and banners', () => {
  test('copy: --copy --dry-run writes nothing and prints Would lines', () => {
    const bare = sandbox();
    const r = bare.run(['--copy', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[DRY-RUN] Would copy');
    expect(bare.snapshot()).toEqual([]);

    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.writeFileSync(at(sb, `${PKG}/SKILL.md`), 'mine');
    const before = sb.snapshot();
    const foreign = sb.run(['--copy', '--dry-run']);
    expect(foreign.stdout).toContain('[DRY-RUN] Would back up');
    expect(sb.snapshot()).toEqual(before);
  });

  // Changed in T10d: an edited copy is backed up, only an outdated one is refreshed.
  test('copy: --dry-run --update --copy says Would back up an edited copy and Would refresh an outdated one, and changes nothing', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(at(sb, `${PKG}/mermaid.config.json`), '\nedited');
    fs.appendFileSync(path.join(sb.repo, 'mermaid.dark.config.json'), '\n');
    const before = sb.snapshot();
    const r = sb.run(['--update', '--copy', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[DRY-RUN] Would back up');
    expect(r.stdout).toContain('[DRY-RUN] Would refresh');
    expect(sb.snapshot()).toEqual(before);
  });

  test('copy: the usage text documents every flag and the banner follows the mode', () => {
    const sb = sandbox();
    const help = sb.run(['-h']);
    expect(help.status).toBe(0);
    for (const flag of ['--tier', '--only', '--skip', '--copy', '--dry-run', '--check', '--update', '--uninstall', '-h']) {
      expect(help.stdout).toContain(flag);
    }
    expect(help.stdout).toContain('Exit codes');

    const install = sb.run(['--dry-run']);
    expect(install.stdout).toContain('==> Sowing Vivera');
    expect(install.stdout).toContain('    Source:');

    const check = sb.run(['--check']);
    expect(check.stdout).toContain('==> Checking the Vivera install');
    for (const text of ['Sowing', 'Source:', 'Tier:']) expect(check.stdout).not.toContain(text);

    const update = sb.run(['--update', '--dry-run']);
    expect(update.stdout).toContain('==> Updating Vivera');
    expect(update.stdout).toContain('    Source:');
    expect(update.stdout).toContain('    Tier:');
    expect(update.stdout).not.toContain('Sowing');

    const uninstall = sb.run(['--uninstall', '--dry-run']);
    expect(uninstall.stdout).toContain('==> Removing the Vivera install');
    for (const text of ['Sowing', 'Source:', 'Tier:']) expect(uninstall.stdout).not.toContain(text);
  });
});
