---
status: accepted
---

# Host Project Runtimes in one supervised local service

Kojo runs one long-lived per-user Kojo Host, started at login and restarted by the operating system, with one isolated logical Project Runtime for each active Kojo Project. This replaces the process-per-project design in [Use one on-demand Project Runtime per Kojo Project](./0001-use-an-on-demand-project-runtime.md): enabled Workflow Schedules and durable engine messages need a continuously supervised local process, while a single host avoids one operating-system service and endpoint per project.

## Decision

- A machine-local Project Index maps each known Kojo Project's stable identity to its canonical repository path. Workflow and schedule state remain project-local.
- The Kojo Host exposes one stable per-user Unix socket. The CLI connects directly; the visualizer's local server proxies browser requests. A client that cannot connect asks the operating system to start the host and retries.
- The host activates a Project Runtime for enabled Workflow Schedules, recoverable Workflow Runs, durable timers, or client demand. A runtime accepts or recovers work only after its database is open, engine ownership is acquired, and compatible Workflow Definitions are registered. Failure to ready one project leaves the others available and reports that project as needing attention.
- Kojo pins the complete Effect family to `4.0.0-beta.102`. Each Project Runtime composes a persistent project-local Bun SQLite client, `BunCrypto`, SQL-backed `SingleRunner`, `ClusterWorkflowEngine`, and its Workflow registration layers behind one Kojo-owned `LocalWorkflowBackend` adapter. Deadline-sensitive clocks always use the durable delayed-message path.
- Durable Workflow Runs have no admission limit. The host limits resource-consuming Workflow Activities with a configurable host-wide capacity whose default is the smaller of four or the machine's available CPU count. Providers may impose lower limits. Activities are FIFO within one Project Runtime and selected fairly across Project Runtimes; Child Workflow Runs use the same pool.
- Every nested invocation is a visible Child Workflow Run with its own identity, state, and Execution Trace. Kojo records the parent Run identity and derives child idempotency from that parent plus a stable invocation key so unrelated parents never share a child accidentally.
- External Workflow Activities are at-least-once across the crash window between completing a side effect and durably recording its result. Kojo requires an Activity Idempotency Key and passes it to external adapters; recovery retries unfinished work with the same key rather than claiming exactly-once execution.
- After a host restart, each ready Project Runtime automatically resumes non-final Workflow Runs and delivers due engine messages. A stopped host cannot deliver them, so operating-system supervision is part of the runtime contract.
- Each host request, Workflow Activity attempt, schedule-delivery attempt, and recovery cycle emits one structured completion event with stable host, project, run, child, activity, replay, outcome, duration, and version fields as applicable. Diagnostic events are never authoritative workflow state.

## Considered Options

- Keeping one operating-system process per Kojo Project preserves stronger process isolation but multiplies service registration, restart supervision, and endpoint discovery for the multi-project visualizer.
- Keeping Project Runtimes purely on demand cannot progress enabled Workflow Schedules or due durable messages when no client is connected.
- Sharing one Workflow Engine database across projects weakens project-local ownership and failure isolation.
- Limiting concurrent Workflow Runs wastes capacity while runs are suspended and can deadlock a parent waiting for a Child Workflow Run. Capacity belongs to resource-consuming Activities instead.
- Effect's in-memory Workflow Engine and Message Storage layers cannot recover after process exit and remain test-only choices.

## Consequences

- One Kojo Host process failure pauses every active Project Runtime until the operating system restarts it, but a project-level readiness failure does not block other projects.
- Effect's unstable workflow, cluster, and SQL contracts do not leak into CLI, visualizer, or domain interfaces. Upgrading the pinned beta is an adapter migration.
- Kojo owns its queryable Run graph, public lifecycle model, Activity idempotency, retention policy, schedule registry, and readiness reporting above Effect's private mailbox format.
- Exact lifecycle states, schedule catch-up and overlap, control RPCs, database tables, trace framing, and repair flows remain decisions in their existing Wayfinder tickets.

The backend evidence is recorded in [Research Effect Workflow's local durable backend](https://github.com/carere/kojo/issues/16).
