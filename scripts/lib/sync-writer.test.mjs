// scripts/lib/sync-writer.test.mjs
//
// The write policy these tests pin lives in `sync-writer.mjs`: obsidian-git
// commits and pushes on a 10-minute timer with no human in the loop, so a
// rewrite of unchanged bytes is a real commit and a real push.
//
// That is why the central assertion in this file is a timestamp and not a
// boolean. "Returns `unchanged` is a claim the function makes about itself; an
// mtime that did not move is a fact about the filesystem, and obsidian-git reads
// the fact. So the mtime assertions are written to be unfakeable: the file is
// aged to a fixed 2001 date first, and the assertion is that the age survived
// the call, asserted BEFORE the return value so the timestamp is what fails when
// a write sneaks in. Measured: disabling the byte comparison fails 5 of these 15
// tests, and the first one to fail in each of the two timestamp tests is the
// timestamp, not the return value. A test that could not tell an always-writes
// writer from a correct one would not be evidence for AC-8.
//
// Everything is fixture-local. Each test gets its own `mkdtempSync` under
// `os.tmpdir()`, and no test reads or writes the real vault or the repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncWrite, planWrites, readIfExists } from './sync-writer.mjs';

// ---------- fixtures ----------

function vault(tag) {
  const root = mkdtempSync(path.join(tmpdir(), `sync-writer-${tag}-`));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const cleanup = (f) => f.cleanup();

// A fixed old date, so "mtime changed" is a comparison against a number this
// file chose in advance rather than against a clock reading taken afterwards.
const OLD_MTIME = new Date('2001-01-01T00:00:00.000Z');

const NOTE = '# title\n\nbody\n';

// ---------- 1. the three outcomes ----------

test('a missing file is created, with its parents, and reported as created', () => {
  const f = vault('create');
  try {
    assert.equal(syncWrite(f.root, 'note.md', NOTE), 'created');
    const abs = path.join(f.root, 'note.md');
    assert.ok(existsSync(abs), 'the file the writer claimed to create is not on disk');
    assert.equal(readFileSync(abs, 'utf8'), NOTE);
    // 'created' is a distinct outcome from 'written' because a caller reporting
    // per-run progress needs to say "12 new notes" separately from "3 edited".
    assert.notEqual(syncWrite(f.root, 'note.md', NOTE), 'created');
  } finally {
    cleanup(f);
  }
});

test('identical content leaves the file untouched — not even its mtime', () => {
  const f = vault('unchanged');
  try {
    const abs = path.join(f.root, 'note.md');
    syncWrite(f.root, 'note.md', NOTE);

    // Age the file so that "unchanged" cannot be satisfied by a write that
    // happened to land in the same millisecond as the read.
    utimesSync(abs, OLD_MTIME, OLD_MTIME);
    const before = statSync(abs).mtimeMs;
    assert.equal(before, OLD_MTIME.getTime(), 'the fixture did not take; the test is not measuring what it claims');

    const result = syncWrite(f.root, 'note.md', NOTE);
    const after = statSync(abs).mtimeMs;

    // The mtime is asserted BEFORE the return value, deliberately. `unchanged`
    // is what the function claims about itself; the mtime is what the filesystem
    // says happened, and obsidian-git reads the second one. If only one of these
    // can fail, it should be the one that catches a write.
    assert.equal(after, before, 'the file was rewritten with identical bytes; obsidian-git would push this');
    assert.equal(result, 'unchanged');
    assert.equal(readFileSync(abs, 'utf8'), NOTE, 'and the content is still correct, so the only thing wrong was the write');
  } finally {
    cleanup(f);
  }
});

test('different content is written over the old bytes', () => {
  const f = vault('written');
  try {
    syncWrite(f.root, 'note.md', '# old\n');
    assert.equal(syncWrite(f.root, 'note.md', '# new\n'), 'written');
    const onDisk = readFileSync(path.join(f.root, 'note.md'), 'utf8');
    assert.equal(onDisk, '# new\n', 'a truncated write would leave the tail of the old file behind');
  } finally {
    cleanup(f);
  }
});

// ---------- 2. the path boundary ----------
//
// `relPath` is derived from a note title, and note titles are user text. Without
// a containment check, a title of `../../../.bashrc` is a file write outside the
// vault, into a directory that is very likely under git and very likely pushed.

test('a relPath escaping via .. is refused, and nothing lands outside the vault', () => {
  // The tag is deliberately not the word "escape": the root is printed in the
  // error message, so a fixture named `escape-*` would let a `/escape/i` match
  // pass on the fixture's own directory name instead of the error's wording.
  const f = vault('dotdot');
  const outside = path.join(path.dirname(f.root), 'evil.md');
  try {
    assert.throws(() => syncWrite(f.root, '../evil.md', 'pwned'), (err) => {
      assert.equal(err.code, 'ERR_PATH_ESCAPE');
      // The message has to be actionable: which input, which root, which rule.
      assert.ok(err.message.includes('"../evil.md"'), `the message does not name the rejected path: ${err.message}`);
      assert.ok(err.message.includes(f.root), `the message does not name the root: ${err.message}`);
      assert.ok(err.message.includes('".."'), `the message does not name the broken rule: ${err.message}`);
      assert.match(err.message, /escapes the vault/);
      return true;
    });
    assert.equal(existsSync(outside), false, 'the write escaped despite the throw');
  } finally {
    cleanup(f);
  }
});

test('a relPath escaping through an interior .. segment is refused', () => {
  const f = vault('escape-interior');
  try {
    assert.throws(() => syncWrite(f.root, '01 - Projects/../../evil.md', 'pwned'), { code: 'ERR_PATH_ESCAPE' });
    assert.throws(() => syncWrite(f.root, 'a/b/../../../evil.md', 'pwned'), { code: 'ERR_PATH_ESCAPE' });
  } finally {
    cleanup(f);
  }
});

test('an absolute relPath is refused, including one that happens to sit under the vault', () => {
  const f = vault('escape-abs');
  try {
    assert.throws(() => syncWrite(f.root, '/tmp/evil.md', 'pwned'), { code: 'ERR_PATH_ESCAPE' });
    // An absolute path inside the root is still refused. The caller is expected
    // to pass a relative path; accepting an absolute one is how a caller bug
    // turns into a write to the wrong vault.
    assert.throws(() => syncWrite(f.root, path.join(f.root, 'note.md'), NOTE), { code: 'ERR_PATH_ESCAPE' });
    assert.throws(() => readIfExists(f.root, '/tmp/evil.md'), { code: 'ERR_PATH_ESCAPE' });
  } finally {
    cleanup(f);
  }
});

test('dots inside a name are not traversal: a title may slug to ".."', () => {
  const f = vault('dots-in-name');
  try {
    // A check written as `relPath.includes('..')` refuses these, and then a
    // legitimate note is dropped from the export with no error and no report —
    // a silent data loss that looks exactly like a successful run. The `..` rule
    // is about whole path segments, and these are all legal names.
    const legal = [
      'Wait..what.md',
      '01 - Projects/..archive/old.md',
      'v1..2/notes.md',
      'no..',
    ];
    for (const rel of legal) {
      assert.equal(syncWrite(f.root, rel, NOTE), 'created', `refused a legal path: ${rel}`);
      assert.equal(readFileSync(path.join(f.root, rel), 'utf8'), NOTE);
    }
  } finally {
    cleanup(f);
  }
});

test('a relPath naming the vault root itself, or a directory, is not a note path', () => {
  const f = vault('not-a-note');
  try {
    // '.' and '' resolve to the root directory. Writing a "note" there would
    // fail at the OS level with a confusing EISDIR, long after the caller
    // believed it had picked a target.
    assert.throws(() => syncWrite(f.root, '.', NOTE), { code: 'ERR_PATH_ESCAPE' });
    assert.throws(() => syncWrite(f.root, '', NOTE), { code: 'ERR_PATH_ESCAPE' });
    assert.throws(() => syncWrite(f.root, null, NOTE), { code: 'ERR_PATH_ESCAPE' });
    assert.throws(() => syncWrite(f.root, undefined, NOTE), { code: 'ERR_PATH_ESCAPE' });
  } finally {
    cleanup(f);
  }
});

test('a nested relPath creates every missing parent directory', () => {
  const f = vault('nested');
  try {
    const rel = '01 - Projects/Some Project/2026/notes/deep/note.md';
    assert.equal(syncWrite(f.root, rel, NOTE), 'created');
    const abs = path.join(f.root, rel);
    assert.ok(existsSync(abs));
    assert.ok(statSync(path.dirname(abs)).isDirectory(), 'the file exists but its parents do not');
    assert.equal(readFileSync(abs, 'utf8'), NOTE);
  } finally {
    cleanup(f);
  }
});

// ---------- 3. planWrites: the per-run report ----------

test('planWrites counts a mixed batch and lists only the paths it changed', () => {
  const f = vault('plan-mixed');
  try {
    // One already-identical file, so 'unchanged' is in the batch from the start
    // rather than only on a second pass.
    syncWrite(f.root, 'same.md', 'same\n');
    const entries = [
      { relPath: 'same.md', content: 'same\n' },
      { relPath: 'changed.md', content: 'new body\n' },
      { relPath: 'brand-new.md', content: 'fresh\n' },
    ];
    // Pre-existing but different, so it reports 'written' and not 'created'.
    syncWrite(f.root, 'changed.md', 'old body\n');

    const s = planWrites(f.root, entries);
    assert.equal(s.created, 1);
    assert.equal(s.written, 1);
    assert.equal(s.unchanged, 1);
    assert.equal(s.total, 3);
    // The counts and the list are two renderings of one measurement. If
    // changedPaths ever grew an unchanged entry, this sum would stop holding and
    // the "re-running writes zero files" claim would be a summary nobody checked.
    assert.equal(s.changedPaths.length, s.created + s.written);
    assert.deepEqual([...s.changedPaths].sort(), ['brand-new.md', 'changed.md']);
    assert.equal(s.changedPaths.includes('same.md'), false, 'an unchanged path in changedPaths would be pushed for nothing');
    assert.equal(readFileSync(path.join(f.root, 'changed.md'), 'utf8'), 'new body\n');
  } finally {
    cleanup(f);
  }
});

test('a second identical planWrites changes nothing at all — the AC-8 proof', () => {
  const f = vault('plan-idempotent');
  try {
    const entries = [
      { relPath: 'a.md', content: 'a\n' },
      { relPath: '01 - Projects/b.md', content: 'b\n' },
      { relPath: 'deep/nested/c.md', content: 'c\n' },
    ];
    const first = planWrites(f.root, entries);
    assert.equal(first.created, 3);
    assert.equal(first.written, 0);
    assert.equal(first.unchanged, 0);
    assert.equal(first.changedPaths.length, 3);

    // Age every file, so "the second run changed nothing" is a filesystem
    // observation and not a return value the writer chose.
    const aged = [Date.parse('2001-01-01T00:00:00.000Z'), Date.parse('2002-02-02T00:00:00.000Z')];
    const mtimesBefore = entries.map((e) => {
      const abs = path.join(f.root, e.relPath);
      utimesSync(abs, aged[0], aged[1]);
      return statSync(abs).mtimeMs;
    });

    const second = planWrites(f.root, entries);
    const mtimesAfter = entries.map((e) => statSync(path.join(f.root, e.relPath)).mtimeMs);
    // Timestamps before counts, for the same reason as in the single-write test:
    // a summary the writer fills in is a claim, the mtimes are the evidence.
    assert.deepEqual(mtimesAfter, mtimesBefore, 'a no-op run still bumped a file');
    assert.equal(second.created, 0);
    assert.equal(second.written, 0);
    assert.equal(second.unchanged, 3);
    assert.equal(second.total, 3);
    assert.deepEqual(second.changedPaths, []);
  } finally {
    cleanup(f);
  }
});

test('planWrites over an empty batch is a zero summary, not a crash', () => {
  const f = vault('plan-empty');
  try {
    assert.deepEqual(planWrites(f.root, []), {
      created: 0, written: 0, unchanged: 0, total: 0, changedPaths: [],
    });
  } finally {
    cleanup(f);
  }
});

// ---------- 4. bytes, not strings ----------

test('newlines, unicode and a null byte round-trip byte-identically', () => {
  const f = vault('binary');
  try {
    // A loose comparison (trim, normalise newlines, `==` on a coerced value)
    // would call several of these equal to something they are not. A note
    // carrying a NUL or a CRLF must be compared the way git compares it.
    const rel = '01 - Projects/weird/note.md';
    const body = 'line one\nline two\r\n\ttabbed\ttrailing spaces  \n\n\u00e9\u0141\u4e2d\u6587\ud83d\udcc1\n\u0000\u0001\u007fEND';
    const expected = Buffer.from(body, 'utf8');

    assert.equal(syncWrite(f.root, rel, body), 'created');
    const onDisk = readFileSync(path.join(f.root, rel));
    assert.ok(onDisk.equals(expected), 'the bytes on disk are not the bytes written');

    // A second run must still be 'unchanged': a UTF-8 round trip through a
    // lossy compare would disagree with the buffer here.
    assert.equal(syncWrite(f.root, rel, body), 'unchanged');
    assert.equal(readIfExists(f.root, rel), body);

    // And a single differing byte is enough to be 'written'.
    const bumped = body.replace('\nline two', '\nLine two');
    assert.equal(syncWrite(f.root, rel, bumped), 'written');
    assert.ok(readFileSync(path.join(f.root, rel)).equals(Buffer.from(bumped, 'utf8')));
  } finally {
    cleanup(f);
  }
});

test('an empty file is a real file: empty content is not "missing"', () => {
  const f = vault('empty-file');
  try {
    assert.equal(syncWrite(f.root, 'empty.md', ''), 'created');
    assert.equal(statSync(path.join(f.root, 'empty.md')).size, 0);
    assert.equal(syncWrite(f.root, 'empty.md', ''), 'unchanged');
    assert.equal(syncWrite(f.root, 'empty.md', 'x'), 'written');
  } finally {
    cleanup(f);
  }
});

// ---------- 5. readIfExists ----------

test('readIfExists returns null for a missing path and the content for a real one', () => {
  const f = vault('read');
  try {
    assert.equal(readIfExists(f.root, 'nope.md'), null);
    assert.equal(readIfExists(f.root, '01 - Projects/also/nope.md'), null, 'a missing leaf under a missing dir is still missing');
    assert.equal(readIfExists(f.root, 'note.md'), null);
    syncWrite(f.root, 'note.md', NOTE);
    assert.equal(readIfExists(f.root, 'note.md'), NOTE);
  } finally {
    cleanup(f);
  }
});
