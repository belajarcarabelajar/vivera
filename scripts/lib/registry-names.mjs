// scripts/lib/registry-names.mjs
//
// The names a PR registry slot derives from its plan and session ids, split out
// of scripts/pr-registry.mjs, which re-exports them.

import path from 'node:path';

// Branch and worktree names have to survive a POSIX filesystem, a git ref, and
// a shell. Everything outside this set collapses to a single dash so two
// different inputs can never produce the same slot by differing only in
// punctuation.
export function slugify(input, label) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  const collapsed = input.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  // Checked before trimming, so a leading dot or dash is refused rather than
  // quietly trimmed into a legal-looking name. `git check-ref-format` rejects
  // both, and a branch the push cannot create is a slot the session cannot use.
  if (collapsed.startsWith('.') || collapsed.startsWith('-') || collapsed.includes('..')) {
    throw new Error(`${label} "${input}" normalises to "${collapsed}", which is not a legal branch segment`);
  }
  const slug = collapsed.replace(/-+$/g, '');
  if (slug === '') throw new Error(`${label} "${input}" contains no usable characters`);
  return slug;
}

// No tool prefix. A branch name is part of the repository's permanent history, so
// it is written to look like a branch a person would have written. A leading
// `ai/` (or any vendor, agent, or workflow marker) asserts an authorship nobody
// asked to assert, and it is the same defect as the `Generated with <tool>`
// footer this repository already forbids: an unrequested claim about who made
// the change, in an artifact nobody can redact afterwards. The plan id already
// dates and describes the work, so the prefix carried no information either.
//
// Revert: put `ai/` back in the template literal and update the two assertions in
// pr-registry.test.mjs that name the shape. Slots already recorded in
// pr.registry.json keep whatever branch they claimed, so the change is
// forward-only and needs no migration.
export function branchFor(planId, sessionId) {
  return `${slugify(planId, 'plan id')}/${slugify(sessionId, 'session id')}`;
}

// The worktree lives beside the repository, never inside it. A worktree nested
// in the repository it checks out is picked up by the parent's file watchers,
// formatters, and test globs, which then operate on two copies of the same file.
//
// `root` (the CLI passes VIVERA_WORKTREE_ROOT) moves the `<repo>-wt` directory
// onto another disk: the laptop's internal NVMe kept filling with worktrees, so
// ~/.bashrc points it at the external disk (user decision 2026-10-29) and
// `claim --worktree` creates the worktree with `wt-new`, which links
// node_modules back to the main checkout on the internal disk. Without it the
// worktree stays beside the repository.
export function worktreeFor(repoRoot, sessionId, root) {
  return path.join(worktreesDirFor(repoRoot, root), slugify(sessionId, 'session id'));
}

// The `<repo>-wt` container that holds every slot of `repoRoot`. Exported so
// the plan publisher derives the same directory instead of a copy that drifts.
export function worktreesDirFor(repoRoot, root) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new Error('repo root must be a non-empty string');
  }
  const base = path.basename(path.resolve(repoRoot));
  const parent = root ? path.resolve(root) : path.dirname(path.resolve(repoRoot));
  return path.join(parent, `${base}-wt`);
}
