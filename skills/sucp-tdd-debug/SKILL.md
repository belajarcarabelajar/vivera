---
name: sucp-tdd-debug
description: Phase skill for super-ultra-code-plan Step 4 (test-driven development and systematic debugging). Covers the RED-GREEN-REFACTOR iron law and the bug isolation loop. Load only from super-ultra-code-plan, before the first failing test or bug reproduction.
---

# TDD and Systematic Debugging

> Part of `super-ultra-code-plan`. Read `sucp-rules` too. Next phase: `sucp-verify-deliver`.

## 4️⃣ 🧪 Test-Driven Development (Iron Law)
> 🧪 **Component 3 — Test loop:** RED → GREEN → REFACTOR, repeated for each behavior, executed inside subagents (see Delegation & Execution for chunking, the high fan-out floor, and the gather & synthesize loop).

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```
Code before test → delete, restart. No "reference", no "adapt", no exceptions.
Cycle: RED (one minimal failing test) → verify fails for right reason → GREEN (minimal code to pass) → verify passes, no regressions → REFACTOR (clean up, stay green) → repeat.
| Quality | Good | Bad |
|---|---|---|
| Minimal | One behavior per test | "and" in test name |
| Clear | Name describes behavior | test('test1') |
| Shows intent | Demonstrates desired API | Obscures intended behavior |
Exceptions require explicit human approval: throwaway prototypes, generated code, documentation/configuration-only work, and visual-only changes. Every exception still needs an appropriate verification method.
Red flags — stop, restart: code before test, test passes immediately, can't explain failure, "just this once", "keep as reference", sunk-cost argument, "spirit not ritual" argument.

```mermaid
stateDiagram-v2
    accTitle: Test-driven development cycle
    accDescr: RED to GREEN to REFACTOR, looping back to RED when a test passes immediately or to GREEN when a regression appears, until every behavior is covered and verified.
    [*] --> RED : Write one minimal failing test
    RED --> RED : Test passes immediately? Rewrite — too weak
    RED --> GREEN : Test fails for right reason
    GREEN --> GREEN : Regressions? Fix before continuing
    GREEN --> REFACTOR : All tests pass
    REFACTOR --> RED : Next behavior — repeat cycle
    REFACTOR --> [*] : All behaviors covered & verified

    state RED {
        direction LR
        [*] --> WriteTest
        WriteTest --> RunTest
        RunTest --> ConfirmFail : Exit non-zero
    }
    state GREEN {
        direction LR
        [*] --> MinimalCode
        MinimalCode --> RunAll
        RunAll --> ConfirmPass : Exit 0, 0 regressions
    }
    state REFACTOR {
        direction LR
        [*] --> CleanUp
        CleanUp --> RunAll2
        RunAll2 --> StayGreen : Exit 0
    }
```

## 4.1 🐞 Systematic Debugging (Iron Law of Bug Isolation)
> 🐞 **Diagnostic loop:** REPRODUCE → DIAGNOSE (RCA) → SMALLEST SAFE FIX → REGRESSION PROOF.

```
NO BUG FIX WITHOUT A MINIMAL REPRODUCING FAILING TEST AND ROOT CAUSE ISOLATION
```
Shotgun debugging, speculative edits, and fixing symptoms without root cause isolation are strictly prohibited.
1. Phase 1 — Reproduce Deterministically:
   - Write a minimal failing test or deterministic reproducer command before touching production code.
   - Confirm failure matches the reported bug symptoms exactly.
2. Phase 2 — Diagnose & Isolate Root Cause:
   - Trace call stack, state transitions, and variable boundaries to identify the exact flaw.
   - Articulate the root cause clearly: what invariant was violated and why.
3. Phase 3 — Smallest Safe Localized Fix:
   - Apply the most focused, surgical patch that eliminates the root cause.
   - Strictly avoid unsolicited refactoring, cleanup of adjacent code, or changing unrelated interfaces.
4. Phase 4 — Regression Proof & Verification:
   - Run the reproduction test to prove GREEN status.
   - Execute the targeted test suite to confirm 0 regressions across existing functionality.

