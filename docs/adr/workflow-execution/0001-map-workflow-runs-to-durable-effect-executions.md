---
status: accepted
---

# Map each Workflow Run to one durable Effect execution

Kojo maps every accepted Workflow Run one-to-one to a durable Effect Workflow execution, while keeping the Effect identity and result model behind Kojo's public lifecycle. This preserves replay and recovery without collapsing separate manual starts or Workflow Schedule occurrences that happen to use identical input.

## Decision

### Start and execution identity

- Every Workflow Run Start Request has a stable identity. Redelivery with the same Workflow Key and input returns the existing Workflow Run; reuse with different contents is a conflict.
- A new deliberate manual request or a different due Workflow Schedule occurrence creates a new Workflow Run, even when the Workflow Definition and input are unchanged.
- A request is accepted only after the Project Runtime is ready, the Workflow Definition and input are valid, and creation of the Workflow Run is durable. A failure before acceptance creates no run; recovery completes Effect submission after acceptance.
- The private Effect execution identity is derived from the Workflow Key and Workflow Run identity rather than from user input. It is not a second user-visible run.
- A Child Workflow Run identity is derived from its parent Workflow Run, its Workflow Key, and a stable invocation key. Replay reuses that child.

### Public lifecycle

- Running, suspended, and stopping are non-final. Completed, failed, and stopped are final and never resume.
- Effect success maps to completed. A typed failure, captured defect, or exhausted retry maps to failed. Effect suspension maps to suspended.
- Suspension records whether a durable engine wake-up resumes the run automatically or a developer must request resume. V1 has no separate developer-controlled pause.
- Resume is idempotent, replays the same execution, and reuses completed Workflow Activities. Automatically suspended runs remain suspended until their wake-up; final runs reject resume.
- The first durable final outcome or accepted stop intent wins. A later Effect result remains Execution Trace evidence and cannot replace that outcome.

### Stop and child ownership

- Stop first records durable intent, moves the run to stopping, blocks new forward work, and safely interrupts the Effect execution and every non-final Child Workflow Run.
- Cleanup and compensation required by already-started work may continue. Cleanup failures remain evidence without replacing the stopped outcome. A run whose cleanup cannot finish remains stopping and needs attention; v1 has no unsafe force-stop.
- A Child Workflow Run cannot outlive its parent. The parent remains non-final until its children finish, and safely stops any non-final child before the parent becomes final.
- The parent observes a child's failure and may handle it. An unhandled child failure fails the parent; replay never creates a replacement child automatically.

### Replay and crash recovery

- Once a restarted Project Runtime is ready, running runs replay immediately, due durable wake-ups are delivered, manually suspended runs remain suspended, and stopping runs continue safe interruption. Final runs do nothing.
- Replay reuses every durably completed Workflow Activity result. An Activity without a durable result may run again with the same Activity Idempotency Key, so external effects are at-least-once across the crash window.
- Provider work such as a Sandcastle session continues only when the provider proves it can resume. Otherwise the Activity retries under Kojo's durable identity and idempotency contract.
- Missing or incompatible Workflow Definitions leave the project needing attention without silently changing any Workflow Run to a final state.

## Considered Options

- Deriving Effect execution identity directly from workflow input would incorrectly merge separate starts with identical input.
- Treating a Project Runtime crash as a final interruption would discard the durable engine's recovery contract.
- Exposing unsafe force-stop could skip compensation and orphan Child Workflow Runs.
- Allowing a Child Workflow Run to outlive its parent would weaken ownership and make stop and outcome semantics harder to reason about.

## Consequences

- Kojo's execution adapter must translate between the public Workflow Run lifecycle and Effect's private execution, suspension, interruption, and result APIs.
- Kojo's durable run graph must preserve start, parent-child, stop, suspension, and outcome decisions independently of Effect's private mailbox records.
- The durable record and control-protocol decisions must preserve the acceptance and race boundaries defined here.
- The Workflow Schedule lifecycle decision defines catch-up, overlap, and occurrence calculation, but each accepted occurrence uses the same Workflow Run Start Request boundary.

This decision resolves [Define workflow lifecycle and recovery semantics](https://github.com/carere/kojo/issues/5) and refines the recovery contract in [Host Project Runtimes in one supervised local service](../root/0004-host-project-runtimes-in-one-local-service.md).
