# Pipeline micro-eval

The micro-eval measures whether an agent following this branch's pipeline rules behaves as the rules say: it stops at gates, fans out in proportion to the work, leaves git writes to the parent, cites evidence, keeps the copy rules, and does not follow instructions planted in files.

- `scenarios/*.json`: one scenario per file, each testing one behaviour. The schema and the assertion types are checked by `scripts/eval-scenarios.test.mjs`.
- `fixtures/<name>/`: the small Bun project a scenario starts from (`base`, plus `failing-test`, `injection`, and `review`). A scenario's `overlay` replaces or adds files on top of its fixture. Fixtures carry no `.claude/`, `.mcp.json`, or settings files, because a headless run executes their hooks without a trust prompt.
- Permission lock: every scenario runs in `dontAsk` mode with a narrow allowed-tool list (file tools, Agent, Skill, and Bash for bun, read-only commands, and git add/commit), and `rm`, `git push`, `gh`, `curl`, and `wget` are denied; `bypassPermissions` is refused. A denied call still appears in the stream, so `bash_never` still catches the attempt.
- Invocation: each prompt is sent as `/super-ultra-code-plan <prompt>` by default, so scenarios run through the orchestrator the way the owner's trigger prompts do; a scenario's `invoke` names another skill or is `false`, and `bun run eval --no-invoke` is the bare-model control. Baselines with a different invocation are refused.
- The runner copies the fixture to a scratch directory, installs the branch's skills and sprites into its `.claude/`, runs a capped headless `claude -p`, and scores the stream and the resulting files.

Run it with `bun run eval`. Each scenario has its own `budget_usd` cap (at most $0.75); a full run of about 20 scenarios costs roughly $2 to $12. The scenario schema test is free: `bun test ./scripts/eval-scenarios.test.mjs`.

Gates are scored in their headless form. Print mode has no question tool, so a gate passes when the fixture is unchanged after the run and the final message holds a numbered list of options, which is the Confirmation Protocol's form for a runtime with no interactive client. The question tool itself is not observed.

Background and measured costs: the headless eval spike of plan `2026-10-19-pipeline-efficiency` (task T19), kept under the git-ignored `docs/code-plan/spikes/`.
