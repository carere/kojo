# Workflow Execution

Workflow Execution controls workflow runs and preserves enough state and evidence to inspect and stop them safely.

## Language

**Workflow Run**:
One requested execution of a Workflow Definition. A stopped, failed, or completed Workflow Run never continues; starting again creates a new Workflow Run from the beginning. Re-delivering the same Workflow Run Start Request returns the existing Workflow Run rather than creating another one.
_Avoid_: Job, process

**Workflow Run Start Request**:
A manual request or due Workflow Schedule occurrence that asks Kojo to create one Workflow Run. Its stable identity makes repeated delivery return the same run, while reuse with different contents conflicts and a new deliberate request or occurrence creates a new run even when its input is unchanged.
_Avoid_: Execution retry, replay

**Workflow Schedule Occurrence**:
One calendar instant considered for one Workflow Schedule. Its identity combines the Schedule Key and scheduled instant, so at-least-once delivery preserves one lifecycle: `planned` until it becomes `started`, `skipped`, `invalidated`, or `failed`. A started occurrence links to exactly one Workflow Run; temporary delivery failures retry the same planned occurrence, while a final occurrence is immutable.
_Avoid_: Cron tick, scheduled run

**Workflow Schedule State**:
The durable operational state of one Workflow Schedule, separate from its version-controlled definition. It exposes enabled intent separately from an `available`, `unavailable`, or `needs-attention` condition, and records the applied Workflow Schedule Revision and a high-water mark for the latest considered scheduled instant. Only an enabled, available schedule has a next occurrence; configuration changes and clock movement do not repeat an already-considered instant or alter already-created Workflow Runs.
_Avoid_: Schedule config, cron process

**Child Workflow Run**:
A Workflow Run durably started and owned by another Workflow Run, with identity scoped to its parent, Workflow Key, and stable invocation key. It has its own state and Execution Trace, cannot outlive its parent, and replay never creates a replacement for the same invocation.
_Avoid_: Nested execution, execution boundary

**Kojo Host**:
The long-lived local service for one developer that keeps Kojo work progressing without a connected CLI or visualizer. It contains an isolated Project Runtime for each active Kojo Project.
_Avoid_: Global daemon, control plane

**Project Runtime**:
The isolated owner that coordinates Workflow Schedules and Workflow Runs for one Kojo Project inside the Kojo Host. The CLI and visualizer control it as clients.
_Avoid_: Kojo Host, visualizer server, run worker

**Project Runtime Readiness**:
The condition in which a Project Runtime has opened its durable store, acquired engine ownership, and registered compatible Workflow Definitions. It does not accept or recover work before reaching this condition; once ready, it recovers non-final Workflow Runs without restarting final runs.
_Avoid_: Host health, process liveness

**Workflow Run State**:
The current durable lifecycle condition of a Workflow Run: running, suspended, stopping, stopped, failed, or completed. It owns Kojo's accepted lifecycle decisions and public outcome, while the durable Workflow Engine owns replay of workflow code and Workflow Activity results. Running, suspended, and stopping are non-final; stopped, failed, and completed are final and never resume.
_Avoid_: Status row, process state

**Workflow Run Stop Request**:
A durable request to safely end a non-final Workflow Run and its children. Once accepted it wins over later outcomes, blocks new forward work, and leaves the run stopping until interruption and required cleanup finish.
_Avoid_: Kill, cancellation

**Workflow Run Resume Request**:
A request to continue a manually suspended Workflow Run under its existing identity. It is idempotent, reuses completed Workflow Activities, and never restarts a final run.
_Avoid_: Restart, retry run

**Workflow Run Start Snapshot**:
The immutable evidence captured when a start is accepted. It contains the exact non-secret inputs, trigger kind, and verifiable identities for the workflow source and execution environment; a scheduled start also records its Schedule Key, occurrence identity, scheduled instant, and Workflow Schedule Revision. It is not an executable archive. The first Execution Event contains the snapshot so the Execution Trace is self-contained. Identities learned after execution starts are recorded as later Execution Events.
_Avoid_: Workflow backup, resumable snapshot

**Workflow Activity**:
A named durable side effect within a Workflow Run whose recorded result is reused during replay. It may be a custom Effect program or a Kojo Agent or Command operation. An Activity without a durable result may run again with the same Activity Idempotency Key, so its external effect is at-least-once.
_Avoid_: Task, step

**Workflow Activity Attempt**:
One actual invocation of a Workflow Activity's external work. A crash before the Workflow Engine records the result may leave one attempt incomplete and cause another attempt with a new identity but the same Activity Idempotency Key.
_Avoid_: Retry

**Activity Idempotency Key**:
A stable identity for one intended external side effect across retries of a Workflow Activity. An external adapter uses it to avoid repeating work that succeeded before the Activity result became durable.
_Avoid_: Request ID, Activity name

**Durable Operation Key**:
A developer-chosen identity for a replay-sensitive operation within one Workflow Run. Reusing it for the same logical operation returns the recorded result, while reuse with different contents conflicts; a Child Workflow Run establishes a new key scope.
_Avoid_: Array index, attempt number

**Workflow Sandbox**:
A logical execution environment identified by a stable key within one Workflow Run. Reusing the key with the same definition refers to the same environment; recovery may recreate its provider session while preserving durable worktree state and recorded artifacts. Processes, installed packages, and environment mutations are not durable unless the definition or provider explicitly guarantees them.
_Avoid_: Container, provider handle

**Workflow Deferred**:
A named durable wait within one Workflow Run. Awaiting an incomplete Workflow Deferred suspends the run, and a serializable completion token lets Kojo complete it later without exposing the Workflow Engine's private identity.
_Avoid_: Promise, in-memory deferred

**Agent Session**:
A provider-native conversation reference optionally returned by an Agent invocation and explicitly passed to a later invocation. It is usable only when the selected Agent Provider and Workflow Sandbox support continuation, and it never represents Workflow Run suspension, resume, or recovery.
_Avoid_: Workflow session, checkpoint

**Execution Boundary**:
A nested unit of activity within a Workflow Run. Its start is recorded for live inspection and crash evidence, and its end produces one context-rich completion event. The Workflow Definition determines which kinds of activity become boundaries.
_Avoid_: Log scope, trace span

**Execution Event**:
A durable, append-only structured fact about activity within a Workflow Run. Each event has a globally unique identity and a strict sequence within its Workflow Run. Concurrent Workflow Runs do not share an authoritative order. Execution Events form the user-visible detailed history rather than the current Workflow Run State.
_Avoid_: Log line, database event

**Execution Trace**:
The ordered view of one Workflow Run reconstructed from its Execution Events. It may refer to disposable Execution Artifacts, but diagnostic logs are not part of it.
_Avoid_: Console log, transcript

**Execution Artifact**:
A disposable file produced or captured during a Workflow Run and referenced by identity from its Execution Trace. Losing an Execution Artifact is shown explicitly and can reduce historical detail, but never damages the trace or changes the recorded outcome of the run.
_Avoid_: Durable output
