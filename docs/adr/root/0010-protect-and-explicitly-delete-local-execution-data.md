---
status: accepted
---

# Protect and explicitly delete local execution data

Kojo treats execution payloads as sensitive local data while retaining the exact values required for durable execution and authoritative history. V1 relies on one developer's operating-system account as its security boundary, masks sensitive values at inspection boundaries, bounds disposable data automatically, and requires explicit CLI operations to delete authoritative history.

## Decision

### Local trust and storage boundary

- The operating-system user who owns a Kojo Project may inspect and control all of its data. V1 has no additional roles or per-Project access-control list.
- The Host socket, Host diagnostic store, `.kojo/`, its database, and its owned files use user-only access. The visualizer reaches the Host only through its explicit same-origin server operations. Remote agents and sandboxes receive only data a Workflow or provider adapter explicitly passes to them.
- Kojo relies on operating-system permissions and the developer's disk encryption rather than managing an application encryption key that other same-user processes could obtain. Documentation and warnings state that same-user processes can read Kojo's local data.

### Sensitive values, credentials, and redaction

- Workflow and Activity inputs and results, suspension and resume values, Agent transcripts and session data, Execution Artifact contents, and detailed diagnostics are Sensitive Execution Data. Identities, states, timestamps, revisions, relationships, and outcome categories are ordinary metadata unless marked sensitive.
- The durable Workflow Engine and authoritative Execution Events retain exact schema-encoded values when execution or history requires them. A sensitivity marking controls presentation and export rather than changing the durable value.
- Every encoded payload stores an immutable Sensitivity Map derived from its schema at encoding time. A parent marking covers its subtree. If the map is missing or invalid, inspection masks the whole payload so unavailable historical source cannot weaken protection.
- Kojo masks sensitive values in ordinary CLI, visualizer, and export results. Each request that reveals values or produces an unredacted export requires an explicit option and warns that arbitrary content has not been scanned for secrets. A masked value exposes only a placeholder and its type, never a preview, length, or hash.
- Artifact access is an explicit download through a Project- and Run-scoped operation. Kojo does not render downloaded content as active HTML.
- Redaction covers known secret sources and explicit schema markings; it does not claim to discover secrets embedded in arbitrary strings, results, transcripts, or files.
- Provider credentials are resolved only at invocation time from the environment, operating-system credential storage, or developer-provided Effect services. Kojo may persist non-secret provider identity and lookup settings but never the credential itself.

### Deep Diagnostic Events

- Kojo follows the deep or wide completion-event model: one structured Diagnostic Event is accumulated and emitted when each service hop or supervised operation completes rather than scattering log messages through it.
- Boundaries include Host requests, Project Runtime activation, readiness assessment or repair, Workflow Schedule delivery attempts, Workflow Run reconciliation, Workflow Activity Attempts, provider calls, retention passes, deletion operations, and developer-defined Execution Boundaries. Authoritative lifecycle facts remain Execution Events and are not duplicated into extra diagnostic messages.
- A Diagnostic Event may contain safe identities, operation and outcome kinds, lifecycle state, durations, sizes, versions, environment characteristics, and safe error codes. It excludes payloads, transcript text, Artifact contents, environment values, command arguments, full local paths, Provider Credentials, and raw exceptions.
- One Host logger writes rotated JSON Lines into a user-only, machine-local diagnostic store outside Kojo Projects. Events are partitioned or accounted by Project Identity when applicable; Host-wide events remain in the same store.
- Diagnostic Events use only informational and error outcomes and are best-effort. A logging failure never replaces or changes an authoritative result and must not recursively generate more log failures.

### Retention

- Execution Data Retention Policy is operational Project state in the Project database, not version-controlled Kojo Configuration.
- Workflow Schedule State, Workflow Schedule Occurrences, Workflow Run State, durable Workflow Engine state, and Execution Events remain until an explicit deletion. Internal engine compaction is allowed only when it preserves every durable behavior and retained authoritative fact.
- Data required by a non-final Workflow Run, enabled Workflow Schedule, recovery, resume, or cleanup is never automatically removed. Continuation data, transcripts, sandbox state, and Artifacts become disposable only after their run is final.
- Diagnostic Events default to 14 days and 100 MiB per Project, with a 500 MiB Host-wide safety limit. Disposable transcripts, session files, sandbox state, and Artifacts default to 30 days after finality and 5 GiB per Project. Limits are configurable and may be disabled.
- Cleanup runs at Host activation, periodically, and after large writes. It removes the oldest eligible content when either age or size is exceeded. If protected data alone exceeds a limit, Kojo retains it, exposes a retention warning, and emits one deep Diagnostic Event rather than weakening recovery.

### Explicit deletion

- Authoritative-history and retention changes are CLI-only in v1. The visualizer may inspect the policy, explicitly reveal sensitive values, and download Artifacts, but it cannot delete history. Every destructive command previews its scope, rechecks it at execution, and requires explicit confirmation.
- A Workflow Run deletion targets a final top-level Run and its complete Child Workflow Run tree. It removes their engine data, Run State, Execution Events, Workflow Activity Attempts, deferred data, transcripts, Artifacts, and sandbox state together. A scheduled occurrence that started the deleted Run remains as a minimal record that its Run was deleted; Kojo retains no other permanent Run tombstone.
- A developer may separately prune final Workflow Schedule Occurrences older than a chosen instant without deleting linked Runs. An unavailable and disabled Workflow Schedule may be explicitly forgotten with its operational state and occurrence history; retained Runs remain self-contained through their start snapshots.
- Forgetting a Project removes only its Project Index entry and never deletes Project files. Full Project execution-data erasure first quiesces its Project Runtime, requires every Run to be final, and stops schedule processing. It removes the database contents, Project-partitioned Diagnostic Events, Artifacts, transcripts, sandboxes, and provider sessions, then creates a fresh empty database while preserving `project.json`, Project Identity, tracked source, and Kojo Configuration. Rediscovered Workflow Schedules start disabled.
- Kojo records local deletion intent before removing owned data, makes the target unavailable for new work, and resumes an interrupted deletion idempotently after Host recovery. It does not report success while a Kojo-owned file remains because of an error.
- Provider adapters request remote session cleanup when supported. Unsupported or failed provider cleanup produces a warning but does not prevent local deletion, and Kojo does not retain credentials or sensitive data indefinitely just to retry it.
- Execution Data Deletion promises logical removal from active Kojo storage and best-effort owned-file and provider cleanup, not secure physical erasure from SQLite pages, filesystem snapshots, backups, exports, or remote systems. A deletion Diagnostic Event may retain an ordinary Run identity until normal log retention removes it; full Project erasure removes its Project-partitioned Diagnostic Events.

## Considered Options

- Kojo-managed encryption at rest would add recovery and key-management failure modes without protecting data from other processes already running as the same user.
- Content scanning cannot reliably find secrets in arbitrary developer and provider output. Explicit schema markings, known-source exclusion, safe defaults, and honest warnings give a testable contract.
- Keeping every transcript, sandbox, Artifact, and log indefinitely would make local disk growth unbounded. Automatically pruning authoritative records would weaken history and recovery, so only disposable data has automatic limits.
- Project-local diagnostic files would not cover Host-wide activation and control work and would expand the initialized Project layout. A partitioned Host store preserves one diagnostic pipeline while still allowing per-Project retention and erasure.
- Destructive visualizer controls would increase the browser-facing safety surface. CLI-only deletion gives v1 an explicit preview and confirmation path without creating different read permissions.
- Permanent Run tombstones would weaken the meaning of deletion. Only a Workflow Schedule Occurrence keeps the minimum marker needed to preserve its own authoritative lifecycle.

## Consequences

- The database and Execution Trace query design must store and apply Sensitivity Maps, default every payload view to masked, and preserve self-contained scheduled-run snapshots when occurrence history is pruned.
- The Host needs one structured diagnostic sink with Project accounting, rotation, safe failure behavior, and deep completion events at control and execution boundaries.
- Retention and deletion must be serialized with Project Runtime ownership, preserve non-final recovery data, and reconcile database, filesystem, and provider cleanup after interruption.
- CLI and browser tests must cover masked defaults, explicit reveal warnings, Artifact download safety, deletion previews, retention limits, protected-data overages, and interrupted cleanup.

This decision resolves [Define execution-data security and retention](https://github.com/carere/kojo/issues/10) and follows [Use one project database with separate execution authorities](./0006-use-one-project-database-with-separated-execution-authorities.md), [Assess and repair Project Runtime readiness by capability](./0008-assess-and-repair-project-runtime-readiness.md), and [Use one versioned local control protocol for every Kojo client](./0009-use-one-versioned-local-control-protocol.md).
