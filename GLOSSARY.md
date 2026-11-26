# Glossary

Technical terms of the pipeline. The Harvest Moon flavour terms live in `docs/vivera-glossary.md`.

- **Cache rebuild:** an assistant turn whose cache write exceeds half of its context on a context above 50k tokens.
- **Close-out pull request:** one pull request per repository that only flips plan status to `Complete` and ticks step boxes, for plans the owner chose to close after their work landed.
- **DONE-ASSERTED:** a plan task with no check command (an empty `skip_if` or the `false` sentinel) whose step boxes are all ticked; counted as done and labelled asserted.
- **Due list:** the landed plans that measure READY and are not kept open at their current hash.
- **Kept-open record:** the owner's "keep open" answer for a plan, stored with the plan's hash and a reason; it lapses when the plan text changes.
- **Retired rule ID:** a memory rule ID removed from its topic file and recorded in the `Retired:` line of `MEMORY.md`; never reused.
- **Rule audit:** the read-only report that lists each memory rule with its age, missing cited paths, and linking eval scenarios.
- **Stale handoff:** an overnight handoff that still says `Result: running` with a `Last update` older than the stale threshold.
