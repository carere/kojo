---
status: accepted
---

# Use one project database with separate execution authorities

Kojo stores Effect Workflow's engine data and Kojo-owned execution records in one project-local SQLite database. Sharing the database keeps project data, backup, and migration together, while separate table ownership and a Kojo adapter keep Effect's storage private. Authority is divided by fact: the Workflow Engine owns execution recovery and reusable Activity results, while Kojo owns accepted lifecycle decisions, schedules, occurrences, public state, and history.

## Decision

### Storage ownership

- Effect owns its engine tables, migrations, persisted messages and replies, Workflow Activity results, durable deferreds, durable clocks, and operational parent-child data. Kojo accesses these only through its Workflow Engine adapter and never queries them for the CLI or visualizer.
- Kojo owns the Workflow Schedule State, Workflow Schedule Occurrence, Workflow Run State, Execution Event, and Execution Artifact metadata tables. Concrete table names, indexes, framing, and migration mechanics remain with the storage-design follow-up.
- Every Effect Workflow execution maps one-to-one to a Workflow Run through an opaque engine identity recorded by Kojo. Activity results, deferreds, and clocks created inside that execution share the association.
- A nested Effect execution maps to its own Child Workflow Run, with a stable invocation link to its parent. Engine-wide ownership, locking, polling, and migration records belong to the Project Runtime rather than a run. A schedule wake-up belongs to its Workflow Schedule Occurrence until that occurrence creates a run.
- Kojo accepts that a future Effect upgrade may require migrating the shared database. Effect table ownership remains private even when the durable primitives and their public APIs stabilize.

### Kojo-owned records

- Workflow Schedule State owns the Schedule Key, enabled intent, current and applied revisions, condition and reason, high-water mark, and next occurrence.
- A Workflow Schedule Occurrence owns its scheduled instant, applied revision, resolved input, lifecycle outcome and reason, processing times, and optional link to a Workflow Run. Schedule history remains separate from an Execution Trace; a started run's snapshot copies the schedule identities needed for correlation.
- Workflow Run State owns the run and start-request identities, Workflow Key and revision, opaque engine identity, trigger and parent links, current lifecycle, suspension details, accepted stop intent, timestamps, and final Execution Event identity.
- The complete schema-encoded Workflow success or failure lives in the immutable final Execution Event. Workflow Run State retains only the final state, a queryable summary, and the event link. Kojo does not duplicate complete Activity results used by the Workflow Engine for replay.
- Execution Artifacts contain large disposable outputs. Their metadata and event links are durable, but losing their content does not change a Workflow Run's state or outcome. Any value required for recovery or outcome calculation must live in authoritative engine or Kojo records instead.

### Consistency across Kojo and the Workflow Engine

- A Kojo transaction changes Workflow Run State and appends its corresponding Execution Event together. Events that do not change current state append independently.
- Sharing a SQLite database does not make a Kojo transaction and an Effect API call atomic. Kojo records durable intent first, calls Effect with a stable identity, and then records the confirmed observation. Recovery safely repeats an unconfirmed start, stop, child invocation, or other engine action.
- Every actual Workflow Activity invocation has a distinct Workflow Activity Attempt identity. Kojo records the attempt before external work starts, passes the stable Activity Idempotency Key across repeated attempts, and records completion only after Effect confirms that the result is durable. A crash may therefore leave an incomplete attempt followed by another attempt with the same idempotency key.
- If Effect has durably recorded a result but Kojo has not recorded its observation, replay returns the result and Kojo appends the missing Event idempotently. An Activity result summary may enter the Execution Trace, but its replay value remains exclusively authoritative in Effect storage.
- An accepted stop remains authoritative when a later Effect success or failure arrives. The later engine result is retained as Execution Trace evidence without replacing the stopped outcome.

### Events, ordering, and correlation

- Execution Events are immutable, versioned, globally identified facts with a strict sequence inside one Workflow Run. Corrections and later observations append new Events rather than changing old ones.
- The per-run sequence is authoritative. Recorded and observed timestamps support presentation and diagnosis but never impose an authoritative order across concurrent Workflow Runs.
- Each Child Workflow Run owns a separate state and Execution Trace. Parent Run identity, Child Run identity, and stable invocation key form the causal link between their traces.
- Workflow Schedule Occurrences are ordered within their schedule by scheduled instant and its durable high-water mark. A started occurrence links to its Workflow Run Start Request and Workflow Run; skipped, invalidated, or failed occurrences have no run.
- Concurrent Workflow Runs have no global authoritative order. Stable run, occurrence, parent, child, operation, attempt, boundary, event, and artifact identities provide explicit correlation instead.

### Recovery and non-authoritative data

- Effect storage is authoritative for resuming workflow code and reusing Activity results. Workflow Run State is authoritative for accepted Kojo starts, stops, and public lifecycle decisions. Workflow Schedule State and Occurrence records are authoritative for scheduled work. Execution Events describe history and never drive replay.
- Kojo repeats a saved start or stop that Effect has not confirmed. It projects a confirmed Effect outcome missing from Kojo into Workflow Run State and an Execution Event.
- Effect execution data without its required Workflow Run, or an acknowledged execution that has disappeared from Effect storage, is damage that leaves the project needing attention. Kojo does not invent replacement state from Events, logs, or Artifacts.
- Diagnostic logs are best-effort structured completion records for host requests, Activity attempts, schedule delivery attempts, and recovery cycles. Their loss never changes recovery or a Workflow Run outcome.
- Missing Execution Artifact content reduces historical detail but does not affect recovery or change an already-recorded result.

## Considered Options

- Keeping Effect and Kojo data in separate SQLite files would strengthen the physical migration boundary, but would split project backup and storage management. Kojo instead accepts future migrations while preserving separate logical ownership in one database.
- Treating the shared database as one undifferentiated authority would couple public behavior to Effect's private schema and obscure conflicts between engine recovery and accepted Kojo lifecycle decisions.
- Reconstructing Workflow Run State from Execution Events would turn the trace into a control store. Kojo instead commits state and its event together while giving each a distinct purpose.
- Keeping canonical history in JSONL would require coordination with SQLite and recovery from torn or missing writes. The Execution Trace is instead reconstructed from durable Execution Events; JSONL may be an export or disposable projection.
- Copying complete Activity results into Kojo tables would create two replay authorities. Kojo stores only user-visible summaries and the final Workflow result.

## Consequences

- Database backup, restoration, and migration must treat the shared project database as a unit while respecting Effect-owned and Kojo-owned tables.
- The Workflow Engine adapter must preserve stable identities and expose confirmed results without leaking private Effect rows or schemas.
- Recovery and integration tests must exercise crashes before and after engine calls, incomplete Workflow Activity Attempts, late engine outcomes after stop, orphaned engine data, and missing Artifacts.
- The storage and Execution Trace framing follow-up can define schemas, indexes, migrations, and export formats without reopening authority, consistency, ordering, or recovery semantics.
- Execution-data security and retention can define redaction and deletion policies without making logs or Artifacts authoritative.

This decision resolves [Define the durable execution record](https://github.com/carere/kojo/issues/7) and supersedes [Separate durable workflow state, execution events, and telemetry](./0002-separate-durable-state-events-and-telemetry.md).
