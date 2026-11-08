// scripts/session-cleanup.test.mjs
//
// The worktree a finished session leaves behind is removed without a question,
// against a real bare origin, clone, and worktree in a temp dir. `git worktree
// remove` deletes gitignored files silently, so every test that removes one also
// checks what happened to the ignored files first.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planCleanup, runCleanup } from './lib/session-cleanup.mjs';

const SCRIPT = path.join(import.meta.dir, 'session-cleanup.mjs');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd, ...args) {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env, ...GIT_ENV } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

function cli(...args) {
  const r = Bun.spawnSync(['bun', SCRIPT, ...args], { env: { ...process.env, ...GIT_ENV } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

// origin (bare) <- repo (main checkout) with a worktree for session s1 on branch p/s1.
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-cleanup-'));
  const origin = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  const worktree = path.join(dir, 'repo-wt', 's1');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, repo);
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\nvo/\n');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'p/s1', 'origin/main');
  const put = (root, rel, content) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  // Lands the session branch in origin/main, the way a merged PR does.
  const merge = () => {
    put(worktree, 'b.txt', 'b\n');
    git(worktree, 'add', 'b.txt');
    git(worktree, 'commit', '-q', '-m', 'session work');
    git(worktree, 'push', '-q', 'origin', 'p/s1:main');
  };
  return { dir, repo, worktree, put, merge, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const branches = (repo) => git(repo, 'branch', '--list', '--format=%(refname:short)').split('\n').filter(Boolean);

describe('planCleanup', () => {
  test('sorts ignored files into disposable, identical to the main checkout, unique, and conflicting', () => {
    const f = fixture();
    try {
      f.put(f.worktree, 'node_modules/x/index.js', 'x');
      f.put(f.repo, '.env', 'K=1\n');
      f.put(f.worktree, '.env', 'K=1\n');
      f.put(f.worktree, 'vo/a.mp3', 'audio-a');
      f.put(f.repo, 'vo/b.mp3', 'main-b');
      f.put(f.worktree, 'vo/b.mp3', 'session-b');
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.main).toBe(f.repo);
      expect(p.branch).toBe('p/s1');
      expect(p.disposable).toEqual(['node_modules/']);
      expect(p.identical).toEqual(['.env']);
      expect(p.salvage).toEqual(['vo/a.mp3']);
      expect(p.conflicts).toEqual(['vo/b.mp3']);
      expect(p.blockers.join('\n')).toContain('vo/b.mp3');
    } finally { f.done(); }
  });

  test('a detached HEAD with a commit on no other ref is a blocker, so the commit is not lost', () => {
    const f = fixture();
    try {
      git(f.worktree, 'checkout', '-q', '--detach');
      f.put(f.worktree, 'd.txt', 'd\n');
      git(f.worktree, 'add', 'd.txt');
      git(f.worktree, 'commit', '-q', '-m', 'detached work');
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.branch).toBe(null);
      expect(p.blockers.join('\n')).toMatch(/detached HEAD.*1 commit/);
    } finally { f.done(); }
  });

  test('a build-like name nested inside an ignored data directory is salvaged, not dropped', () => {
    const f = fixture();
    try {
      f.put(f.worktree, 'vo/build/report.json', '{"unique":true}');
      f.put(f.worktree, 'vo/target/take.wav', 'audio');
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.disposable).toEqual([]);
      expect(p.salvage).toEqual(['vo/build/report.json', 'vo/target/take.wav']);
    } finally { f.done(); }
  });

  test('a salvage target whose parent is a file in the main checkout is a conflict, found before anything is copied', () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.repo, 'vo'), 'a file where the worktree has a directory');
      f.put(f.worktree, 'vo/z.wav', 'audio');
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.salvage).toEqual([]);
      expect(p.conflicts).toEqual(['vo/z.wav']);
    } finally { f.done(); }
  });

  test('the processes that ran this cleanup are not blockers, even with their cwd in the worktree', () => {
    const f = fixture();
    try {
      const p = planCleanup({ worktree: f.worktree, procCwds: [{ pid: process.ppid, cwd: f.worktree }] });
      expect(p.blockers).toEqual([]);
    } finally { f.done(); }
  });

  test('a base that looks like an option is refused', () => {
    const f = fixture();
    try {
      expect(() => runCleanup({ worktree: f.worktree, base: '--upload-pack=x', procCwds: [] })).toThrow(/base/);
    } finally { f.done(); }
  });

  test('a disposable directory nested inside an ignored directory is dropped, not salvaged', () => {
    const f = fixture();
    try {
      f.put(f.worktree, 'vo/run/node_modules/pkg/index.js', 'x');
      f.put(f.worktree, 'vo/run/take.wav', 'audio');
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.disposable).toEqual(['vo/run/node_modules/']);
      expect(p.salvage).toEqual(['vo/run/take.wav']);
    } finally { f.done(); }
  });

  test('a text file whose every line is already in the main copy counts as identical; one extra line is a conflict', () => {
    const f = fixture();
    try {
      f.put(f.repo, 'vo/uploads.jsonl', '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
      f.put(f.worktree, 'vo/uploads.jsonl', '{"id":"b"}\n');
      f.put(f.repo, 'vo/log.jsonl', '{"id":"a"}\n');
      f.put(f.worktree, 'vo/log.jsonl', '{"id":"a"}\n{"id":"new"}\n');
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.identical).toEqual(['vo/uploads.jsonl']);
      expect(p.conflicts).toEqual(['vo/log.jsonl']);
    } finally { f.done(); }
  });

  test('a covered log must keep its order and its repeats; anything else is a conflict', () => {
    const f = fixture();
    try {
      const pair = (name, main, wt) => { f.put(f.repo, `vo/${name}`, main); f.put(f.worktree, `vo/${name}`, wt); };
      pair('order.jsonl', 'FOO=2\nFOO=1\n', 'FOO=1\nFOO=2\n');
      pair('dups.jsonl', 'A\nB\n', 'A\nB\nA\nB\nA\n');
      pair('blank.jsonl', 'a\n', 'a\n\n\n');
      pair('bytes.jsonl', Buffer.from([0x61, 0x0a, 0xff, 0x0a]), Buffer.from([0x61, 0x0a, 0xfe, 0x0a]));
      pair('ok.jsonl', 'a\nb\nc\nd\n', 'b\nd\n');
      pair('settings.toml', 'x=1\ny=2\n', 'x=1\n');
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.identical).toEqual(['vo/ok.jsonl']);
      expect(p.conflicts).toEqual(['vo/blank.jsonl', 'vo/bytes.jsonl', 'vo/dups.jsonl', 'vo/order.jsonl', 'vo/settings.toml']);
    } finally { f.done(); }
  });

  test('a binary file is never judged by lines', () => {
    const f = fixture();
    try {
      // A log extension, so only the NUL guard can turn this down.
      f.put(f.repo, 'vo/a.log', Buffer.from([1, 0, 2, 10, 3, 0, 4]));
      f.put(f.worktree, 'vo/a.log', Buffer.from([1, 0, 2, 10]));
      expect(planCleanup({ worktree: f.worktree, procCwds: [] }).conflicts).toEqual(['vo/a.log']);
    } finally { f.done(); }
  });

  // git lists no special files, so the FIFO is only met while walking a directory it shares with a real file.
  test('a FIFO among the ignored files is a blocker, so the copy never blocks on it', () => {
    const f = fixture();
    try {
      f.put(f.worktree, 'vo/a.wav', 'audio');
      expect(Bun.spawnSync(['mkfifo', path.join(f.worktree, 'vo', 'pipe')]).exitCode).toBe(0);
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.salvage).toEqual(['vo/a.wav']);
      expect(p.blockers.join('\n')).toMatch(/not a regular file.*vo\/pipe/);
      expect(runCleanup({ worktree: f.worktree, base: 'main', procCwds: [] }).status).toBe('kept');
      expect(existsSync(path.join(f.repo, 'vo', 'a.wav'))).toBe(false);
    } finally { f.done(); }
  });

  test('a symlink into the main checkout counts as identical, since removing it loses nothing', () => {
    const f = fixture();
    try {
      f.put(f.repo, '.env', 'K=1\n');
      symlinkSync(path.join(f.repo, '.env'), path.join(f.worktree, '.env'));
      const p = planCleanup({ worktree: f.worktree, procCwds: [] });
      expect(p.identical).toEqual(['.env']);
      expect(p.conflicts).toEqual([]);
      expect(p.blockers).toEqual([]);
    } finally { f.done(); }
  });

  test('a process working inside the worktree and uncommitted changes are blockers', () => {
    const f = fixture();
    try {
      f.put(f.worktree, 'a.txt', 'changed\n');
      const p = planCleanup({ worktree: f.worktree, procCwds: [{ pid: 4242, cwd: path.join(f.worktree, 'sub') }] });
      expect(p.blockers.some((b) => b.includes('4242'))).toBe(true);
      expect(p.blockers.some((b) => b.includes('a.txt'))).toBe(true);
    } finally { f.done(); }
  });

  test('refuses the main checkout itself', () => {
    const f = fixture();
    try {
      expect(() => planCleanup({ worktree: f.repo, procCwds: [] })).toThrow(/main checkout/);
    } finally { f.done(); }
  });
});

describe('runCleanup', () => {
  test('removes a merged session worktree and its branch, salvaging a unique ignored file first', () => {
    const f = fixture();
    try {
      f.merge();
      f.put(f.worktree, 'node_modules/x/index.js', 'x');
      f.put(f.worktree, 'vo/a.mp3', 'audio-a');
      const r = runCleanup({ worktree: f.worktree, base: 'main', procCwds: [] });
      expect(r.status).toBe('removed');
      expect(existsSync(f.worktree)).toBe(false);
      expect(readFileSync(path.join(f.repo, 'vo', 'a.mp3'), 'utf8')).toBe('audio-a');
      expect(existsSync(path.join(f.repo, 'node_modules'))).toBe(false);
      expect(branches(f.repo)).not.toContain('p/s1');
    } finally { f.done(); }
  });

  test('a worktree wt-new locked is unlocked and removed: reading it proved the disk is mounted', () => {
    const f = fixture();
    try {
      f.merge();
      git(f.repo, 'worktree', 'lock', '--reason', 'wt-new: disk eksternal /mnt/x, jangan di-prune saat tidak ter-mount', f.worktree);
      const r = runCleanup({ worktree: f.worktree, base: 'main', procCwds: [] });
      expect(r.status).toBe('removed');
      expect(existsSync(f.worktree)).toBe(false);
      expect(r.lines.join('\n')).toMatch(/unlocked \(wt-new lock\)/);
    } finally { f.done(); }
  });

  test('a lock from anyone else is a blocker: the worktree stays locked and in place', () => {
    const f = fixture();
    try {
      f.merge();
      git(f.repo, 'worktree', 'lock', '--reason', 'portable drive', f.worktree);
      const r = runCleanup({ worktree: f.worktree, base: 'main', procCwds: [] });
      expect(r.status).toBe('kept');
      expect(r.lines.join('\n')).toMatch(/locked: portable drive/);
      expect(existsSync(f.worktree)).toBe(true);
      expect(git(f.repo, 'worktree', 'list', '--porcelain')).toMatch(/locked portable drive/);
    } finally { f.done(); }
  });

  test('a wt-new lock on a worktree with a blocker stays in place', () => {
    const f = fixture();
    try {
      git(f.repo, 'worktree', 'lock', '--reason', 'wt-new: disk eksternal /mnt/x', f.worktree);
      f.put(f.worktree, 'a.txt', 'changed\n');
      const r = runCleanup({ worktree: f.worktree, base: 'main', procCwds: [] });
      expect(r.status).toBe('kept');
      expect(git(f.repo, 'worktree', 'list', '--porcelain')).toMatch(/locked wt-new:/);
    } finally { f.done(); }
  });

  test('keeps an unmerged branch after removing its worktree, so no commit is lost', () => {
    const f = fixture();
    try {
      f.put(f.worktree, 'c.txt', 'c\n');
      git(f.worktree, 'add', 'c.txt');
      git(f.worktree, 'commit', '-q', '-m', 'not merged');
      const r = runCleanup({ worktree: f.worktree, base: 'main', procCwds: [] });
      expect(r.status).toBe('removed');
      expect(existsSync(f.worktree)).toBe(false);
      expect(branches(f.repo)).toContain('p/s1');
      expect(r.lines.join('\n')).toMatch(/branch p\/s1 kept/);
    } finally { f.done(); }
  });

  test('a blocker keeps the worktree and copies nothing into the main checkout', () => {
    const f = fixture();
    try {
      f.put(f.worktree, 'vo/a.mp3', 'audio-a');
      f.put(f.repo, 'vo/b.mp3', 'main-b');
      f.put(f.worktree, 'vo/b.mp3', 'session-b');
      const r = runCleanup({ worktree: f.worktree, base: 'main', procCwds: [] });
      expect(r.status).toBe('kept');
      expect(existsSync(path.join(f.worktree, 'vo', 'a.mp3'))).toBe(true);
      expect(existsSync(path.join(f.repo, 'vo', 'a.mp3'))).toBe(false);
      expect(readFileSync(path.join(f.repo, 'vo', 'b.mp3'), 'utf8')).toBe('main-b');
    } finally { f.done(); }
  });

  test('a dry run reports the plan and changes nothing', () => {
    const f = fixture();
    try {
      f.merge();
      f.put(f.worktree, 'vo/a.mp3', 'audio-a');
      const r = runCleanup({ worktree: f.worktree, base: 'main', procCwds: [], dryRun: true });
      expect(r.status).toBe('dry-run');
      expect(r.lines.join('\n')).toContain('vo/a.mp3');
      expect(existsSync(f.worktree)).toBe(true);
      expect(existsSync(path.join(f.repo, 'vo', 'a.mp3'))).toBe(false);
      expect(branches(f.repo)).toContain('p/s1');
    } finally { f.done(); }
  });

  test('a symlink inside an ignored directory is salvaged as a link, not as its target', () => {
    const f = fixture();
    try {
      f.merge();
      mkdirSync(path.join(f.worktree, 'vo'), { recursive: true });
      symlinkSync('/nonexistent/target.mp3', path.join(f.worktree, 'vo', 'link.mp3'));
      const r = runCleanup({ worktree: f.worktree, base: 'main', procCwds: [] });
      expect(r.status).toBe('removed');
      expect(Bun.spawnSync(['readlink', path.join(f.repo, 'vo', 'link.mp3')]).stdout.toString().trim()).toBe('/nonexistent/target.mp3');
    } finally { f.done(); }
  });
});

describe('CLI', () => {
  test('--session reads the worktree and base from the registry; exit 0 when removed', () => {
    const f = fixture();
    try {
      f.merge();
      const registry = path.join(f.dir, 'pr.registry.json');
      writeFileSync(registry, JSON.stringify({ sessions: [{ session: 's1', plan: 'p', branch: 'p/s1', worktree: f.worktree, base: 'main', state: 'merged' }] }));
      const r = cli('--session', 's1', '--registry', registry);
      expect(r.code).toBe(0);
      expect(r.out).toContain('removed');
      expect(existsSync(f.worktree)).toBe(false);
    } finally { f.done(); }
  });

  test('exit 3 when the worktree is kept, and exit 1 for an unknown session', () => {
    const f = fixture();
    try {
      f.put(f.worktree, 'a.txt', 'changed\n');
      const kept = cli('--worktree', f.worktree, '--base', 'main');
      expect(kept.code).toBe(3);
      expect(kept.out).toContain('kept');
      const registry = path.join(f.dir, 'pr.registry.json');
      writeFileSync(registry, JSON.stringify({ sessions: [] }));
      expect(cli('--session', 'nope', '--registry', registry).code).toBe(1);
    } finally { f.done(); }
  });
});

// Claude Code's own worktrees (branch worktree-<name>) next to a sucp session worktree.
function nativeFixture() {
  const f = fixture();
  const wtA = path.join(f.dir, 'repo-wt', 'a');
  const wtB = path.join(f.dir, 'repo-wt', 'b');
  const wtX = path.join(f.dir, 'repo-wt', 'x');
  git(f.repo, 'worktree', 'add', '-q', wtA, '-b', 'worktree-a', 'origin/main');
  f.put(wtA, 'na.txt', 'a\n');
  git(wtA, 'add', 'na.txt');
  git(wtA, 'commit', '-q', '-m', 'native a');
  git(wtA, 'push', '-q', 'origin', 'worktree-a:main');
  git(f.repo, 'worktree', 'add', '-q', wtB, '-b', 'worktree-b', 'origin/main');
  f.put(wtB, 'uncommitted.txt', 'wip\n');
  git(f.repo, 'worktree', 'add', '-q', wtX, '-b', 'feat/x', 'origin/main');
  return { ...f, wtA, wtB, wtX };
}

describe('CLI --native', () => {
  test('removes a merged native worktree, keeps one with uncommitted work (exit 3), and leaves other branches alone', () => {
    const f = nativeFixture();
    try {
      const r = cli('--native', '--repo', f.repo, '--base', 'main');
      expect(r.code).toBe(3);
      expect(existsSync(f.wtA)).toBe(false);
      expect(branches(f.repo)).not.toContain('worktree-a');
      expect(existsSync(f.wtB)).toBe(true);
      expect(r.out).toMatch(/kept .*b:/);
      expect(r.out).toContain('uncommitted.txt');
      expect(existsSync(f.wtX)).toBe(true);
      expect(existsSync(f.worktree)).toBe(true);
      expect(r.out).not.toContain(f.wtX);
      expect(existsSync(f.repo)).toBe(true);
    } finally { f.done(); }
  });

  test('a dry run removes nothing', () => {
    const f = nativeFixture();
    try {
      const r = cli('--native', '--repo', f.repo, '--dry-run');
      expect(r.out).toContain('would remove');
      expect(existsSync(f.wtA)).toBe(true);
      expect(existsSync(f.wtB)).toBe(true);
      expect(branches(f.repo)).toContain('worktree-a');
    } finally { f.done(); }
  });

  test('no native worktrees: exit 0 with a message', () => {
    const f = fixture();
    try {
      const r = cli('--native', '--repo', f.repo);
      expect(r.code).toBe(0);
      expect(r.out).toContain('no native worktrees');
      expect(existsSync(f.worktree)).toBe(true);
    } finally { f.done(); }
  });

  test('--native with --session or --worktree is a usage error', () => {
    for (const r of [cli('--native', '--session', 'x'), cli('--native', '--worktree', '/tmp/x')]) {
      expect(r.code).toBe(1);
      expect(r.out).toContain('usage:');
      expect(r.out).toContain('--native');
    }
  });
});
