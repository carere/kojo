# 46 — An expired asking waits in the queue for ever

**What to build:** The gate queue stops showing an asking that can no longer be answered.

`waitingRows` filters on `answerer === undefined`, and an expiry writes **no verdict** — so an
expired asking sits in *waiting* with *"overdue by …"* growing without bound, and the run list's
*"N waiting on a human"* count inherits it. A queue that lists work nobody can do is a queue people
stop reading, and human latency is the metric this surface exists to reduce.

Ticket 30 fixed the more dangerous half of the same root cause — an expired gate was being drawn as
*"Applied — the run resumed"* — and deliberately left this half, because closing it is not a Console
change: `GateRepository` has no way to say an asking **settled**. That is a port method, a column, a
migration and a writer.

**Blocked by:** 30

**Status:** done

- [x] The queue distinguishes waiting from settled, where settled covers both answered and expired
- [x] An expired asking leaves the waiting list and the *"N waiting on a human"* count
- [x] *Overdue* and *expired* stay distinct: overdue means an answer may still land, expired means it
      cannot
- [x] The queue still shows how long each waiting asking has waited — that number is the point

## Comments

Built exactly the four pieces the ticket names, plus the read models over them:

- **Port method** — `GateRepository.expired({ token, expiredAt })`, beside `recorded`, keeping the
  first settlement the way `recorded` keeps the first verdict. Implemented by both adapters; an
  expiry never erases a verdict already on the row — the two are different facts, and
  `AskedGate.state` ranks them (`expired` outranks `recorded`, because a verdict the run expired
  past is one it will never apply).
- **Column** — `expired_at` on `kojo_asked_gates`, nullable, absent-tolerant on read so a file from
  before the column decodes as *not settled*.
- **Migration** — `0003_asking_settlement`, in the one ledger (`SqliteTracer.migrations` under
  `kojo_migrations`) with the body owned by the gate context
  (`SqliteGateRepository.settlementMigration`). It meets the table in both states: `create table if
  not exists` for a fresh file, a `pragma table_info`-guarded `alter table add column` for a table
  written before this wave. `expectedSchema` is derived from the migrations record, so the Console's
  schema standing counted it without a second constant.
- **Writer** — `phase/gate.ts`'s record activity: when the expiry half of `DurableDeferred.raceAll`
  wins, the run writes `repository.expired({ token, expiredAt: deadlineAt })` in the same activity
  that records the settled `GateRecord`. The deadline is the settlement time because it replays
  stable, like the reject verdict. The write is logged-and-swallowed on failure — the row is
  observability, and a run must not be traded for the record of it (the trace's own rule). This adds
  `GateRepository` to `gate`/`reviewed`'s requirements and to `FactoryServices`; `factory()` already
  provided it.

Read models: `AskedGate` gains `expiredAt` and the `expired` state; `waitedMillis` freezes at the
expiry (request-to-deadline is what the gate cost); `unanswered` became `unsettled` (answered *and*
expired leave everybody's desk). `kojo gate list` prints `EXPIRED … ago`, never `OVERDUE`, for a
settled asking, and drops it without `--all`. Console: `Asking.expiredAt` on the wire (absent when
absent — no `null`), the queue's *waiting* list excludes expired rows, the second section is
**Settled** (answered → *recorded by X*, expired → *expired — nobody answered in time*), `openGateOf`
and the run list's *N waiting on a human* count exclude settled askings. The `busy` fixture seeds the
settlement for `run-expired` the way the run writes it.

Graded by (each named test reddens if its piece is removed):
- `tests/unit/contexts/gate/gate.test.ts` — "an expired asking settles in the queue's read model":
  fail, reject and escalate branches through the real engine + `RecordingGate` over the in-memory
  repository, plus "never settles an asking somebody answered in time". This grades the writer
  itself, not a stand-in.
- `tests/integration/contexts/gate/adapters/SqliteGateRepository.test.ts` — the settlement across
  two clients on one file, first-settlement-wins, verdict untouched, unknown token refused.
- `tests/integration/contexts/trace/adapters/SqliteTracer.test.ts` — ledger is
  `1_trace, 2_in_flight, 3_asking_settlement`; a pre-wave `kojo_asked_gates` gains the column.
- `tests/unit/contexts/gate/models/AskedGate.test.ts`, `tests/unit/cli/gateTable.test.ts` — the
  `expired` state, the frozen wait, EXPIRED-vs-OVERDUE wording, `unsettled`.
- `apps/console/tests/browser/gate.spec.ts` — "an expired asking leaves the waiting list, and is
  expired, never overdue" (one row, in Settled, badge text, wait frozen at 2h 0m) and the run-list
  count test (compared against the server's own list, because the shared fixture server is mutated
  by the answering test running in parallel).

Proven by walking it, not only by the suites: a scratch factory with an 8-second gate on a real
database — `kojo run` suspended and exited; `kojo gate list` said **overdue** while no runner was
alive (correct: nothing had settled); re-driving the run applied the expiry; `kojo gate list` then
said *no gate waits on anybody* and `--all` printed `expired … EXPIRED 27s ago`; `kojo ui` over the
same file served `expiredAt` with no `null` on the wire, `schemaApplied 3 = schemaExpected 3`, the
`/gates` page showed the row under **Settled** with the wait frozen at 8s, and the run list said
*0 waiting on a human*.
