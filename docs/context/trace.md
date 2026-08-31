# Trace

What a run recorded, and how a human reads it. The trace is observability, not correctness: if you
lose it, you lose nothing you cannot rebuild. It holds one wide record per unit of work, and the
Console is the surface a human reads those records through.

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
Everything known about one phase, written once, on exit, on every path. It is the canonical wide
record of the trace. Anything a phase did that is not on its record is not answerable.
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
The phase a run is executing right now, held on the run record and updated in place. It is not a
phase record. It is the run's current status, and the phase record replaces it on exit. See
[docs/adr/trace/0002-in-flight-phase-lives-on-the-run-row.md](../adr/trace/0002-in-flight-phase-lives-on-the-run-row.md).
_Avoid_: phase start, running phase event

**Artifact**:
A file a phase produced or consumed that is too large for the trace — the rendered prompt, the
captured agent session, the diff. The trace records that it exists; the artifact is read from disk
or from git on demand.
_Avoid_: attachment, blob, payload

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
