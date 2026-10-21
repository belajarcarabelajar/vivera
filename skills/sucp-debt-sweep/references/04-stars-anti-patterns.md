### ⭐ Progress stars
The meter line during the sweep (`sucp-rules`, Output) is one star per debt the sweep found, so 7 debts are 7 stars and 5 debts are 5. The total follows the findings and is never fixed or padded. The stars appear in the chat reply only; the sweep record holds the evidence, never the stars.

- **What counts as a debt:** every candidate in the ranked list from 6.2, `NOW` or `LATER`. Learning-harvest rules (6.2.8) are not debts and get no star.
- **`★` closed, `☆` open, closed ones drawn first.** A debt is closed when its follow-up was executed and verified with fresh evidence. A debt the user declined, or one recorded as `LATER` with a `defer:` line, stays `☆`, and the line says how many are deferred, for example `★★★☆☆ · 3 closed · 2 deferred`.
- **No stars before the ranked list exists.** Once it does, every star starts as `☆`. A sweep that finds no debt prints `0 debt found` instead of stars.
- **The total can grow.** A candidate found by the re-pass after a follow-up batch (6.5) adds a star and the line says `+1 debt`. It stays `☆`, because it goes to the backlog (6.5). Existing stars keep their state.

### 🚫 Anti-Patterns
- Closing the session with a report and no question. A debt sweep that produces prose instead of a selectable question has not run.
- Letting generated Markdown stay invisible to `graphify query` because `graphify update` "should have handled it". It only parses code; run `bun "$VIVERA/scripts/graphify-sync.mjs" --root "$(pwd)"` from the session repository after it, every session (6.6).
- Generic chips (`"Anything else?"`, `"More tests?"`) with no file path and no finish line. Unactionable options waste the user's attention and get ignored.
- Padding to 3-5 items with speculative work, or asking 8 questions because everything looked interesting. Rank first, then cap.
- Turning a follow-up question into a new scope decision. The user picking an item is approval to close known debt inside the same goal, not approval to redesign the feature.
- Re-asking the declined items, or treating "no" as a reason to reopen the verified plan.
- Running a second follow-up round from the re-pass. New debt goes to the backlog; only breakage the follow-up caused is fixed now.
- Doing the follow-ups silently without asking, which violates the check-first contract, or asking and then not doing them, which is worse.
- Closing the session without the plan closeout decision. A plan whose work merged but whose status nobody decided stays `Approved` and its issue stays open; run `--readiness` and ask the `Close plan` gate every time.

```mermaid
flowchart TD
    accTitle: Session-close debt sweep and follow-up injection
    accDescr: Once the plan is done at one hundred percent, harvested debt is ranked into three to five follow-ups and the readiness verdict is shown. One question-tool call asks the follow-ups and the Close plan gate together. Selected follow-ups run as real work and are swept once more, with anything new written to the backlog; then readiness is re-run, and Mark Complete applies only if it is still READY, otherwise the plan records why it stays open. The graphify sync runs last.
    Gate["Plan tasks Done 100%\n+ verification evidence green"] --> Harvest["Harvest debt candidates\nshortcuts, review findings,\nmissing tests/docs, TODOs,\nwarnings, gaps"]
    Harvest --> Rank["Classify NOW vs LATER\nrank by risk x blast radius x cost\ndefault 3-5 items"]
    Rank --> Readiness["6.5.5 steps 1-3: --readiness\nshow verdict and open items"]
    Readiness --> Ask["One question-tool call:\nFollow-ups multi-select\n+ Close plan gate"]
    Ask -->|User selects items| Reopen["Re-open plan to In Progress\nadd follow-up tasks"]
    Ask -->|User selects nothing| Backlog["Record LATER items in backlog\nwith defer markers"]
    Reopen --> Exec["Execute as real work:\nchunk, subagent fan-out,\nTDD, verify, diff audit, commit"]
    Exec --> SweepAgain{"Did the fix create\nnew debt?"}
    SweepAgain -->|"Yes"| Backlog
    SweepAgain -->|"Follow-up broke something"| Fix["Fix the breakage now"]
    Fix --> Recheck
    SweepAgain -->|"No"| Recheck["Re-run --readiness\nafter follow-ups land"]
    Backlog --> Recheck
    Recheck --> CloseGate{"Apply Close plan answer:\nMark Complete and still READY?"}
    CloseGate -->|"Yes"| Complete["status Complete,\npublish, issue sync"]
    CloseGate -->|"No, Keep it open,\nor dismissed"| KeepOpen["Closeout status section:\nverdict, what remains, trigger"]
    Complete --> Graph["6.6 graphify update, then sync"]
    KeepOpen --> Graph
    Graph --> Close(["🏁 Zero-debt session\nor documented deferral"])
```
