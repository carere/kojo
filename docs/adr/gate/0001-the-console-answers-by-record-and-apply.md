# The Console answers a gate by recording it, not by resolving it

## Status for the Daemon design

The record-versus-apply decision remains in force. The accepted client contract in
[Define local Daemon transport and client access](https://github.com/carere/kojo/issues/58)
replaces this ADR's token-only access policy: answering requires access as the Daemon's OS user
and a Gate token for the exact Asking. A token does not grant general Daemon or Project access.

The Daemon serves the Console and records Verdicts through its client API. Clients do not open the
database or execute Runs. The old client-engine, Runner heartbeat, polling, and `kojo watch`
details below describe the earlier implementation, not the planned Daemon contract. See also
[Define the Daemon–Project Runner protocol and recovery](https://github.com/carere/kojo/issues/55).
These are planning decisions; this record does not claim that the runtime has changed.

## Original rationale and implementation

Answering a gate resolves a `DurableDeferred`, which is a write to the engine's storage —
*correctness*, not the trace's *observability*. The obvious implementation is for `kojo ui` to hold
a **runner** and carry the answered run forward itself. It does not. The Console writes the verdict
where any answering half writes one — `answerGate`, the same `DurableDeferred.succeed` that
`kojo gate answer` calls — and stops there. A live runner picks it up and executes the rest.

**Recording is a write, and saying otherwise would misdescribe the code.** `kojo ui` does build an
engine: `SingleNodeEngine.layer({ shardingConfig: { runnerAddress: Option.none() } })`, which is a
client-only Sharding — it enqueues and it registers nothing, so the Console never appears in
`cluster_runners` and never becomes the thing that would apply an answer. That is the whole of the
distinction this ADR turns on: **opening a browser tab is not an act of execution.** The Console
earns exactly the authority a token confers, and no more.

The reason is that the gate port already splits request from answer precisely so the answering half
"may happen in a different process, on a different machine, on Tuesday"
([architecture.md §5](../../design/architecture.md)). The Console is one more answering half. It
earns no privilege that a Slack adapter or a webhook lacks.

## Considered Options

- **`kojo ui` hosts a runner.** Rejected because opening a browser tab would become an act of
  execution, and because the Console would then need the whole engine's dependency graph to render a
  read-only page.

  One reason originally given for this rejection was overstated and is withdrawn: *a second runner
  against one SQLite file*. An audit of the cluster layer showed registration, shard locks, and the
  storage inbox are all guarded on the runner address, so
  `SingleRunner.layer({ shardingConfig: { runnerAddress: Option.none() } })` yields a client-only
  Sharding that enqueues messages without becoming a runner. The contention was avoidable rather
  than inherent, and Kojo's `SingleNodeEngine.layer` — which wraps exactly that call — is what
  `kojo ui` is built on today. The decision stands on the remaining reasons.
- **The Console shells out to `kojo gate answer <token>`.** Rejected: it makes the Console a
  terminal wrapper and it fails whenever the CLI is not on that process's `PATH`.
- **Record and apply.** Chosen.

## Consequences

- **The Console must never show a recorded answer as an applied one.** If no runner is live, the run
  stays suspended, and an "approved ✓" that means nothing is the single failure that destroys trust
  in a control surface. `GET /api/health` reports runner liveness, and the answer UI distinguishes
  *recorded — applying*, *applied — the run resumed*, and *recorded — start `kojo watch` to apply it*.
- **Nor an expired gate as an answered one.** The trace writes a `GateRecord` when an asking
  *settles*, and `phase/gate.ts` writes the same activity whichever half of the race won — so a
  record with `outcome: "expired"` exists over a question nobody ever decided. Reading a record's
  presence as *applied* is this same failure pointed the other way, and it is worse, because there
  is no decision behind it at all. Only `outcome: "answered"` may be drawn as *applied*.
- **Liveness is read from `cluster_runners.last_heartbeat`, never from `RunnerHealth`.** The
  framework already maintains that table on a ten-second heartbeat with a 35-second staleness filter,
  so Kojo writes no heartbeat of its own. But `SingleRunner.layer()` wires `RunnerHealth.layerNoop`,
  whose `isAlive` returns `true` for every address — a Console built on that reports a live runner
  unconditionally, which is exactly the failure this ADR exists to prevent. See
  [console.md §9](../../design/console.md).
- **Applying is not instant.** A runner picks up an answer written by another process on a
  ten-second poll, so *recorded — applying* is a normal state with a visible duration, not a
  transient flash.
- An answer given while nothing is running is not lost. It applies when a runner next starts.
- The gate record gains its answerer for free, because the Console knows who clicked.
- Authorisation is out of scope for v1: the Console binds to localhost, and the OS user is recorded
  as the answerer. This is a decision, not an omission — revisit it before the Console ever listens
  on a non-loopback address.
