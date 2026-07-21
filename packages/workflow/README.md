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

The default export of the nearest repository-root `kojo.config.ts` must synchronously call
`defineConfig` with explicitly imported definitions. `defineConfig` performs no I/O and validates
the whole registry before returning it.

## Workflow Acceptance Tests

`WorkflowTest` runs a `Workflow.make` definition through an in-memory durable engine. Supply an
Effect Layer with controlled Agent, Sandbox, Command, Git, or GitHub adapters and wrap their public
operations with `WorkflowTest.call`. The result exposes the typed outcome, Workflow Run State,
normalized Execution Evidence and Trace, and the observed calls.

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
