// scripts/install-overwrite.test.mjs
//
// What install.sh does to a destination that already exists: a foreign file, directory or live link
// is moved to <dest>.vivera-bak-<UTC stamp> before the link goes in, a stale link of ours is replaced
// without a backup, and a link that is already right is left alone. The sandbox fixes VIVERA_NOW, so
// every backup name here ends in 20260101T000000Z.

import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSandbox, makeSandbox } from './lib/install-sandbox.mjs';

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
const isLink = (sb, rel) => fs.lstatSync(at(sb, rel), { throwIfNoEntry: false })?.isSymbolicLink() === true;
const backups = (sb) => sb.snapshot().filter((line) => line.split('|')[0].includes('.vivera-bak-'));

// Calls one function of scripts/install/lib.sh in a clean shell with the sandbox env.
function lib(sb, fn, ...args) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const script = 'REPO_DIR="$1"; shift; . "$REPO_DIR/scripts/install/lib.sh"; "$@"';
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), '-c', script, '_', sb.repo, fn, ...args], {
    cwd: sb.home,
  });
  return { status: r.exitCode, out: r.stdout.toString().trim() };
}

test('overwrite: a real file where a link goes is kept in a backup and the link is placed', () => {
  const sb = sandbox();
  write(sb, `${PKG}/SKILL.md`, 'mine');
  const r = sb.run([]);
  expect(r.status).toBe(0);
  expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`), 'utf8')).toBe('mine');
  expect(isLink(sb, `${PKG}/SKILL.md`)).toBe(true);
  expect(fs.readlinkSync(at(sb, `${PKG}/SKILL.md`))).toBe(path.join(sb.repo, MASTER));
  expect(r.stdout).toContain('[BACKUP]');
  expect(r.stdout).toContain(`SKILL.md.vivera-bak-${STAMP}`);
  expect(backups(sb).length).toBe(1);
});

test('overwrite: a live symlink to another file is moved aside as a symlink and replaced', () => {
  const sb = sandbox();
  write(sb, 'other.md', 'theirs');
  link(sb, at(sb, 'other.md'), `.config/ai/${MASTER}`);
  const r = sb.run([]);
  expect(r.status).toBe(0);
  const bak = `.config/ai/${MASTER}.vivera-bak-${STAMP}`;
  expect(isLink(sb, bak)).toBe(true);
  expect(fs.readlinkSync(at(sb, bak))).toBe(at(sb, 'other.md'));
  expect(fs.readlinkSync(at(sb, `.config/ai/${MASTER}`))).toBe(path.join(sb.repo, MASTER));
  expect(fs.readFileSync(at(sb, 'other.md'), 'utf8')).toBe('theirs');
  expect(r.stdout).toContain('[BACKUP]');
});

test('overwrite: a dangling link into the old ai-skills repo is replaced without a backup', () => {
  const sb = sandbox();
  const old = `/x/ai-skills/${MASTER}`;
  link(sb, old, `.config/ai/${MASTER}`);
  const r = sb.run([]);
  expect(r.status).toBe(0);
  expect(fs.readlinkSync(at(sb, `.config/ai/${MASTER}`))).toBe(path.join(sb.repo, MASTER));
  expect(backups(sb)).toEqual([]);
  expect(r.stdout).toContain(`Repointed: ${at(sb, `.config/ai/${MASTER}`)} -> ${path.join(sb.repo, MASTER)} (was ${old})`);
});

test('overwrite: a link into this repo at a path that no longer exists is repointed without a backup', () => {
  const sb = sandbox();
  link(sb, path.join(sb.repo, 'gone/old-skill.md'), `${PKG}/SKILL.md`);
  const r = sb.run([]);
  expect(r.status).toBe(0);
  expect(fs.readlinkSync(at(sb, `${PKG}/SKILL.md`))).toBe(path.join(sb.repo, MASTER));
  expect(backups(sb)).toEqual([]);
  expect(r.stdout).toContain('Repointed');
});

test('overwrite: a live link that points elsewhere inside this repo is repointed without a backup', () => {
  const sb = sandbox();
  link(sb, path.join(sb.repo, 'package.json'), `${PKG}/SKILL.md`);
  const r = sb.run([]);
  expect(r.status).toBe(0);
  expect(fs.readlinkSync(at(sb, `${PKG}/SKILL.md`))).toBe(path.join(sb.repo, MASTER));
  expect(backups(sb)).toEqual([]);
});

test('overwrite: a second run changes nothing and says every link is already current', () => {
  const sb = sandbox();
  expect(sb.run([]).status).toBe(0);
  const first = sb.snapshot();
  expect(first.length).toBeGreaterThan(0);
  const r = sb.run([]);
  expect(r.status).toBe(0);
  expect(sb.snapshot()).toEqual(first);
  expect(r.stdout).toContain('Already current');
  expect(r.stdout).not.toContain('[BACKUP]');
});

test('overwrite: --dry-run with a foreign file prints Would back up and writes nothing', () => {
  const sb = sandbox();
  write(sb, `${PKG}/SKILL.md`, 'mine');
  const before = sb.snapshot();
  const r = sb.run(['--dry-run']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('[DRY-RUN] Would back up');
  expect(r.stdout).toContain(`SKILL.md.vivera-bak-${STAMP}`);
  expect(sb.snapshot()).toEqual(before);
});

test('overwrite: a backup name that is taken gets a numeric suffix and the old backup survives', () => {
  const sb = sandbox();
  write(sb, `${PKG}/SKILL.md`, 'mine');
  write(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`, 'older backup');
  const r = sb.run([]);
  expect(r.status).toBe(0);
  expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`), 'utf8')).toBe('older backup');
  expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}-1`), 'utf8')).toBe('mine');
  expect(backups(sb).length).toBe(2);
});

test('overwrite: a real directory where templates is linked is backed up whole', () => {
  const sb = sandbox();
  write(sb, `${PKG}/templates/notes.md`, 'keep me');
  const r = sb.run([]);
  expect(r.status).toBe(0);
  expect(fs.readFileSync(at(sb, `${PKG}/templates.vivera-bak-${STAMP}/notes.md`), 'utf8')).toBe('keep me');
  expect(fs.readlinkSync(at(sb, `${PKG}/templates`))).toBe(path.join(sb.repo, 'templates'));
});

test('overwrite: step 7 fails loudly when the master file is missing and prints no verified line', () => {
  const control = sandbox();
  const ok = control.run([]);
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain('Internal repo skill package symlinks verified.');

  const sb = sandbox();
  fs.rmSync(path.join(sb.repo, MASTER));
  const r = sb.run([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('[FAIL] internal repo skill package link SKILL.md does not resolve');
  expect(r.stdout).not.toContain('Internal repo skill package symlinks verified.');
});

test('overwrite: classify_dest names each destination state', () => {
  const sb = sandbox();
  const desired = at(sb, 'want/real.md');
  write(sb, 'want/real.md', 'x');
  write(sb, 'other.md', 'x');
  write(sb, 'ai-skills/live.md', 'x');
  write(sb, 'isfile', 'x');
  fs.mkdirSync(at(sb, 'isdir'));
  link(sb, desired, 'l/ok');
  link(sb, '../want/real.md', 'l/rel');
  link(sb, '/nowhere/at/all.md', 'l/dangling');
  link(sb, at(sb, 'ai-skills/live.md'), 'l/ai');
  link(sb, path.join(sb.repo, 'package.json'), 'l/inrepo');
  link(sb, at(sb, 'other.md'), 'l/elsewhere');
  const state = (rel) => lib(sb, 'classify_dest', at(sb, rel), desired);
  expect(state('l/missing')).toEqual({ status: 0, out: 'absent' });
  expect(state('l/ok').out).toBe('ok');
  expect(state('l/rel').out).toBe('ok');
  // Changed in T10b (H2): a link that dangles somewhere else, or runs into a dir called ai-skills
  // without being one of the old repo's items, is the user's: moved aside, not silently replaced.
  expect(state('l/dangling').out).toBe('foreign');
  expect(state('l/ai').out).toBe('foreign');
  expect(state('l/inrepo').out).toBe('ours-stale');
  expect(state('l/elsewhere').out).toBe('foreign');
  expect(state('isfile').out).toBe('foreign');
  expect(state('isdir').out).toBe('foreign');
});

test('overwrite: backup_path appends the first free numeric suffix', () => {
  const sb = sandbox();
  const dest = at(sb, 'a/file.md');
  fs.mkdirSync(path.dirname(dest));
  expect(lib(sb, 'backup_path', dest).out).toBe(`${dest}.vivera-bak-${STAMP}`);
  fs.writeFileSync(`${dest}.vivera-bak-${STAMP}`, 'x');
  expect(lib(sb, 'backup_path', dest).out).toBe(`${dest}.vivera-bak-${STAMP}-1`);
  fs.writeFileSync(`${dest}.vivera-bak-${STAMP}-1`, 'x');
  expect(lib(sb, 'backup_path', dest).out).toBe(`${dest}.vivera-bak-${STAMP}-2`);
});

test('overwrite: no link is made with ln -sf any more, every one goes through place_link', () => {
  const files = ['install.sh'];
  for (const f of fs.readdirSync(path.join(WORKTREE, 'scripts/install'))) {
    if (f.endsWith('.sh')) files.push(`scripts/install/${f}`);
  }
  expect(files.length).toBeGreaterThan(5);
  for (const file of files) {
    const text = fs.readFileSync(path.join(WORKTREE, file), 'utf8');
    expect({ file, found: text.includes('ln -sf') }).toEqual({ file, found: false });
  }
});
