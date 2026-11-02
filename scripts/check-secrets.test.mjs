// scripts/check-secrets.test.mjs
//
// The secret gate's CLI end to end, against temporary git repositories: the three
// modes, the exit codes, the report format, the attribute opt-out and, above all, the
// RED proof that a planted credential is refused and a clean tree passes. Credentials
// are assembled at run time, so this file passes the gate it tests.
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const CHECKER = path.join(ROOT, 'scripts', 'check-secrets.mjs');
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
};

const alnum = (n) => 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cF'.repeat(3).slice(0, n);
const TOKEN = `${'1234567'}${'890'}:${alnum(35)}`; // a Telegram bot token shape, assembled
const HOME = (u) => `/home/${u}/project`;

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-secrets-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(dir, message = 'c') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function run(dir, ...args) {
  const r = spawnSync('bun', [CHECKER, ...args], { cwd: dir, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('RED proof: a planted credential is refused, a clean tree passes', () => {
  test('--staged', () => {
    const dir = repo();
    write(dir, 'README.md', 'clean\n');
    commit(dir);
    write(dir, 'src/leak.txt', `a\nTOKEN_X = '${TOKEN}'\n`);
    git(dir, 'add', 'src/leak.txt');
    const red = run(dir, '--staged');
    expect(red.code).toBe(1);
    expect(red.err).toContain('[secret-gate] src/leak.txt:2 telegram-bot-token');
    expect(red.out.trim().split('\n').pop()).toBe('checked 1 files, 1 findings');
    // the value is in neither stream
    expect(red.out + red.err).not.toContain(TOKEN);
    expect(red.out + red.err).not.toContain(alnum(35));
    write(dir, 'src/leak.txt', 'a\nclean now\n');
    git(dir, 'add', 'src/leak.txt');
    const green = run(dir, '--staged');
    expect(green.code).toBe(0);
    expect(green.err).toBe('');
  });

  test('--diff <base>', () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\n');
    commit(dir);
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'b.txt', `x ${TOKEN}\n`);
    commit(dir, 'leak');
    const red = run(dir, '--diff', 'main');
    expect(red.code).toBe(1);
    expect(red.err).toContain('[secret-gate] b.txt:1 telegram-bot-token');
    write(dir, 'b.txt', 'x clean\n');
    commit(dir, 'fix');
    expect(run(dir, '--diff', 'main').code).toBe(0);
  });

  test('--diff reads an untracked new file whole', () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\n');
    commit(dir);
    write(dir, 'new/untracked.txt', `l1\nl2 ${TOKEN}\n`);
    const r = run(dir, '--diff', 'main');
    expect(r.code).toBe(1);
    expect(r.err).toContain('[secret-gate] new/untracked.txt:2 telegram-bot-token');
  });

  test('--all', () => {
    const dir = repo();
    write(dir, 'old.txt', `${TOKEN}\n`);
    write(dir, 'ok.txt', 'fine\n');
    commit(dir);
    const r = run(dir, '--all');
    expect(r.code).toBe(1);
    expect(r.err).toContain('[secret-gate] old.txt:1 telegram-bot-token');
    expect(r.out.trim().split('\n').pop()).toBe('checked 2 files, 1 findings');
  });
});

describe('added lines only (--staged and --diff)', () => {
  test('an old finding does not block an unrelated edit, a new one does', () => {
    const dir = repo();
    write(dir, 'old.txt', `${TOKEN}\nfine\n`);
    commit(dir);
    write(dir, 'old.txt', `${TOKEN}\nfine\nmore\n`);
    git(dir, 'add', 'old.txt');
    expect(run(dir, '--staged').code).toBe(0);
    write(dir, 'old.txt', `${TOKEN}\nfine\nmore\n${TOKEN}\n`);
    git(dir, 'add', 'old.txt');
    const r = run(dir, '--staged');
    expect(r.code).toBe(1);
    expect(r.err).toContain('old.txt:4 telegram-bot-token');
    expect(r.err).not.toContain('old.txt:1 ');
  });

  test('a pure rename adds no lines and passes, a deleted file is ignored', () => {
    const dir = repo();
    write(dir, 'old.txt', `${TOKEN}\n${alnum(40)}\n${alnum(41)}\n`);
    write(dir, 'gone.txt', `${TOKEN}\n`);
    commit(dir);
    git(dir, 'mv', 'old.txt', 'renamed.txt');
    git(dir, 'rm', '-q', 'gone.txt');
    expect(run(dir, '--staged').code).toBe(0);
  });

  test('an empty stage prints nothing and exits 0', () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\n');
    commit(dir);
    const r = run(dir, '--staged');
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toBe('');
  });
});

describe('rules through the CLI', () => {
  test('personal data fires, a waiver with a reason clears it, test files may hold addresses', () => {
    const dir = repo();
    write(dir, 'src/a.ts', `const home = '${HOME('alice')}';\nconst ip = '10.0.0.5';\n`);
    write(dir, 'src/a.test.ts', "const ip = '10.0.0.5';\n");
    commit(dir);
    const r = run(dir, '--all');
    expect(r.code).toBe(1);
    expect(r.err).toContain('src/a.ts:1 home-path');
    expect(r.err).toContain('src/a.ts:2 private-ip');
    expect(r.err).not.toContain('a.test.ts');
    expect(r.err).toContain('cannot be waived');
    const waiver = `// secrets:${' '}allow demo values`;
    write(dir, 'src/a.ts', `${waiver}\nconst home = '${HOME('alice')}';\n${waiver}\nconst ip = '10.0.0.5';\n`);
    commit(dir);
    expect(run(dir, '--all').code).toBe(0);
  });

  test('the -secret-gate attribute opts a path out', () => {
    const dir = repo();
    write(dir, 'streams/a.jsonl', `{"cwd":"${HOME('alice')}"}\n`);
    write(dir, 'other.txt', 'fine\n');
    commit(dir);
    expect(run(dir, '--all').code).toBe(1);
    write(dir, '.gitattributes', 'streams/*.jsonl -secret-gate\n');
    commit(dir, 'attr');
    const r = run(dir, '--all');
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n').pop()).toBe('checked 2 files, 0 findings'); // other.txt and .gitattributes
  });

  test('a binary file is skipped even if it contains a token', () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`${TOKEN}\n`)]));
    write(dir, 'ok.txt', 'fine\n');
    commit(dir);
    expect(run(dir, '--all').code).toBe(0);
  });
});

describe('usage and failure exits', () => {
  test('no mode, two modes, a missing value and an unknown flag exit 2 with a usage line', () => {
    const dir = repo();
    for (const args of [[], ['--staged', '--all'], ['--diff'], ['--nope']]) {
      const r = run(dir, ...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain('usage: bun scripts/check-secrets.mjs');
    }
  });

  test('outside a git repository it exits 2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-secrets-nogit-'));
    dirs.push(dir);
    const r = run(dir, '--all');
    expect(r.code).toBe(2);
    expect(r.err).toContain('not a git repository');
  });

  test('--diff with an unknown base exits 2', () => {
    const dir = repo();
    write(dir, 'a.txt', 'one\n');
    commit(dir);
    expect(run(dir, '--diff', 'nope-branch').code).toBe(2);
  });
});

describe('the gate passes on its own files', () => {
  test('--all over a copy of the checker, the library and both tests exits 0', () => {
    const dir = repo();
    for (const rel of ['scripts/check-secrets.mjs', 'scripts/check-secrets.test.mjs', 'scripts/lib/secret-patterns.mjs', 'scripts/secret-patterns.test.mjs']) {
      write(dir, rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    }
    commit(dir);
    const r = run(dir, '--all');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });
});
