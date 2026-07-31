---
status: accepted
---

# Use Drizzle for Kojo records and versioned Execution Events

Kojo stores its authoritative project records in Drizzle-managed `STRICT` SQLite tables while Effect Workflow owns separate private tables in the same project database. `ProjectRepository` uses Drizzle for every Kojo-owned migration and query; `LocalWorkflowBackend` alone composes Effect's required SQL services, interprets opaque engine references, and operates on Effect-owned storage. Versioned immutable Execution Events reconstruct the user-visible Execution Trace, while current state, engine intents, Activity Attempts, retention, and deletion remain explicit records rather than projections from that trace.

## Database ownership and connections

- `.kojo/kojo.sqlite` is the single Project database. Every Kojo-owned table begins with `kojo_`; Effect-owned names remain private and are never queried through Drizzle.
- `ProjectRepository` uses `drizzle-orm/bun-sqlite` over a Kojo-owned `bun:sqlite` connection. Drizzle schemas are the source of truth, Drizzle Kit generates checked-in migrations, runtime `migrate()` records them in `kojo_schema_migrations`, and `drizzle-kit push` is not used against a Project database.
- Drizzle-managed custom migrations express SQLite features that the schema generator cannot emit, including `STRICT` table declarations and the Execution Event update guard. Generated migration files are not edited by hand.
- `LocalWorkflowBackend` opens Effect's separate `@effect/sql-sqlite-bun` connection to the same file because Effect does not accept Drizzle's Bun `Database` handle. Both connections enable WAL, foreign keys, a five-second busy timeout, and `synchronous=FULL`.
- The Project Runtime is the only coordinator allowed to open writable production adapters. SQL rows, Drizzle types, Effect identities, entity addresses, and migration tables never cross `ProjectRepository`, `LocalWorkflowBackend`, or `@kojo/control` boundaries.

## Physical conventions

- Table and column names use lower snake case. Kojo tables are `STRICT` and use only `INTEGER`, `TEXT`, and `BLOB` storage classes.
- Public generated identities are canonical UUIDv7 strings stored as `TEXT`. Workflow Keys, Schedule Keys, revisions, Durable Operation Keys, Activity Idempotency Keys, Request Keys, and other developer or client keys are validated by Effect Schema before SQL and constrained to non-empty bounded text.
- Instants and durations are non-negative UTC epoch milliseconds in `INTEGER` columns. Per-Run Event sequence is a positive integer and is the only authoritative ordering for an Execution Trace.
- Boolean integers are constrained to `0` or `1`. Lifecycle strings have named `CHECK` constraints. Every JSON column has `json_valid(...)`; every SHA-256 is a 32-byte `BLOB`.
- Application reads decode Drizzle results through Effect Schema before returning domain models. Row-local invariants are also database constraints; cross-row invariants are enforced by one `ProjectRepository` transaction and audited by repair checks.

### Payload bundle

Every payload-bearing record stores one adjacent bundle, with a table-specific prefix:

- `<prefix>_encoding_version INTEGER NOT NULL`
- `<prefix>_schema_identity TEXT NOT NULL`
- `<prefix>_json TEXT NOT NULL`
- `<prefix>_sensitivity_map_version INTEGER NOT NULL`
- `<prefix>_sensitivity_map_json TEXT NOT NULL`
- `<prefix>_sha256 BLOB NOT NULL`

Version 1 stores schema-encoded canonical JSON and a Sensitivity Map shaped as `{ "paths": string[] }`. Paths are sorted, unique RFC 6901 JSON Pointers; the empty pointer marks the whole value. Invalid pointers, a missing map, or an unknown map version make the entire payload sensitive. A marked subtree is replaced at inspection time with `{ "masked": true, "type": "null" | "boolean" | "number" | "string" | "array" | "object" }`; Kojo exposes no preview, length, or hash. Kojo never persists a second masked copy.

## Kojo-owned schema

### `kojo_store_metadata`

One row binds the database to its Project and records compatibility before Effect is initialized:

- `singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1)`
- `project_identity TEXT NOT NULL UNIQUE`
- `database_instance_id TEXT NOT NULL UNIQUE`
- `store_format_version INTEGER NOT NULL`
- `engine_adapter_kind TEXT NOT NULL`
- `engine_adapter_schema_version INTEGER NOT NULL`
- `effect_family_version TEXT NOT NULL`
- `created_at_ms INTEGER NOT NULL`
- `last_migrated_at_ms INTEGER NOT NULL`

An unknown newer store or engine-adapter version is rejected before either owner mutates the database.

### `kojo_control_requests`

This is the idempotency receipt for state-changing control requests:

- `request_key TEXT PRIMARY KEY`
- `operation_kind TEXT NOT NULL`
- `request_sha256 BLOB NOT NULL`
- `target_kind TEXT NOT NULL`
- `target_run_id TEXT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE`
- `target_schedule_key TEXT NULL REFERENCES kojo_workflow_schedule_states(schedule_key) ON DELETE CASCADE`
- `state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'needs-attention'))`
- a nullable `result_` Payload bundle, `result_code TEXT NULL`, and `safe_error_code TEXT NULL`
- `created_at_ms INTEGER NOT NULL`, `completed_at_ms INTEGER NULL`, and `expires_at_ms INTEGER NULL`

The target columns must match `target_kind`. Redelivery with the same operation and fingerprint returns the stored result; a different fingerprint conflicts. Normal receipts live with their target. A completed deletion clears its target columns, retains only its request fingerprint and result counts, and expires after 30 days so it does not become a permanent Run tombstone.

Indexes: partial indexes for non-completed requests and expiring receipts, plus indexes on each target foreign key.

### `kojo_workflow_schedule_states`

One row owns the durable operational state of a Workflow Schedule:

- `schedule_key TEXT PRIMARY KEY`
- `enabled_intent INTEGER NOT NULL CHECK (enabled_intent IN (0, 1))`
- `condition TEXT NOT NULL CHECK (condition IN ('available', 'unavailable', 'needs-attention'))`
- `condition_reason_code TEXT NULL`
- nullable current-definition columns: `current_workflow_key`, `current_revision`, `current_cron`, `current_time_zone`, `current_overlap_policy`, and `current_input_rule_revision`
- nullable applied-definition columns: `applied_workflow_key`, `applied_revision`, `applied_cron`, `applied_time_zone`, `applied_overlap_policy`, and `applied_input_rule_revision`
- `high_water_mark_ms INTEGER NULL`, `next_occurrence_ms INTEGER NULL`
- `row_version INTEGER NOT NULL`, `created_at_ms INTEGER NOT NULL`, `updated_at_ms INTEGER NOT NULL`

Each current or applied definition set is wholly present or wholly absent. Overlap is `allow` or `skip`. `next_occurrence_ms` is present only for an enabled, available schedule and must be later than its high-water mark.

Indexes: `kojo_schedule_states_workflow_idx` on the current Workflow Key and partial `kojo_schedule_states_due_idx` on `(next_occurrence_ms, schedule_key)` for enabled, available schedules.

### `kojo_workflow_schedule_occurrences`

One row owns one considered scheduled instant:

- `schedule_key TEXT NOT NULL REFERENCES kojo_workflow_schedule_states(schedule_key) ON DELETE CASCADE`
- `scheduled_at_ms INTEGER NOT NULL`
- `applied_revision TEXT NOT NULL`
- a required `resolved_input_` Payload bundle
- `outcome TEXT NOT NULL CHECK (outcome IN ('planned', 'started', 'skipped', 'invalidated', 'failed'))`
- `reason_code TEXT NULL`, `delivery_attempt_count INTEGER NOT NULL`
- `planned_at_ms INTEGER NOT NULL`, `first_attempted_at_ms INTEGER NULL`, `processed_at_ms INTEGER NULL`
- `linked_run_id TEXT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE SET NULL`
- `deleted_run_id TEXT NULL`, `deleted_run_at_ms INTEGER NULL`
- `row_version INTEGER NOT NULL`
- primary key `(schedule_key, scheduled_at_ms)`

A planned occurrence has no processed time or Run. A started occurrence has exactly one live linked Run or deleted-Run marker; all other final outcomes have neither. Before Run deletion, one transaction copies `linked_run_id` to `deleted_run_id`, sets the deletion time, and clears the live link.

Indexes: descending schedule history, outcome history, a partial due index for planned occurrences, and a partial unique index on non-null `linked_run_id`.

### `kojo_workflow_runs`

One row owns the current public lifecycle and query projection for a Workflow Run:

- `run_id TEXT PRIMARY KEY`
- `start_request_key TEXT NOT NULL UNIQUE`, `start_request_sha256 BLOB NOT NULL`
- `workflow_key TEXT NOT NULL`, `workflow_revision TEXT NOT NULL`
- `engine_reference_version INTEGER NOT NULL`, `engine_reference_json TEXT NOT NULL`, and `engine_reference_sha256 BLOB NOT NULL UNIQUE`
- `trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'schedule', 'child'))`
- `parent_run_id TEXT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE`
- `child_invocation_key TEXT NULL`
- `schedule_key TEXT NULL`, `scheduled_at_ms INTEGER NULL`, `schedule_revision TEXT NULL`
- `state TEXT NOT NULL CHECK (state IN ('running', 'suspended', 'stopping', 'stopped', 'failed', 'completed'))`
- nullable `suspension_kind`, `suspension_reason_code`, and versioned `suspension_details_json` with its Sensitivity Map
- nullable `stop_request_key`, `stop_requested_at_ms`, and `stop_reason_code`
- nullable `outcome_event_id TEXT UNIQUE`, `outcome_code TEXT`, and `outcome_summary_json TEXT`
- `last_event_sequence INTEGER NOT NULL DEFAULT 0`
- `row_version INTEGER NOT NULL`
- `accepted_at_ms INTEGER NOT NULL`, `engine_confirmed_at_ms INTEGER NULL`, `updated_at_ms INTEGER NOT NULL`, and `finalized_at_ms INTEGER NULL`

Trigger-specific columns are present only for their trigger. Child identity is unique on `(parent_run_id, workflow_key, child_invocation_key)`. Runs copy schedule correlation into their start snapshot and intentionally have no foreign key to occurrence history, so retained Runs survive occurrence pruning or schedule forgetting. Final states require an outcome Event and finalized time; non-final states forbid them.

Indexes: descending Run list, Workflow history, state and update time, parent-child traversal, schedule-started Runs, and a partial index for non-final Runs.

### `kojo_engine_operations`

This is the durable handoff ledger between a Kojo transaction and a non-atomic Effect call:

- `operation_id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE`
- `kind TEXT NOT NULL`, `operation_key TEXT NOT NULL`
- a required `request_` Payload bundle
- `state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'needs-attention'))`
- `attempt_count INTEGER NOT NULL`, `next_attempt_at_ms INTEGER NULL`
- `last_attempted_at_ms INTEGER NULL`, `confirmed_at_ms INTEGER NULL`
- `confirmation_event_id TEXT NULL UNIQUE`, `safe_error_code TEXT NULL`
- `created_at_ms INTEGER NOT NULL`, `updated_at_ms INTEGER NOT NULL`
- unique `(run_id, kind, operation_key)`

Kinds include execution submission, stop, resume, Child Run submission, and deferred completion. A confirmed operation has exactly one semantic confirmation Event; retrying confirmation cannot append another.

Indexes: Run history and partial `(next_attempt_at_ms, operation_id)` for pending work.

### `kojo_workflow_activity_attempts`

One row describes one actual invocation of external Activity work:

- `attempt_id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE`
- `durable_operation_key TEXT NOT NULL`, `activity_name TEXT NOT NULL`
- `effect_retry_number INTEGER NOT NULL`, `invocation_number INTEGER NOT NULL`
- `activity_idempotency_key TEXT NOT NULL`
- `state TEXT NOT NULL CHECK (state IN ('started', 'result-observed', 'engine-confirmed'))`
- nullable safe `outcome_code` and `outcome_summary_json`
- `started_at_ms INTEGER NOT NULL`, `result_observed_at_ms INTEGER NULL`, `engine_confirmed_at_ms INTEGER NULL`
- unique `(run_id, durable_operation_key, effect_retry_number, invocation_number)`

An incomplete invocation remains `started`; recovery may create another invocation number with the same Activity Idempotency Key. Exact replay results stay solely in Effect storage.

Indexes: `(run_id, durable_operation_key, started_at_ms)` and Activity Idempotency Key.

### `kojo_execution_events`

This is the immutable authoritative history used to build one Run's Execution Trace:

- `event_id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE`
- `sequence INTEGER NOT NULL`
- `envelope_version INTEGER NOT NULL`
- `kind TEXT NOT NULL`, `kind_version INTEGER NOT NULL`
- `recorded_at_ms INTEGER NOT NULL`, `observed_at_ms INTEGER NULL`
- nullable `engine_operation_id`, `activity_attempt_id`, `boundary_id`, and `child_run_id`
- a required `payload_` Payload bundle
- unique `(run_id, sequence)` and unique `(run_id, event_id)`

Appending increments `kojo_workflow_runs.last_event_sequence` with `UPDATE ... RETURNING` and inserts that sequence in the same `BEGIN IMMEDIATE` transaction. Sequences begin at one. A `BEFORE UPDATE` trigger always aborts; explicit Run deletion may delete Events. Corrections and reconciled observations append new Events.

Sandbox, Command, and Agent Boundary Events persist their Durable Operation Key
as `boundary_id`. That stable logical-operation identity correlates start and
completion evidence across replay and enables indexed Boundary filtering.

Indexes: `(run_id, kind, sequence)` and each non-null correlation identity. There is no JSON-content index.

### `kojo_execution_artifacts`

Metadata remains after disposable content disappears:

- `artifact_id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE`
- `storage_key TEXT NOT NULL UNIQUE`
- `display_name TEXT NOT NULL`, `media_type TEXT NOT NULL`
- `byte_size INTEGER NOT NULL`, `sha256 BLOB NOT NULL`
- `condition TEXT NOT NULL CHECK (condition IN ('available', 'missing', 'expired'))`
- `created_at_ms INTEGER NOT NULL`, `unavailable_at_ms INTEGER NULL`, `unavailable_reason_code TEXT NULL`
- unique `(run_id, artifact_id)`

`storage_key` is a Kojo-generated opaque filename under `.kojo/artifacts/`; the untrusted display name never becomes a path.

Indexes: Run and creation order, condition, and retention eligibility.

### `kojo_execution_event_artifacts`

This table links Artifacts to every Event that refers to them:

- `run_id TEXT NOT NULL`
- `event_id TEXT NOT NULL`
- `artifact_id TEXT NOT NULL`
- `role TEXT NOT NULL`
- primary key `(event_id, artifact_id, role)`
- foreign key `(run_id, event_id)` to `kojo_execution_events`
- foreign key `(run_id, artifact_id)` to `kojo_execution_artifacts`

The composite foreign keys prevent cross-Run links.

### `kojo_retention_policy`

One row owns Project-local limits:

- `singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1)`
- nullable positive `diagnostic_max_age_ms`, `diagnostic_max_bytes`, `disposable_max_age_ms`, and `disposable_max_bytes`
- `row_version INTEGER NOT NULL`, `updated_at_ms INTEGER NOT NULL`

Null disables a limit. Host-wide diagnostic safety remains Host configuration rather than Project state.

### `kojo_deletion_intents`

This row makes explicit deletion durable before owned state is removed:

- `deletion_id TEXT PRIMARY KEY`, `request_key TEXT NOT NULL UNIQUE`
- `target_kind TEXT NOT NULL`, `target_sha256 BLOB NOT NULL`
- `target_snapshot_json TEXT NOT NULL`, `expected_revision INTEGER NULL`
- `phase TEXT NOT NULL CHECK (phase IN ('quiescing', 'clearing-engine', 'clearing-owned-content', 'deleting-records', 'needs-attention'))`
- `safe_error_code TEXT NULL`
- `created_at_ms INTEGER NOT NULL`, `updated_at_ms INTEGER NOT NULL`

The immutable target snapshot fixes the complete Run tree or other deletion scope after confirmation and rechecking.

Indexes: partial index for active phase and Request Key uniqueness.

### `kojo_deletion_items`

Each engine address, owned file, provider cleanup, or Kojo record group is independently resumable:

- `deletion_id TEXT NOT NULL REFERENCES kojo_deletion_intents(deletion_id) ON DELETE CASCADE`
- `item_kind TEXT NOT NULL`, `item_key TEXT NOT NULL`, `stable_order INTEGER NOT NULL`
- `state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'warning', 'needs-attention'))`
- `attempt_count INTEGER NOT NULL`, `completed_at_ms INTEGER NULL`, `safe_error_code TEXT NULL`
- primary key `(deletion_id, item_kind, item_key)`

Indexes: `(deletion_id, state, stable_order)` for the next item.

## Execution Event contract

Envelope version 1 is independent of each kind version. Any body-shape or semantic change increments `kind_version`; readers explicitly register each supported `(kind, kind_version)` pair.

V1 kinds are:

- Run: `run.accepted`, `run.engine-confirmed`, `run.suspended`, `run.resumed`, `run.stop-requested`, `run.stopped`, `run.completed`, `run.failed`, and `run.late-engine-outcome`.
- Child Run: `child.requested`, `child.linked`, and `child.finished`.
- Activity: `activity.attempt-started`, `activity.result-observed`, `activity.result-confirmed`, and `activity.result-reused`.
- Durable waits: `deferred.created`, `deferred.completed`, `clock.scheduled`, and `clock.fired`.
- Execution Boundaries: `boundary.started` and `boundary.completed`.
- Artifacts: `artifact.recorded` and `artifact.unavailable`.
- Reconciliation: `reconciliation.observation-restored`.

`run.accepted` is sequence one and contains the complete Workflow Run Start Snapshot. `run.completed` and `run.failed` contain the exact schema-encoded final success or failure. Occurrence lifecycle stays in occurrence history rather than the Execution Trace. Routine recovery and diagnostics do not become Execution Events.

An unsupported envelope or kind version is returned as a visible compatibility placeholder with safe Event identity, Run identity, sequence, kind, versions, and times. It is never silently skipped. Its payload is masked according to a supported Sensitivity Map or entirely when that map cannot be trusted. A final Run may receive later evidence such as a late engine outcome or Artifact expiration; `outcome_event_id` remains the fixed winning outcome rather than meaning the last trace Event.

## Transactions and reconciliation

- Kojo writes use short `BEGIN IMMEDIATE` Drizzle transactions. No Effect call, provider call, filesystem operation, or network operation occurs inside them.
- Manual start acceptance commits the control receipt, Workflow Run, `run.accepted` Event, and pending submission operation together.
- Schedule delivery commits the occurrence decision, Workflow Run, first Event, and pending submission operation together.
- Child start acceptance commits the Child Workflow Run, its `run.accepted` Event, pending submission operation, and the parent's `child.requested` Event together. Durable submission confirmation adds exactly one parent `child.linked` Event in the confirmation transaction. A completed, failed, or stopped Child Workflow Run adds exactly one parent `child.finished` Event in the winning finality transaction. All three parent Events correlate through `child_run_id`.
- A lifecycle transition commits current state, its Event, and any engine-operation confirmation together.
- An Activity invocation commits its Attempt and `activity.attempt-started` before external work. Observing its external result does not claim durability. After Effect confirms the replay value, Kojo records `engine-confirmed` and `activity.result-confirmed` together.
- Recovery retries each pending engine operation with its stable identity. A confirmed Effect observation missing from Kojo appends the missing Event idempotently and updates state in one transaction.
- The first durable final outcome or accepted stop wins. A later Effect result appends `run.late-engine-outcome` without replacing state or `outcome_event_id`.

`LocalWorkflowBackend` exposes only initialize, compatibility and ownership assessment, opaque reference creation and validation, idempotent submit/observe/interrupt/resume/deferred completion, and deletion of supplied known references. It uses Effect APIs to observe confirmed results and never queries private tables.

Effect exposes no list-executions API. Kojo prevents orphan creation by durably creating a Workflow Run before submission and can verify every stored reference, but it does not claim an exhaustive private-storage scan. A missing known execution is `run.engine-state-missing`; an unexpected owned execution is `engine.execution-unowned` when it becomes discoverable through an adapter operation.

## Queries, masking, and pagination

- `@kojo/control` owns Effect Schema inputs and outputs. Every operation is Project-scoped and returns domain snapshots rather than database rows.
- Resource lists use versioned opaque keyset cursors, never offsets. A cursor is base64url canonical JSON containing its version, resource kind, direction, sort values, and filter fingerprint plus a checksum for accidental alteration. It is not an authorization token. Unsupported, malformed, or filter-mismatched cursors return typed errors.
- Workflow Runs sort by `(accepted_at_ms DESC, run_id DESC)`. Occurrences sort by `(scheduled_at_ms DESC, schedule_key)`. Default page size is 100 and maximum is 500.
- Trace pages use the visible per-Run sequence with mutually exclusive `after_sequence` and `before_sequence`. A response contains ordered Events, first and last sequence, current high-water sequence, `has_more`, and any compatibility placeholders. Live following continues after a sequence; a slow subscriber receives `resync-required`.
- Indexed filters cover Run state, Workflow Key, trigger, parent, Schedule Key, occurrence outcome, Event family or kind, boundary, Activity, Attempt, Artifact condition, and time interval. V1 has no arbitrary JSON-payload search.
- Ordinary inspection masks payloads before they leave the Project Runtime. `reveal_sensitive: true` applies to one request, is never a persistent preference, and emits one payload-free Diagnostic Event.

## Artifact access and Execution Trace export

- Artifact download requires matching Project, Run, and Artifact identities. Kojo resolves only the stored opaque key beneath `.kojo/artifacts/`, rejects symbolic links and non-regular files, rechecks containment and metadata, and never trusts a display name as a path.
- Responses use attachment disposition, `X-Content-Type-Options: nosniff`, and `application/octet-stream` unless a safer explicit download type is appropriate. Kojo never renders Artifact contents as active HTML.
- Export captures the Run's high-water sequence before reading and creates a versioned ZIP archive. `manifest.json` contains export version, Project and Run identities, export time, high-water sequence, redaction mode, compatibility warnings, Artifact inventory, and file checksums. `events.ndjson` contains one canonical JSON Event per line in sequence order; `artifacts.json` contains metadata.
- Redacted export is the default and omits Artifact contents. `unredacted: true` explicitly includes exact Event payloads with a warning. `include_artifacts: true` is a second explicit option; files use `artifacts/<artifact_id>` paths and never their display names. Unsupported Events remain placeholders in redacted exports; an explicitly unredacted export may preserve their raw stored payload with a compatibility warning.

## Retention and deletion

- Retention removes only eligible disposable content. Deleting or discovering a missing Artifact changes its metadata condition and appends `artifact.unavailable`; authoritative Event history and the Run outcome remain.
- Explicit deletion first commits a deletion intent and its complete ordered item set, then makes the target unavailable. It quiesces the Run tree, clears known Effect workflow and durable-clock addresses through `MessageStorage.withTransaction`, removes owned files and requests supported provider cleanup, updates any linked occurrence to its deleted-Run marker, and finally deletes the root Run so ownership cascades remove Kojo rows.
- Local failures leave the intent `needs-attention` and resume idempotently. Unsupported or failed remote cleanup ends as a warning and does not preserve local credentials or data. Completion removes the intent and target identities; only the bounded target-free control receipt remains.
- The adapter verifies supplied known Effect addresses after clearing but does not claim to prove the absence of arbitrary unknown private rows.

## Migration, backup, and repair

- Migration starts only under exclusive Project Runtime ownership with both normal connections quiesced. If `.kojo/kojo.sqlite.migration-backup` exists, Kojo restores it before any new attempt.
- Preflight rejects newer formats and runs SQLite `quick_check`, `foreign_key_check`, Project Identity validation, migration checksum validation, and required-object checks.
- With `synchronous=FULL`, a dedicated connection creates `.kojo/kojo.sqlite.migration-backup` using `VACUUM INTO`, flushes it, and reopens it read-only. Kojo verifies the backup's integrity, foreign keys, Project Identity, Kojo migration state, and engine-adapter metadata before mutation.
- Runtime Drizzle migrations run first. `LocalWorkflowBackend` then initializes the pinned Effect layers and lets Effect migrate its own tables. Postflight repeats integrity, foreign-key, object, compatibility, and semantic checks before durably recording success and removing the backup.
- Any interruption or failure closes both clients and restores the verified backup. Kojo attempts a migration once per Host activation; another try requires the existing explicit retry action.

Activation checks use `quick_check`, `foreign_key_check`, Project Identity, migration checksums, required Kojo tables/indexes/triggers, pending migration or deletion recovery, non-final Run/Event invariants, unique engine mappings, and backend ownership/readiness. An explicit deep check additionally runs full `integrity_check`, complete Event-sequence continuity, final-state/outcome-Event agreement, occurrence links, acyclic Run trees, Activity Attempt consistency, and Artifact existence and hashes.

Safe repair may restore a migration backup, run an approved migration, recreate a missing index, resume deletion, or append a missing confirmed observation. It never rewrites an Execution Event, invents engine state, reconstructs authority from history, or silently discards a record.

## Considered options

- Using Drizzle for Effect-owned tables would replace or couple to Effect's private migrations. Effect instead retains its required SQL client and table ownership behind `LocalWorkflowBackend`.
- Sharing one Bun SQLite handle is not supported by Effect's SQLite layer. Separate WAL connections preserve the adapter boundary while the Project Runtime coordinates writes and migrations.
- Using raw SQL or Effect SQL for Kojo records would duplicate the chosen Drizzle schema and migration model.
- Reconstructing current state from Events would make the Execution Trace a control store. Kojo instead commits state and its corresponding Event together.
- Querying Effect tables for reconciliation, orphan scans, or deletion verification would bind Kojo to unstable private encoding. The adapter uses Effect and Message Storage operations only for known references and states the resulting detection limit honestly.
- Offset pagination would shift under concurrent inserts. Keyset cursors and per-Run sequences preserve continuation.
- Persisting redacted copies would create a second value that could drift from authoritative data. Exact values plus immutable Sensitivity Maps keep one durable payload.
- Permanent completed-deletion receipts would violate the no-tombstone decision. A bounded target-free receipt covers lost responses without retaining Run identity indefinitely.

## Consequences

- The Host implementation needs Drizzle schemas, generated and custom migrations, a production `ProjectRepository`, the separate `LocalWorkflowBackend`, and in-memory versions of both interfaces for unit tests.
- Integration tests must exercise two WAL connections, transaction crash windows, duplicate operations, Event immutability and sequence, version placeholders, masking and reveal, Artifact traversal and symlinks, export snapshots, migrations and backup restoration, repair checks, incomplete Activity Attempts, late outcomes after stop, and every deletion phase.
- The CLI and visualizer consume the same masked-by-default control models and never acquire direct database or Effect access.
- Distribution policy must pin compatible Drizzle, Bun SQLite, and Effect versions, but exact packaging and upgrade support remain in the map's distribution decision.

This decision resolves [Define the project database schema and Execution Trace query contract](https://github.com/carere/kojo/issues/14) and follows [Use one project database with separate execution authorities](./0006-use-one-project-database-with-separated-execution-authorities.md), [Assess and repair Project Runtime readiness by capability](./0008-assess-and-repair-project-runtime-readiness.md), [Use one versioned local control protocol for every Kojo client](./0009-use-one-versioned-local-control-protocol.md), and [Protect and explicitly delete local execution data](./0010-protect-and-explicitly-delete-local-execution-data.md).
