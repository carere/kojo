# `@kojo/workflow`

The supported authoring boundary for repository-local Kojo Developer Workflows. It publishes ESM
JavaScript, declarations, and source maps from this package root. Deep imports, CommonJS builds,
raw TypeScript runtime files, and Kojo runtime or persistence internals are not supported.

```ts
import { Effect, Schema } from "effect";
import { Schedule, Workflow, defineConfig } from "@kojo/workflow";
import { Cron } from "effect";

export const Hello = Workflow.make("Hello", {
  version: "first-release",
  entryPoint: "workflows/hello.ts",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({ message: Schema.String }),
  failure: Schema.Never,
  run: ({ name }) => Effect.succeed({ message: `Hello, ${name}` }),
});

const MorningHello = Schedule.make("MorningHello", {
  workflow: Hello,
  input: { name: "Kojo" },
  cron: Cron.parseUnsafe("0 9 * * *"),
  timezone: "Europe/Paris",
  missedTimePolicy: "skip",
});

export default defineConfig({
  workflows: [Hello],
  schedules: [MorningHello],
});
```

## Durable composition

`Loop.run` requires an explicit stable name and a positive `maxIterations`. Its body receives a
one-based `iteration` and the previous successful value. `repeatWhile` decides whether to continue;
when it remains true at the limit, the Loop fails with `Loop.MaximumLimitReached`. Nested Loop
names and iterations become part of every Activity's durable identity.

```ts
const verified = yield* Loop.run("implement-and-verify", {
  maxIterations: 3,
  effect: ({ iteration, previous }) => implementAndVerify({ iteration, previous }),
  repeatWhile: (result) => !result.verified,
});
```

`ActivityRetry.run` retries an Effect Workflow Activity only when its typed `while` predicate
selects the failure. `maxAttempts` includes the initial attempt. Every attempt keeps one logical
identity and idempotency key, receives a new ordinal, and waits through a named durable backoff.
Replay consumes the same total budget and preserves the final Typed Failure at exhaustion.

```ts
const receipt = yield* ActivityRetry.run(publishActivity, {
  maxAttempts: 3,
  while: (failure) => failure._tag === "TemporarilyUnavailable",
  backoff: ({ ordinal }) => `${ordinal * 5} seconds`,
});
```

Use Effect Workflow's `withCompensation` for Compensation. Durable Activities used by its
finalizers retain ordinary journal identity and evidence, run idempotently in reverse registration
order after terminal failure, and are not a separate Kojo primitive.

Invoke another registered Developer Workflow with an author-chosen stable key to create a Child
Workflow Run:

```ts
const result = yield* child.run("ticket-35", input);
```

Kojo binds that key within the parent's current durable path. Replay rejoins the same Child Run ID
and rejects changing its input or Developer Workflow. The child retains its own state, result, and
Execution Evidence while its success, Typed Failure, or Defect uses the parent's ordinary Effect
channels. Completed children are immutable and are never reopened for parent Compensation.

## Reusable Sandboxes

`Sandbox.use` scopes one process-local Sandcastle Sandbox to a stable name and Git branch.
`Agent.run` and `Command.run` inside that scope share the same live handle. On restart Kojo checks
the durable Runtime Configuration Snapshot before opening a fresh Sandbox for the same branch.
The handle, provider object, and credentials are never durable values. Only committed Git work is
guaranteed to survive; cleanup evidence identifies retained dirty work and cleanup failures, and a
hard crash can leave an orphan because Sandcastle has no public reopenable identity.

Sandbox and Agent Providers are replaceable Effect services. Their public metadata contains a
stable name, adapter version, explicitly safe scalar fields, and a fingerprint of all remaining
non-secret configuration (plus the Agent model when one applies). The CLI supplies a local Docker
Sandbox Provider only as a fallback when a workflow does not replace it. Secrets must be resolved
while constructing a provider and must not be copied into any durable schema or public metadata.

`SandboxProvider.layer` accepts Sandcastle's `SandboxProvider` interface directly. Docker, Podman,
Vercel, no-sandbox, and providers returned by `createBindMountSandboxProvider` or
`createIsolatedSandboxProvider` therefore follow the same path; Kojo does not switch on a provider
name or copy provider-specific settings. The Project Runtime adds the registered Project path when
it calls `createSandbox`.

```ts
import { createIsolatedSandboxProvider } from "@ai-hero/sandcastle";
import { Effect } from "effect";
import { Sandbox, SandboxProvider } from "@kojo/workflow";

const provider = SandboxProvider.layer({
  sandbox: createIsolatedSandboxProvider({
    name: "company-cloud",
    create: openCompanySandbox,
  }),
  configuration: {
    adapterVersion: "company-cloud@1",
    configurationFingerprint: "non-secret-behavior-v1",
    name: "company-cloud",
    publicFields: { region: "eu-west" },
  },
});

const step = Sandbox.use("ticket", {
  branch: "ticket/42",
  effect: Effect.void,
}).pipe(Effect.provide(provider));
```

`AgentProvider.layer` likewise accepts any object implementing Sandcastle's `AgentProvider`,
including every built-in agent and custom implementations. It also accepts `makeAgent` plus a
`secrets` Effect when an Agent Provider needs credentials. That Effect resolves redacted values
when the provider layer is acquired, and `makeAgent` receives plain strings only at the
process-local Sandcastle construction boundary. The layer may be supplied to a whole workflow
scope or directly to one `Agent.run`, so separate Agent Steps in one Sandbox can use different
providers without making the CLI choose an agent or model. Custom providers that have no model may
omit model metadata.

`Agent.run(name, { prompt, success, failure })` asks the Agent to return a structured
`{ _tag: "Success", value }` or `{ _tag: "Failure", failure }` result in a tagged JSON block and
validates the selected value with the author schema. A controlled adapter may return that value
directly; the Sandcastle adapter extracts it from the reusable Sandbox's stdout. Its durable result
retains commits and finalized, redacted transcript artifact references. Agent evidence records the
logical Step and attempt with only the provider name, model, and adapter version; provider objects,
credentials, secret-derived fingerprints, and transcript text are not rendered into Agent evidence
or traces. The separate Runtime Configuration Snapshot retains the explicitly non-secret
configuration fingerprint used for compatibility checks.

`Command.run` schema-checks `{ exitCode, stdout, stderr }`. A nonzero exit code is observed data;
workflow policy decides whether it is a failure. Rejected executions are typed
`Command.ExecutionFailed` values and may use the command's `retry` option for durable Activity
Retry. Standard output and error are finalized as fingerprinted immutable Execution Artifacts and
referenced by command evidence.

The default export of the nearest repository-root `kojo.config.ts` must synchronously call
`defineConfig` with explicitly imported definitions. `defineConfig` performs no I/O and validates
the whole registry before returning it.

## Workflow Acceptance Tests

`WorkflowTest` runs a `Workflow.make` definition through an in-memory durable engine. Supply an
Effect Layer with controlled Agent, Sandbox, Command, Git, or GitHub adapters and wrap their public
operations with `WorkflowTest.call`. The result exposes the typed outcome, Workflow Run State,
normalized Execution Evidence and Trace, and the observed calls.

For Child Workflow acceptance tests, pass the root snapshot as
`WorkflowTest.make(parent, { workflows: [child] })`. Every returned run has `children`; each node
contains only its own evidence, so the complete Workflow Run Tree remains inspectable without
copying child evidence into its parent.

```ts
import { expect, test } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Delivery, GitHub } from "./delivery";
import { WorkflowTest } from "@kojo/workflow";

test("loads open work without publishing it", async () => {
  const controlledGitHub = Layer.succeed(GitHub, {
    load: (url) =>
      WorkflowTest.call(
        { input: { url }, layer: "GitHub", operation: "load" },
        Effect.succeed({ tickets: [] }),
      ),
  });
  const fixture = WorkflowTest.make(Delivery, {
    clock: "2026-07-20T12:00:00.000Z",
    ids: ["run-result-id"],
    layer: controlledGitHub,
  });

  const result = await fixture.run({ workstream: "https://github.com/example/project/issues/1" });

  expect(result.state).toBe("Completed");
  WorkflowTest.assertCalls(result, {
    required: [{ layer: "GitHub", operation: "load" }],
    forbidden: [{ layer: "GitHub", operation: "close" }],
  });
});
```

Use `run(input, { interruptAfter })` and `restart()` to test replay with the same in-memory journal.
Use `uncertain` to inject an external action whose effect happened without a durable result.
`WorkflowTest.normalize` replaces generated identifiers and timestamps and can omit named plumbing
fields such as SQL or Fiber details while preserving behavioral subjects and event details. Keep
real SQLite, Git, Sandcastle, artifact, and HTTP implementations in their adapter contract tests;
live model quality is not a Kojo test target.

## Supported matrix

The initial exact matrix is Kojo `0.1.0`, Workflow ABI `1`, Effect and `@effect/platform-bun`
`4.0.0-beta.98`, Bun and `@types/bun` `1.3.14`, and TypeScript `7.0.2`. Effect is an exact peer
dependency so the repository and `@kojo/workflow` resolve one Effect instance.
