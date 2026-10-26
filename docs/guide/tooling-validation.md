# Validation & Quality Checks

Run the automated validation suite locally:

```bash
# Install the pinned toolchain (once)
bun install

# Fast runner frontmatter contract check (~1s, pure AST comparison)
bun run contract:check
```

`bun run ci` runs these steps in order, as `scripts/ci-targeted.mjs` defines them:

<!-- include: scripts/ci-targeted.mjs#full-ci -->
```js
const TEST_CMD = ['bun', 'test', '--timeout', '30000'];

// Mirrors the `ci` script; a test keeps them in sync.
export const FULL_CI = [
  { name: 'render-diagrams', cmd: ['bash', 'scripts/render-diagrams.sh'] },
  { name: 'validate-skill', cmd: ['bun', 'scripts/validate-skill.mjs'] },
  { name: 'validate-agents', cmd: ['bun', 'scripts/validate-agents.mjs'] },
  { name: 'gen-sprite-agents', cmd: ['bun', 'scripts/gen-sprite-agents.mjs', '--check'] },
  { name: 'file-size', cmd: ['bun', 'scripts/check-file-size.mjs', '--all'] },
  { name: 'tests', cmd: [...TEST_CMD, 'scripts/'] },
  { name: 'sync-snippets', cmd: ['bun', 'scripts/sync-snippets.mjs', '--check'] },
];
```
<!-- /include -->

For a commit or PR, run `bun run ci:targeted` instead and quote its `--rencana` plan; it chooses the full CI itself when the change needs it.

Verifies:
- YAML frontmatter syntax (`name`, `description`, `triggers`).
- Master file integrity, the debt-sweep contract, and the estimated token budget (~34k tokens, measured at ~4 chars/token).
- Symlink validity in `skills/super-ultra-code-plan/SKILL.md`.
- Presence of all required templates and executable scripts.
- Mermaid syntax validity for every ` ```mermaid` block in the repo (exits 1 on any error).
- `accTitle` and `accDescr` present on every diagram.
- Both mermaid config files parse and pin `theme` + `fontFamily`.
- The committed README hero exists in light and dark.
- `ultra-plan-runner` enforces the visual map: task headings, task nodes, and `depends_on` matching the Mermaid edges in both directions.
- Trigger snippets carry the mandatory subagent contract and use Bun rather than the prohibited runtimes.
- The Confirmation Protocol is pinned (block 3l of `scripts/validate-skill.mjs`): `sucp-rules` holds the section and its key rules, the orchestrator and every phase skill point at it by name, the debt sweep and its follow-up template state the 4-option cap, and the old typed-approval phrases (`wait for explicit yes`, `nod sufficient`, `wait for explicit approval before plan`) are gone. The `CONFIRMATIONS:` paragraph in every trigger snippet is pinned by `bun test scripts/`.
- `snippets.manifest.json` is consistent: valid, complete, no duplicate uuid or keyword, and every trigger snippet is tracked.
- The plan-publishing contract is documented: publisher CLI reference, idempotency marker, and a valid `plans.publish.json`.

Not covered by `bun run ci`, on purpose: `mirror:check`, which needs a vault this runner
cannot see. Run it locally when you own the vault.

## Code Blocks Copied From Source

A code block in a docs page can be a copy of a source file. The copy stays in the page, so GitHub shows it, and a check fails when it no longer matches its source:

````markdown
<!-- include: scripts/ci-targeted.mjs#full-ci -->
```js
...the lines between the region markers...
```
<!-- /include -->
````

- Without `#<region>` the block is the whole file. A region is the lines between `docs-include:start <region>` and `docs-include:end <region>`, written in the source file's own comment syntax; the marker lines and the common indentation are left out.
- `bun run docs:include` and `bun scripts/docs-gen.mjs --check` report a block that differs from its source, a missing file or region, and a malformed block, each as `file:line`. `bun scripts/docs-include.mjs --write` refreshes the stale blocks.
- `bun run ci:targeted` plans the docs checks when a file that an include names changes, so an edit to the source alone is caught too.
- An example inside a fenced block, like the one above, is not checked. The Indonesian twin keeps each include block byte for byte and translates only the text around it.

## Platform Matrix

`.github/workflows/platforms.yml` runs the installer suites on the platforms this machine does not have. Like the other workflows it has no automatic trigger; run it by hand with `gh workflow run platforms.yml` and follow it with `gh run watch`. GitHub only offers it once the file is on the default branch.

| Job | Runner | What it proves |
|---|---|---|
| `windows` | `windows-latest`, once with `pwsh` and once with Windows PowerShell 5.1 | the `install-ps1*` suites on real Windows; the job fails when the shell is missing or of the wrong edition, so the suites cannot skip every test and pass |
| `macos` | `macos-latest` with `/bin/bash` 3.2 first on `PATH` | the `install-*` and `prereq` suites, and `install.sh --dry-run`, under the bash macOS ships |
| `docker` | `ubuntu-latest` | the `Dockerfile` builds and `install.sh --check` passes inside the image |

`bun test scripts/workflows.test.mjs` asserts that every workflow stays dispatch-only.
