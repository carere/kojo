# Kojo

Kojo is an open-source software factory.

This repository contains the foundation for the next Kojo implementation.

## Projects

- `apps/cli`: a Bun CLI built with Effect
- `apps/visualizer`: a TanStack Start SolidJS app using SPA mode, Tailwind CSS, and Zaidan

## Development

Install [proto](https://moonrepo.dev/docs/proto/install) and
[Cocogitto](https://docs.cocogitto.io/#installation), then verify that they are available:

```sh
proto --version
cog --version
```

Install the monorepo toolchain and dependencies:

```sh
proto install
bun install
```

Run the CLI:

```sh
moon run cli:dev
```

Run the visualizer:

```sh
moon run visualizer:dev
```

The visualizer is available at `http://localhost:5173`.

TanStack Start renders the browser application as an SPA while keeping its Bun server available.
One wildcard server route forwards `/api/*` requests to the Effect API in
`apps/visualizer/src/contexts/shared/server`.

The API uses Effect RPC over HTTP with NDJSON serialization. Its typed client and server share the
contract in `apps/visualizer/src/contexts/shared/models/contracts.ts`. The initial `Health`
procedure is available through `POST /api/rpc`; future database reads and log streams can be added
to the same RPC group. Cross-origin browser requests are rejected.

Use the application-lifetime browser client like this:

```ts
import { Effect } from "effect";
import {
  VisualizerApiClient,
  visualizerApiRuntime,
} from "./contexts/shared/services/client";

const health = await visualizerApiRuntime.runPromise(
  Effect.gen(function* () {
    const client = yield* VisualizerApiClient;
    return yield* client.Health();
  }),
);
```

The Bun server creates one lazy Effect web handler for the process. Effect runs each request in its
own scope, and the handler is disposed during development hot reloads.

## Internationalization

Paraglide uses the shared Inlang project in `project.inlang` and the English and French source
messages in `messages`. The Visualizer Vite plugin compiles its generated, untracked runtime to
`apps/visualizer/src/i18n`.

Add or change translations in the root `messages` files. Do not edit the generated `src/i18n`
folder.

## Quality checks

```sh
moon run :check
moon run :tsc
moon run :test
moon run :integration-test
moon run :browser-test
moon run :build
```

Use `moon run :fix` to apply safe Biome fixes.

CLI and Visualizer tests run with Vitest under Bun:

- Unit tests exercise Effect use cases with in-memory services.
- Integration tests exercise real adapters and the Effect RPC boundary.
- Visualizer browser tests use Vitest Browser Mode with Playwright and Chromium.

Effect-based unit and integration tests use `@effect/vitest`. The default `test` task runs unit
tests; integration and browser tests have dedicated Moon tasks.

## Components

The visualizer is configured to consume components from the Zaidan registry:

```sh
moon run visualizer:zaidan-add -- @zaidan/<component>
```
