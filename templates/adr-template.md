# ADR [Number]: [Short Title of Architectural Decision]

> Architecture Decision Record (ADR). Captures a significant architectural choice,
> trade-offs evaluated, and consequences.
>
> Write an ADR only when all three hold:
> - **Hard to reverse:** changing your mind later is costly.
> - **Surprising without context:** a future reader would ask why it was done this way.
> - **The result of a real trade-off:** genuine alternatives existed and one was chosen.
>
> If any one of the three is missing, skip the ADR.

## 1. Metadata
- **Status:** Proposed | Accepted | Superseded | Deprecated
- **Deciders:** [List architects, engineers, or agents involved]
- **Date:** [YYYY-MM-DD]
- **Supersedes / Superseded By:** [ADR Number or N/A]

## 2. Context & Problem Statement
- [Describe the context, technical forces, limitations, and user needs motivating this decision.]

## 3. Decision Drivers & Constraints
- [Driver 1: e.g. Low latency SLA under 50ms]
- [Driver 2: e.g. Memory footprint below 100MB]
- [Constraint 1: e.g. Must run offline without external API call]

## 4. Decision Flow & Alternatives Considered

```mermaid
flowchart TD
    accTitle: Architecture decision record flow
    accDescr: A problem is stated, alternatives are evaluated, options are compared on trade-offs, one is chosen with a rationale, and the consequences are recorded.
    Problem["Problem / Architectural Need"] --> Eval{"Evaluate Alternatives"}
    Eval --> OptA["Option A: [Name]"]
    Eval --> OptB["Option B: [Name]"]
    Eval --> OptC["Option C: [Name]"]
    
    OptA --> Decision["Decision: Choose Option [X]"]
    OptB --> RejectedB["Rejected: [Reason]"]
    OptC --> RejectedC["Rejected: [Reason]"]
    
    Decision --> Impact["Consequences & Follow-up Actions"]
```

### Option A: [Option Name]
- **Description:** [Summary of approach]
- **Pros:** [Positive impacts]
- **Cons:** [Negative impacts or operational costs]

### Option B: [Option Name]
- **Description:** [Summary of approach]
- **Pros:** [Positive impacts]
- **Cons:** [Negative impacts or operational costs]

## 5. Decision Outcome
- **Chosen Option:** [Option X], because [justification with metrics or clear architectural fit].

## 6. Consequences & Risks
- **Positive Consequences:** [What becomes easier or faster]
- **Negative Consequences / Trade-offs:** [Technical debt, complexity, or constraints introduced]
- **Mitigation Strategy:** [How the risks will be contained or observed]

## 7. Implementation & Verification Notes
- [Implementation pointers, migration order, or test checks required to validate this decision.]
