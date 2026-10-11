// The git guard for a harness that has no hook to run it: this text asks, and
// cannot enforce. `comment` is the label that says so.
export function proseGuard() {
  return {
    comment: '# guard: instruction only, not enforced by this harness',
    paragraph:
      'Git is owned by the parent session and this harness cannot enforce that, so you must not run git add, commit, checkout, switch, merge, rebase, stash, reset, push or gh. Running git status, diff, log and show is allowed.',
  };
}
