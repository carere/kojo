# 42 — Two cold starts against one new database can still lose the migration race

**What to build:** Two Kojo commands that create *and* migrate a brand-new database at the same
instant both succeed. Today one can die.

Ticket 40 fixed both hazards Kojo owns — the WAL pragma now waits behind a busy timeout rather than
throwing at open, and Kojo's own migrator retries the whole migration when it loses the ledger race.
Measured over twelve concurrent cold starts, that took failures from 2 to 1.

The residual is upstream: **the cluster's own migrator raises its lock loss as a defect**, which
nothing in Kojo can catch or retry. It only bites when the database does not exist yet — twelve
concurrent `kojo run` processes against an existing file lost none.

**Blocked by:** 40

**Status:** done

- [x] Twelve concurrent cold starts against one non-existent database all succeed, or fail with a
      typed error a caller can retry — never a defect
- [x] The fix does not serialise the normal path; an existing database keeps its current concurrency
- [x] If the only honest fix is upstream, say so and make Kojo create and migrate the file once
      before anything races for it — for instance in `kojo init` or a first-run guard
- [x] A test reproduces the race rather than relying on a rate

## Comments

**The residual really is upstream, and it is confirmed as a defect.** The reproduction is
`SqliteDatabase.test.ts` → *"dies rather than fails when the cluster's migrator loses the lock"*: a
second process holds the write lock, a `SingleNodeEngine` is built over the file with `busyTimeout`
at zero, and the exit is a **die**, not a failure. `Effect.result` cannot see it; `retryOnLock`
cannot see it; ticket 40's fix cannot reach it. So the answer is not a retry.

**The answer is a first-run guard, not `kojo init`.** `kojo init` was the wrong home for it twice
over: `--database` may point anywhere, so a factory stamped by `init` is routinely run against a
file `init` never saw; and a repository cloned by somebody else has a stamped factory and no
database at all, so the first command they run would still be the one creating it. A guard that
lives on the path every writing command already takes has neither problem.

`SqliteDatabase.firstRun` takes a mutex, builds **every** schema in the file while it is the only
writer, and writes a mark. `run`, `watch` and `gate answer` call it through `factory.created`,
immediately after `readyFor` — one makes the directory, the other makes the file.

Three choices worth the record:

- **The mutex is `BEGIN EXCLUSIVE` on a SQLite file of its own, beside the database.** Of its own,
  because locking *inside* the file being migrated is the exact fault being fixed — that file holds
  no schema, so it has no migrator and nothing in it can lose a ledger race. `BEGIN EXCLUSIVE`
  rather than `O_EXCL`, because the kernel drops a POSIX advisory lock when the holder dies:
  `FileRunLock` refuses to break a stale claim on purpose, and here the opposite is needed — a first
  run killed mid-migration must not leave a repository unable to start a factory ever again.
- **The mark is a file beside the database, and it is not the database.** *There* and *ready* are
  different questions: `kojo gate list` and `kojo ui` open the file without migrating it, so a guard
  that trusted the database's own existence would step aside for exactly the half-built file it
  exists to protect. The mark is written after the last migration, so it is true when it exists.
- **The schema is built where the file lies, never staged and renamed.** A file with no mark may be
  an empty one `kojo ui` made a moment ago, or a factory's whole history from before this guard
  existed. Renaming would be right for the first and would destroy the second.

**The deterministic test the ticket asked for.** *"waits for another process's first run, and
creates nothing while it waits"* forces the window rather than starting twelve and counting:
`holdFirstRunLock.ts` takes the lock, and reports **from inside the window** whether the database
existed while it held it — SQLite's busy handler sleeps the waiting thread, so the holder is the
only place that observation can be made. Its companion, *"looks again after it has waited, and
builds nothing the winner already built"*, has the holder finish a whole first run under the lock,
so the second `ready` check is reached on purpose; the schema it would otherwise build dies on
sight.

**The rate, measured rather than restated.** Forty rounds of twelve processes each way, one machine,
back to back, identical layers: `coldStart.ts` as shipped, **480 processes, 0 lost**; the same file
with `created` removed, **480 processes, 10 lost, every one a defect** (`SqlError: Failed to execute
statement`). Across every unguarded round run, 780 processes lost 12. Variance between rounds is
wide — one 15-round unguarded batch lost none — which is precisely why the rate is a smoke test and
the two tests above are the grading.

An earlier reproduction that built only `SingleNodeEngine` lost **0 of 120**: the losses need the
trace, the askings and the cluster contending at once, which is why `coldStart.ts` builds all three
and why a reproduction that skips any of them measures nothing.

**What is not fixed, said plainly.** `kojo gate list` and `kojo ui` still open the file without the
guard, because looking must never be an act of execution (adr/gate/0001). A reader arriving while a
first run holds the lock is therefore still a theoretical loser. It did not appear: 30 rounds of
twelve guarded starters plus four unguarded readers — 360 starters and 120 readers — lost nothing.
The asymmetry is written into the wiring test (*"readies the file from run and from answer, and
never from a listing"*) so the edge is documented rather than discovered.
