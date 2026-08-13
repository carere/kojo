# 24 — The trace schema and the durable writer

**What to build:** One wide record per unit of work, written once, carrying everything known about it. Runs, phases, gates, sandbox acquisitions, and subordinate occurrences, in a schema that can evolve without breaking a reader built against an older engine.

**Blocked by:** 10, 11

**Status:** done

- [x] A phase record carries identity, the agent and its model and session and tokens, the envelope verdict and its checks and corrections, the effect on the repository, and where it ran
- [x] The record is written once, on exit, on every path — and the write sits inside the recorded boundary so a resumed run does not duplicate it
- [x] A run record carries what produced it: engine version and commit, config digest, host, and image digest
- [x] Gate records carry the human latency; sandbox records are one per acquisition
- [x] Occurrences exist only for genuine repetition inside a phase, and no question requires reading them
- [x] Migrations are explicit and additive, and the migration ledger is named rather than inherited
- [x] Which phases needed a container is answerable without a join

## Comments

The writer is `src/contexts/trace/adapters/SqliteTracer.ts`: five tables under Kojo's own
`kojo_migrations` ledger, on the **shared** client from ticket 10. It opens nothing of its own — two
layers on one path are two `bun:sqlite` handles with two independent write serializers — and it is
provided as `Layer.mergeAll(engine, tracer).pipe(Layer.provideMerge(database))`.

**Where it ran.** `PhaseRecord.sandboxId` is the one nullable column the container question rests
on, and it is read through `Effect.serviceOption(Sandbox)` (`services/phase/whereItRan.ts`) so a
phase does not gain a requirement it does not need. It names the **acquisition**: a unit test proves
the phase before a gate and the phase after it record two different containers, which a column
naming the *scope* would have hidden.

**What was widened.** `RunRecord` gains the idempotency key, config digest, host and an optional
image digest (from an extended `BuildInfo`); `AgentCallRecord` gains context occupancy;
`Verification` gains the envelope's identifier; `PhaseRecord` gains `sandboxId` and `repo`; and
`Occurrence` plus `Tracer.occurrence` are new. Two of those carry no producer yet and the code says
so: **`repo` and `breaches` stay absent until a phase runs its call through `withPermissions`**,
which nothing wires up today, and **no provider resolves an image digest**, so that column is null
rather than invented.

**What grades what.** The unit durability suite still grades the `onExit` placement, and that was
measured rather than assumed: moving the write outside the activity in `phase/code.ts` fails three
unit tests, including the duplicate-row one. The SQLite tier grades what the file ends up holding —
after a real suspend and resume on the single-node engine, `kojo_phases` holds one row per phase.
Those are two claims, not one: `phase_id` is unique, so the table alone cannot tell "not written
twice" from "written twice and refused". A separate test writes the same record twice and pins both
halves of that — one row, and one error-level log, with the run still alive, because the trace is
observability and must never take a run down.

**Not built here.** `TraceReader` / `ArtifactReader` are ticket 25 — `SqliteTracer.tables` is
exported for it. The in-flight phase on the run row (adr/trace/0002) is not written yet; it is a
Console need, and the run row is already the mutable one, so it lands as the next migration.
`tests/support/JsonlTracer.ts` still stands in for the trace in the ticket-19 lane suite and could
now be replaced by this adapter.
