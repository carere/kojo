# Compose Developer Workflows as durable child runs

A Developer Workflow may invoke another Developer Workflow as a durable Child Workflow. The child
has its own typed input, Workflow Run, revision, state, evidence, and outcome, linked to the parent
run that selected it.

This allows a Software Factory to be expressed as a Developer Workflow: it can receive developer
work, classify it, and delegate to specialized feature, bug, hotfix, chore, or custom workflows
without Kojo owning a fixed catalog or router.

## Considered Options

- Keep Developer Workflows independent and implement factory routing outside the workflow model.
- Inline every specialized path into one large Developer Workflow.

## Consequences

- Parent-child relationships are part of durable run state and visualizer navigation.
- Failure, cancellation, resumption, and discard semantics must define how they propagate between
  parent and child runs.
- Workflow authors choose Sandbox boundaries independently from workflow boundaries.
- Human Steps remain a future capability; the first vertical slice composes agent and Code Steps
  through the CLI only.
