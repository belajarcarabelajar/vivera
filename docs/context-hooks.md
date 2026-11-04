# Context Hooks

Written 2026-11-05. Three opt-in Claude Code command hooks that keep large tool
output out of the context window and restore a short factual state block after a
compaction. They are Claude Code only for now; Codex and OpenCode versions are a
follow-up.

Merging the code installs nothing. Whether the hooks are recommended for daily
use depends on the A/B eval run (tool-result bytes, tokens, cost and pass rate
with and without the hooks). Until that result is in, treat them as an
experiment.

Terms used here (Output cap, Output replacement, Session journal, State block,
Kill switch) are defined in `GLOSSARY.md`.

## 1. What the hooks do

| Hook | Event and matcher | Behavior |
|---|---|---|
| `scripts/hooks/output-cap.mjs` | PreToolUse `Read` | Denies a full-file Read of a file over 16,384 B and names bounded alternatives (Read with `offset` and `limit`, `rg -n`, `sed -n`, `wc -c`). A Read with `offset` or `limit`, a missing file, or a directory always passes. |
| `scripts/hooks/output-replace.mjs` | PostToolUse `Bash` and `mcp__.*` | When an output is over 4,096 B, saves the full text to a file and replaces the output with its first and last 1,024 B plus a line that gives the omitted size and the saved path. Image output is left untouched. |
| `scripts/hooks/session-journal.mjs` | PostToolUse `Edit`, `Write`, `NotebookEdit` and PostToolUseFailure `Bash` (`record`); SessionStart `compact` (`inject`) | Records each edited path and each failed command (first 200 characters and the exit code). After a compaction it injects a state block of at most 2,048 B: branch, HEAD, recently edited paths, last failure, and the last edited plan file. The plan file wins on any difference. |

Every hook exits 0 on any internal error and lets the tool call proceed (fail
open, rule L98); the only deliberate block is the output-cap deny. Shared code
lives in `scripts/lib/hook-io.mjs`.

## 2. Install, check, uninstall

Run from the repository root:

```bash
bun run context:hooks --install     # add the entries to ~/.claude/settings.json
bun run context:hooks --check       # report whether the entries are installed and current
bun run context:hooks --uninstall   # remove only the entries this installer owns
```

`--dry-run` prints the change without writing it, and `--settings <file>`
points at another settings file. The installer keeps every foreign hook entry
(graphify and your own) and refuses a malformed settings file without touching
it. `./install.sh --check` also prints a `context-hooks` row. Start a new Claude
Code session after installing or uninstalling, so the session reads the changed
settings.

## 3. Kill switch, error log, directories

| What | Default path | Override |
|---|---|---|
| State directory | `~/.local/state/vivera/` | `VIVERA_HOOK_STATE_DIR` |
| Kill switch | `~/.local/state/vivera/context-hooks-off` | lives in the state directory |
| Error log | `~/.local/state/vivera/hook-errors.log` | lives in the state directory |
| Scratch directory | `~/.cache/tmp/vivera-scratch/` | `VIVERA_HOOK_SCRATCH_DIR` |
| Saved outputs | `<scratch>/tool-output/<session_id>/<tool_use_id>.txt` | follows the scratch directory |
| Session journals | `<scratch>/journal/<session_id>.jsonl` | follows the scratch directory |

- Kill switch: `touch ~/.local/state/vivera/context-hooks-off` turns every
  context hook into a no-op at once, without a restart. Delete the file to turn
  them back on.
- Error log: one line per internal error, `<ISO time> <hook name> <message>`.
  Check it when a hook seems to do nothing.
- Saved outputs and journals sit in the scratch directory and are not rotated or
  capped; remove a session's folder by hand when it is no longer needed.

## 4. Revert

1. Fast off switch: `touch ~/.local/state/vivera/context-hooks-off`.
2. Remove the hooks: `bun run context:hooks --uninstall` (same as
   `bun scripts/context-hooks-install.mjs --uninstall`), then start a new Claude
   Code session. Confirm with `bun run context:hooks --check`.
3. Remove the data: delete `~/.cache/tmp/vivera-scratch/tool-output/`,
   `~/.cache/tmp/vivera-scratch/journal/`, and the two files above in
   `~/.local/state/vivera/`.
4. Remove the code: revert the commits that added `scripts/hooks/output-cap.mjs`,
   `scripts/hooks/output-replace.mjs`, `scripts/hooks/session-journal.mjs`,
   `scripts/lib/hook-io.mjs`, and `scripts/context-hooks-install.mjs`.
