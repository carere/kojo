# Kojo

Kojo is a delivery workflow factory. The same executable can run a workflow directly or expose a
server for issue-tracker webhooks and the visualizer.

## Projects

- `apps/cli`: Bun and Effect executable with `serve` and `delivery` commands
- `apps/visualizer`: SolidJS SPA using TanStack Router, TanStack Query, Tailwind CSS, and Zaidan
- `packages/domain`: runtime-independent domain models and typed HTTP contracts

## Tooling

The workspace uses Bun, Moon, Proto, TypeScript, and Biome.

Install the toolchain and dependencies:

```sh
proto install
bun install
```

Run the server for a project:

```sh
moon run cli:serve -- .
```

In another terminal, run the visualizer:

```sh
moon run visualizer:dev
```

The visualizer is available at `http://localhost:5173` and checks the server through the typed
`GET /api/health` contract.

Run the workspace checks:

```sh
moon run :check
moon run :tsc
moon run :test
```

The `delivery` command is present as the direct invocation surface. Its workflow will be populated
when the Sandcastle customization is extracted:

```sh
moon run cli:delivery -- .
```

