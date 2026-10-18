import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitError, gitText } from './git.mjs';

// Isolate from the user's git config so `init` and `rev-parse` behave the same everywhere.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const repos = [];
afterAll(() => {
  for (const d of repos) fs.rmSync(d, { recursive: true, force: true });
});

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-helper-'));
  repos.push(dir);
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  return dir;
}

function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

describe('gitText', () => {
  test('returns stdout of a git command', () => {
    const dir = tempRepo();
    expect(gitText(dir, ['rev-parse', '--is-inside-work-tree'])).toBe('true\n');
  });

  test('passes input on stdin', () => {
    const dir = tempRepo();
    // Known blob id of "hello\n", as printed by `git hash-object --stdin`.
    expect(gitText(dir, ['hash-object', '--stdin'], { input: 'hello\n' }).trim()).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });

  test('throws a GitError whose message starts with the label', () => {
    const dir = tempRepo();
    const e = thrown(() => gitText(dir, ['rev-parse', 'no-such-ref'], { label: 'cannot resolve ref' }));
    expect(e).toBeInstanceOf(GitError);
    expect(e.message.startsWith('cannot resolve ref: ')).toBe(true);
  });

  test('without a label the message starts with git <args> failed', () => {
    const dir = tempRepo();
    const e = thrown(() => gitText(dir, ['rev-parse', 'no-such-ref']));
    expect(e).toBeInstanceOf(GitError);
    expect(e.message.startsWith('git rev-parse no-such-ref failed: ')).toBe(true);
  });

  test("includes git's stderr", () => {
    const dir = tempRepo();
    const e = thrown(() => gitText(dir, ['cat-file', '-p', 'no-such-object']));
    expect(e.message).toContain('Not a valid object name no-such-object');
  });

  test('a spawn error from a missing cwd is a GitError', () => {
    const missing = path.join(os.tmpdir(), `git-helper-missing-${process.pid}-${Date.now()}`);
    const e = thrown(() => gitText(missing, ['status']));
    expect(e).toBeInstanceOf(GitError);
    expect(e.message.startsWith('git status failed: ')).toBe(true);
    expect(e.message).toContain('ENOENT');
  });
});

describe('single helper', () => {
  test('no script defines its own throwing git()', () => {
    const scripts = path.join(import.meta.dir, '..');
    const files = fs
      .readdirSync(scripts, { recursive: true })
      .map((f) => path.join(scripts, f))
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== path.join(import.meta.dir, 'git.mjs'));
    const offenders = files.filter((f) => {
      const m = /^(?:export\s+)?function git\(.*?^\}/ms.exec(fs.readFileSync(f, 'utf8'));
      return m !== null && /\bthrow\b/.test(m[0]);
    });
    expect(offenders.map((f) => path.relative(scripts, f))).toEqual([]);
  });
});
