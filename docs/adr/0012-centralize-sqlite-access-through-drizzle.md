# Centralize SQLite access through Drizzle

The Kojo System Process will be the only process that opens `KOJO_HOME/state.sqlite` during normal
operation. It will use Drizzle ORM as Kojo's sole SQLite access and migration layer, including for
the Effect Workflow journal. Kojo will implement Effect's `WorkflowJournal` interface over Drizzle
rather than using Effect's `SqlClient`; this supersedes that adapter detail from
[Assess Effect Workflow as Kojo's embedded durable kernel](https://github.com/carere/kojo/issues/3).

Project Runtime Processes will submit typed storage commands through the System Process's private
local interface and will never receive SQL or a database connection. Every execution command will
carry its Project ID, root Run ID, Run ID, Execution Attempt, Execution Lease generation, and
idempotency key. The System Process will validate that scope before writing. One Workflow Run Tree
belongs to one Project.

Drizzle-managed relational tables will hold Project registrations and source revisions, Workflow
Revisions and runtime configuration, Workflow Runs and their relationships, transitions, attempts,
Execution Leases and lifecycle requests, the Effect Workflow journal, Evidence Events, and artifact
metadata and references. Stable identities, relationships, lifecycle state, ordering, leases, and
query fields will be columns with foreign-key constraints. Evolving inputs, results, failures, and
event details will use separately versioned encoded payloads. History will not use cascading
deletion, and read projections will remain rebuildable.

Each durable boundary will use one short SQLite transaction that spans the journal mutation,
Workflow Run state, required Evidence Events, and artifact references. Transactions will never
remain open while workflow code or an external action executes. Tree-wide lifecycle changes will
converge through multiple transactions rather than one transaction across the tree.

Large Execution Artifacts will be immutable, fingerprinted files under Kojo Home. Kojo will stage,
flush, and fingerprint their bytes before transactionally attaching finalized metadata to evidence.
Recovery may remove abandoned staging files, and identical finalized content may share physical
storage.

Each active Execution Attempt will have a generation-numbered Execution Lease held by one Project
Runtime Process session. Heartbeats renew it. Expiration or System Process restart invalidates the
old generation, rejects delayed writes, and reconciles affected Running runs to Interrupted with
evidence. A failed commit after an external Activity may instead leave an Uncertain Activity
Outcome.

SQLite will run on a local filesystem with WAL mode, full durability, foreign-key enforcement, and
owner-only permissions. Ordered forward migrations run before the System Process becomes ready;
irreversible migrations first create a backup, failed migrations stop safely, and an older Kojo
version refuses a newer schema.

An explicit online backup snapshots SQLite, copies all referenced immutable artifacts, and emits a
checksummed manifest. Restore, full verification, migration repair, and compaction require the
System Process to be stopped and the Kojo Home lock to be held. Corruption is never silently
recreated: database corruption blocks normal startup, while missing artifacts remain visibly
unavailable and block resumption only when replay needs them.

Aggregate queries list root Workflow Runs across Projects by `(created_at, run_id)` in descending
keyset order, with optional Project, state, and workflow filters. Child runs load through their
Workflow Run Tree, while Evidence Events retain only their authoritative run-local sequence.
Normal inspection and visualization use the running System Process and never open SQLite directly.

## Considered Options

- Let Project Runtime Processes open SQLite directly.
- Use Effect's `SqlClient` for the Workflow Journal and Drizzle for Kojo's other tables.
- Keep one database per Project and aggregate across them.
- Store large artifacts as SQLite blobs.
- Treat generic encoded records as the authoritative schema instead of relational constraints.

## Consequences

- One writer and one ORM make cross-cutting journal, lifecycle, and evidence transactions possible.
- Drizzle becomes a new dependency and the System Process must provide the complete storage command
  boundary.
- Runtime isolation is enforced by typed, lease-scoped capabilities instead of database
  permissions inside project-local code.
- Source-independent inspection remains available whenever the System Process is running, even when
  Project source is missing or incompatible.
- Backups and corruption affect the whole Kojo installation, but immutable artifacts make a
  consistent online snapshot practical.
- Evidence and discarded runs are not automatically pruned in the first vertical slice. Kojo may
  deduplicate artifacts, checkpoint WAL data, clean staging files, monitor capacity, and compact
  explicitly without deleting canonical history.
