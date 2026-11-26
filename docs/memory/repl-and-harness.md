# REPL and harness

> Part of the rule handbook indexed in [MEMORY.md](../../MEMORY.md). Rule IDs are global and never reused.

| # | Rule (`WHEN <situation> → DO <action>, NOT <anti-pattern>`) | Origin session |
|---|---|---|
| L124 | WHEN a REPL script uses a path or value that an earlier script set → DO declare it again in this script, or keep it on `self` and check it, NOT rely on the earlier script's `const` (measured 2026-11-26: in a sample of 58 `ReferenceError` script failures, 55% named a variable an earlier script defined; 78% of these failures were in subagents) | tool-call audit 2026-11-26 (11,265 transcripts) |
| L125 | WHEN writing REPL code → DO use `$`, `file()`, `write()` and `JSON.parse(JSON.stringify(x))`, NOT `Bun`, `process`, `Buffer`, `fetch`, `structuredClone`, `TextEncoder` or `require` (the context is sealed; 29% of the sampled `ReferenceError` failures) | tool-call audit 2026-11-26 (11,265 transcripts) |
| L126 | WHEN a REPL `$` command's non-zero exit is information (no match, files differ, a probe) → DO add `.nothrow()` and read `exitCode`, NOT a bare `await` (a `ShellError` stops the script: 410 failed scripts, rising to 2.2 per 1k turns) | tool-call audit 2026-11-26 (11,265 transcripts) |
| L127 | WHEN checking whether several paths exist → DO one shell call (`ls -d a b c 2>&1` or `test -e`), NOT a Read with `limit` 0 or 1 per path (656 failed Read probes) | tool-call audit 2026-11-26 (11,265 transcripts) |
| L128 | WHEN counting failed tool calls in Claude Code transcripts → DO count direct results (`toolu_*`) and failed REPL scripts (`repl-error-*`) as round trips, report `repl_*` results inside a script apart, dedupe resumed copies, and bucket calls and errors by the same timestamp, NOT sum every `is_error` (measured: 22,534 raw errors, 10,850 that cost a turn) | tool-call audit 2026-11-26 (11,265 transcripts) |
