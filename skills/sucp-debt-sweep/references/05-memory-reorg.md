### 🗂️ Memory reorg: audit the rule handbook and retire rules

The rule handbook is `MEMORY.md` (the index) plus the topic files under `docs/memory/`. Rules pile up; this step finds the ones worth a second look. It never retires anything on its own.

**When to run it**

- Once a month.
- When a topic file under `docs/memory/` passes about 12 KB.
- When the owner asks for it.

Otherwise skip this step and say so in one line.

**Run the audit**

```bash
bun scripts/rule-audit.mjs          # table plus a totals line
bun scripts/rule-audit.mjs --json   # the same data as JSON
```

The audit is read-only. Exit 0 is a report, 1 means `docs/memory/` is missing, 2 is a usage error.

**Read it**

| Column | What it tells you |
|---|---|
| First seen | The date git first saw the row; `unknown` when history is missing. An old rule is not a stale rule on its own. |
| Missing paths | Backticked repo paths the row cites that no longer exist. Fix the path, or treat the rule as a retire candidate. Paths in `other-repositories.md` are not checked. A gitignored path (such as `docs/code-plan/`), a short path that is the tail of a tracked file (`lib/test-paths.mjs` for `scripts/lib/test-paths.mjs`), and a short path that repeats the tail of a longer path in the same row are not reported. Without git these checks are off, so more paths show. |
| Scenarios | Eval scenarios whose `rules` array links the rule. "no scenario" means no eval covers it yet. It does not mean the rule is unused. |

**Retire a rule (human decision)**

Retiring is the owner's call. List the candidates with the reason for each (a missing path, a rule a newer one replaced, a tool that is gone) and ask through the question tool, one question with the candidates as options. Retire only what the owner picks. For each one:

1. Remove its row from the topic file.
2. Remove its ID from that topic's row in the `MEMORY.md` table.
3. Add the ID to the `Retired:` line in `MEMORY.md` (replace `(none)`; keep the list comma separated and in ID order). A retired ID is never reused.
4. Run `bun test scripts/memory-index.test.mjs scripts/eval-scenarios.test.mjs` and cite the exit code.
