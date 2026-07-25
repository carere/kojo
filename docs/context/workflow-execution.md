# Workflow Execution

Workflow Execution controls workflow runs and preserves enough state and evidence to inspect, stop, and continue them safely.

## Language

**Workflow Run**:
One requested execution of a Workflow Definition. Its identity remains stable when execution stops and later continues.
_Avoid_: Job, process

**Execution Attempt**:
One continuous period of work on a Workflow Run. Continuing a stopped or interrupted run starts a new attempt.
_Avoid_: Retry

**Workflow Run State**:
The current lifecycle condition and durable progress of a Workflow Run.
_Avoid_: Status row, process state

**Execution Event**:
An append-only structured fact about activity within a Workflow Run. Execution Events form the detailed history rather than the current Workflow Run State.
_Avoid_: Log line, database event

**Execution Trace**:
The ordered view of a Workflow Run reconstructed from its Execution Events across every Execution Attempt.
_Avoid_: Console log, transcript

**Execution Artifact**:
A disposable file produced or captured during a Workflow Run. Losing an Execution Artifact can reduce historical detail but never prevents the run from continuing.
_Avoid_: Checkpoint, durable output

**Checkpoint**:
Durable progress recorded at a safe execution boundary so a later Execution Attempt can continue the Workflow Run.
_Avoid_: Artifact, snapshot
