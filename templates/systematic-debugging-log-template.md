# Systematic Debugging Log: [Issue Description]

## 1. Issue Summary
- **Reported Bug:** [User description or error symptom]
- **Environment:** [OS, runtime, package version, commit hash]
- **Affected Subsystem:** [Module, endpoint, or component]

## 1b. Debugging Loop

```mermaid
stateDiagram-v2
    accTitle: Systematic debugging state machine
    accDescr: Reproduce deterministically, diagnose the root cause, apply the smallest safe fix, then prove the regression. An inconclusive reproducer loops back to REPRODUCE and an unconfirmed root cause loops back for a new failing test.
    [*] --> REPRODUCE : Bug reported
    REPRODUCE --> DIAGNOSE : Failing test confirms bug
    REPRODUCE --> REPRODUCE : Test flaky or inconclusive — tighten reproducer
    DIAGNOSE --> FIX : Root cause isolated
    DIAGNOSE --> REPRODUCE : New repro needed to confirm root cause
    FIX --> VERIFY : Patch applied
    VERIFY --> [*] : Reproduction test GREEN, 0 regressions
    VERIFY --> DIAGNOSE : Regressions found — root cause incomplete

    state REPRODUCE {
        [*] --> WriteReproducer
        WriteReproducer --> RunReproducer
        RunReproducer --> ConfirmDeterministic
    }
    state DIAGNOSE {
        [*] --> TraceStack
        TraceStack --> IdentifyInvariant
        IdentifyInvariant --> ArticulateRootCause
    }
    state FIX {
        [*] --> SmallestSafePatch
        SmallestSafePatch --> NoUnrelatedRefactor
    }
    state VERIFY {
        [*] --> RunRepro
        RunRepro --> RunFullSuite
        RunFullSuite --> ZeroRegressions
    }
```

## 2. Phase 1 — Deterministic Reproduction (Failing Test First)
- **Minimal Reproducer Test / Command:**
  ```bash
  rtk bun test path/to/repro.test.ts
  ```
- **Observed Failure Output:**
  ```
  [Paste exact error message, call stack, or failure exit code]
  ```
- **Confirmation:** [ ] Confirmed fails deterministically for the exact reason reported.

## 3. Phase 2 — Root Cause Analysis (RCA)
- **Execution Trace:** [Step-by-step trace of state leading up to error]
- **Violated Invariant:** [What invariant, boundary condition, or contract broke?]
- **Root Cause Explanation:** [Why did this occur?]

## 4. Phase 3 — Smallest Safe Localized Fix
- **Target File(s):** `path/to/source.ts`
- **Fix Description:** [Describe the minimal change applied without unrelated refactoring]
- **Patch Preview:**
  ```diff
  - // problematic line
  + // localized fix
  ```

## 5. Phase 4 — Regression Verification
- **Reproduction Test Status:**
  - Command: `rtk bun test path/to/repro.test.ts`
  - Output: Exit 0, 1 passed, 0 failed.
- **Full Suite Status:**
  - Command: `rtk bun test`
  - Output: Exit 0, all existing tests passed.
- **Verdict:** [ ] Bug resolved with 0 regressions.
