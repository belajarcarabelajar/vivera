// scripts/lib/atomic-write.mjs
//
// One function: write a file so a reader never sees a half-written one, and so
// the previous content survives a crash mid-write.
//
// WHY THIS EXISTS, measured rather than assumed.
//
// Three files in this repository are live coordination state, all of them
// gitignored, all of them written by a bare `writeFileSync`:
//
//   scripts/pr-registry.mjs:150      pr.registry.json    — which session owns which branch/worktree
//   scripts/plan-issue-sync.mjs:137  plan.issues.json    — the plan ⇄ GitHub issue mapping
//   scripts/plan-mark-done.mjs:561   <plan>.md           — the durable plan record itself
//
// `writeFileSync` opens the target with O_TRUNC and then writes. A crash, an
// OOM kill, a full disk, or a Ctrl-C in that window leaves a truncated JSON file
// or a half-written plan. For the first two that is unrecoverable by design: they
// are gitignored *because* they are machine-local, so `git checkout` has nothing
// to restore and the machine has no second copy. The plan file at least survives
// in git, but the next `plan-mark-done` run would then read a truncated document
// and rewrite the truncation back over the good copy.
//
// The fix is the standard one and it is not subtle: write a sibling temp file in
// the SAME directory (same filesystem, so rename is atomic), fsync it, then
// `renameSync` over the target. A reader either sees the old bytes or the new
// bytes, never a mixture, and the rename is atomic on POSIX. The temp file is
// unlinked if anything throws, so a failed write leaves no debris.
//
// THE BACKUP IS ONE GENERATION, DELIBERATELY.
//
// `keepBackup` copies the current content to `<target>.bak` before the rename.
// One generation is the whole point: a `.bak` that grows into a version history
// becomes an untracked directory nobody prunes, and a backup nobody prunes is not
// a safety net. It answers exactly one question — "what did this file contain a
// moment ago?" — and the moment after a corrupt write is the only moment that
// question has a useful answer.
//
// WHAT THIS DOES NOT DO, because it is not a lock.
//
// Two processes writing the same file in the same window can still interleave:
// A reads, B reads, A renames, B renames, A's write is gone. Atomicity makes each
// individual write indivisible; it does not serialise them. `pr-registry.mjs`
// guards that case separately with `assertNoCollisions`, which REFUSES a duplicate
// branch or worktree on both load and save — a loud failure after the fact rather
// than a silent merge. Making it a mutual exclusion would need a lock file, a
// stale-lock policy, and a decision about what a crashed lock holder does to the
// next one; that is a design change with its own failure modes, and this module
// does not smuggle it in under the heading "atomic write".
//
// REVERT: delete this file, and the three call sites revert to `writeFileSync`.

import { writeFileSync, readFileSync, renameSync, unlinkSync, existsSync, copyFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';

/**
 * Write `text` to `target` so no reader can observe a partial file.
 *
 * @param {string} target        absolute or cwd-relative destination path
 * @param {string} text          full content to write
 * @param {object} [opts]
 * @param {boolean} [opts.keepBackup]  copy the current content to `<target>.bak` first
 * @returns {string} the path written
 */
export function writeFileAtomic(target, text, { keepBackup = false } = {}) {
  const dir = path.dirname(path.resolve(target));
  // Same directory as the target, not the OS temp dir: rename(2) is only atomic
  // within one filesystem, and /tmp is routinely a different mount.
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`);

  let fd;
  try {
    writeFileSync(tmp, text, 'utf8');
    // fsync before the rename. Without it the rename can reach the directory
    // entry while the file's data is still only in the page cache, and a power
    // loss leaves a correctly-named file with no contents — which is the exact
    // failure this module exists to prevent, just at a larger blast radius.
    fd = openSync(tmp, 'r+');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (keepBackup && existsSync(target)) copyFileSync(target, `${target}.bak`);
    renameSync(tmp, target);
    return target;
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed or never opened */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort: never mask the real error */ }
    throw err;
  }
}

/**
 * Read `<target>.bak` if it exists, else null. Exported so a caller can offer a
 * one-step recovery instead of telling the user to go and look for the file.
 */
export function readBackup(target) {
  const bak = `${target}.bak`;
  return existsSync(bak) ? readFileSync(bak, 'utf8') : null;
}