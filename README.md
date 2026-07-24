# Kojo

Kojo is an open-source software factory.

This repository contains the foundation for the next Kojo implementation.

## Projects

- `apps/cli`: a Bun CLI built with Effect
- `apps/visualizer`: a SolidJS SPA built with Vite, TanStack, Tailwind CSS, and Zaidan

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

## Quality checks

```sh
moon run :check
moon run :tsc
moon run :test
moon run :build
```

Use `moon run :fix` to apply safe Biome fixes.

## Components

The visualizer is configured to consume components from the Zaidan registry:

```sh
moon run visualizer:zaidan-add -- @zaidan/<component>
```
