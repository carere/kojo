# Kojo

Kojo is an open-source, local-first software factory for defining, running, and inspecting durable
software workflows.

Developers author workflows as Effect programs inside a Kojo Project. The Kojo Host keeps Project
state and workflow execution available independently of its clients, while the CLI and Visualizer
provide terminal and browser access to that state.

Kojo is under active development. This repository currently establishes the Host, Project, control,
and workflow-authoring foundations for the wider system.

## Using Kojo

Kojo exposes three public interfaces.

### CLI

The `kojo` command is the terminal interface for initializing and managing Kojo Projects. It can
produce human-readable output or versioned JSON for automation.

```sh
kojo init .
kojo project list
kojo project show
```

### Visualizer

The Visualizer is Kojo's browser interface. It connects to the local Kojo Host, presents
Host-authoritative Project state, and provides the visual surface for inspecting and controlling
workflow execution.

### Workflow authoring

`@kojo/workflow` is the TypeScript interface for workflow authors. A Kojo Project exposes its
Workflow Definitions through a static `kojo.config.ts` file:

```ts
import { defineConfig } from "@kojo/workflow";

export default defineConfig({
  workflows: [],
});
```

The package keeps Kojo's execution engine and local control protocol out of project source so the
authoring interface can remain stable as the runtime evolves.

## Development

Development requires [proto](https://moonrepo.dev/docs/proto/install) for the Bun and Moon toolchain
and [Cocogitto](https://docs.cocogitto.io/#installation) for conventional commits.

```sh
proto --version
cog --version
```

Install the monorepo toolchain and dependencies:

```sh
proto install
bun install
```

Start the Kojo Host in one terminal:

```sh
moon run host:dev
```

Start the Visualizer in another terminal:

```sh
moon run visualizer:dev
```

The Visualizer is then available at `http://localhost:5173`. Run CLI commands against the same Host
from a third terminal:

```sh
moon run cli:dev -- project list
```

Install Chromium before running the browser tests:

```sh
cd apps/visualizer
bunx playwright install --only-shell chromium
```

Run the repository checks with:

```sh
moon run :check :tsc :unit-test :integration-test :browser-test :build
```

Use `moon run :fix` to apply safe Biome fixes.

## Contributors

Contributions are welcome. For non-trivial changes, start with a GitHub issue and use conventional
commits created and verified with Cocogitto. See everyone who has helped on the
[contributors page](https://github.com/carere/kojo/graphs/contributors).

Made with :love: by :carere: from :france:
