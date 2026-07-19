# Kojo

Kojo is a software-factory builder for defining and running reusable Developer Workflows. It gives
software engineers orchestration primitives while delegating sandboxed agent execution to an
execution primitive such as Sandcastle.

## Language

**Software Factory**:
A Developer Workflow that receives developer work and coordinates code, agents, Sandboxes, loops,
and other Developer Workflows to produce governed outcomes.
_Avoid_: Workflow catalog, CI pipeline

**Project**:
A Git repository folder registered with one local Kojo installation. It is the unit from which
Developer Workflows are loaded and under which Workflow Runs are grouped. Linked Git worktrees are
execution resources associated with Workflow Runs and Sandboxes, not separate Projects.
_Avoid_: Git worktree, Workflow Registry

**Project ID**:
The opaque identity assigned to a Project by one local Kojo installation. A Project keeps this
identity when its folder moves; its path, Git remote, folder name, branch, and commit are metadata
rather than identity.
_Avoid_: Project path, repository URL

**Project Registration State**:
The user's installation-local intent for a Project: Enabled, Disabled, or Archived. Enabled permits
new root Workflow Runs; Disabled prevents future root starts without stopping a currently Running
Workflow Run Tree; Archived retains identity and history without remaining an active registration.
_Avoid_: Project Availability, Workflow Run State

**Project Availability**:
The derived diagnosis of whether an Enabled or Disabled Project can currently start a root Workflow
Run from its registered folder and compatible Workflow Registry. Availability reports structured
reasons without changing Project Registration State.
_Avoid_: Project Registration State, Resume Compatibility

**Kojo Home**:
The user-scoped home of one local Kojo installation. It holds installation-wide Project and
Workflow Run state rather than repository-authored workflow behavior or secrets.
_Avoid_: Project `.kojo` directory, workflow configuration

**Developer Workflow**:
A software-engineer-authored Effect program that coordinates a class of developer work. It owns its
input handling, scheduling, routing, loops, and outcome through ordinary TypeScript and Effect
composition rather than belonging to a predefined workflow category or graph DSL.
_Avoid_: Pipeline, workflow template, implementation workflow

**Workflow Acceptance Test**:
A deterministic test that runs a Developer Workflow through its public entry point with controlled
in-memory adapters and checks its outcome, Workflow Run State, meaningful Execution Evidence, and
observable external calls. It proves the workflow's behavior, not the production adapter wiring.
_Avoid_: System end-to-end test, adapter contract test

**Workflow Registry**:
The validated, explicitly configured set of Developer Workflows available from one repository.
Every member has a unique repository-scoped stable name; Kojo never discovers members by scanning
for files.
_Avoid_: Workflow catalog, auto-discovered workflows

**Workflow Entry Point**:
The repository-local TypeScript module declared by a Developer Workflow as the root of its
replay-relevant static source closure. Kojo uses it to compute that workflow's source fingerprint;
it is provenance, not the workflow's stable identity.
_Avoid_: Workflow name, CLI selector

**Workflow Run**:
A durable execution of a Developer Workflow for a specific input, with its own state, evidence, and
outcome. It executes on the host where Kojo was invoked, is pinned to one Workflow Revision, and can
be resumed after failure or deliberately discarded.
_Avoid_: Job, workflow

**Workflow Run ID**:
The opaque identity assigned to a Workflow Run when it is durably created. CLI operations use this
identity rather than a workflow path, declared version, or latest-run selector.
_Avoid_: Workflow name, execution number

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

**Execution Evidence**:
The durable history needed to reconstruct and debug what a Workflow Run did and why. It consists of
immutable Evidence Events and referenced Execution Artifacts rather than diagnostic telemetry.
_Avoid_: Log stream, compliance attestation

**Evidence Event**:
An immutable fact about a meaningful execution boundary or execution-shaping decision, ordered
within its Workflow Run and linked to its parent and cause.
_Avoid_: Log line, arbitrary code branch

**Execution Decision**:
An Evidence Event that records a choice which changes subsequent execution, such as selecting a
Route, continuing a Loop, retrying an Activity, or accepting a lifecycle request.
_Avoid_: Arbitrary code branch, agent reasoning

**Execution Span**:
The grouping of Evidence Events for one durational action in an Execution Trace. Attempts are child
spans of their logical action so failures, interruption, and uncertain outcomes remain visible.
_Avoid_: OpenTelemetry span, Activity result

**Execution Artifact**:
Immutable fingerprinted content produced or consumed during execution and referenced by Evidence
Events, such as command output, an agent transcript, a patch, or a review report.
_Avoid_: Live Sandbox state, log line

**Execution Trace**:
The read-only reconstruction of a Workflow Run from its Execution Evidence, preserving actual
nesting, concurrency, attempts, decisions, and linked Child Workflows. Sandbox and Agent Steps show
the explicitly safe provider name, model, and adapter version recorded when they ran.
_Avoid_: Statically inferred workflow graph, telemetry export

**Unsuccessful Result**:
An observed step result that domain policy may inspect and act on without failing the Effect. For
example, a nonzero command exit is an Unsuccessful Result unless workflow code deliberately turns it
into a Typed Failure.
_Avoid_: Error, exception

**Typed Failure**:
An expected operational or domain failure represented in Effect's typed error channel. Workflow code
may handle it; an unhandled Typed Failure ends the current execution and moves the Workflow Run to
Failed with its tagged data, cause chain, and durable boundary retained as evidence.
_Avoid_: Defect, interruption, unsuccessful result

**Defect**:
An unexpected programming or invariant failure represented as an Effect defect. A Defect is never
retried automatically and, when unhandled, moves the Workflow Run to Failed as a cause distinct from
a Typed Failure.
_Avoid_: Typed failure, exception

**Activity Retry**:
An author-selected re-execution of the same logical Activity after a Typed Failure, preserving its
stable identity and idempotency key while recording a new attempt ordinal against a budget that
persists across Execution Attempts. Typed Failures are not retried by default, and an Uncertain
Activity Outcome must be reconciled before an Activity Retry.
_Avoid_: Execution Attempt, Loop iteration

**Uncertain Activity Outcome**:
The durable diagnosis that an Activity's external effect may have happened but its result was not
recorded. The attempt remains evidence and consumes its ordinal; a reconciliation Activity must
establish the outcome before the boundary can continue, and only confirmed non-occurrence permits
an Activity Retry.
_Avoid_: Typed Failure, failed attempt

**Resumable Failure**:
A Typed Failure explicitly designated by the Developer Workflow as permitting a Failed Workflow Run
to resume through failure-specific preparation or reconciliation. Resumption creates an Execution
Attempt without replenishing Activity Retry budgets, and Defects are not resumable.
_Avoid_: Activity Retry, Resume Compatibility

**Recovery Handler**:
Developer Workflow logic registered against a Resumable Failure's stable tag. It durably reconciles
or prepares state in a new Execution Attempt before execution continues, without placing behavior
inside the failure value.
_Avoid_: Activity Retry, compensation

**Propagated Child Failure**:
A parent Workflow Run failure caused by an unhandled Typed Failure or Defect from a Child Workflow.
It retains a durable link to the child's original cause rather than creating an independent copy.
If the child has a Recovery Handler, root resumption recovers the child before replaying the parent;
the parent does not need to register the same handler again.
_Avoid_: Independent parent failure, copied child failure

**Workflow Run Interruption**:
Unexpected loss of execution ownership through process exit, crash, or lease loss. It moves the
Workflow Run to Interrupted and is distinct from Effect's internal fiber interruption or an
intentional cooperative suspension.
_Avoid_: Suspension, Effect interruption

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

**Workflow ABI**:
Kojo's opaque, monotonically changing compatibility identity for replay, durable encoding, kernel
adaptation, and author-facing orchestration semantics. It is independent of package versions,
participates in every Workflow Revision's source fingerprint, and must match exactly for resumption.
_Avoid_: Package version, declared workflow version

**Workflow Revision Snapshot**:
The immutable mapping from the Workflow Registry's stable names to the exact Workflow Revisions
available when a root Workflow Run starts. Every descendant in its Workflow Run Tree selects its
revision from this snapshot, so resuming an older run cannot introduce newer Child Workflow code.
_Avoid_: Latest revisions, live registry

**Runtime Configuration Snapshot**:
The append-only durable record of the provider identities, models, and safe public configuration
used by a Workflow Run. A Sandbox or Agent Step records its entry when it first reaches its durable
boundary; another attempt at that same Step must match it, while a new Step may add another entry.
Each entry contains the provider name, model when applicable, adapter version, explicitly safe
public fields, and a fingerprint of the remaining non-secret configuration. Secret values, secret
names not explicitly marked safe, and secret fingerprints never belong to the snapshot. Rotating a
secret does not make an otherwise matching run incompatible.
_Avoid_: Workflow Revision, secret snapshot

**Runtime Configuration Compatibility**:
The derived diagnosis of whether the currently supplied Sandbox Providers and Agent Providers match
the Runtime Configuration Snapshot entries needed to continue an unfinished Workflow Run. A
mismatch preserves the Workflow Run State but prevents the affected Step from resuming, separately
from Workflow Revision compatibility. Kojo diagnoses and safely explains a mismatch before creating
a Sandbox or running an agent; inability to start an otherwise matching provider is instead a Typed
Failure.
_Avoid_: Workflow Revision compatibility, Workflow Run State

**Agent Step**:
A workflow step whose work is delegated to an AI agent in an isolated execution environment.
_Avoid_: Agent, task

**Agent Provider**:
The runtime capability that supplies a configured Sandcastle agent implementation and model to an
Agent Step. The Developer Workflow chooses this capability and may replace it within a narrower
scope, including using different Agent Providers for different Agent Steps in one Sandbox. The CLI
supplies configuration sources but does not choose an agent. Kojo pairs the process-local provider
object with a stable name and explicitly safe description; only that description may enter the
Runtime Configuration Snapshot and Execution Evidence.
_Avoid_: Agent, model name, durable provider

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

**Sandbox Provider**:
The runtime capability that creates a Sandbox through a configured Sandcastle provider. Kojo's CLI
supplies a local Docker fallback, while a Developer Workflow may replace that capability within a
narrower scope. One Sandbox keeps the Sandbox Provider it was created with for its entire lifetime;
Kojo pairs the process-local provider object with a stable name and explicitly safe description;
only that description may enter the Runtime Configuration Snapshot and Execution Evidence.
_Avoid_: Container runtime setting, provider name string, durable provider

**Reusable Sandbox**:
A Sandbox created once and used for multiple agent runs so they share the same branch, filesystem,
installed dependencies, and accumulated changes.
_Avoid_: Long-lived container, agent session

**Child Workflow**:
The role of an ordinary Developer Workflow when another Developer Workflow invokes it durably. It
is not a separate workflow kind or public primitive. Its Workflow Run remains linked to its parent
while retaining its own input, state, evidence, and outcome. A Child Workflow Run has exactly one
parent, though a Developer Workflow may invoke its own definition recursively because every
invocation creates a distinct Run ID and the Workflow Run Tree remains acyclic.
_Avoid_: Separate workflow type, subroutine, workflow step

**Child Workflow Invocation**:
A durable call from a parent Workflow Run to a Child Workflow, identified by an author-chosen stable
key within the parent's durable path. Replay of the same call rejoins the same child run; that key
cannot later name different input or another Developer Workflow, and a new child requires a new key
or durable path. Completion returns the child's typed value, while its Typed Failure or Defect
composes through the ordinary Effect channels. A parent may handle that failure and Complete while
the child remains Failed. The child owns its result and Execution Evidence; the parent retains the
child Run ID and exact result it observed rather than copying the child's history. Once the root
Completes, a Failed child is historical and can no longer be resumed or discarded.
_Avoid_: Child Workflow Run, detached execution

**Workflow Run Tree**:
A root Workflow Run and all of its descendant Child Workflow Runs. Every run is independently
inspectable, but suspension, resumption, and discard are requested through the root and propagated
to the descendants needed to preserve the tree's lifecycle invariants. A lifecycle request is
durable and convergent rather than one transaction across the tree: descendants settle first, the
root changes state last, and an interruption resumes the unfinished propagation. Discard changes
Running, Suspended, Interrupted, and Failed descendants to Discarded while leaving Completed and
already Discarded descendants unchanged. Resumption preflights every required descendant before
starting another Execution Attempt, then recovers the deepest children first; independent siblings
may recover concurrently.
_Avoid_: Detached run collection, workflow graph

**Child Workflow Cancellation**:
The safe termination of an unfinished Child Workflow when its parent stops awaiting that child
because workflow-authored concurrency is ending with a non-resumable parent failure. The child
completes its Compensation and becomes Failed with a non-resumable Typed Failure that retains the
parent Run ID and cause before the parent becomes terminal. It consumes no Activity Retry and is
distinct from Workflow Run Interruption and Discard. A Resumable Failure instead suspends active
children after their current Activities settle, without running Compensation, so they can continue
when the root resumes.
_Avoid_: Workflow Run Interruption, discard, forced interruption

**Route**:
A transition selected by a Developer Workflow from a Workflow Run's input or accumulated results.
_Avoid_: Branch

**Loop**:
Workflow control that repeats a defined portion of a Developer Workflow until an exit condition or a
positive configured limit is reached. `Loop.run(name, options)` requires an explicit stable name
whose nested path supplies durable identity; ordinary bindings such as `reviewLoop` communicate
domain intent but are not replay identity, and every Loop uses the same
`Loop.MaximumLimitReached` Typed Failure.
_Avoid_: Agent iteration, retry

**Review Loop**:
A Developer Workflow's ordinary, named use of `Loop.run(...)` in which a reviewer evaluates the
latest implementation and the implementer addresses the review findings in a Reusable Sandbox. It
succeeds only when the reviewer reports no P1, P2, or P3 finding, and fails with the same
`Loop.MaximumLimitReached` Typed Failure as every other Loop when its configured limit is reached.
_Avoid_: Specialized Review Loop primitive, Review retry, reviewer repair

**Compensation**:
A workflow-authored, idempotent, evidenced effect registered through Effect Workflow after a
compensable effect succeeds. It runs when the Workflow later ends in terminal failure, not when the
Workflow Run is Suspended, Interrupted, or Discarded, and Kojo does not define a separate
compensation primitive. Compensation belongs to one Workflow Run: a Completed Child Workflow is
never reopened by a later parent failure, so the parent must register its own Compensation when the
child's completed result needs to be undone. Failure settles the deepest descendants first;
independent siblings may settle concurrently, and every child finishes Compensation before its
parent begins Compensation.
_Avoid_: Activity Retry, cleanup, rollback guarantee
