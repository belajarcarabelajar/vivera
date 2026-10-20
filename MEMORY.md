# MEMORY.md — Distilled Rules

> Domain knowledge handbook. Durable `WHEN → DO → NOT` rules distilled from the Step 6 Learning
> Harvest (`templates/session-learning-ledger-template.md`), split by topic into the files under `docs/memory/` below.
> Each rule passed both the Minimum-Signal NO-OP gate and the 30-Day Horizon test before landing here.
> Moving task state and transient errors do NOT belong here — they expire with the session.

---

## Task Group: vivera repo (super-ultra-code-plan skill maintenance)

| Topic | File | Rules |
|---|---|---|
| Git and delivery | [docs/memory/git-and-delivery.md](docs/memory/git-and-delivery.md) | L8, L16, L17, L18, L19, L21, L22, L25, L28 |
| Gates and tests | [docs/memory/gates-and-tests.md](docs/memory/gates-and-tests.md) | L2, L9, L11, L13, L23, L24, L30, L32, L36, L37, L39, L42, L45, L54, L56, L59, L73, L74, L75, L78, L79 |
| Plans and approvals | [docs/memory/plans-and-approvals.md](docs/memory/plans-and-approvals.md) | L3, L20, L29, L31, L35, L41, L43, L44, L46, L47, L53, L55, L60, L65 |
| Subagents | [docs/memory/subagents.md](docs/memory/subagents.md) | L6, L7, L38, L49, L50, L52, L63, L64, L69 |
| Tools and environment | [docs/memory/tools-and-environment.md](docs/memory/tools-and-environment.md) | L1, L4, L5, L10, L12, L14, L15, L26, L27, L33, L34, L40, L48, L51, L57, L58, L61, L62, L66, L67, L77, L80 |
| Other repositories | [docs/memory/other-repositories.md](docs/memory/other-repositories.md) | L68, L70, L71, L72, L76 |

Find rule L<n>: find it in the Rules column and open that file.

Add a rule:

1. The next ID is one above the highest ID in `docs/memory/`; IDs are never reused.
2. Append the row to its topic file, in ID order.
3. Add the ID to that topic's row in the table above.
4. Run `bun test scripts/memory-index.test.mjs`.
