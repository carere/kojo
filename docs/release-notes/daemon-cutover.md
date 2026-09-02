# One per-user Daemon: breaking release notes

This release replaces repository-local execution with one Kojo Daemon for each OS user on a Host.
There is no migration from the old execution model because Kojo has no accepted production state to
migrate.

Install the global CLI with `bun add -g @carere/kojo`, and then run `kojo daemon install`. The
managed installation retains its own Kojo package, Bun executable, Console, launcher, and lifecycle
metadata. Removing the global CLI or Bun does not remove the managed installation.

The supported Hosts are macOS and Linux with a functioning systemd user manager. On Linux,
`kojo daemon keep-running-after-logout` requests linger for the complete OS user. This action can
need Host policy authorization. On macOS, the LaunchAgent lifetime follows the graphical login
session. Kojo does not describe the macOS lifetime as linger.

## Public command cutover

Repository-local authoring uses `kojo init` and `kojo doctor`. Daemon-owned work uses these command
groups:

- `kojo daemon install|start|stop|status|logs|repair|upgrade|remove|purge`
- `kojo project register|list|status|relocate|archive|restore|configure|repair`
- `kojo workflow list|status|start|stop`
- `kojo run list|status|cancel|resume`
- `kojo gate list|answer`
- `kojo ui`

The CLI is a short-lived client. It does not open correctness storage, execute a Workflow, apply a
Gate answer, or start the Daemon as a side effect of inspection. `kojo ui` asks the Daemon to open
one authenticated Console and then returns.

The removed watcher command, positional Run start form, repository-local database, client Gate
application, global-package authoring exports, and agent spending controls have no compatibility
path. Factory source imports authoring APIs by deep path from `@carere/kojo-runtime`.

## Coordinated packages

The release contains one matching version of `@carere/kojo`, `@carere/kojo-runtime`,
`@carere/kojo-client-contracts`, and `@carere/kojo-runner-contracts`. The CLI package contains the
matching Console and managed entry points. The runtime package contains the Project Runner,
standalone validator, and `runtime-manifest.json`.

Release acceptance needs one revision-bound evidence record for every check in spec #64. It also
needs shipped evidence from macOS and systemd Linux. A cache hit, a zero-test result, an unnamed
skip, a missing supported Host, or a different tested revision cannot satisfy that evidence.
