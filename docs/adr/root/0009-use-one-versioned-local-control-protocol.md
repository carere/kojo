---
status: accepted
---

# Use one versioned local control protocol for every Kojo client

Kojo exposes one transport-neutral `@kojo/control` contract to the CLI and visualizer rather than giving either client direct access to the Host, Project Runtime, database, or durable Workflow Engine. The CLI carries this contract over the per-user Unix socket, while the visualizer's local server proxies the same contract to its same-origin browser client.

## Decision

### Authority and project discovery

- The Host is the only component that applies lifecycle decisions. The CLI and visualizer are clients that submit typed requests and render authoritative results.
- Both clients may start Workflow Runs; enable or disable Workflow Schedules; resume or stop Workflow Runs; complete Workflow Deferreds; refresh readiness; add the required ignore rule; and retry a failed migration.
- Assigning a new Project Identity, replacing missing durable data, and forgetting a Project are CLI-only operations. No client can send arbitrary shell commands or filesystem edits through the Host.
- The Host's Project Index is the only authoritative Project list. The visualizer stores only versioned presentation preferences such as the selected Project, hidden Projects, pins, and ordering, keyed by Project Identity. It ignores malformed entries and reconciles the rest against the current Project Index.
- Registering a Project submits a path to an already-initialized Git working tree. The Host resolves and validates its canonical path, Project Identity, and layout. Forgetting removes only its Project Index entry, deletes no project data, and is rejected while the Project has enabled schedules or non-final runs.

### Connection and compatibility

- `@kojo/control` owns versioned Effect RPC commands, queries, results, errors, and change schemas. A shared local-client adapter owns Host discovery, Unix-socket transport, operating-system activation, and bounded reconnect behavior.
- The first exchange reports the protocol major and minor version, Host version, and supported capabilities. A major mismatch stops before a lifecycle request and returns upgrade guidance; optional minor behavior requires an explicit capability.
- Only Host information and the Project list are Host-wide. Every Workflow Definition, Workflow Schedule, occurrence, Workflow Run, readiness, repair, and Execution Trace operation identifies exactly one Kojo Project.
- The browser never connects to the Host socket or receives a generic Host proxy. The visualizer server maps its explicit browser operations to the same control contract.

### Requests and results

- Every state-changing request carries a client-generated Request Key. Redelivery with the same contents returns the existing result; reuse with different contents conflicts.
- A manual start includes the Workflow Definition Revision the client observed. Enabling a schedule includes the Workflow Schedule Revision the client observed. A stale revision returns a typed conflict and the current snapshot. Disabling future occurrences, resuming, and stopping remain idempotent without a revision precondition.
- A repair request carries the readiness assessment revision already required by Project Runtime Readiness. The Host rechecks every precondition before applying it.
- A successful command returns the newly committed resource snapshot, whether the request was already applied, and its Request Key rather than a bare acknowledgment. A scheduled start exposes both the occurrence and its linked Workflow Run.
- Project, schedule, occurrence, and run snapshots expose the actions currently allowed by the Host. Clients may use them to render controls but never reproduce lifecycle rules; the Host authorizes every request again.
- Expected refusals are typed results with a stable code, safe message, affected resource, retry guidance, and relevant current revisions or Readiness Finding keys. Connection, decoding, and incompatible-protocol failures remain transport errors. Raw exceptions and secrets do not cross the control contract.

### Control surface

The control contract provides operations to:

- negotiate the connection, inspect the Host, list Projects, and watch changes;
- register, forget, and inspect a Project; inspect or refresh readiness; and request an allowed typed repair;
- list and inspect Workflow Definitions;
- list and inspect Workflow Schedules, inspect their next occurrence and occurrence history, and enable or disable future occurrences;
- start, list, and inspect Workflow Runs; resume or stop a run; complete a Workflow Deferred; and read or follow an Execution Trace; and
- inspect Child Workflow Runs through the same run operations, using their parent links and query filters.

The contract has no manual suspend, recover, retry, replay, unsafe force-stop, raw-log, raw-database, or raw-Effect operation. Suspension is observed, a manually suspended run may be resumed, and crash recovery proceeds automatically when its Project Runtime is ready. Completing a Workflow Deferred is not run resume, and disabling a Workflow Schedule never stops an accepted run.

### Histories and live changes

- Workflow Schedule Occurrences, Workflow Runs, and each run's Execution Trace remain separate, linked views. Activity attempts and replay evidence appear in the Execution Trace; Effect's private engine history is never a product API.
- One subscription may select several Projects and topics such as readiness, schedules, runs, and traces. Every update carries its Project Identity, and Kojo claims no authoritative ordering across Projects.
- Execution Trace updates carry their durable sequence within one Workflow Run. Other updates are temporary change notices rather than a second durable history.
- Reconnecting clients reload current snapshots and continue a trace from its per-run sequence. A slow client receives a resync-required result and reloads; it never delays the Host.

## Considered Options

- A read-only visualizer would have reduced the browser control surface but forced developers to switch tools for ordinary lifecycle decisions already authorized by the Host.
- A visualizer-owned Project list would have created a second source of truth and conflicting validation behavior beside the Project Index.
- A durable global change stream would have invented ordering across independent Project Runtimes and duplicated the authoritative resource histories. Snapshot reload plus per-run trace continuation keeps recovery explicit without another durable record.
- Letting clients interpret lifecycle state or proxy arbitrary Host calls would have made UI and CLI behavior drift and weakened the Project Runtime's ownership boundary.

## Consequences

- `@kojo/control` must remain independent of Unix-socket frames, browser RPC details, Effect execution identities, SQLite rows, and Host implementation modules.
- Host integration tests must cover retry idempotency, stale revisions, version negotiation, multi-Project subscriptions, reconnect, slow-client resynchronization, and the CLI-only operation boundary.
- The exact database queries, pagination, Execution Trace reconstruction, CLI syntax, and visualizer interactions remain in their dedicated Wayfinder decisions. [Protect and explicitly delete local execution data](./0010-protect-and-explicitly-delete-local-execution-data.md) defines redaction, Artifact access, retention, and deletion across this contract.

This decision resolves [Define the CLI and visualizer control protocol](https://github.com/carere/kojo/issues/9) and follows [Organize Kojo around stable package seams and a dedicated Host app](./0007-organize-kojo-around-stable-package-seams-and-a-dedicated-host-app.md), [Assess and repair Project Runtime readiness by capability](./0008-assess-and-repair-project-runtime-readiness.md), and [Use one project database with separate execution authorities](./0006-use-one-project-database-with-separated-execution-authorities.md).
