# Local development with another Project

Use the source checkout for the CLI and Daemon. Link the Project's Runtime to the same checkout.
These steps do not publish or download a Kojo package. Managed Daemon bundles stay immutable;
Workflow Revisions keep the Runtime and Factory content used by existing Runs.

## Prepare the checkout

From the Kojo repository:

```bash
bun install
moon run console:build
kojo_source="$(pwd)"
source_kojo() { bun "$kojo_source/packages/kojo/src/main.ts" "$@"; }
kojo_version="$(source_kojo --version)"
```

Use `source_kojo` in this terminal for the commands below. It selects the source CLI even when a
published `kojo` executable is on PATH.

If this OS user has no managed Daemon installation, install from this source checkout:

```bash
source_kojo daemon install
```

If a Daemon is already installed, use the update steps below. `daemon install` keeps an existing
installation; it does not replace it with current source.

## Link the Project Runtime

The target Project must have a `package.json` and its dependencies installed. From the Kojo checkout:

```bash
moon run kojo:link-runtime -- /absolute/path/to/zaidan
source_kojo doctor --root /absolute/path/to/zaidan
source_kojo project register /absolute/path/to/zaidan
source_kojo project list
```

The link command changes only `node_modules`. It links `@carere/kojo-runtime` and the Runtime's
Effect instance. It preserves replaced installations under `node_modules/.kojo-link-backups` and
keeps `package.json` and the lockfile unchanged. This lets Docker install the Project's ordinary
locked dependencies while the Host captures unpublished Factory Runtime code.

The command refuses an installed Effect version that differs from the source Runtime. Align the
Project dependency first. Run the link command again after `bun install` replaces a link. Removing
`node_modules` and running `bun install` restores the Project's declared dependencies.

## Try Factory and Runtime edits

The Daemon detects Factory edits automatically. After a linked Runtime edit or relink, update
the Workflows directory's timestamp to request a new input scan:

```bash
touch /absolute/path/to/zaidan/.kojo/workflows
source_kojo workflow list --project <project-id>
source_kojo workflow start <project-id> <workflow-name> --payload '{"request":"a new request"}'
source_kojo run list --project <project-id>
source_kojo run status <run-id>
source_kojo ui
```

Use the payload declared by that Workflow. A repeated idempotency key returns the same Run;
use a new authored request identity when you want a new Run. Wait for `workflow list` to show a
completed Refresh and the new Revision before starting. Refresh captures new content for
subsequent Runs. It does not rewrite the Revision of an admitted Run.

## Try Daemon, CLI, and Console edits

The source CLI uses edits on its next invocation. A running Daemon uses its installed bundle.
Build the Console after a Console edit, then stage and activate a local bundle from current source:

```bash
moon run console:build
source_kojo daemon upgrade --version "$kojo_version" --check
source_kojo daemon upgrade --version "$kojo_version"
source_kojo daemon status
source_kojo ui
```

The version is the source package's version. A version bump is not required for local edits: the
managed bundle identity also includes its content. `--check` stages and checks the candidate;
the command without `--check` activates that checked candidate. Follow any reported compatibility
or pending-operation instructions. A timeout does not cancel an upgrade or force active work to stop.
No registry publication is part of this path.

## Manage local work

```bash
source_kojo workflow stop <project-id> <workflow-name>
source_kojo run cancel <run-id>
source_kojo gate list
source_kojo gate answer <token> --choice approve
```

Workflow stop disables future Trigger admission and polling; admitted Runs can continue. Run cancel targets one admitted Run.
Use the exact Gate token and one of its listed choices; `approve` above is only an example.
Inspect a Run after each operation. The Console keeps Run start and Gate actions beside Run state.

The editable [issue Factory](../examples/issue/README.md) supplies the Zaidan trial Workflow.
Actual single-issue and dependency-graph trials, plus maintainer acceptance of the CLI, authoring
API, and Console, are still required before publication.
