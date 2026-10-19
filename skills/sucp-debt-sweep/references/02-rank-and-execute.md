### 🧮 6.3 Rank & Cap: detail

- Default to **3-5 follow-up questions**, ranked by `(leftover risk × blast radius × cheapness to close)`. Cap at 5 so the user can answer in one glance; rank below that always go to a written follow-up backlog in the plan or progress log, not to an extra question batch.
- The follow-ups go into multi-select questions of at most 4 options each, at most 4 questions in the single call, because the Claude Code question tool caps a call at 4 questions and 4 options per question. Group by surface (for example Code, and Docs and tests). The lowest-ranked overflow goes to the written backlog. The last option of the last group is `Nothing, close session`, so a zero-selection submit is never required. The 3 to 5 default counts follow-up items, not tool questions. Every group has 2 to 4 options, so a lone leftover item joins another group. If `Nothing, close session` is ticked together with items, the items run.
- Expand beyond 5 only when the harvested debt is itself more than 5 genuinely independent items, and then state explicitly why the cap was raised. Under-filling is also a defect: never ask a single trivial question when three real ones exist.
- Every candidate is classified `NOW` (closes fully inside this session, no new approval, no destructive action, no external dependency) or `LATER`. `NOW` items become selectable questions. `LATER` items are recorded in the plan's follow-up backlog with an owner-less `defer: <ceiling>, <upgrade-trigger>` line so they survive the session instead of evaporating.

- Banned as a question: anything already `Done 100%`, anything the user never asked about and the plan never touched when the risk is cosmetic, and anything only phrased as a preference question with no code outcome ("would you like me to also..."). A question must resolve into a code change, a test, a doc, or a deletion.

### 🛠️ 6.5 Execute: selected follow-ups run as real work
- A selected follow-up is a task, not a favor. It enters the same pipeline as plan work: chunk it, fan out to subagents, TDD when behavior changes, verification with fresh evidence, diff audit, and commit. No reduced standard, no "quick fix" exemption.
- Re-open the plan status to `In Progress` for the duration, add the item as a numbered follow-up task with its own acceptance criterion and `skip_if`, and close that task when the evidence is green; the plan itself reaches `Complete` only through the closeout decision (6.5.5). The plan file, not the chat, is the record.
- After the batch closes, run the sweep's own short pass once more: did executing item A create new debt in the surface it touched? Any new candidate goes to the same ranked list, and the user is asked again only for genuinely new items.
- A candidate the re-pass finds adds a star to the meter (see Progress stars below).
- Batch the selections into one round. Sequentially asking about each follow-up's sub-steps reproduces the low-value prompting this stage exists to eliminate.
