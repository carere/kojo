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

## Run Kojo on this repository

The root `kojo.config.ts` registers a small `Hello` Developer Workflow that opens a local Docker
Sandbox and prints `Hello from Kojo`. The self-host registry imports the in-repository workflow API
source so an immutable checkout tests the exact Kojo code being developed. Build the default
Sandbox image before starting Kojo:

```sh
bun run test:self-host
bun run sandbox:build
```

Use an isolated Kojo Home for the self-hosting smoke test. Project source activation reads the
local default branch, so the Kojo configuration and workflow must be committed there before the
Project can be enabled.

```sh
export KOJO_HOME=/tmp/kojo-self-host
bun run apps/cli/main.ts start
bun run apps/cli/main.ts project add "$PWD"
bun run apps/cli/main.ts project list
bun run apps/cli/main.ts project enable <project-id>
bun run apps/cli/main.ts workflow start <project-id> Hello --input '{}'
bun run apps/cli/main.ts workflow inspect <run-id>
```

After the Project is enabled, add `--from-checkout` to `workflow start` to freeze and run current
dirty and untracked workflow source.

Kojo's reference delivery automation is a repository-local Developer Workflow. Its acceptance tests
exercise delivery, review, interruption recovery, publication, and finalization through Kojo's
workflow authoring API:

```sh
moon run delivery-workflow:test
```

See [`packages/delivery-workflow/README.md`](packages/delivery-workflow/README.md) for its input,
runtime adapter contract, and registration instructions.
