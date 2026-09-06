# Operating Kojo

Kojo uses one Daemon for the current OS user. The Daemon owns storage, admission, scheduling,
Runners, and Gate application. Use the CLI or Console as a client of that Daemon.

## Prepare and inspect

```bash
kojo doctor
kojo daemon status
kojo project register .
kojo workflow list --project <project-id>
```

`doctor` is repository-local and read-only. It validates the Project package in its own runtime.
It does not require or start the Daemon. Register uses the exact Git worktree root and waits for
the first Factory Refresh.

## Start and observe

```bash
kojo workflow start <project-id> <workflow> --payload '<json>'
kojo run status <run-id> --follow
kojo gate list --project <project-id>
kojo gate answer <token> --choice approve --wait
kojo ui
```

Start accepts JSON. It returns after durable admission unless `--wait` asks for a terminal Run.
A timeout or client exit never cancels accepted work. Gate answer records a Verdict. Applied is
a separate Daemon-owned state. No watcher is required. `kojo ui` opens an authenticated Console
tab and exits; it does not serve the Console or start work.

Run IDs are Project-qualified and idempotent. Repeating the same authored idempotency key returns
the recorded Run, including a failure. Use `kojo run status` to inspect that Run.

## Boundaries

- Use public CLI and Console surfaces. The Daemon is the only correctness-store owner and
  execution engine.
- Keep `.kojo/` unchanged while its own Workflow performs requested work.
- Let the Workflow perform its declared merge and release Phases.
