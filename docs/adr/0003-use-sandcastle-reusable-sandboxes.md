# Use Sandcastle Reusable Sandboxes for multi-agent work

Kojo will use Sandcastle's provider-independent `createSandbox()` primitive whenever multiple agent
runs collaborate through one evolving codebase. A Reusable Sandbox can be backed by a local
container, cloud compute, or another Sandcastle provider; Kojo will not model it as a container.

The reference delivery workflow's implementer and read-only reviewer will run in the same Reusable
Sandbox. Their turns share its branch, filesystem, dependencies, and accumulated commits until the
Review Loop succeeds or reaches its configured limit.

## Considered Options

- Start an unrelated Sandcastle run and Sandbox for every agent turn.
- Add a Kojo-specific container abstraction around Sandcastle.

## Consequences

- Developer Workflow primitives accept Sandcastle providers without depending on provider-specific
  compute concepts.
- Kojo must own the scoped lifecycle of a Reusable Sandbox and expose its activity evidence.
- A process-local Sandbox handle cannot itself be durable workflow state. Kojo must decide how to
  recover or recreate the logical Sandbox around persisted repository state after process failure.
- A single Developer Workflow may create several Reusable Sandboxes and operate them concurrently.
