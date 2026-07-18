# Kojo

Kojo is a software-factory builder for defining and running reusable Developer Workflows. It gives
software engineers orchestration primitives while delegating sandboxed agent execution to an
execution primitive such as Sandcastle.

## Language

**Software Factory**:
A Developer Workflow that receives developer work and coordinates code, agents, Sandboxes, loops,
and other Developer Workflows to produce governed outcomes.
_Avoid_: Workflow catalog, CI pipeline

**Developer Workflow**:
A software-engineer-authored Effect program that coordinates a class of developer work. It owns its
input handling, scheduling, routing, loops, and outcome through ordinary TypeScript and Effect
composition rather than belonging to a predefined workflow category or graph DSL.
_Avoid_: Pipeline, workflow template, implementation workflow

**Workflow Run**:
A durable execution of a Developer Workflow for a specific input, with its own state, evidence, and
outcome. It executes on the host where Kojo was invoked, is pinned to one Workflow Revision, and can
be resumed after failure or deliberately discarded.
_Avoid_: Job, workflow

**Workflow Run State**:
The single persisted lifecycle state of a Workflow Run: Running, Suspended, Interrupted, Failed,
Completed, or Discarded. Revision compatibility is diagnosed separately and never replaces this
state.
_Avoid_: Run status, compatibility state

**Execution Attempt**:
One period in which a process owns and executes a Workflow Run. Resuming an unfinished Workflow Run
creates the next numbered Execution Attempt without changing the Workflow Run's identity or erasing
earlier evidence.
_Avoid_: Workflow Run, retry

**Resume Compatibility**:
The derived diagnosis of whether the currently discovered Developer Workflow exactly matches a
Workflow Run's pinned stable name, declared version, and source fingerprint. An incompatible run
retains its Workflow Run State but cannot be resumed.
_Avoid_: Incompatible state, latest-compatible

**Workflow Revision**:
The exact Developer Workflow definition used by a Workflow Run. Its repository-scoped stable name
identifies the Developer Workflow, its declared version is an opaque author-controlled label, and
its Kojo-generated source fingerprint identifies the replay-relevant executable closure. All three
must match for resumption; the same name and declared version with another fingerprint is a
different Workflow Revision.
_Avoid_: Workflow version, latest workflow

**Agent Step**:
A workflow step whose work is delegated to an AI agent in an isolated execution environment.
_Avoid_: Agent, task

**Reviewer Step**:
A read-only Agent Step that evaluates the cumulative change and reports structured P1, P2, or P3
findings. It never modifies the code; remediation belongs to an implementer.
_Avoid_: Review-and-repair step, reviewer repair

**Code Step**:
A named deterministic computation or tool execution performed by a Developer Workflow.
_Avoid_: Script node, code agent

**Human Step**:
A future workflow step that waits durably for a person to supply judgment, approval, or another
explicit decision.
_Avoid_: Manual task, human agent

**Sandbox**:
A provider-independent isolated execution environment created through Sandcastle and used by one or
more Agent Steps or Code Steps. Its boundary and name are chosen by the workflow author, and it may
be backed by a local container, cloud compute, or another provider.
_Avoid_: Container, worker

**Reusable Sandbox**:
A Sandbox created once and used for multiple agent runs so they share the same branch, filesystem,
installed dependencies, and accumulated changes.
_Avoid_: Long-lived container, agent session

**Child Workflow**:
A Developer Workflow invoked durably by another Developer Workflow. Its Workflow Run remains linked
to its parent while retaining its own input, state, evidence, and outcome.
_Avoid_: Subroutine, workflow step

**Route**:
A transition selected by a Developer Workflow from a Workflow Run's input or accumulated results.
_Avoid_: Branch

**Loop**:
Workflow control that repeats a defined portion of a Developer Workflow until an exit condition or a
configured limit is reached.
_Avoid_: Agent iteration, retry

**Review Loop**:
A bounded Loop in which a reviewer evaluates the latest implementation and the implementer addresses
the review findings in a Reusable Sandbox. It succeeds only when the reviewer reports no P1, P2, or
P3 finding, and stops unsuccessfully when its configured iteration limit is reached.
_Avoid_: Review retry, reviewer repair
