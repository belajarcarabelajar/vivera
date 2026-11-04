# Glossary

Technical terms of the pipeline. The Harvest Moon flavour terms live in `docs/vivera-glossary.md`.

- **Cache rebuild:** an assistant turn whose cache write exceeds half of its context on a context above 50k tokens.
- **Kill switch:** the file whose presence turns every context hook into a no-op.
- **Output cap:** the PreToolUse rule that refuses a full-file Read over 16,384 B and names bounded alternatives.
- **Output replacement:** swapping a tool output over 4,096 B for its head, tail, size and saved path, with the full text kept in a file.
- **Retired rule ID:** a memory rule ID removed from its topic file and recorded in the `Retired:` line of `MEMORY.md`; never reused.
- **Rule audit:** the read-only report that lists each memory rule with its age, missing cited paths, and linking eval scenarios.
- **Session journal:** the per-session record of edits and failed commands kept by the context hooks.
- **Stale handoff:** an overnight handoff that still says `Result: running` with a `Last update` older than the stale threshold.
- **State block:** the at most 2,048 B factual summary injected after a compaction from the session journal and git.
