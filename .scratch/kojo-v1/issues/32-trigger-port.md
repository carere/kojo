# 32 — The trigger port and deduplication

**What to build:** What starts a run, and what a run is deduplicated by. A ticket that fires twice must not open two factories.

**Blocked by:** 10

**Status:** done

- [x] One stream interface covers a manual trigger, a poller, a webhook receiver, and a cron
- [x] The manual adapter emits one event and ends
- [x] Each event carries the value the run is deduplicated by, and two events for the same ticket revision produce exactly one run
- [x] Acknowledging an event is where a ticket gets closed or a webhook gets its response
- [x] An in-memory adapter drives whole workflows in tests
- [x] The issue tracker is not a port — reading and updating a ticket stays a phase the author writes

## Comments

### What landed

- `src/contexts/trigger/models/TriggerEvent.ts` — `source`, `key`, `payload`, `receivedAt`. The
  payload is `Schema.Unknown` because it arrives from outside the process; it is decoded against the
  workflow's own payload schema when the run starts.
- `src/contexts/trigger/models/TriggerError.ts` — four faults, answered differently by a watcher:
  `unreachable` (retry), `malformed` and `key-mismatch` (a mistake in the factory), `ack-refused`
  (the run happened, only the telling failed). `fromSchemaError` reuses `DecodeIssue`, so a bad
  webhook body names `revision` rather than "invalid payload".
- `src/contexts/trigger/ports/Trigger.ts` — `stream: Stream<TriggerEvent, TriggerError>` and
  `ack(event, run)`. No dedup lives in the port.
- `src/contexts/trigger/adapters/ManualTrigger.ts` — the reference adapter: one event from the
  `Clock`, then the stream ends; `ack` prints one line and returns.
- `src/contexts/trigger/adapters/InMemoryTrigger.ts` — programmed events with an optional `after`
  delay, plus `AcknowledgedEvents` for reading acks back, on the `RecordedTrace` pattern.
- `src/contexts/trigger/services/drive.ts` — `runFor` (decode, check the key, start) and `drive`
  (one event at a time until the source ends). `settled` polls `status` on a `Schedule`, never
  joining, because the engine's own `execute` returns only on `Complete`.
- `tests/unit/contexts/trigger/trigger.test.ts` — 10 tests, all on `TestClock`.

### Dedup is the workflow's `idempotencyKey`, and now it is checked

Nothing was built beside `idempotencyKey`: the engine hashes `${tag}-${idempotencyKey(payload)}`
into the execution id, and `WorkflowEngine.layerMemory.execute` only starts a body when that id is
new. Two events with one key therefore find one run.

The one addition is a **guard, not a second mechanism**. `Workflow.idempotencyKey` is a public field
on the definition, so `drive` compares it against the event's `key` before starting anything. Without
that comparison a trigger could name a dedup value its workflow disagrees with, everything would
still appear to work, and the *second* delivery would open the second factory this ticket exists to
prevent. A disagreement is now a `key-mismatch` error before the run starts.

### Deviations

- **`ack` takes a `TriggerOutcome`, not a bare `RunOutcome`.** typescript-effect.md §5 sketches
  `ack(event, outcome: RunOutcome)`. `TriggerOutcome` is `{ runId, outcome }` — the same outcome plus
  the run it belongs to, because an adapter that closes a ticket or answers a webhook has nothing
  else to link to the branch and the trace with.
- **`drive` ships here, in `trigger/services`.** Ticket 33 owns the daemon — the durable engine, the
  restart, the deregistration. What is here is the loop from event to run to ack, without which the
  in-memory adapter cannot "drive whole workflows in tests".
- **`docs/context/trigger.md` was not written.** `map.md` still marks the context as not yet written.
  Left for `/domain-modeling` rather than edited alongside two parallel branches.

### API findings

- **`WorkflowEngine.layerMemory.execute` skips the body for a known execution id** — `if (!state)`
  guards the `resume` — and `makeUnsafe` returns the execution id from a discarded execute. Read in
  `WorkflowEngine.ts`, then confirmed by the paired tests: same key → one `RunRecord`, two acks with
  one run id; different revision → two run ids.
- **`Workflow.idempotencyKey` is on the public `Workflow` interface**, not only on the internal
  props type. That is what makes the key check above possible without reimplementing the hash.
- **`TestClock.adjust` picks up sleeps registered during its own window** (its loop pops the sleep
  queue and yields as it advances), so one `adjust` covers several turns of a poll loop. A poll
  scheduled *past* the window is not released, which is what lets the poller test assert "another
  minute has not passed yet".
- **`Effect.repeat`'s `until` accepts a type refinement**, so `(s): s is RunOutcome => s !== "running"`
  narrows `RunStatus` to the three settled outcomes without a cast.

### Checks

`moon run kojo:test` (26 files, 169 tests), `kojo:test-integration` (9 files, 46 tests),
`kojo:check`, `kojo:tsc`, `kojo:check-public-types`, `root:check`, `root:tsc`, plus `bun tsc --build`,
`bun biome check .` and `bun knip` from the worktree root. All green. No Moon task and no Vitest
project was added — `tests/unit/**` already carries this file.
