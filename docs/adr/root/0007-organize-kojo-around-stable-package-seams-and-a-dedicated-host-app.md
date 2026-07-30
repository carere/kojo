---
status: accepted
---

# Organize Kojo around stable package seams and a dedicated Host app

Kojo uses three runnable applications and two shared packages. The dedicated Host application owns runtime composition, while the public workflow package and the private control package provide the only cross-application interfaces. Effect Workflow, Sandcastle, SQL, and transport implementations remain inside adapters rather than leaking through those interfaces.

## Decision

### Applications and packages

- `apps/host` builds the internal `kojo-host` executable. It is the composition owner for the Kojo Host and every Project Runtime. It is installed alongside the CLI but runs as a separately supervised per-user process.
- `apps/cli` is a client of the Host. It owns command parsing and terminal presentation and cannot import Host implementation modules.
- `apps/visualizer` is a client of the Host. Its local server proxies browser requests to the Host; browser code never opens the Host's Unix socket or imports Host implementation modules.
- `packages/workflow` publishes `@kojo/workflow`, the stable developer-facing authoring interface. Its package subpaths expose built-in Agent and Sandbox Provider definitions and author testing support.
- `packages/control` provides the private `@kojo/control` package shared by the Host, CLI, and visualizer. It owns transport-neutral control commands, queries, results, errors, and event schemas. Its local-client subpath may provide the shared Unix-socket client adapter without adding transport details to the root interface.
- Internal Host adapters remain modules inside `apps/host` under the bounded context and concept they implement. Kojo does not create a workspace package for every adapter or implementation detail.

### Public authoring seam

- `@kojo/workflow` may depend on stable Effect and Schema interfaces. It does not import Effect Workflow's unstable workflow, engine, cluster, SQL, registration, Activity, clock, or deferred modules.
- `@kojo/workflow` does not import Sandcastle, transport implementations, Kojo applications, or private Host modules.
- Built-in package subpaths such as `@kojo/workflow/agents/codex` and `@kojo/workflow/sandboxes/docker` construct immutable Kojo authoring values. They do not expose Sandcastle types or live provider handles.
- Custom Agent and Sandbox Providers implement stable Kojo-owned interfaces and may require developer-provided Effect services. Provider-specific execution still crosses the Host's provider seam.
- `@kojo/workflow/testing` runs developer-authored Workflow Definitions through an in-memory authoring adapter and supplies fake Agent, Command, and Sandbox Providers. It does not expose or imitate Host internals.

### Host modules and adapters

- One deep `ProjectRuntime` module owns readiness, Workflow Definition reconciliation, Workflow Schedules, Workflow Runs, recovery, inspection, and project-scoped control. The Kojo Host activates and routes to Project Runtimes but does not duplicate their coordination logic.
- A Kojo-owned `WorkflowBackend` interface is the seam for durable workflow execution. `LocalWorkflowBackend` is the production adapter over the pinned Effect Workflow, Cluster, and SQL modules; unit tests use an in-memory adapter.
- A Kojo-owned `ProjectRepository` interface is the seam for Kojo's project-local execution records. Its production adapter owns Kojo's SQLite tables while an in-memory adapter supports unit tests. Effect-owned tables remain accessible only through `LocalWorkflowBackend`, even though both use one project database.
- A Kojo-owned `ProviderRuntime` interface is the seam for Agent, Command, and Workflow Sandbox execution. The production adapter interprets built-in definitions through Sandcastle and invokes custom providers through their stable Kojo interfaces; unit tests use a fake adapter.
- A `ProjectDefinitionLoader` interface is the seam for loading and validating `kojo.config.ts`. The production adapter loads the TypeScript configuration, while unit tests provide definitions directly.
- The Host's Unix-socket server is a transport adapter over the control interface. It translates requests into Host and Project Runtime operations without placing transport concerns in those modules.
- Application behavior and adapters live under `apps/*/src/contexts/<bounded-context>/<concept>`. Ports and their adapters remain local to the context that owns them; data access uses `repositories`, while non-data capabilities use `services`. Shared application behavior lives under `src/contexts/shared`. Framework entrypoints, routes, internationalization, and styles remain outside `contexts`.
- `apps/host/src/composition/live.ts` is the only production composition module and the explicit exception to the context layout. It opens the Project Index and project databases, constructs production adapters, provides their Layers, configures Host-wide Activity capacity and supervision, and starts the Unix-socket server.

### Dependency direction

- `@kojo/workflow` depends only on stable external libraries and its own modules.
- `@kojo/control` may depend on stable identities and schemas from `@kojo/workflow`; `@kojo/workflow` never depends on `@kojo/control`.
- The CLI, visualizer, and Host may import `@kojo/control`. Only the Host imports runtime adapters.
- Host use cases depend on Kojo-owned interfaces, never concrete adapters. Concrete adapters depend inward on those interfaces and outward on Effect Workflow, Sandcastle, SQL, filesystem, or transport libraries.
- Only the Host composition module selects concrete production adapters. CLI and visualizer modules cannot import from `apps/host`.
- No public or control interface exposes Effect Workflow execution identities, Sandcastle handles, SQL clients or rows, Unix-socket frames, or browser RPC types.

### Testing ownership

- Unit tests exercise Project Runtime and Host use cases through in-memory `WorkflowBackend`, `ProjectRepository`, `ProviderRuntime`, and `ProjectDefinitionLoader` adapters. They do not use RPC, SQLite, or the real filesystem.
- `@kojo/workflow/testing` is a separate author-facing test surface because it tests Workflow Definitions rather than Kojo's Host behavior.
- Integration tests exercise real temporary project files, the project-local SQLite database, `LocalWorkflowBackend`, and control transport where those seams matter.
- Browser tests exercise visualizer behavior through the real browser and local server rather than importing Host modules.
- Unit and integration tests mirror their bounded-context source paths beneath `tests/unit/contexts` and `tests/integration/contexts`; browser tests remain in their separate browser project.

## Considered Options

- Hosting durable execution inside `apps/cli` would couple Workflow Run and Workflow Schedule progress to a user-facing client's process and dependencies.
- Hosting execution inside `apps/visualizer` would make the browser application's local server an execution owner and prevent clean CLI-only use.
- Splitting runtime, storage, Effect Workflow, Sandcastle, and every provider into separate private packages would turn internal seams into repository-wide interfaces and add shallow package indirection without independent consumers.
- Naming the shared contract `@kojo/domain` would imply ownership of both bounded contexts and encourage unrelated shared models to accumulate there. `@kojo/control` names its narrower purpose.
- Putting concrete built-in provider implementations in `@kojo/workflow` would make the stable authoring package depend on Sandcastle and its pre-1.0 lifecycle contract.
- Sharing one testing implementation between workflow authors and Host tests would conflate the stable authoring interface with the private durable-engine seam.

## Consequences

- Kojo ships the CLI and the internal Host executable together, but they keep separate process lifetimes and dependency graphs. Exact installer and operating-system service registration mechanics remain a later distribution decision.
- Developers learn one stable authoring package; clients learn one transport-neutral control package; maintainers can change unstable engines and providers locally inside Host adapters.
- The Host application is intentionally substantial, but its complexity is concentrated behind the `ProjectRuntime`, `WorkflowBackend`, `ProjectRepository`, `ProviderRuntime`, and `ProjectDefinitionLoader` interfaces instead of spread across applications.
- The control-protocol decision can define exact operations, streaming, reconnect behavior, and version negotiation without reopening package ownership or dependency direction.
- The project-schema and Execution Trace decision can define concrete tables and queries without exposing SQL through application interfaces.

This decision resolves [Define the package and adapter layout](https://github.com/carere/kojo/issues/17), follows [Host Project Runtimes in one supervised local service](./0004-host-project-runtimes-in-one-local-service.md), and preserves the public interface chosen in [Expose an Effect-native workflow authoring contract](../workflow-authoring/0001-expose-an-effect-native-workflow-authoring-contract.md).
