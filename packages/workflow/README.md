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

## Supported matrix

The initial exact matrix is Kojo `0.1.0`, Workflow ABI `1`, Effect and `@effect/platform-bun`
`4.0.0-beta.98`, Bun and `@types/bun` `1.3.14`, and TypeScript `7.0.2`. Effect is an exact peer
dependency so the repository and `@kojo/workflow` resolve one Effect instance.
