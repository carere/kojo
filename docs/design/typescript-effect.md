# Kojo — the project as built

> The model is in [architecture.md](architecture.md). This is how it is built: packages, services,
> layers, the durability engine, the Sandcastle boundary, and the order to build it in.

Every API this document names was checked against the pinned packages — compiled, and in the
load-bearing cases executed. The evidence, including what was found wrong, is in
[docs/research/effect-v4-api-audit.md](../research/effect-v4-api-audit.md). Where this document now
states a constraint flatly ("`make` returns a plain object", "`onExit` goes inside the Activity"),
that is a measurement, not a reading.

---

## 1. Stack

**Effect v4 consolidates almost everything into the `effect` package.** Verified against
`Effect-TS/effect@main`, which is `4.0.0-beta.106`: there is no separate `@effect/workflow`,
`@effect/cli`, `@effect/cluster`, or `@effect/platform` on 4.x. They are subpath exports:

```
effect/unstable/workflow      Workflow · Activity · DurableDeferred · DurableClock
                              DurableQueue · WorkflowEngine
effect/unstable/cluster       ClusterWorkflowEngine · SingleRunner · SqlMessageStorage
effect/unstable/cli           Command · Flag · Argument · Prompt
effect/unstable/sql           the SQL abstraction
effect/unstable/observability, /http, /rpc, /persistence, …
```

The standalone `@effect/workflow@0.19.1` and `@effect/cli@0.77.0` on npm are **v3-only artefacts** —
neither has published anything on 4.x, and both peer on `effect: ^3.22.1`. On v4 you do not want
them; you want the subpaths.

| Package | Version | Role |
|---|---|---|
| `effect` | `4.0.0-beta.106` | the runtime model **and** workflow, cluster, CLI, SQL |
| `@effect/platform-bun` | `4.0.0-beta.106` | `BunServices.layer` supplies the whole `Command.Environment` in one line — `FileSystem`, `Path`, `Terminal`, `ChildProcessSpawner`, `Stdio` — plus `BunHttpServer` for `kojo ui` and `BunRuntime` for the bin. The ports themselves moved into core `effect` (`effect/FileSystem`, `effect/Path`, `effect/Crypto`), process execution into `effect/unstable/process` |
| `@effect/sql-sqlite-bun` | `4.0.0-beta.106` | trace database, and cluster message storage, over `bun:sqlite` |
| `@effect/vitest` | `4.0.0-beta.106` | `it.effect`, and `TestClock` from `effect/testing` — already in `it.effect`'s `TestEnv`, so no explicit layer. Peer range `>=4.1 <5` |
| `@types/bun` | latest | required by `@effect/platform-bun`'s HTTP types. With `skipLibCheck: true` its absence degrades silently to unchecked arguments rather than erroring |
| `@ai-hero/sandcastle` | `0.12.0` | sandboxes, worktrees, branches, agent providers |
| bun | latest | package manager, test runtime, and the runtime the published CLI targets |

Span export is **not** `@effect/opentelemetry`. That package leaves all eight `@opentelemetry/*`
peers optional, none of them resolve on a plain install, and importing it fails at runtime. Use
`effect/unstable/observability/OtlpTracer` — no extra packages, and it is what Effect's own
`ai-docs` teach for a new project.

Sandcastle is internally an Effect v3 codebase, and that is not a problem: its build enforces that
**Effect never appears in its public types**, so Kojo's Effect version and Sandcastle's never have
to agree. Kojo makes the opposite call and exposes Effect deliberately — the workflow is exactly
where a typed error channel and swappable layers pay.

---

## 2. Layout

Behavior lives under `src/contexts/<bounded-context>/<concept>`, per AGENTS.md. Each bounded
context owns its ports, its adapters (real and in-memory, side by side — every port ships one of
each), its models, and its errors. `cli` stays outside `contexts`, the way `routes` does in a
frontend app.

```
kojo/
├── packages/
│   └── kojo/                          # the published package: primitives, ports, adapters, CLI
│       ├── src/
│       │   ├── index.ts               # deep-import surface; no barrel re-exports
│       │   ├── contexts/
│       │   │   ├── workflow/          # the primitives and the contract
│       │   │   │   ├── models/        # Envelope.ts (EnvelopeBase + extend), errors
│       │   │   │   ├── services/      # Workflow.ts, phase/{agent,code,gate,sandboxed}.ts,
│       │   │   │   │                  #   Acceptance.ts, the correction loop
│       │   │   │   └── guards/        # Check.ts, checks/*.ts, Permissions.ts
│       │   │   ├── agent/             # who the agents are, and one agent call
│       │   │   │   ├── ports/         # AgentInvoker.ts, Roster.ts
│       │   │   │   └── adapters/      # SandcastleAgentInvoker, InMemoryAgentInvoker (scripted
│       │   │   │                      #   envelopes), YamlRoster, kojoPi (AgentProvider
│       │   │   │                      #   preserving system prompt + tools)
│       │   │   ├── sandbox/           # the isolation boundary and the working copy
│       │   │   │   ├── ports/         # Workspace.ts, Sandbox.ts
│       │   │   │   └── adapters/      # boundary.ts — THE ONLY Promise boundary,
│       │   │   │                      #   BindMountWorkspace, SandboxExecWorkspace,
│       │   │   │                      #   InMemoryWorkspace, providers.ts (re-exports
│       │   │   │                      #   docker/podman/vercel/daytona/none)
│       │   │   ├── gate/              # how a human answers
│       │   │   │   ├── ports/         # Gate.ts
│       │   │   │   └── adapters/      # TerminalGate — the reference adapter, InMemoryGate
│       │   │   │                      #   (pre-programmed verdicts)
│       │   │   ├── trigger/           # how a run starts
│       │   │   │   ├── ports/         # Trigger.ts
│       │   │   │   └── adapters/      # ManualTrigger — the reference adapter, InMemoryTrigger
│       │   │   ├── trace/             # observability
│       │   │   │   ├── ports/         # Tracer.ts
│       │   │   │   └── adapters/      # SqliteTracer, InMemoryTracer
│       │   │   └── shared/            # used by several contexts, organized by concept
│       │   │       ├── ports/         # Display.ts
│       │   │       └── models/        # run id, common types
│       │   ├── cli/                   # effect/unstable/cli — outside contexts, like routes
│       │   ├── main.ts                # bin
│       │   └── template/              # what `kojo init` stamps
│       ├── tests/
│       │   ├── unit/contexts/         # mirrors src/contexts
│       │   └── integration/contexts/  # mirrors src/contexts
│       ├── moon.yml
│       ├── biome.json                 # root: false, extends: "//"
│       └── tsconfig.json
├── apps/
│   └── console/                       # the run UI — same contexts layout; routes/ and
│                                      #   styles/ outside contexts; tests/browser/ (Playwright).
│                                      #   Its build output ships inside packages/kojo, so
│                                      #   `kojo ui` works for a consumer. See console.md
└── .kojo/                             # Kojo's own factory — dogfood
```

One published package. Split it when a second consumer exists, not before.

Two placement calls worth recording:

- `sandboxed` is a workflow primitive, so it lives in `workflow/services` — it *consumes* the
  `Sandbox` service that the `sandbox` context owns.
- Errors live in the context that owns them (`EnvelopeParseError` in `workflow`, `GateRejected` in
  `gate`, `SandboxError` in `sandbox`), not in one shared `errors.ts`. §6 lists them together only
  for reading convenience.

### What lands in a target repo

SSSF stamps *all* of its runtime into your repo. Right for Python; wrong for TypeScript, where
stamped source means stamped dependencies and drift you cannot upgrade away.

**The runtime is a versioned dependency. Everything opinionated is yours.**

```
.kojo/
├── kojo.config.yaml     # roster + sandbox/agent defaults          ← yours
├── workflows/*.ts       # the ADWs — this is the product            ← yours
├── envelopes.ts         # Schema per output type                    ← yours
├── checks.ts            # your definition of done                   ← yours
├── commands.ts          # your real test/lint/build invocations      ← yours
├── prompts/{agent}/{system,user}.md                                 ← yours
├── sandbox/Dockerfile                                               ← yours
├── .env
└── data/                # runs, trace db, worktrees      ← gitignored
```

Plus **two lines in the repository's own `package.json`**, which is the other half of "a versioned
dependency": every file above imports `kojo` and `effect`, so `kojo init` declares both — merging
into an existing manifest and never changing a value already there. `effect` is pinned to the exact
version the engine resolved, derived from the engine's own install rather than written a second
time. The exactness is load-bearing: two copies of `effect` in one process are two `Schema` modules,
so a workflow's payload struct and the engine's reading of it are different types, and the run dies
with `TypeError: Cannot convert a symbol to a string` inside the framework. `kojo doctor` refuses
that before a run reaches it, and names both copies (ticket 44).

Checks are functions and workflows are code, so SSSF's *"it is designed to be edited"* survives —
what you edit is your own file, not a vendored copy of an engine.

---

## 3. Durability

`effect/unstable/workflow` supplies everything §4 of the architecture needs.

| Kojo concept | v4 API |
|---|---|
| workflow | `Workflow.make(tag, { payload, idempotencyKey, success?, error?, annotations? })` |
| phase | `Activity.make({ name, success, error, execute })` — `execute` is an Effect **value**, not a thunk |
| retry within a phase | `Activity.retry` — `times` / `while` / `until` only, **no `schedule`**. `Activity.CurrentAttempt` keys the result slot |
| gate | `DurableDeferred.make(...)` returns a **plain object**, so no `yield*`. Then `.token` to request, `.done` / `.succeed` / `.fail` / `.failCause` to answer |
| gate deadline | `DurableDeferred.raceAll({ name, success, error, effects })` against `DurableClock.sleep({ name, duration, inMemoryThreshold? })` |
| dedup by trigger | `idempotencyKey` on the workflow |
| cleanup on failure | `myWorkflow.withCompensation` — prefer the method over the module function, which widens `cause` to `unknown` |
| run-lifetime cleanup | `Workflow.addFinalizer` |
| pause on error instead of dying | `Workflow.make(...).annotate(Workflow.SuspendOnFailure, true)` — an **annotation**, not a combinator |

Four sharp edges on that table, each found by running the code rather than reading it:

- **`DurableClock.sleep` below `inMemoryThreshold` (default 60 s) never suspends.** It runs as an
  in-memory activity holding the fiber. A short deadline does not exercise the suspend path.
- **`raceAll` requires both `success` and `error`**, unlike `make`, and every racer shares one schema
  pair — so racing a `Verdict` against a `void` sleep needs a common success type.
- **`Activity.retry` takes no `Schedule`.** Schedule-shaped backoff has to be plain `Effect.retry`
  *outside* the activity, which then does not advance `CurrentAttempt`, so every attempt collapses
  into one persistence slot.
- **Suspension waits for sibling activities.** A suspending fiber blocks until every concurrently
  running activity finishes or itself suspends. A gate in lane A therefore waits on a long agent
  phase in lane B before either sandbox is released.

`Workflow.CaptureDefects` also exists and **defaults to true**: a defect becomes a recorded
`Complete` carrying a failed Exit rather than propagating. That is probably not what Kojo wants for
an agent crash that should page a human, and the default must be chosen deliberately.

### The engine

Two layers, and neither needs distributed infrastructure:

- `WorkflowEngine.layerMemory` — a separate hand-rolled engine, state in plain `Map`s. It suspends
  and resumes correctly *in-process*; what it loses is a **process restart**. Correct for tests and
  for a one-shot `kojo run`, wrong for anything that must survive closing the laptop.
- `ClusterWorkflowEngine.layer` over `SingleRunner.layer()` + `SqlMessageStorage` on SQLite — a
  single-node cluster, no Kubernetes, no message broker. **This is what `kojo watch` runs.**
  `SingleRunner.layer` is a **function**, and the layer it returns can fail with `ConfigError`, so
  something must `Layer.orDie` it. It always requires a `SqlClient` and `Crypto`, even with
  `runnerStorage: "memory"`.
- `ClusterWorkflowEngine.layer` over **`TestRunner.layer`** — the real cluster engine with zero SQL,
  no requirements and no error channel. It exercises message envelopes, entity mailboxes, and
  durable-clock wakeups, none of which `layerMemory` touches. Worth a test tier of its own.

The same SQLite file can hold the engine's state and the trace, but they stay separate schemas for
the reason in *Two stores* below.

### Every phase is an Activity

Activity results are persisted. On resume the workflow replays from the top, completed activities
return their recorded values without re-running, and execution lands where it stopped.

This is the mechanism that makes tear-down-and-rebuild work: `sandboxed` is a **scope, not an
activity**, so replay re-enters it and rebuilds the sandbox from the branch on the way past — while
the planner that already ran does not run again.

It is also the sharpest edge in the system. **Anything outside an activity re-runs on every resume.**
Both halves were verified by running them: the recorded activity value came back without its side
effect firing again, and everything outside an activity re-executed.

**And the scope must stay outside the activity, or the run dies instead of suspending.**
`Activity.make` wraps every body in `retryOnInterrupt` — it retries while the cause has interrupts,
up to ten attempts, then `Effect.die("Activity … interrupted and retry attempts exhausted")`. Since
suspension *is* an interrupt, a sandbox scope acquired inside an activity turns a gate into a defect.
Tear-down-and-rebuild works precisely because `sandboxed` is a scope **around** activities.

### Use a local scope for the sandbox, never the workflow scope

v4 offers both, and the choice is the whole tear-down-and-rebuild decision:

- `Workflow.scope` / `Workflow.provideScope` — a scope **closed only when the execution fully
  completes**. A sandbox acquired here would be held across a two-day gate. Never do this.
- `Effect.scoped` — a local scope. `Workflow.suspend` marks the instance suspended and then
  *interrupts the fiber*, so a local scope unwinds: the container stops and the worktree is
  preserved, exactly as a normal interrupt would.

So `sandboxed` uses `Effect.scoped`, and suspension releases it for free. `Workflow.addFinalizer` is
still the right tool for run-lifetime cleanup that must outlive suspension — closing the trace row,
returning the ticket to its previous status.

Both halves are confirmed against the engine rather than inferred. A run holding an
`Effect.acquireRelease` inside `Effect.scoped` around a gate logged *sandbox acquired → suspend →
**sandbox released*** on its first pass, before any answer arrived. And `intoResult` calls
`Scope.close` only on failure or completion — the `Suspended` branch returns `Effect.void`, which is
exactly why a workflow-scoped sandbox would be held across the wait.

### The gate

```ts
export const gate = <Choices extends ReadonlyArray<string>>(params: {
  readonly name: string
  readonly description: string
  readonly actor: ActorName
  readonly choices: Choices
  readonly context: GateContext          // branch, diff, run id, what is being decided
  readonly deadline?: Duration
  readonly onExpiry?: "reject" | "escalate" | "fail"
}) =>
  Effect.gen(function* () {
    // `make` returns a plain object — not an Effect. `yield*` on it is a defect at runtime.
    // The attempt suffix is load-bearing; see below.
    const attempt = yield* Activity.CurrentAttempt
    const deferred = DurableDeferred.make(`gate/${params.name}/${attempt}`, { success: Verdict })
    const token = yield* DurableDeferred.token(deferred)

    // The requesting half: open a PR review, print a command, post to Slack. Runs and finishes.
    yield* Gate.request({ token, ...params })

    // The run suspends here. Nothing is held. Resume happens whenever the answer arrives.
    return yield* DurableDeferred.await(deferred)
  })
```

**A gate name must be unique per asking, and this is not a detail.** A `DurableDeferred` is keyed
`${executionId}/${deferred.name}`, and `deferredDone` refuses to overwrite an existing answer. A
correction loop that asks the same gate twice under the same name reads the *first* verdict back
instantly, forever. Run as originally written, the hotfix loop in §8 completed five iterations in
milliseconds against one stale rejection, never suspending and never involving a human.

So **a repeated gate belongs to an `Activity.retry` loop, not a `while` loop**, because
`Activity.CurrentAttempt` is the only counter the engine itself maintains — and
`DurableDeferred.withActivityAttempt` exists for exactly this, appending `/${CurrentAttempt}` for
you. A hand-written `while` would have to thread its own counter into every gate name, and forgetting
once produces a loop that looks like it is asking and is not.

The answering half is out of band: any process holding the token calls `DurableDeferred.done`. The
terminal adapter prints `kojo gate answer <token> --approve`; a PR adapter answers from a webhook;
the Console answers from a click. The port does not care.

**But the token alone is not enough to answer.** `done` / `succeed` / `fail` need the
`DurableDeferred` *value* — the same name and the same schemas — plus a `WorkflowEngine` layer. The
token decodes to `workflowName / executionId / deferredName` and carries no schema. So the answering
process must reconstruct the deferred, which means one of two things, and Kojo picks the second:
a registry keyed by gate name, or **one `Verdict` schema for every gate**. One schema keeps any
adapter able to answer any gate with nothing but the token.

### Starting a run that is going to suspend

`workflow.execute(payload)` **does not return while the run is suspended.** The engine's execute is
a poll loop that only returns on `Complete`, so a caller awaiting it sits unsettled for as long as
the human takes — two days, in the case this design is built around.

`execute(payload, { discard: true })` returns the execution id immediately, and `poll(executionId)`
reports `Suspended`. That is the shape every entry point uses: `kojo run` starts a run and reports
where it stopped rather than blocking on it, and a test forks the run and advances the clock rather
than awaiting it. Blocking is opt-in, never the default — see §11.

### Compensation

`Workflow.withCompensation` registers a finalizer that fires when the **whole workflow** fails —
the merge step's inverse. Return the ticket to its previous status, post the failure, preserve the
branch rather than delete it.

One documented gotcha to respect, and confirmed by running all three cases: compensations **only
register for top-level effects in the workflow, not for nested activities**. A compensation on a
top-level effect fired; one wrapping an activity from the top level fired; one registered *inside* an
activity body did not, because an activity executes under a throwaway workflow instance whose scope
closes with the activity's own success. So compensation belongs in the factory body, not inside a
lane. Anything a lane must undo is the lane's own scope's job.

### Two stores, not one

Worth stating plainly so they never get conflated:

- **The engine's persistence** is *correctness*. Activity results, suspension state, tokens. Losing
  it loses the ability to resume.
- **The trace** is *observability*. Occurrences, tool calls, timings, token usage, gate history.
  Losing it loses nothing you cannot rebuild.

They share one SQLite file, and that was run rather than assumed: one client with `SqlMessageStorage`
and a Kojo migrator on top produced `cluster_*` and `kojo_*` tables side by side. Three conditions
make it safe, and all three are easy to get wrong:

- **Share one `SqlClient`, not one path.** The tag is a single service, so two `SqliteClient.layer`
  calls for the same file are two `bun:sqlite` handles with two independent write serializers. Build
  the client once and provide it to both.
- **Name the migration table.** The cluster names its own `cluster_migrations`, which overrides the
  package default — so Kojo must pass `kojo_migrations` explicitly rather than inherit a name it does
  not own.
- **Migrating is racy.** A migration row is inserted before its body runs, and a conflict there is
  swallowed as a debug log returning no migrations. Combined with `busy_timeout = 0`, two processes
  starting together can leave one proceeding against a database it never verified. A failing
  migration is also `Effect.die`, not a typed error.

---

## 4. Ports

Each is a **`Context.Service`** — v4's idiom is
`class X extends Context.Service<X, Interface>()("id")`, not v3's `Context.Tag`. Each has a real
adapter and an in-memory one. That pairing is the design.

```ts
// contexts/sandbox/ports/Workspace.ts — the filesystem and shell a phase acts on, wherever it physically is
export class Workspace extends Context.Service<Workspace, {
  readonly root: string
  readonly hostPath: Option<string>          // None for isolated providers
  readonly exec:   (argv: ReadonlyArray<string>, opts?: ExecOptions) => Effect<ExecResult, WorkspaceError>
  readonly git:    (args: ReadonlyArray<string>) => Effect<ExecResult, WorkspaceError>
  readonly read:   (path: string) => Effect<string, WorkspaceError>
  readonly write:  (path: string, content: string) => Effect<void, WorkspaceError>
  readonly stat:   (path: string) => Effect<Option<FileStat>, WorkspaceError>
  readonly unlink: (path: string) => Effect<void, WorkspaceError>
}>()("kojo/Workspace") {}
```

`Workspace` is why code phases and checks are honest. Without it, a check calls `fs.stat` on the
host while the agent wrote inside a container, and the factory grades a tree nobody touched. Two
adapters: bind-mount (worktree on the host — fast, debuggable) and sandbox-exec (everything through
`sandbox.exec` — required for isolated providers).

```ts
// contexts/gate/ports/Gate.ts — how a human is asked, and how the answer gets back
export class Gate extends Context.Service<Gate, {
  readonly request: (r: GateRequest) => Effect<void, GateError>
  readonly describe: (r: GateRequest) => string        // for the trace and the CLI
}>()("kojo/Gate") {}

// contexts/trigger/ports/Trigger.ts — what starts a run, and what it is deduplicated by
export class Trigger extends Context.Service<Trigger, {
  readonly stream: Stream<TriggerEvent, TriggerError>  // one event per unit of work
  readonly ack:    (event: TriggerEvent, outcome: RunOutcome) => Effect<void, TriggerError>
}>()("kojo/Trigger") {}
```

`Trigger` as a `Stream` covers all four shapes with one interface: the manual adapter emits one
event and ends; a poller emits on an interval; a webhook receiver emits on request; a cron emits on
schedule. `ack` is where a ticket gets closed or a webhook gets its response.

```ts
// contexts/trace/ports/Tracer.ts — where the trace goes. One wide record per unit of work.
export class Tracer extends Context.Service<Tracer, {
  readonly runStarted:  (r: RunRecord) => Effect<void, TracerError>
  readonly runFinished: (id: RunId, outcome: RunOutcome) => Effect<void, TracerError>
  readonly phase:       (p: PhaseRecord) => Effect<void, TracerError>   // written once, on exit
  readonly gate:        (g: GateRecord) => Effect<void, TracerError>
  readonly sandbox:     (s: SandboxRecord) => Effect<void, TracerError> // one per acquisition
  readonly occurrence:  (o: Occurrence) => Effect<void, TracerError>    // §9 — subordinate only
}>()("kojo/Tracer") {}
```

The shape is the point. There is **no `Tracer.event(name, data)`**, because a method like that is an
invitation to scatter a dozen half-context lines across a phase and reassemble them later in a
query. Each method above takes a *completed* record: everything known about one unit of work, in
one call, at the moment it ends. §9 says what those records carry.

`Display` is not a second logger. It renders what is happening for a human at a terminal, reads
from the same records, and writes nothing durable — if a fact matters after the process exits, it
belongs to `Tracer`. Effect's own `Effect.log` is for engine-level diagnostics only (a retry
backing off, a layer failing to build), never for run history, and it defaults off. Three sinks
with three jobs, stated here so nobody later has to guess which one to reach for.

`Tracer` writes; **`TraceReader` reads**, and `ArtifactReader` serves the three things a trace
deliberately does not store — the rendered prompt, the captured agent session, and the diff. Both
live in the `trace` context, both ship an in-memory adapter beside the real one, and together they
are the whole data path of the Console. Keeping them apart from `Tracer` keeps the write side free
of query shapes, and keeps a missing artifact from reading like a missing record.

The remaining ports — `AgentInvoker` and `Roster` — are unchanged from the usual shape.
`SandboxProvider` and `AgentProvider` are Sandcastle's own; Kojo re-exports them rather than
redefining them.

---

## 5. Schema is the whole contract

SSSF's most-repeated warning is about a contract living in three places:

> The type, the JSON example in the agent's prompt, and `output_type=` at the call site are ONE
> contract — change one, change all three in the same edit.

One declaration here:

```ts
// .kojo/envelopes.ts
export class BuildOutput extends EnvelopeBase.extend<BuildOutput>("BuildOutput")({
  _tag:          Schema.tag("BuildOutput"),
  changedFiles:  Schema.Array(Schema.String),
  commitMessage: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
}) {}
```

Three things in those four lines were wrong on the first draft and are worth stating, because each
fails in a different way:

- **`EnvelopeBase` must be a plain `Schema.Class`, and each envelope declares its own
  `Schema.tag`.** `.extend` merges fields, so a `TaggedClass` base is *inherited*: every envelope
  would report the base's tag at runtime and in its JSON Schema, and overriding `_tag` against a
  tagged base is a compile error. A plain base plus a per-envelope tag field gives the right tag in
  all three places.
- **`Schema.optionalWith` does not exist.** v4 splits it, and every default is an **Effect**, not a
  thunk. The decode-side one — which is what a missing key in an agent's JSON needs — is
  `withDecodingDefaultKey`. `withConstructorDefault` is the constructor-side sibling and is not the
  same thing.
- **The explicit self type parameter is mandatory.** `extend<BuildOutput>` is not decoration.

Serving four uses:

1. the TypeScript type at the call site;
2. the decoder — and its `SchemaError` carries a `SchemaIssue.Issue` tree, which is a field-level
   explanation and makes a far better correction prompt than a list of field names. **Decode with
   `{ errors: "all" }` as an invariant of Kojo's own helper**, never per call site: the default is
   `"first"`, so a three-field mistake reports one field and the correction loop burns one retry per
   field. `toStandardSchemaV1` hardcodes `"all"` internally, so leaving the default in place also
   makes the two paths disagree;
3. `Schema.toJsonSchemaDocument(BuildOutput)` rendered into the agent's prompt, together with the
   output tag, so the example cannot drift. It returns a **document** —
   `{ dialect, schema: { $ref }, definitions }` — so the prompt renderer must inline the definition
   or emit both halves. Pasting the object verbatim hands the agent a dangling `$ref`;
4. the wire contract — which is Kojo's to enforce, not Sandcastle's: the agent provider never
   receives the schema. Sandcastle's own `Output.object` (a Standard Schema, via
   `Schema.toStandardSchemaV1`) exists on its top-level `run()` only; `sandbox.run()` has no
   `output` option, so inside a sandbox Kojo extracts the tagged output and decodes it itself —
   which the correction loop must own anyway, since `EnvelopeParseError` is its input.

Drift is not expressible. The roster gets the same treatment — `kojo.config.yaml` is decoded through
`Schema`, so a bad roster is a path-precise error at load, before anything spawns.

---

## 6. Errors

**Every Kojo error is a `Schema.TaggedError`, not a `Data.TaggedError`.** This is not a style
preference. `Workflow.make`'s `error` option is typed `Error extends Schema.Top`, and the engine
persists a finished run as `Schema.Exit(success, error, Schema.Defect())`. A `Data.TaggedError` is
not a schema, so it cannot be a workflow's error channel and cannot survive the suspend-and-resume
round trip this whole design exists for. The difference is invisible until the first suspension,
which is the worst possible moment to find it.

```ts
export class EnvelopeParseError extends Schema.TaggedError<EnvelopeParseError>()(
  "EnvelopeParseError",
  {
    agent: Schema.String, expected: Schema.String,
    parseError: SchemaError, raw: Schema.String,   // SchemaError, not ParseError — see below
  },
) {}

export class CheckViolation extends Schema.TaggedError<CheckViolation>()("CheckViolation", {
  agent: Schema.String, check: Schema.String, report: CheckReport,
}) {}

export class PermissionBreach extends Schema.TaggedError<PermissionBreach>()("PermissionBreach", {
  agent: Schema.String, scope: Schema.String,
  paths: Schema.Array(Schema.Struct({ path: Schema.String, outcome: RollbackOutcome })),
}) {}

export class GateRejected extends Schema.TaggedError<GateRejected>()("GateRejected", {
  gate: Schema.String, actor: Schema.String, reason: Schema.String,
}) {}

export class GateExpired extends Schema.TaggedError<GateExpired>()("GateExpired", {
  gate: Schema.String, waited: Schema.Duration,
}) {}

export class NotAccepted extends Schema.TaggedError<NotAccepted>()("NotAccepted", {
  reason: Schema.String,
}) {}
// … SandboxError, WorkspaceError, AgentError, ConfigError, TriggerError
```

**There is no `ParseError` and no `ParseResult` module in v4.** The decode failure type is
`SchemaError`, carrying a `SchemaIssue.Issue`. The correction-prompt builder should hold the
`Issue` tree rather than a rendered string, because the tree is what lets the feedback name paths.

This makes architecture.md's D8 structural, and it was checked by compiling both directions.
`catchTags({ EnvelopeParseError, CheckViolation })` over `E = … | PermissionBreach` leaves the
residual channel exactly `PermissionBreach`; and adding a handler for a tag the effect cannot raise
is a hard `TS2322`, because the cases intersection maps unknown keys to `never`. A breach cannot be
retried by accident, and a handler cannot be written for an error that does not exist. Upstream this
is a paragraph in a docstring; here it is a type error. Moving to `Schema.TaggedError` preserves it
unchanged.

### The correction loop

Not a plain retry: the error has to become the next prompt, and the retry must re-enter the *same*
agent session, so a correction costs one message rather than a cold start.

```ts
const withCorrections = <A, R>(
  attempt: (correction: Option<string>) => Effect<A, EnvelopeParseError | CheckViolation, R>,
  limit: number,
): Effect<A, EnvelopeParseError | CheckViolation, R> => {
  const go = (n: number, correction: Option<string>): Effect<A, EnvelopeParseError | CheckViolation, R> =>
    attempt(correction).pipe(
      Effect.catchTags({
        EnvelopeParseError: (e) => n >= limit ? Effect.fail(e) : go(n + 1, Option.some(reparseFeedback(e))),
        CheckViolation:     (e) => n >= limit ? Effect.fail(e) : go(n + 1, Option.some(checkFeedback(e))),
      }),
    )
  return go(0, Option.none())
}
```

---

## 7. The Sandcastle boundary

One module. Every `Promise` in the codebase is inside it.

```ts
// contexts/sandbox/adapters/boundary.ts
export const acquireSandbox = (opts: sc.CreateSandboxOptions) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try:   () => sc.createSandbox(opts),
      catch: (cause) => new SandboxError({ op: "create", cause }),
    }),
    (sandbox) => Effect.promise(() => sandbox.close()).pipe(Effect.orDie),
  )
```

Release is `orDie`: a teardown failure is a defect, not something a workflow author handles.

Enforced by inverting Sandcastle's own build check — it asserts Effect never leaks *out*; Kojo
asserts a bare `Promise` never appears in its public types, so the boundary cannot quietly spread.

Facts of the 0.12.0 boundary, audited against the source (2026-08-08), to encode in the adapters:

- `sandbox.exec()` surfaces a non-zero `exitCode` in its result rather than throwing — the
  `Workspace` adapter decides what enters the error channel. `close()` returns a `CloseResult`.
- **Resume and capture are two capabilities, not one**, and the matrix has three rows rather than
  two: **bind-mount (Docker, Podman) captures and resumes; `noSandbox()` resumes without capturing**,
  because the agent writes its session in place on the host and Sandcastle never has to move it;
  **isolated providers (Vercel, Daytona) do neither.** Capture is further limited to the
  `claudeCode`, `codex`, and `pi` providers. The `AgentInvoker` port must expose resume as a
  capability, not assume it.
- **Kojo must carry its own provider tag.** Internally `SandboxProvider` is a discriminated union on
  `"bind-mount" | "isolated" | "none"` and every gate dispatches on it — but `tag` is stripped from
  the published types, the isolated and none shapes are structurally identical, and `docker()` is
  typed as the wide union. Resume capability is therefore not statically derivable from a provider
  value.
- Option names: `docker({ imageName })` (not `image`); mounts are a provider-factory option, not a
  `createSandbox` option. Hooks have **three** slots, not a 2×2: `host.onWorktreeReady`,
  `host.onSandboxReady`, `sandbox.onSandboxReady` (which also takes `sudo?`). There is no
  `sandbox.onWorktreeReady`, so a `hooks` type modelled as a cross-product would not compile.
- `CreateSandboxOptions` has **no `env`**, unlike every other entry point, so per-run secrets are
  threaded by constructing a fresh provider inside `resolve(config)`.
- Worktree refresh fast-forwards from `origin/<branch>` and is best-effort. It has **four** silent
  skip paths, not one: HEAD not on the branch, fetch failure, local divergence from origin, and a
  dirty worktree. Each logs and reuses the worktree as-is. The first of those is precisely the state
  a suspended run leaves behind — see architecture.md §8, edge 3.
- The `Sandbox` handle **survives abort**: an `AbortSignal` cancels the in-flight agent, not the
  container. That is the bridge for suspension — Effect interruption drives the signal into
  `sandbox.run()`, and the scope's release then calls `close()`.
- `@standard-schema/spec` resolves in practice, because `effect` declares it directly. Kojo declares
  it too — it is undeclared load-bearing surface in Sandcastle rather than a missing module.
  Sandcastle is ESM-only; so is Kojo.
- **Sandcastle bundles Effect 3.20.0 into its `dist`.** No peer conflict and no dedupe fight, but a
  Kojo process runs two Effect runtimes side by side and nothing propagates between them — fibers,
  FiberRefs and tracing context do not cross. §9's correlation story cannot lean on Effect tracing
  reaching into Sandcastle, which is why the `KOJO_RUN_ID` environment injection is load-bearing
  rather than belt-and-braces. The only other seams are the `onAgentStreamEvent` and `exec` `onLine`
  callbacks.

Two capabilities the design record did not know about, recorded so the overlap reads as deliberate:

- **`fork()`** exists beside `resume()`, giving one-iteration session fan-out that leaves the parent
  transcript intact — one planning session forked into N implementers. It isolates the session, not
  the branch, so concurrent forks need distinct branches; and pi's `buildPrintCommand` silently drops
  `forkSession`, so `kojoPi` must implement the flag itself.
- **`run()` owns a structured-output correction loop.** `Output.object({ tag, schema, maxRetries })`
  resumes the failed session with generated feedback. That is §6's job, and it is available only on
  the top-level `run()`, which Kojo does not use. Kojo reimplements it on purpose, because the
  correction loop must own `EnvelopeParseError` and feed the trace.

### `sandboxed`

```ts
export const sandboxed = <A, E, R>(
  config: SandboxConfig,                      // branch, provider, hooks, mounts, copyToWorktree
  body: Effect<A, E, R | Workspace | Sandbox>,
) => Effect.scoped(
  Effect.provide(body, Layer.effect(Sandbox, acquireSandbox(resolve(config)))
    .pipe(Layer.provideMerge(BindMountWorkspace.layer))),
)
```

Scoped, so an interrupt — including a suspension — closes the container and preserves the worktree
on the way out. Re-entered on replay, which is where the rebuild happens.

### `kojoPi`

Sandcastle's built-in `pi()` builds `pi -p --mode json --model X [--thinking Y] [--session Z]` and
passes the prompt over stdin. It has **no** `--system-prompt`, no `--tools`, no extension flag. The
roster depends on all three — an agent's identity is its system prompt, its tool allowlist, and its
harness extensions. A stock provider silently drops them.

`AgentProvider` is a plain object interface, so Kojo supplies its own. Reuse is narrower than the
interface suggests, and the asymmetry is sharper than it first looked: the Claude and Codex
session-storage helpers **are** public, and only pi's are private, along with
`makePiSessionStorage`. The pi stream parser is likewise reachable only through an instance —
`pi(model).parseStreamLine` — whose return type `ParsedStreamEvent` is not exported, so `kojoPi` must
infer it with `ReturnType<AgentProvider["parseStreamLine"]>`.

So `kojoPi` wraps a `pi()` instance for parsing and reimplements the session-capture half: pi's cwd
encoding, the sandbox-side transcript locate, and the transfer rewrite. One quirk decides whether it
works at all — **pi resolves `--session <id>` against the current project's encoded directory**, so
a captured transcript must land under the encoded *host* cwd. Put it anywhere else and pi hangs on
an interactive "fork session?" prompt in json mode. `claudeCode()` and `codex()` are used unmodified.

---

## 8. What an author writes

The showcase from architecture.md §3, as user code. Note that no Kojo API decides the lanes.

```ts
// .kojo/workflows/factory.ts
export const factory = workflow({
  name: "factory",
  payload: Ticket,
  success: Shipped,
  idempotencyKey: (t) => `${t.id}@${t.updatedAt}`,     // one run per ticket revision
}, (ticket) =>
  Effect.gen(function* () {
    yield* code({
      name: "in_progress",
      description: "Claim the ticket so no one else picks it up",
    }, () => tracker.setStatus(ticket.id, "In Progress"))

    const route = yield* agent({
      name: "route",
      owner: "router",                                  // runs on the host — no sandbox needed
      description: "Classify the ticket into the lane that fits it",
      output: RouteOutput,
      prompt: routePrompt(ticket),
    })

    const built = yield* Match.value(route.lane).pipe(
      Match.when("hotfix",  () => hotfix(ticket)),
      Match.when("feature", () => feature(ticket)),
      Match.when("bug",     () => bug(ticket)),
      Match.when("chore",   () => chore(ticket)),
      Match.exhaustive,
    )

    // The one place judgement happens. Everything after it is consequence.
    const review = yield* gate({
      name: "review", actor: "engineer", choices: ["approve", "reject"],
      description: "Confirm the work is what was asked for, before anything lands",
      context: { branch: built.branch, diff: built.diffPath },
      deadline: Duration.days(2), onExpiry: "escalate",
    })
    yield* requireAcceptance(review.choice === "approve", review.reason)

    yield* code({ name: "merge", description: "Land the approved branch on the target" }, (ws) =>
      ws.git(["merge", "--no-ff", built.branch]))

    yield* code({ name: "ship", description: "Release what was merged" }, () => release(built))

    return yield* code({ name: "close", description: "Close the ticket that started this" }, () =>
      tracker.close(ticket.id))
  }))
```

```ts
// .kojo/workflows/lane/hotfix.ts — a lane, independently runnable
export const hotfix = (ticket: Ticket) =>
  sandboxed({
    branch: `kojo/hotfix/${ticket.id}`,
    provider: docker({ imageName: "kojo:hotfix" }),
    hooks: { sandbox: { onSandboxReady: [{ command: "bun install" }] } },
  }, Effect.gen(function* () {
    const scout = yield* agent({
      name: "scout", owner: "scout", output: ScoutOutput,
      description: "Find where the fault lives; change nothing",
      prompt: scoutPrompt(ticket),
      checks: [checks.artifactsExist],
    })

    let fix = yield* agent({
      name: "hotfix", owner: "hotfixer", output: BuildOutput, previous: scout,
      description: "Write the smallest change that resolves the fault",
      prompt: fixPrompt(ticket),
      checks: [checks.diffMatchesClaims],
    })

    // A rejected fix returns to the same agent, in the same session.
    // The run suspends at the gate — sandbox released, branch retained.
    //
    // This is `reviewed`, not `while (true)`, and the difference is not cosmetic. A repeated gate
    // needs a distinct DurableDeferred name per asking; the engine's own counter is
    // Activity.CurrentAttempt, which only advances under Activity.retry. A hand-written loop
    // re-reads the first verdict forever and never suspends again. See §3.
    fix = yield* reviewed({
      name: "approve", actor: "engineer", limit: 5,
      description: "A hotfix is approved before it is built, not after",
      deadline: Duration.days(2), onExpiry: "fail",
      // The subject is passed in and comes back approved, so the first asking approving is not a
      // special case with nothing to return. `context` and `revise` read it rather than closing
      // over it: the second asking is about the *revised* fix, and a context captured once would
      // show the reviewer the diff they already rejected.
      subject: fix,
      context: (fix) => ({ branch: currentBranch, diff: fix.diffPath }),
      revise: (verdict, fix) => agent({
        name: "hotfix_revise", owner: "hotfixer", output: BuildOutput,
        description: "Address the reviewer's objection",
        prompt: verdict.reason, previous: fix,
        checks: [checks.diffMatchesClaims],
      }),
    })

    let tests = yield* code({ name: "test", description: "Run the suite" }, runTests)
    for (let i = 1; !tests.passed && i <= 3; i++) {
      fix = yield* agent({
        name: `fix_${i}`, owner: "hotfixer", output: BuildOutput, previous: tests.asEnvelope,
        description: "Repair what the suite reported, from its verbatim output",
        prompt: ticket.body, checks: [checks.diffMatchesClaims],
      })
      tests = yield* code({ name: `retest_${i}`, description: "Re-run the suite" }, runTests)
    }

    yield* requireAcceptance(tests.passed, "the suite never came back clean")
    return fix
  }))
```

Plain control flow throughout — `Match`, `for`, early return — **with one exception, and it is the
only place Kojo takes control flow away from the author**: a loop that contains a gate must be a
`reviewed` loop rather than a hand-written one, because a repeated gate needs the engine's own
attempt counter in its name. Everything that does not re-ask a human stays plain.

That counter pays twice, which is why `revise` above names one phase rather than `hotfix_revise_1`,
`hotfix_revise_2`. Activity results are keyed `executionId/name/attempt`, so `Activity.retry` gives
the revision its own persistence slot on every round and it genuinely re-runs. `limit` bounds the
loop, and spending it is a typed failure — `GateRejected`, carrying the last reviewer's own words,
for the same reason the correction loop fails with the refusal that ended it rather than a wrapper.
How many times they said no is a question for the trace, which keeps one gate record per asking.

Note what this costs the UI: a run of this lane produces `fix_1`, `retest_1`, `fix_2`, `retest_2` as
four phases, not a cycle. A run is a walk, which is why the Console renders a waterfall — see
[console.md §5](console.md).

---

## 9. Trace

**The schema is Kojo's, not SSSF's.** The tempting move is to keep the upstream tables
byte-compatible so SSSF's visualizer runs against `kojo.db` unmodified, and it is worth saying
plainly why that is not on offer — two decisions recorded elsewhere in this design already spent
it. Architecture.md §6 renames *session* to **run** — deliberately, because Sandcastle
already uses "session" for an agent's conversation record — while SSSF's tables key everything on
`sessions.adw_id`; and D9 moves the agent, model, tokens, and cost onto the phase row, whereas the
upstream visualizer reconstructs its agent lanes from `agent_start` events and derives cost by
parsing `agent_end` payloads. Keeping that UI working would mean keeping `adw_id` and keeping the
thin events, which is to say abandoning both decisions to avoid writing a read-only view. Kojo
ships its own **Console** (`kojo ui`, §12 phase 6, designed in [console.md](console.md)); SSSF's
remains a reference for what the UI should *show*.

What is worth inheriting is the **transport rule**, and it is inherited exactly: one SQLite file in
WAL mode, writers write, readers poll a monotonic cursor —
`select rowid, * from occurrences where run_id = ? and rowid > ?`. No ingest endpoint, no WebSocket,
no daemon between the run and the screen. A reader that dies loses nothing and catches up by
re-polling, and a run that has no reader pays nothing. Note the upstream UI also *writes* one
column — `archived`, for review triage. Kojo keeps triage state out of the trace: the trace records
what happened, and what a human later thought about it belongs elsewhere.

Three facts about that one line, each of which breaks it silently:

- **`select *` does not return `rowid`.** SQLite never expands the implicit rowid, so the reader gets
  no cursor to advance and re-reads row 1 forever. Either name it, or give the table an explicit
  `INTEGER PRIMARY KEY`.
- **WAL is already on** — the driver issues it by default and it can only be turned *off*. But the
  pragma is skipped for a read-only client, so a Console opening a path that does not exist yet gets
  a non-WAL file. The first writer must create the database.
- **`busy_timeout` is 0 and there is no retry.** A second writer fails instantly with a
  `LockTimeoutError`. Kojo sets `PRAGMA busy_timeout` itself when it builds the client, and retries
  on that error tag. Without it, `kojo watch` and `kojo run` starting together is a coin flip.

There are also **no streaming reads** on this driver: `executeStream` is `Stream.die("not
implemented")`. It type-checks and then exits with a defect the typed error channel cannot catch, so
the read path is `SqlSchema.findAll` and friends, which decode rows through `Schema` and put failures
in the typed channel as `SchemaError`.

### The phase row is the canonical wide event

A trace made of many thin rows — *started*, *tool called*, *finished* — forces every question to be
reassembled by a join, and answers only the questions whose rows someone thought to write. So the
rule here is the [canonical log line](https://stripe.com/blog/canonical-log-lines): **one wide row
per unit of work, written once, carrying everything known about it.**

Kojo has no requests, so the mapping is: a **phase** is the unit of work, a **run** is the trace
that ties phases together, and a **sandbox** is a service hop. SSSF's `phases` table is the right
starting shape — identity, kind, owner, status, attempt, retries, error, start, end — and Kojo's is
that table widened and re-keyed on `run_id`.

Schema changes stay additive, for our own reader's sake rather than an upstream one: new columns
ship as explicit migrations, so a Console built against an older engine keeps working when the
factory upgrades under it. This is the discipline SSSF arrived at the hard way — its `MIGRATIONS`
list exists because `CREATE TABLE IF NOT EXISTS` never revisits a table that already exists, and a
schema that silently fails to evolve is worse than one that fails loudly.

A phase row carries, beyond what SSSF records:

- **identity and correlation** — run id, phase id, parent phase id, the trigger's dedup key.
- **the agent, when there is one** — name, provider, model, session id, whether the call resumed an
  existing session or started cold, tokens in and out, context-window occupancy after the turn.
- **the verdict** — envelope type, whether it decoded, which checks ran and which failed, how many
  corrections it took, and the terminal error tag when there is one.
- **the effect on the repo** — files claimed changed, files actually changed, commits produced, and
  any permission breach with its rollback outcome.
- **where it ran** — sandbox id when inside one, `null` when on the host. That single nullable
  column answers "which phases needed a container" without a join.

Written **once, on exit, on every path**. Not at the end of the happy path: `Effect.onExit` so a
phase that fails, dies, or is interrupted at a gate still leaves a complete row. A phase with no row
is a phase you cannot debug, and interruption is precisely when you care.

**The `onExit` goes inside the Activity, not around it.** Put it around, and it is outside the
recorded boundary, so replay re-runs it: a probe with a body that logged, ran an activity, slept
seven durable days and logged again produced its body log twice and its activity log once. A run that
suspends three times would leave four rows for one phase, and "written once" would be a promise the
placement does not keep. The write is a side effect, and rule 1 of architecture.md §4 already says
where side effects live.

### Stamp the environment on every run

`runs` carries what produced it, not only what it did: the kojo version and git commit of the
engine, the factory's own config digest, the host identifier, and the resolved sandbox image
digest. Kojo is a versioned dependency under a factory that keeps running across upgrades, so
*"which engine version produced this run"* is a question that will certainly be asked, and no
amount of per-phase detail answers it after the fact.

### The other tables

- `runs` gains `suspended` as a status, plus the open gate and its deadline, plus **the in-flight
  phase** — phase id, name, kind, owner, start, attempt — updated in place and cleared when the
  phase row replaces it. A phase row is written on exit, so without this a live run has nothing to
  draw for the four minutes an agent is thinking. This is the run's mutable status, not a record of
  completed work, so D9 is intact. See
  [adr/trace/0002](../adr/trace/0002-in-flight-phase-lives-on-the-run-row.md).
- `gates` table — request, token, actor, verdict, who answered, latency. **Human latency is the
  metric a factory lives or dies by**, and nothing upstream measures it.
- `sandboxes` table — provider, image digest, branch, worktree path, acquisition and release
  timestamps, outcome, and one row **per acquisition**, so a rebuild after a gate is visible as its
  own row rather than hidden. This row *is* the sandbox's wide event; there are deliberately no
  `sandbox_start` / `sandbox_end` events, because a pair of rows for one lifecycle is the thin-row
  pattern this section exists to avoid.
- `occurrences` survives for genuine repetition **within** a phase — individual tool calls, `exec`
  invocations, iterations — where the count is unknown and each occurrence is its own fact. It is
  subordinate: an occurrence never carries context its phase row lacks, and no question should
  require reading it to answer. It is the one table with a rowid cursor.

### Correlation across the sandbox boundary

A container is a separate execution context, so the correlation key has to cross into it. `KOJO_RUN_ID`,
`KOJO_PHASE_ID`, and `KOJO_ATTEMPT` are injected into every sandbox environment and every agent
invocation. Sandcastle emits its own stream events and captures session JSONL back to the host;
without the key carried in, none of that joins to the phase that caused it except by timestamp,
which stops working the moment two lanes run in parallel.

Effect contributes real parent/child nesting for free: `Effect.withSpan` on each phase derives it
from the fiber tree, across `forkChild` and `forkIn` too, where SSSF threads a `parent_id` by hand.
Export goes through `effect/unstable/observability/OtlpTracer`, not `@effect/opentelemetry`.

**But spans and the phase table are two models, not one, and the difference appears at exactly the
moment this design cares about.** Verified: before suspending, the tree is
`run.root → execute → phase`. After the durable clock fires, replayed phases re-parent under
whichever fiber completed the deferred — in production, the gate-answer HTTP handler. A run that
suspends N times yields N+1 disconnected trace fragments with the pre-suspend spans duplicated in
each. So the earlier claim that both sinks carry one model is withdrawn:

- **The phase table is the authority.** It is the thing that is written once and joins on `run_id`.
- **Spans are a within-segment convenience.** Use span links rather than pretending the parent
  relationship survives a two-day gate, and never answer a question from spans that the phase row
  should answer.

One more thing to record before someone trips on it: `Tracer.Tracer` is a single-slot
`Context.Reference`, and every exporter installs by replacing it. There is no fan-out combinator.
This is harmless today, because Kojo's sink is a phase row rather than an Effect `Tracer` — but
building `SqliteTracer` as an Effect `Tracer` would silently lose it to whichever exporter is layered
last.

---

## 10. Testing

The payoff for the port indirection: a whole factory, no Docker, no tokens, deterministic.

```ts
const TestLayer = Layer.mergeAll(
  Roster.layerFromObject(fixtureRoster),
  InMemoryWorkspace.layer({ "src/health.ts": "export const ok = true" }),
  InMemoryAgentInvoker.layer({
    router:   { lane: "hotfix" },
    scout:    { status: "success", artifacts: ["notes.md"] },
    hotfixer: { status: "success", changedFiles: ["src/health.ts"] },
  }),
  InMemoryGate.layer({ approve: { choice: "approve" }, merge: { choice: "merge" } }),
  InMemoryTracer.layer,
)

it.effect("suspends at the approval gate and resumes on approve", () =>
  Effect.gen(function* () {
    // `discard: true`, never a bare execute — a suspending run never settles. See §3.
    const runId = yield* factory.execute(ticket, { discard: true })
    yield* settleThenAdvance(Duration.days(2))          // the helper below
    const phases = yield* InMemoryTracer.phases
    expect(phases.map((p) => p.name)).toEqual([
      "in_progress", "route", "scout", "hotfix", "approve", "test", "merge",
    ])
  }).pipe(Effect.provide(TestLayer)))
```

Three tiers, matching AGENTS.md. Unit and integration tests mirror the bounded-context paths
beneath `tests/unit/contexts` and `tests/integration/contexts`; each tier is its own Vitest project
and moon task.

| Tier | Layers | Catches |
|---|---|---|
| **Unit** | in-memory adapters only, `@effect/vitest` with `TestClock` | check logic, permission globs, envelope decode, correction text; whole workflows on a scripted `InMemoryAgentInvoker` (phase order, loop bounds, acceptance, trace shape); suspending, resuming, and expiring a run |
| **Integration** | real adapters — real invoker, `noSandbox()` or `docker()`, `ClusterWorkflowEngine` on `SingleRunner.layer()` over SQLite; and a no-SQL rung on `TestRunner.layer` | the Sandcastle boundary, image contents, session resume, suspension across a process restart. The `TestRunner` rung exercises message envelopes, entity mailboxes, and durable-clock wakeups, none of which `layerMemory` implements |
| **Browser** | the Console through `@playwright/test`, against in-memory `TraceReader` and `ArtifactReader` behind the real HTTP server | the user flows of the run UI — see [console.md §11](console.md) |

Unit tests never touch a real adapter; integration tests never touch an in-memory one. Nothing that
reads the wall clock or spawns a container belongs in a unit test — time goes through `TestClock`.

Durability is not a separate tier: suspending a run, resuming it, and expiring a gate are use
cases like any other, and their tests are ordinary unit tests. They run on
`WorkflowEngine.layerMemory` with in-memory adapters, and the `TestClock` is what makes deadlines
testable. This is verified, not hoped for: `DurableClock` reads the Effect `Clock` on both of its
paths, so **a seven-day durable sleep completes in 371 ms** of wall time after
`TestClock.adjust("7 days")`, and the whole §3 deadline mechanism resolves on both branches.
`it.effect` already provides `TestClock` in its `TestEnv`, so no explicit layer is needed.

**Kojo owns a `settleThenAdvance` helper, because the naive one-liner deadlocks.** Two ordering
hazards, both hit during the audit:

1. `TestClock.adjust` only releases sleeps registered *before* it runs. Advance before the workflow
   fiber has actually reached the durable sleep and the sleep parks for the full virtual duration —
   a seven-day sleep against a thirty-second vitest timeout.
2. After the deferred completes, the engine's own top-level poll is itself parked on the TestClock,
   so `Fiber.join` stays pending until one further bare `adjust`.

The helper is settle → advance → settle → advance, and every durability test goes through it. A
raw `TestClock.adjust` in a test is a bug waiting to be flaky.

The resume test is mechanical — suspend at each gate, resume, assert every activity ran exactly
once — and it cannot be skipped, because it is the only thing that catches a side effect placed
outside a phase, the sharpest edge in the system. Its sibling is the **duplicate-row test**: assert
one phase row per phase after a run that suspended twice, which is what catches the `onExit`
placement in §9.

Test `Permissions` table-driven against the upstream cases. Its `*` deliberately stops at `/`; a JS
glob library crosses `/` and silently widens every protected path.

---

## 11. CLI

`effect/unstable/cli` — `Command`, `Flag`, `Argument`, `Prompt`.

```
kojo init                        # agent, model, sandbox provider, template; builds the image
kojo run <workflow> [payload]    # [--sandbox docker|none|vercel] [--dry-run] [--wait]
kojo watch                       # drive runs from the configured Trigger
kojo runs                        # every run: id, status, open gate, deadline, tokens
kojo gate list                   # what is waiting on a human, and for how long
kojo gate answer <token>         # --decision approve|reject [--reason]
kojo phases <run-id>             # the phase table for one run
kojo tail <run-id>               # live occurrence stream
kojo ui                          # serve the Console
kojo doctor                      # node, docker, image, credentials, placeholder commands
```

`kojo gate list` and `kojo gate answer` are the reference `Gate` adapter, and the shape every other
adapter answers in. `--dry-run` assembles every layer, decodes the config, validates the roster, and
stops before the first spawn.

**`kojo run` does not block on a gate.** It starts the run with `{ discard: true }`, prints the run
id and where execution stopped — *suspended at gate `approve`, deadline in 47h* — and exits 0. A run
that suspends is a success, not a hang. `--wait` opts into polling until the run reaches a terminal
status, for scripts that genuinely want to block.

Four constraints the CLI framework imposes, worth knowing before the command tree is written:

- **`--approve | --reject` as two booleans is not enforceable.** There is no exclusivity combinator,
  and `--approve --reject` parses as both true. It is one `Flag.choice`, which is why the synopsis
  above changed.
- **Root flags need `Command.withSharedFlags`.** Flags declared in the root's own config are
  invisible to subcommands.
- **Five global flags are already taken**: `--help/-h`, `--version/-v`, `--wizard`, `--completions`,
  `--log-level`. Note `-v` is version, not verbose.
- **`Command.run` requires a `version`,** and a `Prompt`-driven `kojo init` leaks `Terminal.QuitError`
  under `run` — only `runWith` excludes it. `runWith` plus `Stdio.layerTest` is also the CLI's unit
  test seam, since argv is read from the `Stdio` service rather than `process.argv`.

Some of `kojo init` ships free: `Flag.withFallbackPrompt` turns a missing required flag into a
prompt, and `--wizard` builds an argv array interactively.

---

## 12. Build order

Each phase ends somewhere shippable. The ordering principle: **the contract and the durability
before the containers**, because those are what must be right and what can be tested for free.

| Phase | Deliverable | Done when |
|---|---|---|
| **0** Skeleton | package, `workflow()`, `code` phase, `InMemoryTracer` | `kojo run hello` prints a phase table |
| **1** Contract | `Envelope`/`Schema`, `AgentInvoker` + in-memory adapter, `agent` phase, correction loop, `Check` | a 3-phase chain runs green on scripted envelopes, in tests only |
| **2** Durability | `Gate` port + terminal adapter, `DurableDeferred` wiring, deadlines, `layerMemory` for tests and `ClusterWorkflowEngine` + SQLite for real, the suspend-and-resume unit tests | a run suspends, the process exits, `kojo gate answer` resumes it, nothing re-runs |
| **3** Ports | `Workspace` bind-mount adapter, `Permissions` with its glob tests, command blocks | `--sandbox none` runs a real agent on the host |
| **4** Sandboxed | the Sandcastle boundary, `sandboxed`, `kojoPi`, structured output | a lane with a mid-lane gate rebuilds its sandbox correctly on resume |
| **5** Factory | branch per run, acceptance-gated merge, compensation, `kojo init`, `kojo doctor` | a rejected run merges nothing and leaves branch and worktree intact |
| **6** Trace | `SqliteTracer`, spans, `gates`/`sandboxes` tables, `TraceReader`/`ArtifactReader`, the Console | `kojo ui` shows a live run, and a human answers a gate from the browser |
| **7** Triggers | `Trigger` port + manual adapter, `kojo watch`, idempotency | two triggers for the same ticket revision produce one run |
| **8** Reach | sandbox-exec workspace for Vercel/Daytona, parallel lanes, `.claude/skills/kojo/` | the showcase factory runs end to end on Kojo's own repo |

Phase 2 before phase 4 is the deliberate call. Suspension is the thing this design is *for*, it is
where the model can be structurally wrong, and it is fully testable with no container in sight.
Discovering at phase 6 that gates and sandboxes do not compose would invalidate everything built on
top of them.

### What the showcase exercised, and what it did not

Phase 8's own deliverable, and the honest half is the half that matters. Kojo's factory is in
[`.kojo/`](../../.kojo/README.md): a roster of five agents, a router, three lanes, one review gate,
one acceptance-gated merge. What follows is what was *watched*, and what was not.

**What ran, on this repository, with the Console open.** Seven runs of `.kojo/workflows/factory.ts`
against a scratch trunk branch — never `main`, never `feat/kojo-v1`. Four landed and three failed,
and one of the four landings was **discarded as evidence** rather than counted: it had succeeded for
the wrong reason, through the stale-module fault named below. Then seven more runs, by a second
person who built nothing, wrote their own stand-in and drove the committed factory cold; the row
below marked *re-walk* is theirs.

| | seen | evidence |
|---|---|---|
| routing selects a subgraph | yes | one run per lane; the `LANE` column of the phase table names `chore`, `hotfix`, `feature` and the phases under each differ |
| the lanes differ | yes | `chore` commits `chore:` and grades with lint + `knip`; `hotfix` commits `fix:`, asks a human **before** measuring, and grades with the typecheck alone; `feature` commits `docs:` then `feat:` and grades with typecheck + lint + unit |
| trigger to shipped, gates the only stop | yes | `kojo run` → suspend → answer → `kojo watch` applies → the trunk gains a `feat(kojo): merge the <lane> that ran as <run id>` merge commit carrying the agent's file |
| watched and answered from the Console | yes | the run view drew the waterfall over the scope tree (`host` / `route` / lane) and every gate below was answered in the browser, never on the command line |
| the three-state receipt is honest | yes | with no runner the card read *"Recorded — nothing is running"*; with `kojo watch` alive the same card read *"Recorded — applying…"* |
| acceptance is the single condition | yes | one run's typecheck was red, the maintainer rejected it, and `merge` failed in **0 ms** — it refuses before it runs a single git command |
| agent-facing skills are stamped | yes | `.claude/skills/kojo/` is in this repository and is byte-identical to what `kojo init` writes, asserted by `ownFactory.test.ts` |
| the permission guard undoes a real write | yes, *re-walk* | the planner wrote outside `.scratch/` and the run failed `PermissionBreach{agent: planner, scope: limited to .scratch/, path: docs/…, outcome: Deleted}` — the file was gone from the tree |
| a gate's asking limit is enforced | yes, *re-walk* | three rejections on the hotfix lane's in-lane gate ended the run `GateRejected`, carrying the last reviewer's own sentence rather than a wrapper's |
| the revise loop runs | yes, *re-walk* | rejected in the browser → the fixer revised → approved → typecheck clean; the waterfall showed *acquisition 1 of 3 … 3 of 3* with `revise` / `commit-revision` under the second |
| the post-gate worktree really is restored | yes, *re-walk* | the negative was checked too: `bun tsc --build` in a nested worktree with no `node_modules` fails `TS2307`, so the post-gate green was work and not a vacuous pass |
| a replayed failure records no phases | yes, *re-walk* | re-running a failed subject returned the recorded failure and *"no phases recorded"* |

**What a scripted stand-in cannot prove, and this is the line not to blur.** Every agent call above
was answered by a shell script on the child's `PATH` named like an agent binary — the repository
owner authorised five real agent calls for ticket 15 and three more for ticket 48, and the build spent
**nine**, two of them on a dogfood and a demo walk that no authorisation covered (the ledger, with the
method that counts it, is the table at the top of `tests/integration/cli/realAgent.test.ts`). A
stand-in proves the
factory, the durability, the trace, the Console and the merge. It does **not** prove a real model's
output surviving the envelope contract across many runs: no decode failure was repaired, no
`corrections` counter advanced, and no routing decision was a judgement call — the stand-in reads a
marker out of the request. Criterion 2's *taxonomy* is proven; the *classifier* is not.

The re-walk sharpened that limit into something stronger than "not exercised": **the correction turn
is unreachable with any stand-in at all.** A repair *resumes the captured provider session*, so when
the re-walk deliberately made its agent claim a file it had never written, the checks fired and the
phase failed correctly — and then the repair attempt died as `AgentInvocationError{provider-failed,
resumeSession "…" not found under ~/.claude/projects}`. `CheckViolation`- and
`EnvelopeParseError`-driven repair, and therefore the `corrections` counter, can only ever be proven
by a real agent call. Two of those were bought earlier and are pinned in
`tests/integration/cli/realAgent.test.ts`, where they are skipped unless the budget is re-opened.

**Ticket 48 re-opened it for three calls and spent two, and this half of the paragraph is now
bought.** What a real model settled, quoted from the surviving session transcript rather than
inferred:

| the claim | bought? | what the transcript says |
|---|---|---|
| a real answer fails the envelope contract | yes | the drafter answered a valid `Drafted` whose `risk` held a sentence, and the decoder refused it: `risk: Expected "low" \| "medium" \| "high"` |
| the correction is built from the issue tree, not a generic retry | yes | the second prompt in the session is Kojo's own: *"Your last answer was not a valid `Drafted`… These fields are wrong: - risk: Expected …"* — the field named, with the words it wanted |
| the repair re-enters the same conversation | yes | **one** session file under `~/.claude/projects/`, two top-level prompts, one `sessionId` — the repair was a second turn, not a cold start |
| the repair returns an envelope that decodes | **no** | the repair rewrote the sentence with the expected literal moved to the front — `"low — this is a one-line text addition to notes/hello.txt…"` — which is a prefix and not the value, so `withCorrections` exhausted its bound and the phase failed `EnvelopeParseError` |

The last row is a finding rather than an omission, and it is the one worth carrying: **a correction
turn moves the answer, but it does not fully escape the context that caused the fault.** The fault was
provoked by a standing rule in the factory's own task template ("a single bare word is not a risk
note"), repeated by the run's own subject; the repair re-enters a conversation that still holds both,
so the model tried to obey the rule and the correction at once and produced something valid only as a
prefix. It failed by a hair, not by stubbornness — which is why the correction is not the useless half
of the loop, and why the first remedy to try is a change to **Kojo** rather than to the fixture:
`correctionFor` reports the expected *type* of a literal field and never says the value must **equal**
one of the listed words with nothing before or after it. Closing that gap is untested and is what the
next real calls should buy; loosening the fixture's prompt, and raising the bound, rank behind it.
Design a decode failure that a *correction* can undo, not merely one that a *prompt* can cause.

The design, the rehearsal that costs nothing, and the exact spend are in
`tests/support/riskNote.ts`, `tests/integration/cli/correctionLoop.test.ts` and ticket 48.
The re-walk also learned why the classifier cannot be faked: its first attempt classified on keywords
and mis-routed, because the router's **own system prompt names every symptom of every lane**. A
stand-in either reads a marker or is a coin toss.

**Three defects the dogfood found, all of which one walk of a stamped starter could not.** Each is
fixed, and each is the kind that only appears in a repository that already has opinions.

1. **A repository's own git hooks run inside the `commit` and `merge` phases.** Kojo enforces
   Conventional Commits on `commit-msg`, the `commit` phase puts the agent's own summary on the
   commit — *agents propose, code disposes* — and `cog verify` refused it. Worse, git runs
   `commit-msg` on a **merge** commit too, so `Merge branch 'kojo/<id>'` would have refused the last
   step of a run that everything else had already accepted, leaving the target mid-merge. `merge`
   gained an optional `message`; the lanes name their own commit type in `conventional`.
2. **A recorded phase replays its result; it does not replay its effect on the environment.**
   `install` was a `code` phase. The hotfix lane suspended at its in-lane gate, the scope tore the
   worktree down, the answer arrived, the body replayed — and `install` returned its recorded string
   without running, so `verify` typechecked a worktree with no `node_modules` and reported a red
   typecheck about a change that was fine. **Dependency restoration is a `SandboxHooks` entry, not a
   phase**, because a hook runs on every acquisition. Only a lane with a gate *inside* it can find
   this, which is why phase 4's own done-when names that shape.
3. **One run leaves a whole copy of the repository under `.sandcastle/worktrees/`.** Sandcastle
   derives that path itself and `CreateSandboxOptions` has no override. It self-ignores for git, but
   not for tools that read only the root ignore file: `bun biome check .` died on *"Found a nested
   root configuration"* — and `bun biome check .` is the `lint` command two of the three lanes grade
   a change with. The root `.gitignore` now covers it, exactly as it already covered
   `.claude/worktrees`.

**Four faults the independent re-walk found, all of them in the last mile.** None is in the engine's
behaviour; every one of them stopped a newcomer who had only the documentation. All four are fixed.

1. **`kojo doctor`'s own printed remedy damaged the factory it was diagnosing.** The `credentials`
   failure said *"Run `kojo init` again to stamp it"*, and `.kojo/README.md` said the same. Following
   it literally in this repository was measured: `init` keeps every file you edited, but it also
   writes the ones it thinks are missing — **8 written, 7 kept** — which here means the two files
   `.kojo/README.md` says at length this factory deliberately does *not* have, prompts for two agents
   the roster does not carry, and a second workflow `.kojo/workflows/hotfix.ts` importing an envelope
   `envelopes.ts` does not export. `doctor` then went from one failed check to **two of 14**, the new
   one being `workflows — Export named 'Scouted' not found`, which cascaded into `payload` and
   `layers` skipping. A newcomer who followed the advice ended with a factory that could not run and
   nothing telling them to delete seven files. The remedy now names the variable and says to write it
   or export it, and warns against re-stamping; `.kojo/README.md` carries the same correction.
2. **`kojo` is not on the `PATH`.** Every code block in the stamped skill and in `.kojo/README.md`
   read `kojo …`, while the binary is `node_modules/.bin/kojo`. Both now say so.
3. **Nothing said that `kojo watch` and `kojo ui` never exit** — and the skill taught the opposite
   lesson, *"do not hold the terminal open waiting"*, about `kojo run`, the one command that does
   return. This is what killed the first attempt at this ticket: it stalled for six consecutive
   180-second windows and was destroyed after two hours. Also recorded: `--sweep <n>` is the seconds
   *between* sweeps and does not bound the command. Both documents now say it, at the top.
4. **`kojo ui` needs a front end this repository does not commit.** `packages/kojo/console` is
   `console:build`'s output and is git-ignored, so on a fresh clone `kojo ui` serves the API and a
   placeholder. That the server resolves the directory once at startup — so a build under a running
   server changes nothing until it is restarted — is deliberate and reasoned in `shell.ts`; what was
   missing was anyone saying it. The placeholder page now names the remedy, since that page is what
   the person is actually looking at, and `.kojo/README.md` gives the exact command.

**Two more the re-walk named, left as follow-ups.** `forbidden = "main"` has never executed and
currently cannot: `main` holds no `.kojo/workflows/`, so a run started there is refused as *"unknown
workflow: factory"* before the `target` phase exists — correct code on an unreachable path. And the
`route` and lane `sandboxed` scopes report the **same** `.sandcastle/worktrees/kojo-<run id>` path,
where `factory.ts` reasons at length about a resume rebuilding *two* worktrees; the cost is real and
visible as two acquisitions per resume, but it is not two trees.

**Three things left standing, named rather than fixed.**

- **`kojo doctor` fails Kojo's own factory on a credential file nothing at run time reads.** The
  `credentials` check wants `.kojo/.env` to exist and to set a non-empty variable. Nothing in the
  engine reads that file: `SandcastleAgentInvoker` passes no `env` at all and the agent binary
  authenticates with the operator's ambient session, which is the property
  `realAgent.test.ts` asserts against a real recorded run. So on a fresh clone Kojo's own factory is
  *"not ready — 1 of 14 checks failed"* until a maintainer writes an untracked `.env` the run then
  ignores. The check is right for a containerised factory and wrong here, and the fix is a way for a
  factory to declare that it needs no credential — which is a design decision, not a patch.
- **A runner holds the workflow module it loaded when it started.** Editing `.kojo/` while a run is
  suspended means the process that resumes it may run different code than the process that started
  it. One landing during this ticket did exactly that — the starting process had no `install` phase
  and the watcher, older by two commits, ran one — and the run succeeded for the wrong reason. It
  was re-run with one version everywhere before anything was claimed. Nothing warns about this
  today.
- **No lane of this factory can grade the factory.** `.kojo/` is deliberately outside
  `bun tsc --build` — `tsconfig.json` there explains why at length — and `bun tsc --build` is exactly
  the `typecheck` command every lane runs. The linter does reach these files, and
  `ownFactory.test.ts` typechecks them, but that test is in the integration tier, which
  `commands.ts` deliberately excludes as too slow to grade a run with. So a change that breaks
  `.kojo/`'s own **types** passes typecheck, lint and unit and lands. The factory grades the
  repository and not itself.

**Not exercised at all.** Span export (ticket 31, **closed wontfix** on 2026-08-13 by the repository's
owner — it blocked nothing through seventeen waves, and the claim it was written under was withdrawn
when §9 demoted spans to a within-segment convenience and made the phase table the authority; a
suspension re-parents replayed spans, so export would have shipped disconnected fragments beside a
record that already answers every question. Reopening it means `OtlpTracer` plus span links, and the
ticket says so). A container provider for Kojo's own
factory — it runs `noSandbox()`, deliberately, because the integration tier drives Docker itself and
docker-in-docker is not a trade worth making here; so the `hooks.sandbox.onSandboxReady` slot that a
containerised factory would restore dependencies through is untested by this showcase. Parallel
lanes. The `feature` lane's review-failure loop back to the *planner*, which architecture.md §3
draws and `.kojo/` does not implement: only the hotfix lane loops, and `reviewed` is what makes that
one safe.

### Where the build stopped

Forty-eight tickets: forty-seven landed, ticket 31 closed wontfix. Unit **582**, integration **252**
(3 skipped, all named), browser **91**. Kojo stamps a factory into a repository and drives that
factory in this one.

**What is proven, and by what.** A run is an Effect program over four primitives; it cuts a branch,
runs phases in a sandbox scope, decodes each agent answer against a `Schema`, grades it against the
repository, suspends on a human and resumes where it stopped, undoes a write an agent was not permitted
to make, merges behind an acceptance gate, and leaves one wide row per unit of work that the Console
reads back as a waterfall. Every one of those has a test, and the load-bearing ones were confirmed by
mutation — the mechanism removed, the test seen to redden — rather than by reading the assertion. The
parts only a real walk could settle were walked twice, the second time because the first walk's claims
did not all survive checking. Two limits on the words above: a multi-day suspension is proven against
`TestClock`, not against a calendar (a seven-day sleep completes in 371 ms of wall time, and the
durability the calendar would test is the branch plus the row, both of which survive process death);
and the agent answers behind most of it came from scripted stand-ins, not models.

**What is not.** The correction loop is proven for three of its four claims against a real model and
**not** for the fourth: no repaired answer has ever decoded, so no `corrections` counter has been read
off a *succeeded* phase. That gap cannot be closed by a stand-in — a repair resumes the captured
provider session — and it is the single most load-bearing unproven thing here, because the loop is
what makes a typed envelope survive a model that answers in prose. The router's *classifier* is
likewise unproven: its taxonomy is graded, its judgement is not. No container provider runs Kojo's own
factory, no lanes run in parallel, and the `feature` lane's loop back to the planner is drawn but not
built.

**And one thing to distrust.** This build corrected roughly one overstated proof per wave, including
in the wave that wrote this paragraph — the correction-loop finding above was measured, written down
wrongly, committed, and only caught because an auditor re-read the transcript rather than the report.
Where this document says *measured*, a command or a transcript is named. Where it does not, read it as
an argument.
