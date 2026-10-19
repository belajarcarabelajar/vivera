### 📇 6.6 Sync Session Artifacts to Graphify: local, no model, mandatory (a repo without a graph is offered registration)

- **Order is load-bearing.** `graphify update .` rewrites the code graph and is not known to preserve foreign nodes; running it *after* the sync can discard the document nodes the sync just added. So the sequence is: (1) `graphify update .`, (2) the sync command below.
- **What the sync does.** It runs the deterministic structural layer of the vault-index pipeline over this repository's eligible Markdown (one `document` node per file, its ATX `heading` nodes, and its resolvable `[[wikilinks]]` as `references` edges), then unions them into `graphify-out/graph.json` with the same merge used by the vault rebuild. It is a **local line scan: no LLM call, no API key, no network**, so it does not cross the cloud-extraction boundary recorded in `.graphifyignore`.
- **Run it from the session repository with `--root "$(pwd)"`, in vivera and in every other repository.** The script lives in vivera because the pipeline it reuses lives there, and without `--root` it defaults to vivera's own root, so a bare run from another repository syncs the wrong tree and reports success. With `--root "$(pwd)"` the same command is correct everywhere, vivera included:
  ```bash
  # run from the session repository; VIVERA is wherever vivera is checked out
  VIVERA="${VIVERA:-../vivera}"          # or an absolute path on this machine
  graphify update .                                                    # in the session repo
  bun "$VIVERA/scripts/graphify-sync.mjs" --root "$(pwd)"               # in the session repo
  bun "$VIVERA/scripts/graphify-sync.mjs" --check --root "$(pwd)"       # verify
  ```
  With no file arguments it syncs every eligible repo doc; pass explicit `docs/code-plan/plans/<file>.md` paths to narrow it.
- **It is deterministic and idempotent.** A second run over unchanged files writes byte-identical output, existing graphify-era document ids are remapped rather than duplicated, and every code/concept/rationale node already in the graph is retained. Verify without writing by adding `--check` to the command above (exit 1 = stale), and preview by adding `--dry-run`.

  **This automation does NOT extend to other repositories.** Two measured reasons, both silent: the hook resolves the sync script as `$REPO_DIR/scripts/graphify-sync.mjs`, which does not exist outside vivera, so its `[ -f "$SYNC" ]` guard does nothing without a warning; and it exits 0 early when `graphify-out/graph.json` is absent, so a repo that never built a graph skips the hook forever. A project repository using its own hook directory (for example `.husky`) has no graphify step at all. **Therefore: in any repository other than vivera, run the manual pair above explicitly at session close.** Do not assume the commit hook covered it, and do not treat the absence of a graph as permission to skip without asking (next bullet).

- **A green `--check` is not evidence that your documents are in the graph.** `--check` asserts the node count did not fall, so it reports `CURRENT` just as happily when nothing was indexed as when everything was. A sync pointed at the wrong root can therefore leave the count completely unchanged and still print `CURRENT, exit 0`, while the session's documents sit untouched in a different tree. The node delta is the signal, not the exit code. Preview before writing and read the two numbers that matter:
  ```bash
  # run from the session repository; VIVERA is wherever vivera is checked out
  VIVERA="${VIVERA:-../vivera}"
  bun "$VIVERA/scripts/graphify-sync.mjs" --root "$(pwd)" --dry-run    # read "eligible docs" and the "nodes:" line
  bun "$VIVERA/scripts/graphify-sync.mjs" --root "$(pwd)"               # write
  bun "$VIVERA/scripts/graphify-sync.mjs" --check --root "$(pwd)"       # confirm the delta you previewed
  ```
  `eligible docs: 0`, or a `nodes: X -> X` delta on a session that produced Markdown, means the sync ran against the wrong tree regardless of what it printed. The same shape of failure appears elsewhere: an empty `git status` proves nothing about gitignored artifacts, and a green guard proves only what it measures.
