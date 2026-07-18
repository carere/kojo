# Use Effect Workflow as Kojo's execution kernel

Kojo will build Developer Workflows on `effect/unstable/workflow` rather than creating a competing
workflow scheduler and durability model. A thin Kojo domain layer will wrap Effect Workflow and its
durable primitives with developer-work capabilities such as Sandcastle execution, workspaces,
evidence, and run metadata, while insulating workflow authors from changes to Effect's unstable API.

This keeps Developer Workflows directly composable with Effect while avoiding a bespoke graph DSL
or orchestration runtime. Kojo must still determine how to provide embedded durable execution for
local CLI and server processes because Effect currently offers an in-memory engine and a
cluster-backed engine.

## Considered Options

- Use ordinary Effect internally and implement Kojo's own durable workflow runtime.
- Expose `effect/unstable/workflow` directly without a Kojo compatibility boundary.

## Consequences

- Effect's Workflow, Activity, durable clock, queue, deferred, and engine semantics become
  foundational to Kojo.
- Kojo's public domain layer must remain thin enough to preserve normal Effect composition.
- Effect V4 API changes are absorbed by Kojo rather than every repository-local Developer Workflow.
- An embedded durable Workflow Engine remains an explicit design and research problem.
