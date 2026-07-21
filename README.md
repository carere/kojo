# Kojo

Kojo is a software-factory builder. Its project-local CLI controls one Kojo System Process for a
Kojo Home and runs Developer Workflows.

## Projects

- `apps/cli`: Bun and Effect executable with system lifecycle, `serve`, and `delivery` commands
- `apps/visualizer`: SolidJS SPA using TanStack Router, TanStack Query, Tailwind CSS, and Zaidan
- `packages/domain`: runtime-independent domain models and typed HTTP contracts

## Development

Install [proto](https://moonrepo.dev/docs/proto/install) and [cocogitto](https://docs.cocogitto.io/#installation)
and verify that they are available in your `PATH`:

```sh
proto --version && cog --version
```

Install the monorepo toolchain:

```sh
proto install
```

Install the monorepo dependencies:

```sh
bun install
```

## Launch apps

Control the Kojo System Process with `start`, `stop`, `restart`, `status`, and `logs`. The commands
return versioned JSON and are safe to repeat. `KOJO_HOME` may select an absolute Kojo Home path; it
defaults to `~/.kojo`.

```sh
bun run apps/cli/main.ts start
bun run apps/cli/main.ts status
bun run apps/cli/main.ts logs
bun run apps/cli/main.ts restart
bun run apps/cli/main.ts stop
```

The System Process uses an owner-only private local socket and is the sole normal owner of
`KOJO_HOME/state.sqlite`. These commands do not install an operating-system login service.

Start the Dense Inspector gateway for the local System Process:

```sh
moon run cli:serve
```

In another terminal, run the visualizer:

```sh
moon run visualizer:dev
```

The visualizer is available at `http://localhost:5173`. It reads aggregate Workflow Runs and
source-independent Execution Evidence through the gateway's read-only System Process API.

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
