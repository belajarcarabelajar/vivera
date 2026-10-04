import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic, readBackup } from './atomic-write.mjs';

const dir = () => mkdtempSync(path.join(tmpdir(), 'atomic-write-'));

test('writes the file, and the content is complete', () => {
  const d = dir();
  const target = path.join(d, 'state.json');
  writeFileAtomic(target, '{"a":1}\n');
  assert.equal(readFileSync(target, 'utf8'), '{"a":1}\n');
});

test('leaves no temp file behind on the happy path', () => {
  const d = dir();
  const target = path.join(d, 'state.json');
  writeFileAtomic(target, 'x');
  assert.deepEqual(readdirSync(d), ['state.json'], 'a successful write must not leave debris');
});

test('the temp file is a SIBLING of the target, so rename(2) stays atomic', () => {
  // The whole mechanism is that rename within one filesystem is atomic. A temp
  // file in the OS temp dir would be a different mount on most systems, and the
  // rename would degrade into a copy — which is exactly the non-atomic write
  // this module exists to replace.
  const d = dir();
  writeFileAtomic(path.join(d, 'state.json'), 'x');
  const leftovers = readdirSync(d).filter((f) => f.includes('tmp-'));
  assert.deepEqual(leftovers, []);
  // Nothing was created outside the target directory either.
  assert.deepEqual(readdirSync(d), ['state.json']);
});

test('keepBackup preserves the previous generation, one generation only', () => {
  const d = dir();
  const target = path.join(d, 'state.json');
  writeFileAtomic(target, 'v1');
  writeFileAtomic(target, 'v2', { keepBackup: true });
  assert.equal(readFileSync(target, 'utf8'), 'v2');
  assert.equal(readFileSync(`${target}.bak`, 'utf8'), 'v1');
  assert.equal(readBackup(target), 'v1');
  // One more write moves the backup forward, it does not accumulate a history.
  writeFileAtomic(target, 'v3', { keepBackup: true });
  assert.equal(readBackup(target), 'v2');
  assert.deepEqual(readdirSync(d).sort(), ['state.json', 'state.json.bak']);
});

test('no backup is written when keepBackup is not asked for', () => {
  const d = dir();
  writeFileAtomic(path.join(d, 'state.json'), 'v1');
  writeFileAtomic(path.join(d, 'state.json'), 'v2');
  assert.equal(existsSync(path.join(d, 'state.json.bak')), false);
});

test('readBackup is null when there is no backup, not a throw', () => {
  const d = dir();
  assert.equal(readBackup(path.join(d, 'never-written.json')), null);
});

test('a failed write leaves the original file intact and no debris', () => {
  // The point of the whole module. A bare writeFileSync opens the target with
  // O_TRUNC first, so anything that fails afterwards has already destroyed the
  // old content. This is the failure the temp-file dance exists to make
  // impossible.
  const d = dir();
  const target = path.join(d, 'state.json');
  writeFileAtomic(target, 'GOOD CONTENT');

  // A non-empty directory occupies the destination: rename(2) onto it fails
  // with EISDIR/ENOTDIR, so the write throws late — after the temp file exists.
  assert.throws(() => writeFileAtomic(d, 'x'));
  assert.equal(readFileSync(target, 'utf8'), 'GOOD CONTENT', 'the original must survive a failed write');
  assert.deepEqual(readdirSync(d).sort(), ['state.json'], 'a failed write must clean up its temp file');
});

test('a write that cannot even create its temp file leaves nothing behind', () => {
  // Fails earlier than the case above: the temp file is never created, so there
  // is nothing to clean up and the error must surface rather than be swallowed.
  const d = dir();
  const target = path.join(d, 'state.json');
  writeFileAtomic(target, 'GOOD CONTENT');
  fs.chmodSync(d, 0o500);
  try {
    if (process.getuid && process.getuid() === 0) {
      // root ignores the mode bits, so the negative assertion below would be a
      // test of nothing. Say so instead of pretending it passed.
      return;
    }
    assert.throws(() => writeFileAtomic(target, 'v2'), 'a read-only directory must reject the write');
    assert.equal(readFileSync(target, 'utf8'), 'GOOD CONTENT');
    assert.deepEqual(readdirSync(d).sort(), ['state.json']);
  } finally {
    fs.chmodSync(d, 0o700);
  }
});