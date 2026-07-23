# Sandcastle provider and Effect configuration API boundaries

> Primary-source research for “Define Sandcastle provider, agent, and secret configuration.”
> Sandcastle upstream `main` and Kojo's pinned Effect `4.0.0-beta.98` were inspected on
> 2026-07-18. This note records API facts, not a Kojo product decision.

## Sandcastle

Sandcastle's selection APIs are constructed values, not global settings:

- A sandbox provider is an object returned by a provider factory such as `docker()`, `podman()`,
  `vercel()`, `noSandbox()`, or a custom provider factory. It is passed as the `sandbox` property;
  provider-specific settings belong in the factory call, for example `docker({ imageName, mounts,
  env })`. Sandcastle documents Docker and Podman as bind-mount providers, Vercel as isolated, and
  `noSandbox()` as explicitly bypassing isolation
  ([provider table and examples](https://github.com/mattpocock/sandcastle/blob/main/README.md#sandbox-providers)).
- An agent provider is an `AgentProvider` object returned by a factory such as
  `claudeCode(modelString, options)`, `codex(modelString, options)`, `pi(modelString, options)`,
  `cursor(modelString)`, `opencode(modelString)`, or `copilot(modelString)`. Thus the model is a
  string argument to an agent-provider factory; the value supplied to a run is the resulting
  provider object
  ([`RunOptions`](https://github.com/mattpocock/sandcastle/blob/main/README.md#runoptions),
  [provider options](https://github.com/mattpocock/sandcastle/blob/main/README.md#claudecodeoptions)).
- The accepted value is the structural `AgentProvider` interface, not a closed union of built-in
  agents. A custom implementation supplies its command construction and stream parsing behavior
  directly, and the interface itself does not require model metadata
  ([`AgentProvider`](https://github.com/mattpocock/sandcastle/blob/main/src/AgentProvider.ts)).

`createSandbox()` does **not** select an agent or model. Its documented arguments are:
`branch` and `sandbox` (required), plus `cwd`, `hooks`, `copyToWorktree`, and `timeouts`. The returned
reusable sandbox receives an `AgentProvider` later on each `sandbox.run({ agent, ... })`, so one warm
sandbox can run different agent/model provider objects in sequence
([`CreateSandboxOptions` and `SandboxRunOptions`](https://github.com/mattpocock/sandcastle/blob/main/README.md#createsandbox--reusable-sandbox)).

Sandcastle accepts environment values as plain `Record<string, string>` options on both agent and
sandbox providers. Provider values override `.sandcastle/.env` values; agent-provider and
sandbox-provider records may not contain the same key; and Sandcastle also resolves
`.sandcastle/.env` plus `process.env` automatically. There is no secret wrapper in this API boundary
([provider `env`](https://github.com/mattpocock/sandcastle/blob/main/README.md#provider-env)).

## Effect v4 configuration and runtime services

Kojo currently pins Effect `4.0.0-beta.98` ([lockfile](../../bun.lock)). In that version:

- `Config<A>` is itself an `Effect<A, ConfigError>` and a typed description of how to load and
  validate a value. `Config.all` builds a typed record/tuple, `Config.withDefault` supplies a value
  only for missing data (not malformed data), and `Config.orElse` catches any `ConfigError`
  ([`Config`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/Config.ts#L51-L89),
  [`all`, `withDefault`, and `orElse`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/Config.ts#L329-L557)).
- The active `ConfigProvider` is a `Context.Reference` whose default value is `fromEnv()`.
  `fromEnv()` reads `process.env` and `import.meta.env` unless given an explicit record.
  `ConfigProvider.fromUnknown()` makes an in-memory provider from an object
  ([context reference](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/ConfigProvider.ts#L260-L307),
  [`fromUnknown` and `fromEnv`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/ConfigProvider.ts#L945-L1100)).
- Provider composition is ordered. `ConfigProvider.orElse(primary, fallback)` consults the fallback
  only when the primary returns “not found”; a source failure is not swallowed.
  `ConfigProvider.layer(provider)` replaces the active provider. `layerAdd(provider)` adds it as a
  fallback by default, while `{ asPrimary: true }` puts it ahead of the active provider
  ([`orElse`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/ConfigProvider.ts#L416-L500),
  [`layer` and `layerAdd`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/ConfigProvider.ts#L829-L927)).
- Runtime dependencies are represented by `Context.Service` keys (or `Context.Reference` when a
  default is appropriate). `Layer.succeed` provides an already-built service; `Layer.effect`
  constructs one effectfully; `Layer.mergeAll` combines independent layers; `Layer.provide` feeds
  dependency layers into a layer and keeps those dependencies private; `provideMerge` retains both
  outputs
  ([`Context.Service`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/Context.ts#L99-L241),
  [`Layer` constructors](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/Layer.ts#L930-L1069),
  [`Layer.provide`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/Layer.ts#L1841-L1986)).

These APIs permit CLI-supplied values to become either a composed `ConfigProvider` or an ordinary
runtime service layer. They also permit an effectful secret resolver to be a `Context.Service` and
to be supplied as a dependency of the code that constructs the plain-string Sandcastle `env`
record. Which precedence and service shapes Kojo should choose remains a product decision.

## Redacted values and durable Workflow boundaries

Effect v4 exposes `Redacted`, not the former `Secret` module. `Config.redacted(name)` yields a
`Redacted<string>`. A `Redacted` value prints and serializes through ordinary JavaScript inspection
as a placeholder, but it still retains the original value in memory and trusted code can recover it
with `Redacted.value`; it is explicitly not cryptographic protection
([`Config.redacted`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/Config.ts#L1453-L1486),
[`Redacted`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/Redacted.ts#L1-L217)).

The important persistence caveat is that redaction and non-encoding are separate:

- `Schema.Redacted(inner)` hides validation detail and normal inspection, but its JSON codec
  unwraps the value during encoding by default.
- `Schema.Redacted(inner, { disallowJsonEncode: true })` forbids JSON encoding.
  `Schema.RedactedFromValue(inner, { disallowEncode: true })` likewise forbids encoding after
  wrapping a raw value
  ([schema implementation](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/Schema.ts#L8925-L9088)).
- `Config.redacted(name)` uses `Schema.Redacted(Schema.String)` without the encoding prohibition.
  It protects logs and inspection; by itself it does not prove that a value cannot enter durable
  storage.

Effect Workflow makes the persistence-sensitive boundaries explicit: a `Workflow` declares schemas
for payload, success, and error, and an `Activity` schema-encodes its success or failure for durable
execution
([`Workflow.make`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/unstable/workflow/Workflow.ts#L422-L458),
[`Activity.make`](https://github.com/Effect-TS/effect-smol/blob/effect%404.0.0-beta.98/packages/effect/src/unstable/workflow/Activity.ts#L111-L162)).
Consequently, any secret copied into a workflow payload, workflow result/error, activity
result/error, durable deferred value, or other schema-encoded durable value is within a persistence
boundary. A `Redacted` wrapper does not change that unless its schema forbids encoding.

Conversely, `Context` services and `Layer` construction are runtime dependency-injection values,
not Workflow payload/result schemas. Resolving a secret through a runtime service immediately before
constructing Sandcastle's plain-string `env` record avoids placing the value in a Workflow schema;
the durable state can carry only non-secret selection data or a resolver reference. This is an API
boundary fact, not a guarantee against separate leaks through agent output, Sandcastle logs/session
capture, process inspection, or application evidence.
