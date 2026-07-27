---
status: accepted
---

# Manage Workflow Schedules as durable project resources

Kojo manages each Workflow Schedule as a version-controlled definition reconciled with project-local durable operational state. The Project Runtime, rather than Effect `Schedule` or `ClusterCron`, owns occurrence identity, enablement, catch-up, overlap, history, and idempotent Workflow Run creation because those Effect APIs do not provide the required management lifecycle.

## Decision

### Definition and identity

- A developer chooses a Schedule Key that is unique within one Kojo Project. Display, export, and file-path changes preserve identity; changing the key creates a new schedule and leaves the old one unavailable. V1 has no rename operation.
- A schedule targets one Workflow Key and declares a standard five-field cron expression, an explicit IANA time zone, a deterministic input rule, and an overlap policy.
- The input rule may use only the Schedule Key and scheduled instant interpreted in the declared time zone. Kojo validates and persists the exact resolved input before requesting a Workflow Run.
- The overlap policy is `allow` or `skip`, defaulting to `allow`. `skip` considers only non-final runs started by the same schedule; manual runs never block it. V1 has no queue or coalescing policy.
- A stable Workflow Schedule Revision identifies the target Workflow Key, cron, time zone, input rule, and overlap policy. Identical declarations keep the same revision across reloads; changing any of those fields changes it. The authoring contract chooses the concrete fingerprint representation.
- A newly discovered schedule starts disabled and requires an explicit enable request.

### Reconciliation and control

- Workflow Authoring owns the version-controlled definition. Workflow Execution owns project-local durable state: enabled intent, the applied revision, operational condition, next occurrence, high-water mark, and history.
- Enabled intent is separate from the `available`, `unavailable`, or `needs-attention` condition. Only an enabled, available schedule has a next occurrence.
- Kojo Configuration snapshots reconcile atomically. If a snapshot cannot load or validate, active Workflow Runs continue, no new scheduled work starts, and the project reports that it needs attention.
- Applying a changed definition under the same Schedule Key preserves enabled intent, invalidates future occurrences from the old revision, and calculates the next occurrence strictly after the update. It never changes an already-created Workflow Run.
- Removing a schedule from a valid configuration makes it unavailable without deleting enabled intent or history. If the same Schedule Key returns, it resumes automatically when previously enabled and does not catch up the unavailable interval. A different key is a new, disabled schedule.
- Enable and disable requests are idempotent and serialized with occurrence processing. If disable is accepted before a Workflow Run Start Request, the occurrence cannot create a run. A run whose start was accepted first continues independently. Enabling or re-enabling calculates the first occurrence strictly after the command time and never starts immediately or catches up disabled time.

### Occurrences and timing

- A Workflow Schedule Occurrence is identified by its Schedule Key and scheduled UTC instant. It is `planned` until it becomes `started`, `skipped`, `invalidated`, or `failed`; final occurrence outcomes are immutable.
- Each enabled, available schedule persists one future occurrence and arms an occurrence-specific durable wake-up through Kojo's `LocalWorkflowBackend`. The Kojo Host keeps its Project Runtime active without a connected client. After restart, the runtime scans durable schedule state, processes due work, and rearms future work. Revision and occurrence checks make duplicate or stale wake-ups harmless.
- Cron cadence is anchored to scheduled instants rather than Workflow Run completion. A slow, suspended, stopped, failed, or completed run never shifts later occurrences.
- When downtime crosses several cron instants, Kojo creates only the latest missed occurrence and records older missed instants as one range summary containing their count and first and last times. Deliberately disabled, unavailable, or invalid intervals never catch up.
- A durable high-water mark records the latest considered scheduled instant. A backward clock change cannot repeat it; a forward jump uses the bounded latest-missed policy. Effect's cron calculation supplies daylight-saving behavior: nonexistent spring-forward local times are skipped and only the first matching fall-back time occurs.

### Delivery and Workflow Runs

- Before requesting a run, Kojo durably records the occurrence identity, applied revision, and exact resolved input. It then uses the occurrence identity as the stable Workflow Run Start Request identity.
- Occurrence delivery is at-least-once. Repeated delivery returns the existing Workflow Run or the same final occurrence decision, so Kojo claims idempotent run creation rather than exactly-once triggering.
- Temporary delivery failures retry the same planned occurrence. A permanent input, missing-definition, or compatibility error makes the occurrence failed and the schedule needs attention, blocking later occurrences.
- Repair never reopens a failed occurrence. It restores the schedule and calculates the next strictly future occurrence; a developer who wants the missed work creates a separate manual Workflow Run.
- A scheduled Workflow Run Start Snapshot records its trigger kind, Schedule Key, occurrence identity, scheduled instant, Workflow Schedule Revision, and resolved input. The occurrence and Workflow Run remain separate, linked histories.

### Inspection and diagnostics

- Schedule inspection exposes its Schedule Key, target Workflow Key, enabled intent, condition and reason, current and applied revisions, cron, time zone, overlap policy, next occurrence, latest occurrence, and active schedule-started runs.
- Occurrence inspection exposes scheduled and processed times, applied revision, outcome and reason, and its linked Workflow Run when one exists. Disabling reports that active runs were not stopped; stopping a run remains a separate operation.
- Removing a definition never deletes schedule or occurrence history. The execution-data retention decision may later prune it only through an explicit policy.
- Each schedule-delivery attempt emits one structured completion event with host, project, Schedule Key, occurrence identity, revision, scheduled time, lateness, attempt, outcome, reason, linked run, duration, and Kojo version. Diagnostic events are not authoritative schedule state or occurrence history.

## Considered Options

- Effect `Schedule.cron` and a repeated Effect keep timing in one live fiber and do not provide managed identity, durable enablement, reconciliation, or occurrence history.
- Effect `ClusterCron` provides durable delayed delivery but serializes executions, collapses or skips missed work according to its own policy, and has no enable, disable, update, or inspection API. Kojo may reuse durable cluster primitives only behind its adapter.
- Enabling schedules when first discovered could start trusted but unexpected work merely by loading or checking out a repository.
- Catching up every missed instant could create an unbounded burst after laptop sleep, while skipping every missed instant would make overnight local schedules unreliable. Running only the latest missed instant provides bounded recovery.
- A single no-overlap policy would hide legitimate concurrency needs. A small explicit policy keeps behavior visible without adding v1 queue semantics.

## Consequences

- Kojo needs its own durable schedule registry, occurrence records, revision checks, high-water marks, reconciliation transaction, and delayed-wake adapter above Effect's unstable APIs.
- The workflow-authoring contract must provide a stable way to fingerprint deterministic input rules and the other revision fields.
- The durable execution record, control protocol, CLI, and visualizer decisions must expose the distinct schedule, occurrence, and Workflow Run identities and lifecycle boundaries defined here.
- Recovery and integration tests must cover duplicate delivery, host downtime, clock movement, daylight-saving changes, configuration replacement, enable-disable races, overlap, and failure repair.

This decision resolves [Define Workflow Schedule lifecycle and triggering semantics](https://github.com/carere/kojo/issues/15) and follows the runtime ownership established by [Host Project Runtimes in one supervised local service](./0004-host-project-runtimes-in-one-local-service.md).
