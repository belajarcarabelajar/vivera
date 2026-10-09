# Snippet Command: Review and Merge If Safe

> Type this on a new line AFTER `prr` (the PR review trigger) in the same message.
> It is the explicit pre-authorization that `prr` requires before it may merge.
> Without it `prr` is review-only. Every AUTO-MERGE gate inside `prr` still applies.

---

Pre-authorized: review and merge if safe. Merge each PR that passes every AUTO-MERGE gate; a PR that fails a gate stays unmerged with its report.
