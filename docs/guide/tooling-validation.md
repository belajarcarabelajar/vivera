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

Or run the whole gate in order with `bun run ci`. For a commit or PR, run `bun run ci:targeted` instead and quote its `--rencana` plan; it chooses the full CI itself when the change needs it.

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
