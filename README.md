# Kojo

Kojo is a software factory builder. A Factory is the authored program under `.kojo/`. A Workflow
is one executable entry in that Factory. A Project is a registered repository. One per-user Daemon
owns Run execution, Gate application, the Console, and all correctness storage.

Factory authors import the runtime from `@carere/kojo-runtime`. The `@carere/kojo` package owns
only the CLI, scaffolding, and Daemon lifecycle.

## Design

Read these records in order:

1. [Architecture](docs/design/architecture.md) describes the domain model and boundaries.
2. [TypeScript and Effect](docs/design/typescript-effect.md) describes the implementation.
3. [Console](docs/design/console.md) describes the Daemon-hosted operator view.
4. [Context map](docs/context/map.md) defines the ubiquitous language.

## Install

Kojo requires Bun.

The current release is a breaking cutover from repository-local execution to one per-user Daemon.
See the [Daemon cutover release notes](docs/release-notes/daemon-cutover.md).

```bash
bun add -g @carere/kojo
kojo daemon install
```

The Daemon manager starts one Daemon for the current OS user. The Daemon opens the store and owns
every Runner. CLI commands are short-lived clients.

## Stamp and register a Factory

```bash
kojo init --agent claude --model sonnet --sandbox docker --template review
bun install
kojo doctor
kojo project register --path .
```

`kojo init` keeps authored files. Complete the placeholders in `.kojo/commands.ts`, commit the
Factory, and run `kojo doctor` before registration.

```bash
kojo project list
kojo workflow list --project <project-id>
```

## Start and inspect a Run

```bash
kojo workflow start <project-id> review --payload '{"request":"the change to make"}'
kojo run list --project <project-id>
kojo run status <run-id>
kojo gate list
kojo gate answer <token> --choice approve
```

The Daemon Runner continues a suspended Run after a Gate answer. A client records the answer
through the Daemon API. No client opens the store or applies the answer.

`kojo ui` asks the Daemon to launch its Console and then returns.

## Develop Kojo

This is a moon + bun monorepo. Do not use npm.

```bash
bun install
bun tsc --build
bun biome check .
bun knip
```

Use moon for project tasks:

```bash
moon run kojo:test
moon run kojo:test-integration
moon run console:build
```

The main paths are:

- `apps/console/`: the Console.
- `packages/kojo/`: the CLI, scaffolder, and Daemon.
- `packages/kojo-runtime/`: the Factory authoring runtime.
- `.kojo/`: this repository's Factory.
- `docs/`: context, design, ADR, and research records.
