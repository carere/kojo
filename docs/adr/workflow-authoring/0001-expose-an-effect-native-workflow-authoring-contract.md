---
status: accepted
---

# Expose an Effect-native workflow authoring contract

Kojo exposes a stable, Effect-native authoring contract from `@kojo/workflow` while keeping Effect Workflow's unstable definitions, engine operations, registration layers, and persisted identities private. Developers write ordinary Effect programs and provide their own services and execution resources inside complete Workflow Definitions; Kojo owns the durable operations that translate those programs into the local Workflow Engine.

## Decision

### Public module and configuration

- `@kojo/workflow` owns Workflow Definition, Workflow Schedule, Workflow Activity, child invocation, durable clock, Workflow Deferred, Agent, Command, Workflow Sandbox, and Sandbox Image Definition interfaces. Optional built-in integrations use package subpaths such as `@kojo/workflow/agents/codex` and `@kojo/workflow/sandboxes/docker`; testing support uses `@kojo/workflow/testing`.
- Project code may use stable `effect` types such as `Effect`, `Layer`, and `Schema`. It cannot import or receive `Workflow`, `WorkflowEngine`, `WorkflowInstance`, `Activity`, `DurableClock`, `DurableDeferred`, cluster, SQL, or registration types from Effect's unstable modules.
- `kojo.config.ts` default-exports one static `defineConfig({ workflows })` value. It registers only complete Workflow Definitions and performs no automatic discovery. Importing it is synchronous and starts no workflow work.
- Every registered Workflow Definition contains a stable Workflow Key, an explicit opaque Workflow Definition Revision, input, success, and failure schemas, one Effect handler, and its attached Workflow Schedules. It has no unresolved developer-provided Effect services; authors may provide services around any subprogram, the handler, or the complete definition.
- Every Child Workflow Run targets another explicitly registered Workflow Definition. Child definitions are listed alongside definitions that invoke them rather than discovered from handler source.

### Loading and compatibility

- Before a Project Runtime becomes ready, Kojo atomically validates unique Workflow Keys, non-empty revisions, encodable schemas, unique Schedule Keys within each definition, schedule expressions and time zones, and registration of every declared child dependency. An invalid snapshot replaces nothing.
- A replay-incompatible change to schemas, handler behavior, or durable operation keys requires a new Workflow Definition Revision. Kojo fingerprints schemas and records the exact source identity in the Workflow Run Start Snapshot, but it does not pretend to derive handler compatibility from JavaScript source text.
- A handler's typed error must match its declared failure schema. Defects and result-encoding failures fail the Workflow Run. Kojo does not expose Effect's defect-capture, failure-suspension, or raw suspension controls.
- A public Workflow Definition has no execute, poll, interrupt, or resume methods. Manual starts and lifecycle control belong to Kojo's control interface; workflow code invokes a child only through `Workflow.runChild`.

### Durable operations

- Kojo provides `Workflow.activity` for arbitrary Effect programs and stable operations for Agent invocation, Command execution, Workflow Sandbox acquisition, child invocation, durable sleep, and Workflow Deferred creation and awaiting. Agent and Command operations use the same Workflow Activity contract.
- Every replay-sensitive operation requires a developer-chosen Durable Operation Key scoped to one Workflow Run. Reusing a key for the same logical operation returns its recorded result; reuse with different contents conflicts. Child Workflow Runs establish new key scopes, and repeated operations derive keys from stable domain identity rather than collection position.
- Recovery retries an unfinished Workflow Activity with the same Activity Idempotency Key. An explicit retry policy creates numbered attempts but retains the operation-level idempotency key unless the author deliberately requests an attempt-specific key for distinct external work.
- Kojo clocks always use the durable delayed-message path. Kojo wraps durable deferred creation, awaiting, tokens, and completion so private Effect execution identities never enter the authoring interface.

### Agents, commands, and sandboxes

- Each Agent or Command operation independently selects the Agent Provider and Workflow Sandbox it needs. A Workflow Definition may combine any number of built-in or custom providers and sandbox kinds.
- Built-in Agent Providers cover Codex, Claude Code, Pi, Cursor, OpenCode, and GitHub Copilot. `Agent.run` returns a normalized result containing text, usage when available, commits, artifacts, and an optional Agent Session. Passing a session to a later invocation is explicit and is rejected before Activity acceptance when the Agent Provider and Workflow Sandbox cannot continue it.
- Built-in Sandbox Providers cover Docker, Podman, Vercel, Daytona, and explicit trusted-host execution. Host execution requires an unsafe acknowledgement and is never described as isolation.
- Custom Agent and Sandbox Providers are immutable local values with stable keys and revisions. Their implementation Effects may require developer-provided services. A Sandbox Provider's scoped live handle is visible only to Agent and Command adapters, never to workflow code.
- `Sandbox.acquire` returns an opaque logical Workflow Sandbox identified within its Workflow Run. Reusing its key with the same definition returns the same logical environment; a different definition conflicts. Kojo may reuse a live provider handle, but recovery may create a replacement over the durable Git worktree. Processes, installed packages, and environment mutations are not durable unless a definition or provider explicitly guarantees them.
- Sandbox Image Definitions are immutable local values with stable keys, explicit revisions, version-controlled build sources, and a content identity recorded when an Activity starts. Neither providers nor images are registered in Kojo Configuration.
- Agent, Sandbox, and Sandbox Image constructors validate their own definitions. Because authors may construct and select them in arbitrary handler branches, Kojo validates provider capabilities and Agent-Sandbox compatibility immediately before accepting the related Workflow Activity. Serializable definitions contain no secrets; providers obtain secrets through Effect services.
- `Command.run` accepts an argument vector plus optional working directory, environment, and timeout. Shell parsing is explicit. A non-zero exit produces a typed command failure by default, while an opt-in mode returns it as an ordinary result.

### Workflow Schedules and tests

- A Workflow Schedule is attached to its target Workflow Definition. It declares a stable Schedule Key, five-field cron expression, explicit IANA time zone, overlap policy, and a pure input rule that receives only the Schedule Key and scheduled instant.
- An input rule carries an explicit revision. Kojo parses schedule expressions with Effect Cron internally and derives Workflow Schedule Revision from the Workflow Key, expression, time zone, overlap policy, and input-rule revision; Effect Cron values do not enter the public contract.
- `@kojo/workflow/testing` supplies an in-memory workflow adapter and fake Agent, Command, and Sandbox providers for unit tests. It makes no process-restart durability claim; integration tests exercise the real local backend.

## Considered Options

- Registering providers, Sandbox Image Definitions, and project Layers in Kojo Configuration would centralize values that developers need to compose freely in individual Workflow Definitions.
- Exposing Effect Workflow definitions and operations directly would leak unstable APIs, payload-derived execution identity, registration layers, and backend behavior into project source.
- Automatically discovering Workflow Definitions or child dependencies would make loading depend on import side effects or handler inspection rather than one explicit project contract.
- Exposing live sandbox handles to workflow code would make replay depend on process-local resources that cannot survive host failure.
- Fixing one Agent or Sandbox Provider for an entire Workflow Definition would prevent heterogeneous planning, implementation, testing, and review Activities within one Workflow Run.
- Hashing JavaScript handler source as its compatibility identity would be sensitive to builds and formatting without proving semantic compatibility. An explicit revision makes the author's compatibility claim visible.

## Consequences

- A registered Workflow Definition is a closed, testable module: its interface declares durable inputs and outputs while its implementation may compose arbitrary Effect services behind that interface.
- Kojo can validate the static definition graph before readiness, but it cannot validate every dynamically selected provider combination until the corresponding handler branch reaches an Activity.
- Upgrading Effect Workflow or Sandcastle changes Kojo adapters rather than project authoring source, subject to the stable provider capabilities Kojo promises.
- The initialized-project layout decides where the public package and configuration live; the control protocol decides external start, deferred-completion, and lifecycle operations; execution-record and security decisions own persisted details, redaction, and retention.

This decision resolves [Define the workflow authoring contract](https://github.com/carere/kojo/issues/6) and follows the durable execution and schedule semantics established by [Define workflow lifecycle and recovery semantics](https://github.com/carere/kojo/issues/5) and [Define Workflow Schedule lifecycle and triggering semantics](https://github.com/carere/kojo/issues/15).
