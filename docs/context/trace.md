# Trace

What a Run recorded, and how a human reads it. Trace is observability, not execution correctness;
lost observations need not be recoverable, and their absence does not establish an execution outcome.

## Language

### The records

**Trace**:
Everything one run recorded. Not a stream of messages — a small set of wide records that each
describe one completed unit of work.
_Avoid_: log, event log, history

**Run record**:
The row that ties a run's phases together. It carries what produced the run — engine version,
config digest, host, image digest — and it is updated in place as the run's status changes.
_Avoid_: session, adw

**Phase record**:
One wide record of the observations of a Phase attempt, written once on exit. Process loss can
prevent that write; a missing record does not establish the Phase's outcome.
_Avoid_: phase event, span row

**Gate record**:
What was asked of a human, who answered, what they answered, and how long they took.
_Avoid_: approval log

**Sandbox record**:
One acquisition of one sandbox — provider, image digest, branch, worktree, acquisition and release.
A rebuild after a suspension is a new acquisition, so it is a new record.
_Avoid_: sandbox lifecycle, sandbox start/end

**Occurrence**:
One repetition inside a phase — a tool call, an `exec`, an iteration — where the count is unknown
and each instance is its own fact. Occurrences are subordinate: an occurrence never carries context
its phase record lacks, and no question may need one to answer it.
_Avoid_: event, log line

**In-flight phase**:
The latest observation of a Run's executing Phase, separate from its completed Phase records.
It can be stale after process loss and does not establish execution authority. See
[docs/adr/trace/0002-in-flight-phase-lives-on-the-run-row.md](../adr/trace/0002-in-flight-phase-lives-on-the-run-row.md).
_Avoid_: phase start, running phase event

**Artifact**:
A file retained for a Run, such as a rendered prompt, captured agent session, or diff. Its retention
is separate from Trace records, and its presence alone does not establish execution or cleanup.
_Avoid_: attachment, blob, payload, Factory asset, Workflow Revision

### The Console

**Console**:
The Daemon's local web surface for Project and Run inspection and applicable user actions. It reads
Trace and records Gate answers without owning Run execution; it is not a bounded context of its own.
_Avoid_: visualizer, observer, orchestrator, obs, dashboard

**Waterfall**:
The run view. Time runs left to right, and each row is a scope — the host, then one row per sandbox
acquisition. A phase is one span on the row of the scope it ran in. See
[docs/adr/trace/0001-run-view-is-a-waterfall-not-the-authored-graph.md](../adr/trace/0001-run-view-is-a-waterfall-not-the-authored-graph.md).
_Avoid_: gantt, timeline, graph, flowchart

**Break**:
A segment of the waterfall's time axis that is collapsed to a fixed width and labelled with its real
duration. A break replaces any span or gap that would otherwise flatten the rest of the run —
usually a human holding a gate.
_Avoid_: gap, elision, compressed region
