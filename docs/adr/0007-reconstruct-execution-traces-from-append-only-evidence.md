# Reconstruct execution traces from append-only evidence

Kojo will persist immutable, schema-versioned Evidence Events alongside the mutable operational
state used to replay a Workflow Run. A state transition and its evidence commit transactionally,
but the evidence log does not drive replay and the operational journal is not treated as historical
evidence. Execution Traces and Execution Spans are read-only projections of the events and their
referenced Execution Artifacts rather than a statically inferred workflow graph.

Every event has a stable idempotency key, a Workflow Run-local order, an Execution Attempt, a
subject, parent and causation links, producer and actor identity when known, typed details, artifact
references, and optional OpenTelemetry trace correlation. Logical actions may cross Execution
Attempts; replay that reuses a completed Activity result links back to the original evidence rather
than inventing another attempt. Missing provider detail remains explicitly unavailable.

Small typed values live with events. Large or streaming outputs use immutable Kojo-managed
artifacts, which remain incomplete until finalized with a content fingerprint. Effect `Redacted`
values protect logs and telemetry, while secret-bearing schemas must forbid encoding and external
plain-text output must be scrubbed before it becomes evidence. OpenTelemetry is an optional export:
its failure never changes Workflow Run behavior or the canonical history.

## Considered Options

- Derive history from mutable replay tables and current Workflow Run state.
- Treat OpenTelemetry logs and spans as the canonical execution record.
- Event-source the complete workflow engine and drive replay from the evidence log.

## Consequences

- Kojo can reconstruct actual nesting, concurrency, retries, named Loop iterations, decisions,
  Sandboxes, agent and command runs, review findings, failures, and linked Child Workflows without
  predicting the Developer Workflow's graph.
- Failure to commit required evidence prevents the related durable completion; an external action
  whose result may already have happened becomes an Uncertain Activity Outcome.
- Discard preserves evidence, corrections append new events, and schema versions keep old runs
  readable. Read projections may be cached but must remain rebuildable.
- Portable evidence export, compliance-grade tamper protection, automatic retention, and explicit
  purge are deferred beyond the first vertical slice.
