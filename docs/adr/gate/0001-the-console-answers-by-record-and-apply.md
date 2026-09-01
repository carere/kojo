# ADR 0001: The Daemon records and applies Gate answers

- Status: Accepted

## Context

A Gate answer is a human decision. Recording it and resuming a Run must use one correctness
authority. A browser, terminal client, or Project process can disconnect at any time.

## Decision

The Console and CLI send the answer to the per-user Daemon API. The Daemon validates and records the
Gate transition. The owning Runner applies the transition and continues the Run. Both operations
use the Daemon store.

Clients do not open the store, construct Workflow layers, or apply answers.

## Consequences

- A recorded decision survives client exit and browser refresh.
- The Console can show durable transition state.
- One Daemon owns concurrency and idempotency.
- A Gate answer does not require a second client process to become an execution owner.
- Removed client-side answering helpers are not compatibility aliases.
