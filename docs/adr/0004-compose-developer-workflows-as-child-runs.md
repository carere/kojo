# Compose Developer Workflows as durable child runs

A Developer Workflow may invoke another Developer Workflow as a durable Child Workflow. The child
has its own typed input, Workflow Run, revision, state, evidence, and outcome, linked to the parent
run that selected it.

The root Workflow Run captures a Workflow Revision Snapshot. Every descendant selects its exact
Workflow Revision from that snapshot, so an older run never introduces newer child code during
replay. Each Child Workflow Invocation has an author-chosen stable key within the parent's durable
path. Starting the child atomically binds that key, creates its Run ID, records its input and
bidirectional parent-child link, and pins its revision before any Activity starts. Replay rejoins
that child even when it has Failed; a new child requires a new key or durable path.

A Child Workflow Run has exactly one parent. Workflow definitions may invoke themselves recursively
because each invocation creates a distinct Run ID and the run relationships remain an acyclic tree.
Child success returns its typed value through ordinary Effect composition; a Typed Failure or Defect
propagates through the corresponding Effect channel. The parent may handle a child failure and
Complete, leaving the Failed child as immutable historical evidence within the completed tree.

Lifecycle control is rooted in the Workflow Run Tree. Individual runs remain inspectable, but
suspension, resumption, and discard are requested through the root and converge durably rather than
changing every run in one transaction. Descendants settle before the root changes state, and an
interruption resumes unfinished propagation.

- Suspension lets active descendant Activities settle, suspends descendants, then suspends the
  root.
- A Resumable Failure also suspends active children without running Compensation so root resumption
  can continue them.
- A non-resumable parent failure safely cancels unfinished children deepest-first. Independent
  siblings may settle concurrently; each child records a non-resumable Typed Failure, completes its
  Compensation, and becomes Failed before its parent begins Compensation.
- Discard changes every Running, Suspended, Interrupted, or Failed descendant to Discarded while
  leaving Completed and already Discarded descendants unchanged.
- Process or lease loss interrupts each run owned by the lost process.

Resuming a tree first verifies every required descendant's Workflow Revision, recovery policy,
lease, and pending lifecycle request without starting a new Execution Attempt. Once that preflight
succeeds, the deepest children recover first and independent siblings may recover concurrently. A
Propagated Child Failure is recovered by the child's Recovery Handler; the parent retains the link
to the original cause and does not require a duplicate handler.

The child owns its final result and Execution Evidence. Completion atomically records that result
and a durable notification for the parent; the parent later records the exact result it observed and
the child Run ID without copying the child's evidence history.

Compensation remains local to one Workflow Run. A later parent failure never reopens a Completed
child; if the child's successful result must be undone, the parent must have registered its own
Compensation.

This allows a Software Factory to be expressed as a Developer Workflow: it can receive developer
work, classify it, and delegate to specialized feature, bug, hotfix, chore, or custom workflows
without Kojo owning a fixed catalog or router.

## Considered Options

- Keep Developer Workflows independent and implement factory routing outside the workflow model.
- Inline every specialized path into one large Developer Workflow.
- Allow detached children or let multiple parents join one Child Workflow Run.
- Resolve a child's revision from the live Workflow Registry whenever the child first starts.
- Wrap every child result in a generic outcome value instead of preserving ordinary Effect
  composition.
- Let operators mutate child lifecycle independently from its root Workflow Run.
- Reopen Completed children or automatically extend their Compensation into the parent.

## Consequences

- Parent-child relationships are part of durable run state and visualizer navigation.
- Child creation and completion add transactional handoff boundaries to the embedded durable engine.
- Kojo must capture a Workflow Revision Snapshot when the root starts and retain it for the entire
  Workflow Run Tree.
- Lifecycle propagation may be partially complete after a crash, so requests and progress must be
  durable, idempotent, and visible as evidence.
- A root cannot resume when a required child is incompatible or non-resumable.
- A handled child failure can remain visible beneath a Completed parent, but that child can no
  longer be resumed or discarded.
- Workflow authors choose Sandbox boundaries independently from workflow boundaries.
- Human Steps remain a future capability; the first vertical slice composes agent and Code Steps
  through the CLI only.
