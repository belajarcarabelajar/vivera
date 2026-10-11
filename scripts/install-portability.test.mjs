// scripts/install-portability.test.mjs
//
// Defects found by an adversarial run of the copy-mode design and a portability review of the installer
// (scripts/install/place.sh, targets.sh, uninstall.sh). One describe per defect:
//   D2  a marker shared through a symlinked skills dir loses its entry lines when the second target places
//       nothing, so --update makes spurious backups of untouched copies and --uninstall keeps outdated ones;
//   D3  a copy killed half way leaves a partial copy at the destination, which the next run backs up as the
//       NEWEST backup and --uninstall then restores over the live path;
//   P1  the "is this a checkout of its own" test compared two spellings of the same path (Git Bash prints
//       C:/..., bash pwd -P prints /c/...);
//   P2  a bare "${array[@]}" is an unbound variable on bash before 4.4 when the array is empty;
//   P3  a plain file named sucp-<tab>x was reported as an unusual stale phase dir.
// Every run uses the sandbox from scripts/lib/install-sandbox.mjs; the bash functions under test are also
// called straight in a clean shell with the sandbox PATH.

import { afterEach, describe, expect, test } from 'bun:test';
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

// Copy mode compares content with cmp and diff, which the sandbox PATH does not carry by default.
function sandbox({ tools = [], git = false } = {}) {
  const sb = makeSandbox({ tools, git });
  open.push(sb);
  for (const t of ['cmp', 'diff']) fs.symlinkSync(Bun.which(t), path.join(sb.bin, t));
  return sb;
}

const at = (sb, rel) => path.join(sb.home, rel);
const read = (sb, rel) => fs.readFileSync(at(sb, rel), 'utf8');
const write = (sb, rel, text) => {
  fs.mkdirSync(path.dirname(at(sb, rel)), { recursive: true });
  fs.writeFileSync(at(sb, rel), text);
};
const lexists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const names = (sb) => sb.snapshot(sb.root).map((l) => l.split('|')[0]);
// A backup is one entry named ...vivera-bak-...; a backed-up directory counts once, not file by file.
const backups = (sb) => names(sb).filter((n) => n.split('/').pop().includes('.vivera-bak-'));
const leftovers = (sb) => names(sb).filter((n) => n.split('/').pop().includes('.vivera-tmp-'));
const phases = (sb) => fs.readdirSync(path.join(sb.repo, 'skills')).filter((n) => n.startsWith('sucp-')).sort();
const outdate = (sb) => {
  const dir = path.join(sb.repo, 'templates');
  fs.appendFileSync(path.join(dir, fs.readdirSync(dir).sort()[0]), '\nnew line\n');
};
const entryLines = (text) => text.split('\n').filter((l) => l.startsWith('entry '));

function writeShim(sb, name, body, shell = '/bin/bash') {
  const file = path.join(sb.bin, name);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `#!${shell}\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// Runs one shell snippet with the sandbox env after sourcing the installer's functions.
function shell(sb, script, ...args) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const head = 'set -euo pipefail; REPO_DIR="$1"; shift; . "$REPO_DIR/scripts/install/lib.sh"; . "$REPO_DIR/scripts/install/place.sh"; ';
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), '-c', head + script, '_', sb.repo, ...args], {
    cwd: sb.home,
    timeout: 30_000,
  });
  return { status: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// Runs the sandbox copy of install.sh from another working directory than the sandbox home.
function runIn(sb, cwd, args) {
  assertSandbox(sb.env);
  const pairs = Object.entries(sb.env).map(([k, v]) => `${k}=${v}`);
  const r = Bun.spawnSync(['/usr/bin/env', '-i', ...pairs, Bun.which('bash'), path.join(sb.repo, 'install.sh'), ...args], {
    cwd,
    timeout: 60_000,
  });
  return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe('D2: a marker reached through a symlinked skills dir keeps the entry lines of what it did not place', () => {
  // ~/.claude/skills -> ../.agents/skills, so the claude target works on the very files the agents
  // target just placed. Every one of its entries is "viadir" (left alone), so it places nothing.
  const ARGS = ['--tier', 'minimal', '--copy', '--only', 'agents,claude'];
  function shared() {
    const sb = sandbox();
    fs.mkdirSync(at(sb, SKILLS), { recursive: true });
    fs.mkdirSync(at(sb, '.claude'), { recursive: true });
    fs.symlinkSync('../.agents/skills', at(sb, '.claude/skills'));
    return sb;
  }

  test('D2: after both targets the package marker and every phase marker still hold their entry lines', () => {
    const sb = shared();
    const r = sb.run(ARGS);
    expect(r.status).toBe(0);
    const pkg = read(sb, `${PKG}/${MARKER}`);
    expect(entryLines(pkg).map((l) => l.split(' ')[1]).sort()).toEqual(
      ['SKILL.md', 'examples', 'mermaid.config.json', 'mermaid.dark.config.json', 'templates'].sort(),
    );
    for (const phase of phases(sb)) {
      expect(entryLines(read(sb, `${SKILLS}/${phase}/${MARKER}`)).map((l) => l.split(' ')[1])).toEqual(['SKILL.md']);
    }
  });

  test('D2: --update of an outdated checkout refreshes the untouched copies with no backup at all', () => {
    const sb = shared();
    expect(sb.run(ARGS).status).toBe(0);
    outdate(sb);
    const r = sb.run(['--update', ...ARGS]);
    expect(r.status).toBe(0);
    expect(backups(sb)).toEqual([]);
    const template = fs.readdirSync(path.join(sb.repo, 'templates')).sort()[0];
    expect(read(sb, `${PKG}/templates/${template}`)).toBe(fs.readFileSync(path.join(sb.repo, 'templates', template), 'utf8'));
  });

  test('D2: --uninstall of an outdated checkout removes the untouched copies and keeps nothing', () => {
    const sb = shared();
    expect(sb.run(ARGS).status).toBe(0);
    outdate(sb);
    const r = sb.run(['--uninstall', '--tier', 'minimal', '--copy', '--only', 'agents,claude']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('[KEEP]');
    expect(lexists(at(sb, `${PKG}/templates`))).toBe(false);
    expect(lexists(at(sb, `${PKG}/SKILL.md`))).toBe(false);
  });

  describe('write_marker', () => {
    // A marker dir holding A, B and (when asked) C, a marker that names all three, then one write_marker
    // call for the names given.
    function mark(sb, { existing, placed, keepC = false }) {
      const dir = path.join(sb.root, 'dir');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'A'), 'a1');
      fs.writeFileSync(path.join(dir, 'B'), 'b1');
      if (keepC) fs.writeFileSync(path.join(dir, 'C'), 'c1');
      fs.writeFileSync(path.join(dir, MARKER), existing);
      const r = shell(sb, 'write_marker "$@"', path.join(dir, MARKER), ...placed.map((n) => path.join(dir, n)));
      expect(r.status).toBe(0);
      return fs.readFileSync(path.join(dir, MARKER), 'utf8');
    }
    const old = (sb) => `source=${sb.repo}\nentry A sha256:${'a'.repeat(64)}\nentry B sha256:${'b'.repeat(64)}\nentry C sha256:${'c'.repeat(64)}\n`;

    test('D2: a name it did not place keeps its line while the name still exists, and a name that is gone loses it', () => {
      const sb = sandbox();
      const out = mark(sb, { existing: old(sb), placed: ['A'] });
      const lines = out.trim().split('\n');
      expect(lines[0]).toBe(`source=${sb.repo}`);
      // B was not placed and still exists: its old line stays. C is gone from the dir: its line goes.
      expect(lines).toContain(`entry B sha256:${'b'.repeat(64)}`);
      expect(lines.some((l) => l.startsWith('entry C '))).toBe(false);
    });

    test('D2: a name it placed gets the new digest in place of the old line', () => {
      const sb = sandbox();
      const out = mark(sb, { existing: old(sb), placed: ['A'] });
      const a = entryLines(out).filter((l) => l.startsWith('entry A '));
      expect(a).toHaveLength(1);
      expect(a[0]).not.toContain('a'.repeat(64));
      expect(a[0]).toMatch(/^entry A sha256:[0-9a-f]{64}$/);
    });

    test('D2: with nothing placed every line of a name that still exists is kept, byte for byte', () => {
      const sb = sandbox();
      const out = mark(sb, { existing: old(sb), placed: [], keepC: true });
      expect(out).toBe(old(sb));
    });

    test('D2: a name with spaces (the ai-config sidecar one) is kept whole, and replaced whole when placed', () => {
      const sb = sandbox();
      const dir = path.join(sb.root, 'dir');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'My File.md'), 'x');
      fs.writeFileSync(path.join(dir, 'A'), 'a1');
      const line = `entry My File.md sha256:${'d'.repeat(64)}`;
      fs.writeFileSync(path.join(dir, MARKER), `source=${sb.repo}\n${line}\n`);
      expect(shell(sb, 'write_marker "$@"', path.join(dir, MARKER), path.join(dir, 'A')).status).toBe(0);
      expect(fs.readFileSync(path.join(dir, MARKER), 'utf8').split('\n')).toContain(line);
      expect(shell(sb, 'write_marker "$@"', path.join(dir, MARKER), path.join(dir, 'My File.md')).status).toBe(0);
      const after = fs.readFileSync(path.join(dir, MARKER), 'utf8');
      expect(entryLines(after).filter((l) => l.startsWith('entry My File.md '))).toHaveLength(1);
      expect(after).not.toContain('d'.repeat(64));
    });

    test('D2: a second call with the same arguments leaves the same bytes (rewritten only when it differs)', () => {
      const sb = sandbox();
      const once = mark(sb, { existing: old(sb), placed: ['A'] });
      const marker = path.join(sb.root, 'dir', MARKER);
      const r = shell(sb, 'write_marker "$@"', marker, path.join(sb.root, 'dir', 'A'));
      expect(r.status).toBe(0);
      expect(fs.readFileSync(marker, 'utf8')).toBe(once);
    });

    test('D2: a line that is not an entry line is dropped, as before', () => {
      const sb = sandbox();
      const out = mark(sb, { existing: `source=/elsewhere\nnote from somebody\nentry A\nentry B sha256:${'b'.repeat(64)}\n`, placed: [] });
      expect(out).toBe(`source=${sb.repo}\nentry B sha256:${'b'.repeat(64)}\n`);
    });
  });
});

describe('D3: a copy is made beside its destination and renamed into place only when it is whole', () => {
  // A cp that does part of the job and then kills the installer (SIGKILL, as the adversarial run did) or
  // just fails. It fires once, for the first copy whose destination is <dest> or <dest>.vivera-tmp-*.
  function cpShim(sb, { dest, dir = false, kill = true }) {
    const real = fs.readlinkSync(path.join(sb.bin, 'cp'));
    const flag = path.join(sb.root, 'cp-fired');
    const part = dir ? 'mkdir -p "$to"; printf partial > "$to/partial.txt"' : 'head -c 10 "$from" > "$to"';
    writeShim(
      sb,
      'cp',
      [
        `real=${JSON.stringify(real)}`,
        'to="${!#}"; from="${@:(-2):1}"',
        'case "$to" in',
        `  *${dest} | *${dest}.vivera-tmp-*)`,
        `    if [ ! -e ${JSON.stringify(flag)} ]; then`,
        `      : > ${JSON.stringify(flag)}`,
        `      ${part}`,
        kill ? '      kill -9 "$PPID"' : '',
        '      exit 1',
        '    fi ;;',
        'esac',
        'exec "$real" "$@"',
      ].join('\n'),
    );
    return flag;
  }
  const ARGS = ['--tier', 'minimal', '--copy', '--only', 'agents'];
  const unshim = (sb, real) => {
    fs.rmSync(path.join(sb.bin, 'cp'), { force: true });
    fs.symlinkSync(real, path.join(sb.bin, 'cp'));
  };

  test('D3: a killed copy of a file leaves no partial beside the user edit: rerun, then --uninstall gives the edit back', () => {
    const sb = sandbox();
    const real = fs.readlinkSync(path.join(sb.bin, 'cp'));
    write(sb, `${PKG}/SKILL.md`, 'my own edit\n');
    cpShim(sb, { dest: '/super-ultra-code-plan/SKILL.md' });
    const killed = sb.run(ARGS);
    expect(killed.status).not.toBe(0);
    expect(read(sb, `${PKG}/SKILL.md.vivera-bak-${STAMP}`)).toBe('my own edit\n');

    unshim(sb, real);
    const again = sb.run(ARGS);
    expect(again.status).toBe(0);
    expect(read(sb, `${PKG}/SKILL.md`)).toBe(fs.readFileSync(path.join(sb.repo, MASTER), 'utf8'));
    // One backup, the user's: the partial copy is never kept as a backup.
    expect(backups(sb)).toEqual([`home/${PKG}/SKILL.md.vivera-bak-${STAMP}`]);
    expect(leftovers(sb)).toEqual([]);

    const gone = sb.run(['--uninstall', ...ARGS]);
    expect(gone.status).toBe(0);
    expect(read(sb, `${PKG}/SKILL.md`)).toBe('my own edit\n');
  });

  test('D3: a killed copy of a directory leaves no partial beside the user edit: rerun, then --uninstall gives the edit back', () => {
    const sb = sandbox();
    const real = fs.readlinkSync(path.join(sb.bin, 'cp'));
    write(sb, `${PKG}/templates/mine.md`, 'my own template\n');
    cpShim(sb, { dest: '/super-ultra-code-plan/templates', dir: true });
    const killed = sb.run(ARGS);
    expect(killed.status).not.toBe(0);

    unshim(sb, real);
    const again = sb.run(ARGS);
    expect(again.status).toBe(0);
    expect(fs.readdirSync(at(sb, `${PKG}/templates`)).sort()).toEqual(fs.readdirSync(path.join(sb.repo, 'templates')).sort());
    expect(backups(sb)).toEqual([`home/${PKG}/templates.vivera-bak-${STAMP}`]);
    expect(leftovers(sb)).toEqual([]);

    const gone = sb.run(['--uninstall', ...ARGS]);
    expect(gone.status).toBe(0);
    expect(fs.readdirSync(at(sb, `${PKG}/templates`))).toEqual(['mine.md']);
  });

  test('D3: a copy that fails (not killed) puts the user file back and leaves no temporary copy', () => {
    const sb = sandbox();
    write(sb, `${PKG}/SKILL.md`, 'my own edit\n');
    cpShim(sb, { dest: '/super-ultra-code-plan/SKILL.md', kill: false });
    const r = sb.run(ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('your file was put back');
    expect(read(sb, `${PKG}/SKILL.md`)).toBe('my own edit\n');
    expect(leftovers(sb)).toEqual([]);
  });

  test('D3: a directory copy that fails (not killed) puts the user directory back and leaves no temporary copy', () => {
    const sb = sandbox();
    write(sb, `${PKG}/templates/mine.md`, 'my own template\n');
    cpShim(sb, { dest: '/super-ultra-code-plan/templates', dir: true, kill: false });
    const r = sb.run(ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('your file was put back');
    expect(fs.readdirSync(at(sb, `${PKG}/templates`))).toEqual(['mine.md']);
    expect(leftovers(sb)).toEqual([]);
    expect(backups(sb)).toEqual([]);
  });

  test('D3: a leftover <dest>.vivera-tmp-<digits> of a killed run is removed before the next copy, other names are not', () => {
    const sb = sandbox();
    write(sb, `${PKG}/SKILL.md.vivera-tmp-4242`, 'half');
    write(sb, `${PKG}/templates.vivera-tmp-77/partial.txt`, 'half');
    const decoys = ['SKILL.md.vivera-tmp-abc', 'SKILL.md.vivera-tmp-', 'SKILL.md.vivera-tmpx', 'SKILL.md.vivera-tmp-12x', 'notes.vivera-tmp-5'];
    for (const d of decoys) write(sb, `${PKG}/${d}`, 'mine');
    const r = sb.run(ARGS);
    expect(r.status).toBe(0);
    expect(lexists(at(sb, `${PKG}/SKILL.md.vivera-tmp-4242`))).toBe(false);
    expect(lexists(at(sb, `${PKG}/templates.vivera-tmp-77`))).toBe(false);
    for (const d of decoys) expect(read(sb, `${PKG}/${d}`)).toBe('mine');
    // A leftover is neither a backup nor user data: nothing was backed up on its account.
    expect(backups(sb)).toEqual([]);
  });

  test('D3: --uninstall also removes the leftover of a killed first install, so the package dir can go', () => {
    const sb = sandbox();
    const real = fs.readlinkSync(path.join(sb.bin, 'cp'));
    cpShim(sb, { dest: '/super-ultra-code-plan/SKILL.md' });
    expect(sb.run(ARGS).status).not.toBe(0);
    expect(leftovers(sb).length).toBe(1);
    unshim(sb, real);
    const r = sb.run(['--uninstall', ...ARGS]);
    expect(r.status).toBe(0);
    expect(leftovers(sb)).toEqual([]);
    expect(lexists(at(sb, PKG))).toBe(false);
  });
});

describe('P1: the hooks step compares the same resolution of the checkout path on both sides', () => {
  // git prints the toplevel in its own spelling. On Git Bash that is C:/..., which bash pwd -P spells
  // /c/...; here the same difference is made with a trailing slash, a path through a symlink, and a ".." hop.
  function hooksSandbox(spelling) {
    const sb = sandbox({ tools: ['git', 'bun'], git: true });
    writeShim(sb, 'graphify', 'exit 0', '/bin/sh');
    const realGit = fs.readlinkSync(path.join(sb.bin, 'git'));
    fs.symlinkSync(sb.repo, path.join(sb.root, 'alias-repo'));
    const printed = spelling(sb);
    writeShim(
      sb,
      'git',
      [
        'if [ "${1:-}" = "-C" ] && [ "${3:-}" = "rev-parse" ] && [ "${4:-}" = "--show-toplevel" ]; then',
        printed === null ? '  :' : `  printf '%s\\n' ${JSON.stringify(printed)}`,
        '  exit 0',
        'fi',
        `exec ${JSON.stringify(realGit)} "$@"`,
      ].join('\n'),
    );
    return sb;
  }
  const hooksPath = (sb) => {
    const r = Bun.spawnSync([Bun.which('git'), '-C', sb.repo, 'config', '--get', 'core.hooksPath'], {
      env: { HOME: sb.home, PATH: path.dirname(Bun.which('git')), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    return { status: r.exitCode, out: r.stdout.toString().trim() };
  };
  const ARGS = ['--only', 'ai-config'];

  const spellings = {
    'with a trailing slash': (sb) => `${sb.repo}/`,
    'through a symlink': (sb) => path.join(sb.root, 'alias-repo'),
    'with a dot-dot hop': (sb) => `${sb.repo}/../repo`,
  };
  for (const [what, spelling] of Object.entries(spellings)) {
    test(`P1: a toplevel printed ${what} is still the checkout of its own`, () => {
      const sb = hooksSandbox(spelling);
      const r = sb.run(ARGS);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('Not a git checkout of its own');
      expect(r.stdout).toContain('[OK] Enabled git hooks: core.hooksPath=.githooks');
      expect(hooksPath(sb)).toEqual({ status: 0, out: '.githooks' });
    });
  }

  test('P1: control: a toplevel that is another directory is not the checkout, and nothing is written', () => {
    const sb = hooksSandbox((s) => s.root);
    const r = sb.run(ARGS);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[SKIP] Not a git checkout of its own; skipping core.hooksPath');
    expect(hooksPath(sb).status).toBe(1);
  });

  test('P1: control: git printing nothing (and exiting 0) is not a checkout, even with the working dir at the checkout', () => {
    // No toplevel must never match, whatever the shell does with cd -P of an empty path: bash 5.3 refuses it,
    // so on this machine the guard cannot be mutation-tested; an older bash was not available to run.
    const sb = hooksSandbox(() => null);
    const r = runIn(sb, sb.repo, ARGS);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[SKIP] Not a git checkout of its own; skipping core.hooksPath');
    expect(hooksPath(sb).status).toBe(1);
  });
});

describe('P2: no bare "${array[@]}" in the files of this chunk', () => {
  // Bash before 4.4 (macOS ships 3.2) treats an empty array as an unbound variable under set -u, so every
  // expansion is written ${a[@]+"${a[@]}"}. A text test is the only one available: no bash 3.2 binary is
  // installed here to run the scripts under. It reads the files and so cannot see an array expanded in a
  // way it does not look for (indirect expansion, eval), which these files do not use.
  const FILES = ['place.sh', 'targets.sh', 'uninstall.sh'];
  const EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]\}/g;

  // Every expansion of a whole array on one line that is not the inner half of the safe form.
  function bareSites(text) {
    const found = [];
    text.split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('#')) return;
      for (const m of line.matchAll(EXPANSION)) {
        const safe = `\${${m[1]}[@]+"`;
        if (!line.slice(0, m.index).endsWith(safe) || m[0].includes('[*]')) found.push(`${i + 1}: ${line.trim()}`);
      }
    });
    return found;
  }

  test('P2: the checker flags the bare forms and accepts the safe one (control)', () => {
    expect(bareSites('for x in "${a[@]}"; do')).toHaveLength(1);
    expect(bareSites('f ${a[@]}')).toHaveLength(1);
    expect(bareSites('f "${a[*]}"')).toHaveLength(1);
    expect(bareSites('for x in ${a[@]+"${a[@]}"}; do')).toEqual([]);
    expect(bareSites('f "${#a[@]}"')).toEqual([]);
    expect(bareSites('# for x in "${a[@]}"; do')).toEqual([]);
  });

  for (const file of FILES) {
    test(`P2: ${file} has no bare array expansion`, () => {
      const text = fs.readFileSync(path.join(import.meta.dir, 'install', file), 'utf8');
      expect(bareSites(text)).toEqual([]);
    });
  }
});

describe('P3: a plain file or a symlink named sucp-<tab>x is not an unusual stale phase dir', () => {
  const ODD = 'sucp-\tx';
  const ARGS = ['--update', '--tier', 'minimal', '--only', 'agents'];

  test('P3: a plain file with a tab in its name is ignored, so the run does not end "left alone"', () => {
    const sb = sandbox();
    write(sb, `${SKILLS}/${ODD}`, 'just a file');
    const r = sb.run(ARGS);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('unusual name');
    expect(r.stdout).not.toContain('left alone');
    expect(r.stdout).toContain('==> Vivera updated');
    expect(read(sb, `${SKILLS}/${ODD}`)).toBe('just a file');
  });

  test('P3: a symlink with a tab in its name (to a directory, and dangling) is ignored too', () => {
    const sb = sandbox();
    fs.mkdirSync(at(sb, SKILLS), { recursive: true });
    fs.mkdirSync(at(sb, 'elsewhere'));
    fs.symlinkSync(at(sb, 'elsewhere'), at(sb, `${SKILLS}/sucp-\tdir`));
    fs.symlinkSync('/nonexistent', at(sb, `${SKILLS}/sucp-\tdangling`));
    const r = sb.run(ARGS);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('unusual name');
    expect(r.stdout).toContain('==> Vivera updated');
  });

  test('P3: control: a real directory with a tab in its name is still reported and left alone', () => {
    const sb = sandbox();
    write(sb, `${SKILLS}/${ODD}/SKILL.md`, 'mine');
    const r = sb.run(ARGS);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('unusual name');
    expect(r.stdout).toContain('==> Vivera finished with 1 entry left alone');
    expect(read(sb, `${SKILLS}/${ODD}/SKILL.md`)).toBe('mine');
  });
});
