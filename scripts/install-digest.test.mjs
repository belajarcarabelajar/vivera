// scripts/install-digest.test.mjs
//
// Copy-mode data safety. A managed copy that differs from its source can mean two things: it is merely
// outdated (the checkout moved on), or the user edited it. The marker `.vivera-managed` therefore keeps,
// next to `source=<repo>`, one line per entry it manages: `entry <name> <algo>:<digest>`, the digest of
// what the installer last placed. A copy whose digest still matches is `pristine` and is refreshed
// without a backup; any other difference is `modified` and is moved aside first, never discarded. The
// same rule decides what uninstall removes and what update prunes. Every run uses the sandbox from
// scripts/lib/install-sandbox.mjs.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertSandbox, makeSandbox } from './lib/install-sandbox.mjs';

const MASTER = 'Super Ultra Code Plan Implementation.md';
const SKILLS = '.agents/skills';
const PKG = `${SKILLS}/super-ultra-code-plan`;
const STAMP = '20260101T000000Z';
const MARKER = '.vivera-managed';

const open = [];
afterEach(() => {
  while (open.length) open.pop().cleanup();
});

function sandbox({ compare = true } = {}) {
  const sb = makeSandbox({ tools: ['git', 'bun'] });
  open.push(sb);
  if (compare) for (const t of ['cmp', 'diff']) fs.symlinkSync(Bun.which(t), path.join(sb.bin, t));
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const read = (sb, rel) => fs.readFileSync(at(sb, rel), 'utf8');
const exists = (sb, rel) => fs.existsSync(at(sb, rel));
// A backup is one entry named ...vivera-bak-...; a backed-up directory counts once, not file by file.
const backups = (sb) => sb.snapshot(sb.root).filter((l) => l.split('|')[0].split('/').pop().includes('.vivera-bak-'));
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const repoFile = (sb, rel) => path.join(sb.repo, rel);
const firstTemplate = (sb) => fs.readdirSync(repoFile(sb, 'templates')).sort()[0];

// install.sh with a hard limit, so a hang is a failed test and not a stuck run.
function runFast(sb, args, seconds = 15) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const t0 = Date.now();
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), path.join(sb.repo, 'install.sh'), ...args], {
    cwd: sb.home,
    timeout: seconds * 1000,
  });
  return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), seconds: (Date.now() - t0) / 1000 };
}

describe('F1: an edited managed copy is moved aside, an outdated one is refreshed', () => {
  for (const args of [['--copy'], ['--update', '--copy']]) {
    test(`digest: ${args.join(' ')} backs up an edited SKILL.md and a templates file the user added, edits intact`, () => {
      const sb = sandbox();
      expect(sb.run(['--copy']).status).toBe(0);
      fs.appendFileSync(at(sb, `${PKG}/SKILL.md`), '\nmy edit\n');
      const edited = read(sb, `${PKG}/SKILL.md`);
      fs.writeFileSync(at(sb, `${PKG}/templates/mine.md`), 'mine');

      const r = sb.run(args);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('[BACKUP]');
      expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)).toBe(edited);
      expect(read(sb, `${PKG}/templates.vivera-bak-${STAMP}/mine.md`)).toBe('mine');
      expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`)).equals(fs.readFileSync(repoFile(sb, MASTER)))).toBe(true);
      expect(exists(sb, `${PKG}/templates/mine.md`)).toBe(false);
      expect(backups(sb).length).toBe(2);
      // Refreshed, so a further run has nothing to do and makes no new backup.
      expect(sb.run(args).status).toBe(0);
      expect(backups(sb).length).toBe(2);
    });
  }

  test('digest: a copy the user never touched but the checkout outdated is refreshed with no backup', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(repoFile(sb, MASTER), '\nnew rule\n');
    fs.appendFileSync(repoFile(sb, 'mermaid.config.json'), '\n');
    fs.appendFileSync(path.join(repoFile(sb, 'templates'), firstTemplate(sb)), '\nnew line\n');
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Refreshed');
    expect(r.stdout).not.toContain('[BACKUP]');
    expect(backups(sb)).toEqual([]);
    expect(fs.readFileSync(at(sb, `${PKG}/SKILL.md`)).equals(fs.readFileSync(repoFile(sb, MASTER)))).toBe(true);
    expect(fs.readFileSync(at(sb, `.config/ai/${MASTER}`)).equals(fs.readFileSync(repoFile(sb, MASTER)))).toBe(true);
    expect(sb.run(['--check', '--copy']).stdout).toContain('check: CURRENT');
  });

  test('digest: link mode over an edited copy backs it up, over an outdated pristine one it just relinks', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(at(sb, `${PKG}/SKILL.md`), '\nmy edit\n');
    const edited = read(sb, `${PKG}/SKILL.md`);
    fs.appendFileSync(repoFile(sb, 'mermaid.config.json'), '\n');
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)).toBe(edited);
    expect(backups(sb).length).toBe(1);
    expect(fs.lstatSync(at(sb, `${PKG}/SKILL.md`)).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(at(sb, `${PKG}/mermaid.config.json`)).isSymbolicLink()).toBe(true);
    expect(exists(sb, `${PKG}/${MARKER}`)).toBe(false);
  });

  test('digest: uninstall keeps an edited copy and removes an outdated pristine one', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(at(sb, `${PKG}/SKILL.md`), '\nmy edit\n');
    fs.appendFileSync(repoFile(sb, 'mermaid.config.json'), '\n');
    const r = sb.run(['--uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${at(sb, `${PKG}/SKILL.md`)} (modified copy: it stays as it is; ./install.sh --update --copy replaces it after backing yours up)`);
    expect(read(sb, `${PKG}/SKILL.md`).endsWith('my edit\n')).toBe(true);
    expect(exists(sb, `${PKG}/mermaid.config.json`)).toBe(false);
    expect(exists(sb, `${PKG}/templates`)).toBe(false);
  });
});

describe('F2 and F6: pruning a stale managed phase dir', () => {
  const stale = (sb, name, skill, digestOf) => {
    const dir = at(sb, `${SKILLS}/${name}`);
    fs.mkdirSync(dir);
    if (skill !== null) fs.writeFileSync(`${dir}/SKILL.md`, skill);
    fs.writeFileSync(`${dir}/${MARKER}`, `source=${sb.repo}\nentry SKILL.md ${sha(digestOf)}\n`);
    return dir;
  };

  test('digest: a stale dir whose SKILL.md was edited is kept with a KEEP line, an untouched one is pruned', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const edited = stale(sb, 'sucp-edited', 'old text\nmy edit\n', 'old text\n');
    const pristine = stale(sb, 'sucp-pristine', 'old text\n', 'old text\n');
    const r = sb.run(['--update', '--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${edited} (modified copy of a skill this checkout no longer has)`);
    expect(fs.readFileSync(`${edited}/SKILL.md`, 'utf8')).toBe('old text\nmy edit\n');
    expect(fs.existsSync(`${edited}/${MARKER}`)).toBe(true);
    expect(r.stdout).toContain(`[PRUNED] ${pristine}`);
    expect(fs.existsSync(pristine)).toBe(false);
  });

  for (const mode of [[], ['--copy']]) {
    test(`digest: a stale dir whose SKILL.md is a directory does not stop the prunes after it (${mode.join('') || 'link mode'})`, () => {
      const sb = sandbox();
      expect(sb.run(mode).status).toBe(0);
      const odd = at(sb, `${SKILLS}/sucp-a`);
      fs.mkdirSync(`${odd}/SKILL.md`, { recursive: true });
      fs.writeFileSync(`${odd}/SKILL.md/inner.txt`, 'x');
      fs.writeFileSync(`${odd}/${MARKER}`, `source=${sb.repo}\n`);
      const later = stale(sb, 'sucp-b', 'old text\n', 'old text\n');
      const r = sb.run(['--update', ...mode]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`[KEEP] ${odd} (modified copy of a skill this checkout no longer has)`);
      expect(fs.existsSync(`${odd}/SKILL.md/inner.txt`)).toBe(true);
      expect(fs.existsSync(later)).toBe(false);
    });
  }

  test('digest: a stale dir whose name holds a newline is skipped, and files in the working dir survive', () => {
    const sb = sandbox();
    const odd = at(sb, `${SKILLS}/sucp-x\n..`);
    try {
      fs.mkdirSync(odd, { recursive: true });
    } catch {
      return; // this filesystem cannot hold such a name, so there is nothing to test
    }
    fs.writeFileSync(`${odd}/SKILL.md`, 'old');
    fs.writeFileSync(`${odd}/${MARKER}`, `source=${sb.repo}\n`);
    // The installer runs with the sandbox home as its working dir, so a `..` entry would reach the root.
    fs.writeFileSync(path.join(sb.root, 'SKILL.md'), 'canary');
    fs.writeFileSync(path.join(sb.root, MARKER), 'canary');
    const r = sb.run(['--update']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('unusual name');
    expect(fs.readFileSync(path.join(sb.root, 'SKILL.md'), 'utf8')).toBe('canary');
    expect(fs.readFileSync(path.join(sb.root, MARKER), 'utf8')).toBe('canary');
    expect(fs.existsSync(`${odd}/SKILL.md`)).toBe(true);
  });
});

describe('F3: a copy that stopped early does not turn the installer own files into foreign ones', () => {
  test('digest: a phase dir that is a file stops --copy with a message, and the re-run makes no backup', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, SKILLS), { recursive: true });
    fs.writeFileSync(at(sb, `${SKILLS}/sucp-rules`), 'a file where a dir belongs');
    const first = sb.run(['--copy']);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain('[FAIL]');
    expect(exists(sb, `${PKG}/SKILL.md`)).toBe(false);
    fs.rmSync(at(sb, `${SKILLS}/sucp-rules`));
    const again = sb.run(['--copy']);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain('[BACKUP]');
    expect(backups(sb)).toEqual([]);
    expect(sb.run(['--uninstall']).status).toBe(0);
    expect(exists(sb, `${PKG}/SKILL.md`)).toBe(false);
  });
});

describe('F4 and F5: a marker that is not a regular file', () => {
  const make = {
    fifo: (p) => expect(Bun.spawnSync([Bun.which('mkfifo'), p]).exitCode).toBe(0),
    directory: (p) => fs.mkdirSync(p),
    'dangling symlink': (p) => fs.symlinkSync('/nonexistent/marker', p),
    'symlink to a file': (p) => {
      fs.writeFileSync(`${p}.target`, `source=${p}\n`);
      fs.symlinkSync(`${p}.target`, p);
    },
  };

  for (const [kind, create] of Object.entries(make)) {
    test(`digest: a ${kind} as the package marker fails --copy fast with a message and copies nothing`, () => {
      const sb = sandbox();
      fs.mkdirSync(at(sb, PKG), { recursive: true });
      create(at(sb, `${PKG}/${MARKER}`));
      for (const args of [['--copy', '--only', 'agents'], ['--update', '--copy', '--only', 'agents']]) {
        const r = runFast(sb, args);
        expect({ kind, args, status: r.status }).toEqual({ kind, args, status: 1 });
        expect(r.seconds).toBeLessThan(10);
        expect(r.stderr).toContain('[FAIL]');
        expect(r.stderr).toContain('is not a regular file');
        expect(exists(sb, `${PKG}/SKILL.md`)).toBe(false);
        expect(exists(sb, `${PKG}/templates`)).toBe(false);
      }
    });

    test(`digest: a ${kind} as the ai-config sidecar fails --copy fast with a message and copies nothing`, () => {
      const sb = sandbox();
      fs.mkdirSync(at(sb, '.config/ai'), { recursive: true });
      create(at(sb, `.config/ai/${MASTER}${MARKER}`));
      const r = runFast(sb, ['--copy', '--only', 'ai-config']);
      expect({ kind, status: r.status }).toEqual({ kind, status: 1 });
      expect(r.seconds).toBeLessThan(10);
      expect(r.stderr).toContain('is not a regular file');
      expect(exists(sb, `.config/ai/${MASTER}`)).toBe(false);
    });
  }

  test('digest: in link mode a directory marker is left alone, and install and uninstall both finish', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, `${PKG}/${MARKER}`), { recursive: true });
    const install = sb.run([]);
    expect(install.status).toBe(0);
    expect(install.stdout).toContain('Vivera farm planted');
    expect(fs.lstatSync(at(sb, `${PKG}/SKILL.md`)).isSymbolicLink()).toBe(true);
    const uninstall = sb.run(['--uninstall']);
    expect(uninstall.status).toBe(0);
    expect(exists(sb, `${PKG}/${MARKER}`)).toBe(true);
    expect(exists(sb, `${PKG}/SKILL.md`)).toBe(false);
  });
});

describe('F8 and F9: honest completion and a clear failure', () => {
  test('digest: an entry left alone behind a symlinked dir is said in the last line, not "complete"', () => {
    const sb = sandbox();
    const other = path.join(sb.root, 'other');
    fs.mkdirSync(path.join(other, 'super-ultra-code-plan'), { recursive: true });
    fs.writeFileSync(path.join(other, 'super-ultra-code-plan/SKILL.md'), 'their file');
    fs.mkdirSync(at(sb, '.claude'), { recursive: true });
    fs.symlinkSync(other, at(sb, '.claude/skills'));
    const pkg = at(sb, '.claude/skills/super-ultra-code-plan');
    const r = sb.run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[SKIP] ${pkg}/SKILL.md is reached through a symlinked directory; left alone`);
    expect(r.stdout).toContain(`[WARN] skill package in: ${pkg}: 1 entry left alone`);
    expect(r.stdout).not.toContain(`[OK] Linked skill package in: ${pkg}`);
    expect(r.stdout).not.toContain('Vivera farm planted');
    const last = r.stdout.trim().split('\n').pop();
    expect(last).toBe('==> Vivera finished with 1 entry left alone (see the [SKIP] lines above)');
    expect(fs.readFileSync(path.join(other, 'super-ultra-code-plan/SKILL.md'), 'utf8')).toBe('their file');
    expect(sb.run(['--check']).status).toBe(1);
  });

  test('digest: a package dir that cannot be written to fails with a [FAIL] line and the user file stays', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, PKG), { recursive: true });
    fs.writeFileSync(at(sb, `${PKG}/SKILL.md`), 'mine');
    const chmod = Bun.which('chmod');
    Bun.spawnSync([chmod, 'a-w', at(sb, PKG)]);
    try {
      const r = sb.run(['--only', 'agents']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`[FAIL] could not place ${at(sb, `${PKG}/SKILL.md`)}: mv failed`);
      expect(read(sb, `${PKG}/SKILL.md`)).toBe('mine');
    } finally {
      Bun.spawnSync([chmod, 'u+w', at(sb, PKG)]);
    }
  });
});

describe('no cmp and diff, and other digest algorithms', () => {
  test('digest: without cmp and diff on PATH an edited copy is still kept by uninstall and backed up by update', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.appendFileSync(at(sb, `${PKG}/SKILL.md`), '\nmy edit\n');
    fs.appendFileSync(repoFile(sb, 'mermaid.config.json'), '\n');
    for (const tool of ['cmp', 'diff']) fs.rmSync(path.join(sb.bin, tool));

    const update = sb.run(['--update']);
    expect(update.status).toBe(0);
    expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`).endsWith('my edit\n')).toBe(true);
    expect(backups(sb).length).toBe(1);

    const other = sandbox();
    expect(other.run(['--copy']).status).toBe(0);
    fs.appendFileSync(at(other, `${PKG}/SKILL.md`), '\nmy edit\n');
    fs.appendFileSync(repoFile(other, 'mermaid.config.json'), '\n');
    for (const tool of ['cmp', 'diff']) fs.rmSync(path.join(other.bin, tool));
    const r = other.run(['--uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`[KEEP] ${at(other, `${PKG}/SKILL.md`)} (modified copy: it stays as it is; ./install.sh --update --copy replaces it after backing yours up)`);
    expect(exists(other, `${PKG}/mermaid.config.json`)).toBe(false);
  });

  test('digest: a digest recorded with another algorithm cannot vouch for a copy, so that copy is treated as edited', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const marker = at(sb, `${PKG}/${MARKER}`);
    const text = fs.readFileSync(marker, 'utf8').replace(/^entry SKILL\.md \S+$/m, 'entry SKILL.md cksum:1-1');
    expect(text).toContain('cksum:1-1');
    fs.writeFileSync(marker, text);
    fs.appendFileSync(repoFile(sb, MASTER), '\nnew rule\n');
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(exists(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)).toBe(true);
    expect(exists(sb, `.config/ai/${MASTER}.vivera-bak-${STAMP}`)).toBe(false);
  });

  test('digest: the marker records source and one digest line per entry, written after the placement', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    const lines = read(sb, `${PKG}/${MARKER}`).trim().split('\n');
    expect(lines[0]).toBe(`source=${sb.repo}`);
    const names = lines.slice(1).map((l) => l.split(' ')[1]).sort();
    expect(names).toEqual(['SKILL.md', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json', 'templates']);
    for (const l of lines.slice(1)) expect(l).toMatch(/^entry \S+ sha256:[0-9a-f]{64}$/);
    const side = read(sb, `.config/ai/${MASTER}.vivera-managed`).trim().split('\n');
    expect(side[1]).toBe(`entry ${MASTER} ${sha(fs.readFileSync(repoFile(sb, MASTER), 'utf8'))}`);
  });
});

describe('portability', () => {
  test('digest: a .DS_Store inside a copied directory does not make the copy look changed', () => {
    const sb = sandbox();
    expect(sb.run(['--copy']).status).toBe(0);
    fs.writeFileSync(at(sb, `${PKG}/templates/.DS_Store`), 'finder');
    const r = sb.run(['--copy']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('[BACKUP]');
    expect(backups(sb)).toEqual([]);
    expect(sb.run(['--check', '--copy']).stdout).toContain('check: CURRENT');
  });

  test('digest: the macOS xcode-select git stub does not count as git', () => {
    const sb = sandbox();
    const file = path.join(sb.bin, 'git');
    fs.rmSync(file);
    fs.writeFileSync(file, '#!/bin/sh\necho "xcode-select: note: no developer tools were found" >&2\nexit 1\n');
    fs.chmodSync(file, 0o755);
    const r = sb.run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Missing prerequisite: 'git'");
    expect(sb.snapshot()).toEqual([]);
  });
});
