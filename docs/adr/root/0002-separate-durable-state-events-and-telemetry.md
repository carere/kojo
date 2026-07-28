---
status: deprecated
---

# Separate durable workflow state, execution events, and telemetry

This decision is superseded by [Use one project database with separate execution authorities](./0006-use-one-project-database-with-separated-execution-authorities.md), which accounts for Effect Workflow's authoritative engine state and Activity results.

Kojo stores current Workflow Run State in SQLite and durable Execution Events in a per-run JSONL journal. A Drizzle-managed SQLite transaction updates state and queues the complete next event before related external work proceeds, reconciling the need for atomic lifecycle decisions with a user-readable append-only Execution Trace.

## Considered Options

- Using JSONL alone would make current-state queries and atomic lifecycle changes difficult.
- Writing SQLite and JSONL independently would allow a crash to preserve a state change without its event, or an event without its state change.
- Keeping the complete history only as SQLite event rows would make JSONL a disposable projection rather than the canonical long-term Execution Trace.
- Treating Effect logs or OpenTelemetry spans as history would make durable behavior depend on telemetry buffering, sampling, and exporter availability.

## Consequences

- Drizzle ORM owns SQLite access and migrations.
- The SQLite transaction that accepts an event assigns its globally unique identity and strict per-run sequence, updates Workflow Run State when applicable, and retains the complete event in a pending-delivery record.
- One writer per Workflow Run appends pending events to ordered JSONL segments. It removes the full pending payload only after durable delivery.
- Recovery discards only torn final bytes, reuses an already-written event when its identity and checksum match, and preserves malformed interior data before continuing in a new segment.
- The first event contains the complete non-secret Workflow Run Start Snapshot. Execution Artifacts remain disposable and are referenced from events.
- Every Execution Boundary maps to an Effect span and produces one wide completion summary. The same summary feeds the durable Execution Event, span attributes, and one structured Effect diagnostic event.
- OpenTelemetry export is optional and may sample or lose telemetry. Diagnostic logging and telemetry never determine Workflow Run State or replace Execution Events.
- A later decision defines the concrete Drizzle schema, indexes, migrations, and JSONL framing.
