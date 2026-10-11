// scripts/install-cleanup.test.mjs
//
// Findings of the final reviews of the install-methods work, one describe each (every run uses the
// sandbox from scripts/lib/install-sandbox.mjs, never the real HOME):
//   C1 copy mode never writes a real file into another tree: ANY link behind a symlinked directory is
//      left alone there, while link mode and a plain --uninstall still manage the installer's own links
//   C2 --uninstall keeps a foreign link behind a symlinked directory, counts it, and keeps its marker
//   C3 a copy made from a read-only checkout is owner-writable, so refresh and uninstall can remove it
//   C4 link mode never deletes a .vivera-managed marker that sits behind a symlinked directory
//   C5 "every entry was left alone" is said when nothing was placed, not "the rest is in place"
//   C6 make_dir names HOME only when the reason is a permission problem
//   C7 the dry run says "Would create directory" only for a directory that is absent
//   C8 a tool found only in ~/.local/bin or ~/.bun/bin is appended to PATH, so it never shadows cp, mv, rm
// Not tested: the comment fixes (h).

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './lib/install-sandbox.mjs';

const MASTER = 'Super Ultra Code Plan Implementation.md';
const VIA = 'is reached through a symlinked directory; left alone';
const PACKAGE = 'super-ultra-code-plan';
const ENTRIES = ['SKILL.md', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json'];
const LINK = ['--tier', 'minimal', '--only', 'claude,opencode'];
const COPY = ['--copy', ...LINK];

// A read-only checkout leaves read-only directories behind: the sandbox could not be removed.
function makeWritable(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.chmodSync(p, 0o755);
    for (const name of fs.readdirSync(p)) makeWritable(path.join(p, name));
  } else {
    fs.chmodSync(p, st.mode | 0o200);
  }
}

function readOnly(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) readOnly(path.join(p, name));
    fs.chmodSync(p, 0o555);
  } else {
    fs.chmodSync(p, st.mode & ~0o222);
  }
}

const open = [];
afterEach(() => {
  while (open.length) {
    const sb = open.pop();
    makeWritable(sb.root);
    sb.cleanup();
  }
});

function sandbox(tools = []) {
  const sb = makeSandbox({ tools: ['git', 'bun', 'cmp', 'diff', ...tools] });
  open.push(sb);
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const phases = (sb) => fs.readdirSync(path.join(sb.repo, 'skills')).filter((n) => n.startsWith('sucp-')).sort();
const links = (lines) => lines.filter((l) => l.split('|')[1] === 'l');
const lastLine = (out) => out.trim().split('\n').pop();

// Every destination of one package target, as the installer lists them.
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

// ~/.claude/skills is a symlink into ANOTHER checkout of this repository (its package entries are
// relative links, its phase skills real files): every entry there is foreign to the installer.
function otherCheckout(sb) {
  const other = path.join(sb.root, 'other');
  for (const rel of ['skills', 'templates', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json', MASTER]) {
    copyTree(path.join(sb.repo, rel), path.join(other, rel));
  }
  fs.mkdirSync(at(sb, '.claude'), { recursive: true });
  fs.symlinkSync(path.join(other, 'skills'), at(sb, '.claude/skills'));
  return { other, pkg: path.join(other, 'skills', PACKAGE), dests: destsIn(sb, '.claude/skills') };
}

describe('C1: copy mode leaves the installer\'s own links behind a symlinked dir alone', () => {
  test('C1-1: a link install, then --copy: nothing is replaced by a real copy, twice; a plain --uninstall still removes the links', () => {
    const { sb, dot, dests } = dotfiles();
    expect(sb.run(LINK).status).toBe(0);
    const placed = sb.snapshot(dot);
    expect(links(placed).length).toBe(dests.length);

    const first = sb.run(COPY);
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain('Refreshed');
    for (const dest of dests) expect(first.stdout).toContain(`[SKIP] ${dest} ${VIA}`);
    expect(lastLine(first.stdout)).toBe(
      `==> Vivera finished with ${dests.length} entries left alone (see the [SKIP] lines above)`,
    );
    expect(sb.snapshot(dot)).toEqual(placed);
    const second = sb.run(COPY);
    expect(second).toEqual(first);
    expect(sb.snapshot(dot)).toEqual(placed);

    const un = sb.run(['--uninstall', ...LINK]);
    expect(un.status).toBe(0);
    expect(un.stdout).toContain(`==> Vivera uninstalled: ${dests.length} link(s) removed, 0 restored, 0 kept`);
    expect(links(sb.snapshot(dot))).toEqual([]);
  });

  test('C1-2: --uninstall --copy removes the same links: what is on disk decides, not the flag', () => {
    const { sb, dot, dests } = dotfiles();
    expect(sb.run(LINK).status).toBe(0);
    const un = sb.run(['--uninstall', ...COPY]);
    expect(un.status).toBe(0);
    expect(un.stdout).toContain(`==> Vivera uninstalled: ${dests.length} link(s) removed, 0 restored, 0 kept`);
    expect(links(sb.snapshot(dot))).toEqual([]);
  });
});

describe('C2: --uninstall keeps a foreign link behind a symlinked dir, and says so', () => {
  test('C2-1: each foreign link is a counted [KEEP], and the marker of its directory stays', () => {
    const sb = sandbox();
    const { other, pkg, dests } = otherCheckout(sb);
    fs.writeFileSync(path.join(pkg, '.vivera-managed'), `source=${sb.repo}\n`);
    const before = sb.snapshot(other);
    const un = sb.run(['--uninstall', '--tier', 'minimal', '--only', 'claude']);
    expect(un.status).toBe(0);
    for (const dest of dests) expect(un.stdout).toContain(`[KEEP] ${dest} (behind a symlinked directory)`);
    expect(un.stdout).toContain(`==> Vivera uninstalled: 0 link(s) removed, 0 restored, ${dests.length} kept`);
    expect(sb.snapshot(other)).toEqual(before);
  });

  test('C2-2: the same with --copy, and a dry run prints the same [KEEP] lines', () => {
    const sb = sandbox();
    const { other, dests } = otherCheckout(sb);
    const before = sb.snapshot(other);
    for (const extra of [[], ['--dry-run']]) {
      const un = sb.run(['--uninstall', ...extra, '--copy', '--tier', 'minimal', '--only', 'claude']);
      expect(un.status).toBe(0);
      for (const dest of dests) expect(un.stdout).toContain(`[KEEP] ${dest} (behind a symlinked directory)`);
      expect(sb.snapshot(other)).toEqual(before);
    }
  });
});

describe('C3: a copy made from a read-only checkout can be refreshed and removed', () => {
  test('C3-1: the copy is owner-writable, the next refresh succeeds and so does --uninstall', () => {
    const sb = sandbox();
    const src = path.join(sb.repo, 'templates');
    readOnly(src);
    readOnly(path.join(sb.repo, 'examples'));
    const dest = at(sb, `.claude/skills/${PACKAGE}/templates`);
    const args = ['--copy', '--tier', 'minimal', '--only', 'claude'];

    const first = sb.run(args);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`[OK] Copied skill package in: ${at(sb, `.claude/skills/${PACKAGE}`)}`);

    // The checkout moves on: one file of the source changes, so the copy is outdated, never edited.
    makeWritable(src);
    const file = fs.readdirSync(src, { recursive: true }).map((n) => path.join(src, n)).find((p) => fs.statSync(p).isFile());
    fs.appendFileSync(file, '\nchanged upstream\n');
    readOnly(src);

    const second = sb.run(args);
    expect(second.stderr).not.toContain('[FAIL]');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`[OK] Refreshed: ${dest}`);
    expect(fs.readFileSync(path.join(dest, path.relative(src, file)), 'utf8')).toContain('changed upstream');
    expect(fs.statSync(dest).mode & 0o200).toBe(0o200);
    const sub = fs.readdirSync(dest, { withFileTypes: true }).find((e) => e.isDirectory());
    if (sub) expect(fs.statSync(path.join(dest, sub.name)).mode & 0o200).toBe(0o200);

    const un = sb.run(['--uninstall', ...args]);
    expect(un.status).toBe(0);
    expect(un.stdout).toContain(`[REMOVED] ${dest}`);
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('C4: link mode keeps a marker that sits behind a symlinked directory', () => {
  test('C4-1: a managed copy in the dotfiles tree, reached through a symlinked ~/.claude, keeps every marker', () => {
    const sb = sandbox();
    expect(sb.run(['--copy', '--tier', 'minimal', '--only', 'claude']).status).toBe(0);
    const dot = path.join(sb.root, 'dotfiles');
    fs.mkdirSync(dot);
    fs.renameSync(at(sb, '.claude'), path.join(dot, 'claude'));
    fs.symlinkSync(path.join(dot, 'claude'), at(sb, '.claude'));
    const before = sb.snapshot(dot);
    const markers = before.filter((l) => l.split('|')[0].endsWith('.vivera-managed'));
    expect(markers.length).toBeGreaterThan(1);

    const r = sb.run(['--tier', 'minimal', '--only', 'claude']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('left alone');
    expect(sb.snapshot(dot)).toEqual(before);
  });
});

describe('C5: the summary says so when every entry of a package was left alone', () => {
  test('C5-1: nothing placed: "every entry was left alone, nothing was placed"', () => {
    const { sb, dests } = dotfiles();
    const r = sb.run(COPY);
    expect(r.status).toBe(0);
    for (const skills of ['.claude/skills', '.config/opencode/skills']) {
      const dir = at(sb, `${skills}/${PACKAGE}`);
      expect(r.stdout).toContain(`[WARN] skill package in: ${dir}: every entry was left alone, nothing was placed`);
    }
    expect(r.stdout).not.toContain('the rest is in place');
    expect(dests.length).toBeGreaterThan(0);
  });

  test('C5-2: control: some placed, some left alone keeps "the rest is in place"', () => {
    const sb = sandbox();
    const { pkg, dests } = otherCheckout(sb);
    fs.rmSync(path.join(pkg, 'templates'));
    fs.symlinkSync('/nowhere/ai-skills/templates', path.join(pkg, 'templates')); // the installer's own: repointed
    const r = sb.run(['--tier', 'minimal', '--only', 'claude']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `[WARN] skill package in: ${at(sb, `.claude/skills/${PACKAGE}`)}: ${dests.length - 1} entries left alone, the rest is in place`,
    );
    expect(r.stdout).not.toContain('every entry was left alone');
  });
});

describe('C6: make_dir names HOME only when the reason is a permission problem', () => {
  test('C6-1: a file where a directory is needed: the reason alone, exit 1, nothing written', () => {
    const sb = sandbox();
    fs.writeFileSync(at(sb, '.claude'), 'a file, not a directory');
    const before = sb.snapshot();
    const r = sb.run(['--tier', 'minimal', '--only', 'claude']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[FAIL\] cannot create \S.*: (Not a directory|File exists)\n/);
    expect(r.stderr).not.toContain('is HOME writable');
    expect(sb.snapshot()).toEqual(before);
  });
});

describe('C7: the dry run names a directory to create only when it is absent', () => {
  test('C7-1: ~/.config/ai present: no line; absent: the line', () => {
    const sb = sandbox();
    const dir = at(sb, '.config/ai');
    const args = ['--dry-run', '--tier', 'minimal', '--only', 'ai-config'];
    const absent = sb.run(args);
    expect(absent.status).toBe(0);
    expect(absent.stdout).toContain(`[DRY-RUN] Would create directory: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
    const present = sb.run(args);
    expect(present.status).toBe(0);
    expect(present.stdout).not.toContain('Would create directory');
    expect(present.stdout).toContain('[DRY-RUN]');
  });
});

describe('C8: a tool found in ~/.local/bin is appended to PATH, so it shadows nothing', () => {
  test('C8-1: bun is found there, and the installer\'s cp is the system one, not the user\'s shim', () => {
    const sb = makeSandbox({ tools: ['cmp', 'diff'] });
    open.push(sb);
    const bunReal = Bun.which('bun');
    expect(bunReal).toBeTruthy();
    const local = at(sb, '.local/bin');
    fs.mkdirSync(local, { recursive: true });
    fs.symlinkSync(bunReal, path.join(local, 'bun'));
    const mark = path.join(sb.root, 'shim-ran');
    const realCp = fs.realpathSync(path.join(sb.bin, 'cp'));
    fs.writeFileSync(path.join(local, 'cp'), `#!/bin/bash\n: > '${mark}'\nexec '${realCp}' "$@"\n`);
    fs.chmodSync(path.join(local, 'cp'), 0o755);
    expect(fs.existsSync(path.join(sb.bin, 'bun'))).toBe(false);

    const r = sb.run(['--copy', '--tier', 'minimal', '--only', 'claude']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[OK] Optional tool found: bun');
    expect(r.stdout).toContain('[OK] Copied skill package in:');
    expect(fs.existsSync(mark)).toBe(false);
  });
});
