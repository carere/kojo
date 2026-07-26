# Workflow Execution

Workflow Execution controls workflow runs and preserves enough state and evidence to inspect and stop them safely.

## Language

**Workflow Run**:
One requested execution of a Workflow Definition. A stopped, interrupted, failed, or completed Workflow Run never continues; starting again creates a new Workflow Run from the beginning.
_Avoid_: Job, process

**Project Runtime**:
The single local owner that coordinates active Workflow Runs for one Kojo Project. It is independent of the CLI and visualizer, which control Workflow Runs as clients.
_Avoid_: Global daemon, visualizer server, run worker

**Workflow Run State**:
The current durable lifecycle condition of a Workflow Run: running, stopping, stopped, interrupted, failed, or completed. Every state other than running and stopping is final.
_Avoid_: Status row, process state

**Workflow Run Start Snapshot**:
The immutable evidence captured when a start is accepted. It contains the exact non-secret inputs and verifiable identities for the workflow source and execution environment, but it is not an executable archive. The first Execution Event contains the snapshot so the Execution Trace is self-contained. Identities learned after execution starts are recorded as later Execution Events.
_Avoid_: Workflow backup, resumable snapshot

**Execution Boundary**:
A nested unit of activity within a Workflow Run. Its start is recorded for live inspection and crash evidence, and its end produces one context-rich completion event. The Workflow Definition determines which kinds of activity become boundaries.
_Avoid_: Log scope, trace span

**Execution Event**:
A durable, append-only structured fact about activity within a Workflow Run. Each event has a globally unique identity and a strict sequence within its Workflow Run. Concurrent Workflow Runs do not share an authoritative order. Execution Events form the user-visible detailed history rather than the current Workflow Run State.
_Avoid_: Log line, database event

**Execution Trace**:
The ordered view of one Workflow Run reconstructed from its Execution Events. Its journal may use multiple ordered segments after damage or rotation. It may refer to disposable Execution Artifacts, but diagnostic logs are not part of it.
_Avoid_: Console log, transcript

**Execution Artifact**:
A disposable file produced or captured during a Workflow Run and referenced by identity from its Execution Trace. Losing an Execution Artifact is shown explicitly and can reduce historical detail, but never damages the trace or changes the recorded outcome of the run.
_Avoid_: Durable output
