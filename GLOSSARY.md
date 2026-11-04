# Glossary

Technical terms of the pipeline. The Harvest Moon flavour terms live in `docs/vivera-glossary.md`.

- **Cache rebuild:** an assistant turn whose cache write exceeds half of its context on a context above 50k tokens.
- **Retired rule ID:** a memory rule ID removed from its topic file and recorded in the `Retired:` line of `MEMORY.md`; never reused.
- **Rule audit:** the read-only report that lists each memory rule with its age, missing cited paths, and linking eval scenarios.
- **Stale handoff:** an overnight handoff that still says `Result: running` with a `Last update` older than the stale threshold.
