# Domain ownership survives Daemon replacement

The accepted Daemon design adds a `daemon` context for the per-user service, managed releases,
lifecycle operations, and durable client receipts. Lifecycle operations can continue while no
Daemon instance is running, so they need an owner separate from the Project catalogue. Project
Runner supervision and Resource leases stay in `project`; Run scheduling and correctness stay
in `workflow`. See the [context map](../../context/map.md) for the remaining owners.

Global `@carere/kojo` supplies delivery and Daemon infrastructure. Project-local
`@carere/kojo-runtime` supplies authoring, validation, and execution. Two independent contract
packages supply client wire contracts and private Runner wire contracts. Neither depends on
application implementations. This permits shared client schemas without a Console build cycle,
and keeps private Runner IPC separate from client access. Authored Effect values stay in the
Project-local runtime, including standalone validation; only encoded contracts cross process
boundaries. The Runner's local engine adapter translates execution to typed Daemon operations.

Use cases depend on typed ports for complete state transitions. Daemon database adapters commit
required changes across contexts together, including the associated mutation receipt. Shared
database code owns connection and transaction mechanics, not domain policy. Separate commits for
Verdict recording and continuation scheduling, for example, would leave an accepted answer without
its required work after a crash. Artifact storage belongs to `trace`, with retention separate from
Trace records; execution correctness and Resource leases remain with their owners.

The lifecycle controller owns its private journal, managed installation, and native service
transitions. A narrow lifecycle-control port links it to the Daemon, which alone owns database
checks, backups, migrations, receipts, and Project Runner supervision. Their handoff is recoverable
across separate durable stores; neither a journal entry nor a receipt alone proves activation.

These are planning decisions, not claims about the current implementation. The full allocation and
its accepted trade-offs are in
[Define Daemon context and port boundaries](https://github.com/carere/kojo/issues/62#issuecomment-5472854062).
The execution, client, and lifecycle protocols remain in their linked resolutions there.
