# 40 — The CLI must write a durable trace, not an in-memory one

**What to build:** A run started by `kojo run` or driven by `kojo watch` leaves a trace on disk that
`kojo ui` can read. Today it does not: `src/cli/factory.ts` wires `InMemoryTracer`, so the trace dies
with the process and the durable schema ticket 24 built is never created by any real command.

Measured live against a freshly stamped factory after a real run:

- `GET /api/health` → `schema: "unwritten", schemaApplied: 0`
- `GET /api/runs` → **503 `trace-unreadable`**

The Console degrades honestly rather than crashing — ticket 26 built that deliberately — but it
cannot show a real factory anything at all. Every ticket downstream of the trace is reading from a
store nothing writes.

This is a seam between finished tickets rather than a defect in any of them: 24 built the writer, 25
built the readers, 26 built the server, and nothing connects them to the command that produces runs.

**Blocked by:** 24, 26

**Status:** done

- [x] `kojo run` and `kojo watch` write through `SqliteTracer` against the factory's own database
- [x] The schema is created on first write, and `kojo ui` then reports it applied rather than
      `unwritten`
- [x] `GET /api/runs` returns a run that `kojo run` actually produced — asserted end to end, from
      the command to the HTTP response, not from a seeded fixture
- [x] The engine's tables and the trace's tables share **one** `SqlClient`, per ticket 10 — two
      clients on one file are two handles with independent write serializers
- [x] `busy_timeout` is set and lock contention retried, so `kojo watch` and `kojo run` starting
      together is not a coin flip — for everything Kojo owns. One residual is upstream and named
      below.
- [x] The in-memory tracer stays the unit tier's adapter; nothing in the unit tier gains a database
- [x] A trace write can never take a run down — a failure to record is not a failure to run

## Comments

**The trace is wrapped, not replaced.** `factory.ts` now builds
`RecordingTracer.layer.pipe(Layer.provide(SqliteTracer.layer))`. `SqliteTracer` is what `kojo ui`
reads days later; `RecordingTracer` is a new decorator that passes every record on and keeps a copy
of it under the `RecordedTrace` service `InMemoryTracer` already declares. That copy is what
`reportPhases` and `kojo watch` print, and keeping it is not convenience — it is **the replay
witness**. A resumed run must print only the phases that ran after the gate; read back from the
file, the table would hold the whole run and the witness would be gone. `run.ts`, `gate.ts` and
`watch.ts` were not touched.

**Two lock hazards were found by measuring, and both are fixed in `SqliteDatabase`.**

1. *The WAL pragma at open was an unretryable death.* The driver asks for
   `PRAGMA journal_mode = WAL` with a bare `db.run` before any busy timeout exists and does not
   catch what it throws, so opening a file another process is writing raised
   `SQLiteError: database is locked` as a **defect**. The driver is now told `disableWAL`, the busy
   timeout is set first, and the pragma is asked through the client — where it waits, and where
   losing is a typed error `retryOnLock` asks again. Graded by
   `SqliteDatabase.test.ts > "opens a file another process has locked, instead of dying on the WAL
   pragma"`, with a new `tests/support/holdRollbackLock.ts` that holds the lock on a file still on
   its rollback journal — the one state that forces the journal-mode change. Reverting only
   `disableWAL` makes that test die with exactly that error, so it grades the fix rather than a
   synonym of it.
2. *Kojo's migrator lost the ledger race.* The migrator reads its ledger and writes in one
   transaction, and SQLite refuses that upgrade **immediately** when another connection has written
   since the read — a busy timeout cannot help. `migrated` now retries the whole migration rather
   than the statement, so the second attempt reads the ledger the first lost to. Measured, not
   test-proven: two processes building `SqliteTracer.layer` on one fresh file went from 3 failures
   in 8 processes to 0 in 12.

**The residual, stated plainly.** Two commands that create *and migrate* a brand-new database at the
same instant can still lose, because the **cluster's own** migrator raises its lock loss as a defect
that nothing in Kojo can retry. Measured over twelve concurrent cold starts: base branch 2 failures,
this branch 1 — and this branch does considerably more startup writing. Against a database that
already exists, twelve concurrent `kojo run` processes lost none. Worth its own ticket; it is
upstream of everything here and predates this change.

**Verified live, three processes over one file:** `kojo watch` started a run from an inbox event and
suspended it, `kojo gate answer` in another process resumed it, and the file then held one `kojo_runs`
row with `outcome = succeeded`, exactly two `kojo_phases` rows (`draft`, `land` — no duplicate from
the replay), and the answered `kojo_gates` row. `kojo gate answer` printed `land` alone.
