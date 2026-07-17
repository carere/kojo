# Effect Workflow as Kojo's embedded durable kernel

> Decision research for “Assess Effect Workflow as Kojo's embedded durable kernel.”
> Examined `effect@4.0.0-beta.98`, pinned to upstream commit
> [`3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec`](https://github.com/Effect-TS/effect-smol/tree/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec).
> Last updated: 2026-07-17.

## Answer

Kojo should reuse Effect V4's **workflow programming and replay semantics**, but provide its own
small embedded engine behind the existing `WorkflowEngine.makeUnsafe` seam.

The smallest sound design is:

1. Kojo's public domain layer wraps `Workflow`, `Activity`, `DurableDeferred`, and
   `DurableClock`. Workflow authors continue to write ordinary Effect programs.
2. An internal `EmbeddedWorkflowEngine` implements Effect's ten-operation
   `WorkflowEngine.Encoded` contract and is converted to the typed Effect service by
   `WorkflowEngine.makeUnsafe`.
3. A small transactional `WorkflowJournal` stores runs, completed activity attempts, deferred
   completions, and clock deadlines. The journal depends on Effect's provider-neutral `SqlClient`;
   the CLI supplies `@effect/sql-sqlite-bun` and a repository-local database file.
4. Runtime-only values—fibers, scopes, registered handlers, and Sandcastle Sandbox handles—remain
   in memory. On restart, Kojo registers the pinned Workflow Revision again and replays the handler
   from its input. Completed activities and deferreds are returned from the journal instead of
   executing again.

This is substantially smaller than adopting Effect Cluster: no sharding, RPC protocol, message
storage, entity addressing, or distributed worker lifecycle. It is also safer than adapting
`WorkflowEngine.layerMemory` to serialize its maps because the in-memory implementation deliberately
stores live functions, scopes, fibers, and mutable `WorkflowInstance` values and is explicitly
documented as non-durable
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/WorkflowEngine.ts#L558-L599)).

## What Kojo can reuse

### Adopt behind Kojo names

| Effect primitive | Kojo use | Boundary |
| --- | --- | --- |
| `Workflow.make` | Typed Developer Workflow input, success, error, registration, execution, polling, interruption, and resumption | Wrap it. Keep Effect's unstable module and execution-ID policy out of repository workflow files. |
| `Activity.make` | Durable boundary for Agent Steps, Code Steps, Sandbox lifecycle operations, and evidence-producing side effects | Wrap it with required stable names, Kojo metadata, and idempotency propagation. |
| `Activity.retry`, `CurrentAttempt`, `idempotencyKey` | Retry-aware attempt identity and a stable key for external side effects | Reuse, but require loop iterations to have distinct durable identities. |
| `DurableDeferred` | Durable wait points, child completion, and the future Human Step/signal seam | Reuse its typed tokens and completion API. |
| `DurableClock` | Durable backoff, timeout, and scheduled resumption | Wrap it so all Kojo clocks are actually persisted, including short waits. |
| Child `Workflow.execute` | Child Workflow composition | Reuse; the typed engine already detects a parent `WorkflowInstance`, links interruption, and suspends the parent while the child is suspended. |
| `WorkflowEngine.makeUnsafe` | Adapter from Kojo's embedded journal to Effect's typed engine | Internal implementation detail only. Pin and test it at the selected Effect beta. |

`Workflow.make` already defines schemas and deterministic execution IDs derived from workflow tag
and author-provided idempotency key
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Workflow.ts#L37-L60),
[construction](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Workflow.ts#L316-L369)).
It exposes `execute`, `poll`, `interrupt`, `resume`, `toLayer`, and `executionId`
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Workflow.ts#L77-L149)).
Kojo therefore does not need a second workflow definition model or graph scheduler.

Activities are the essential replay checkpoint. An Activity is a named Effect with success and
error schemas, and Effect delegates each invocation to the engine with the current attempt number
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Activity.ts#L28-L84),
[execution](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Activity.ts#L314-L334)).
Effect also derives an external idempotency key from the Workflow Run, activity-supplied name, and
optionally its attempt
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Activity.ts#L236-L271)).
Kojo should pass that key into Sandcastle and any external API that accepts an idempotency key.

Durable Deferreds already express the right suspension model: a missing named result suspends the
workflow; completing the result by token asks the engine to resume it
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/DurableDeferred.ts#L132-L166),
[token completion](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/DurableDeferred.ts#L541-L607)).
This can later support a Human Step without changing the kernel.

### Defer or hide

- **`WorkflowEngine.layerMemory`** is appropriate for unit tests only. It is not restart-safe.
- **Effect Cluster** is a semantic reference, not a first-slice dependency. Its engine requires
  sharding and message storage
  ([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L762-L779)).
- **`DurableQueue`** should wait until Kojo needs out-of-process workers. It requires a separate
  `PersistedQueueFactory`; Agent Steps running on the CLI host can be Activities
  ([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/DurableQueue.ts#L170-L240)).
- **Workflow proxy/server APIs** are unnecessary for the CLI slice.
- **`WorkflowInstance`, fibers, scopes, and Sandbox handles** must never enter durable state. They
  are process-local runtime coordination.
- **Raw compensation helpers** should not be presented as durable until compensations themselves
  are Activities. Effect notes that compensation finalizers apply only to top-level effects
  ([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Workflow.ts#L812-L888)).

## The adapter seam is sufficient

Effect exposes a low-level `WorkflowEngine.Encoded` interface with exactly these ten operations:

- register a workflow handler;
- execute, poll, interrupt, unsafe-interrupt, and resume a Workflow Run;
- execute an activity attempt;
- read and complete a deferred;
- schedule a clock.

`WorkflowEngine.makeUnsafe` converts that implementation to the typed `WorkflowEngine`, handling
schema decoding around activity and deferred results
([contract](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/WorkflowEngine.ts#L284-L375),
[adapter](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/WorkflowEngine.ts#L377-L479)).
Its documentation explicitly assigns correct persistence, resumption, and encoding to the
implementation, so this is the intended extension seam—not a fork of `Workflow` or `Activity`.
The journal adapter must use each workflow's JSON codecs to encode its payload and terminal result;
`makeUnsafe` does not turn arbitrary local storage into a schema-aware store by itself.

The Cluster engine supplies a useful semantic oracle without being reused physically:

- a Workflow Run is addressed by workflow name plus execution ID;
- an activity result is keyed by activity name plus attempt
  ([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L644-L658));
- a deferred is keyed by name
  ([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L667-L676));
- a child records its parent workflow name and execution ID
  ([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L443-L455));
- a clock persists an absolute wake-up time keyed by clock name
  ([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L722-L742)).

Kojo can implement those semantics with four logical record sets rather than Cluster entities and
messages.

## Minimal embedded journal

The engine needs the following durable records. These are logical records; one SQLite schema may
split status and encoded values differently.

### `workflow_runs`

Primary key: `(workflow_name, execution_id)`.

Store:

- encoded payload;
- Workflow Revision identity: stable name, declared version, and source fingerprint;
- optional parent workflow name and execution ID;
- state (`running`, `suspended`, `interrupt_requested`, `completed`, `discarded`);
- encoded `Workflow.Result` when suspended or complete;
- a runner lease/owner and timestamps.

The lease prevents two local Kojo processes from replaying one run concurrently. On restart, an
expired lease is reclaimable. The pinned revision must be checked before handler execution.

### `activity_attempts`

Primary key: `(workflow_name, execution_id, activity_name, attempt)`.

Store a state and the encoded terminal result. A completed record is replayed. An abandoned
`running` record is eligible to execute again after its runner lease expires.

This produces **at-least-once activity execution**, not magical exactly-once side effects: a process
can fail after an external action succeeds but before its result commits. Stable
`Activity.idempotencyKey` values, idempotent Sandcastle operations where available, and recoverable
repository/Sandbox state are therefore required.

Activity names are program positions. Reusing the same name and attempt for multiple loop
iterations aliases their results: both Effect's memory engine and Cluster key attempts by execution
ID, name, and attempt
([memory engine](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/WorkflowEngine.ts#L691-L715),
[Cluster](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L720)).
Kojo's named Loop/Review Loop combinator must therefore scope step names by loop identity and
iteration, such as `review-loop/review/3`.

### `deferred_results`

Primary key: `(workflow_name, execution_id, deferred_name)`.

Store the first encoded `Exit`; completion is insert-if-absent and resumes a suspended run. This
supports signals and child-to-parent wake-up without a message broker.

### `clocks`

Primary key: `(workflow_name, execution_id, clock_name)`.

Store an absolute deadline and completion state using insert-if-absent. Replaying scheduling must
not move the deadline forward. At CLI startup or explicit resume, due clocks atomically complete
their corresponding deferred before replay begins.

Effect's `DurableClock.sleep` converts waits at or below 60 seconds into an in-memory sleeping
Activity by default
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/DurableClock.ts#L63-L117)).
That would restart the whole sleep after a process failure. Kojo's wrapper should set
`inMemoryThreshold` to zero, or call the engine's durable scheduling path directly, whenever
restart-safe timing is promised.

An append-only Kojo event/evidence table is useful for the visualizer, but it is not required to
implement Effect replay. It should remain a Kojo concern so the visualizer can distinguish
`not-found`, `running`, and `suspended`; Effect's `poll` returns `Option.none` both while a run has no
terminal result and when no execution is known in the memory implementation
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/WorkflowEngine.ts#L717-L730)).

## Why transactional SQL, with SQLite as the CLI provider

Effect V4's generic `KeyValueStore` and `PersistenceStore` are useful codecs and simple result
stores, but they do not expose the conditional insert, ordered enumeration, multi-record
transaction, or leasing operations this engine needs. `KeyValueStore` is essentially
get/set/remove/clear/size/modify
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/persistence/KeyValueStore.ts#L32-L95));
`PersistenceStore` similarly stores typed exits by key
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/persistence/Persistence.ts#L49-L95)).
Building leases and atomic run/activity/deferred transitions on those contracts would recreate a
transaction layer poorly.

Effect's `SqlClient` is a better provider boundary. It exposes a `withTransaction` operation
independently of SQL implementation
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/sql/SqlClient.ts#L30-L62)).
The matching `@effect/sql-sqlite-bun` beta opens a local database file, creates it by default,
enables WAL by default, serializes access, and supplies transaction acquisition
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/sql/sqlite-bun/src/SqliteClient.ts#L76-L127),
[transactions](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/sql/sqlite-bun/src/SqliteClient.ts#L198-L224)).

The dependency direction should be:

```text
Effect Workflow / Activity APIs
              ↓
Kojo EmbeddedWorkflowEngine (WorkflowEngine.Encoded)
              ↓
Kojo WorkflowJournal
              ↓
Effect SqlClient
              ↓
@effect/sql-sqlite-bun for the CLI
```

This keeps the engine provider-independent while giving the first slice a zero-service,
restart-safe local provider. A future server could provide another `SqlClient` or replace the
journal/engine entirely with Effect Cluster without changing Developer Workflow source.

## Replay and recovery algorithm

1. **Register:** Load the Developer Workflow module, verify its Workflow Revision, and retain its
   handler in memory.
2. **Start/execute:** In one transaction, insert the run if absent or load the existing run. Reject a
   revision mismatch. Acquire the run lease and start a fresh `WorkflowInstance`.
3. **Replay:** Execute the handler from the beginning. Pure Effect/TypeScript control flow runs
   again. Every side effect must cross an Activity, Deferred, Clock, or Child Workflow boundary.
4. **Activity:** Atomically return a completed attempt or claim an executable attempt. Run it
   outside the transaction; transactionally persist its terminal encoded result; continue replay.
5. **Deferred/clock:** Return a completion if present. Otherwise persist suspension or the original
   absolute clock deadline and return `Workflow.Suspended`.
6. **Complete:** Persist the encoded terminal result and release the lease. If this is a child,
   make its parent resumable.
7. **Resume after restart:** Register the exact pinned revision, reclaim the lease, process due
   clocks, and replay. No continuation or Sandbox handle is deserialized.

This matches Effect's own `intoResult` model: suspension closes neither the workflow's logical
lifetime nor its replayable definition, while completion produces an encoded `Exit`
([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Workflow.ts#L651-L713)).

The Reusable Sandbox is recovered separately. The activity result should persist its provider-neutral
Sandbox reference plus repository, branch, and commit evidence. A restarted Activity either
reattaches through Sandcastle when supported or creates a replacement Reusable Sandbox around the
persisted repository state. The workflow journal never serializes the live Sandbox object.

## API hazards Kojo must normalize

1. **Effect's `discard` does not delete a run.** `Workflow.execute(..., { discard: true })` starts
   execution without awaiting the result and returns the deterministic execution ID
   ([source](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Workflow.ts#L77-L92)).
   Kojo should expose this as `start` or `detach`. User-requested run discard is a separate Kojo
   operation: stop/unsafe-interrupt the active run, mark it discarded, then deliberately remove or
   retain its journal and Sandbox evidence according to policy.
2. **Execution IDs deduplicate identical keys.** Effect hashes the workflow tag and the author's
   idempotency key. Kojo must define whether a repeated CLI invocation attaches to the existing run
   or supplies a fresh run key; Workflow Revision remains separate metadata.
3. **Storage failures become defects.** `WorkflowEngine.Encoded` operations do not expose a typed
   storage error channel. The journal should validate connectivity before starting, retry
   transient failures internally, and surface a Kojo engine failure around defects rather than
   leaking raw `makeUnsafe`.
4. **Ordinary effects are replayed.** Randomness, current time, filesystem mutation, network access,
   agent execution, and Sandbox lifecycle changes must not occur directly in workflow control code.
   They belong in Activities or durable clocks.
5. **Short clocks are not durable by default.** Kojo must override the threshold as described
   above.
6. **The API is unstable.** Only Kojo internals should import `effect/unstable/workflow`; contract
   tests should cover start, crash/restart, replay, child completion, interrupt, clock wake-up,
   activity idempotency, revision mismatch, and discard for every Effect beta upgrade.

## First-slice recommendation

Build only:

- `DeveloperWorkflow` over `Workflow`;
- Agent Step and Code Step over `Activity`;
- Child Workflow execution;
- named Loop/Review Loop iteration identities;
- a durable clock wrapper;
- `EmbeddedWorkflowEngine` plus the four-record `WorkflowJournal`;
- the Bun SQLite provider;
- Kojo run state/evidence queries and explicit resume/discard commands.

Do not build Durable Queue workers, proxy/server transports, Cluster integration, workflow
migrations, or a generic database-provider plugin in the first slice. Depending internally on
`SqlClient` already preserves the provider seam; only SQLite needs to be wired and tested now.

## Primary sources

- Effect V4 beta.98,
  [`Workflow.ts`](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Workflow.ts).
- Effect V4 beta.98,
  [`Activity.ts`](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/Activity.ts).
- Effect V4 beta.98,
  [`WorkflowEngine.ts`](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/WorkflowEngine.ts).
- Effect V4 beta.98,
  [`DurableDeferred.ts`](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/DurableDeferred.ts).
- Effect V4 beta.98,
  [`DurableClock.ts`](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/DurableClock.ts).
- Effect V4 beta.98,
  [`DurableQueue.ts`](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/workflow/DurableQueue.ts).
- Effect V4 beta.98,
  [`ClusterWorkflowEngine.ts`](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts).
- Effect V4 beta.98,
  [`SqlClient.ts`](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/sql/SqlClient.ts).
- Effect V4 beta.98,
  [`@effect/sql-sqlite-bun` client](https://github.com/Effect-TS/effect-smol/blob/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/sql/sqlite-bun/src/SqliteClient.ts).
