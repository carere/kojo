# 08 — The gate port and suspension

**What to build:** A run reaches a human decision point, releases everything it holds, and stops. The asking half runs and finishes; the answering half happens later, possibly in another process. This is the feature the whole design exists for.

**Blocked by:** 03, 04

**Status:** done

- [x] Requesting a gate returns a token and the run suspends; nothing is held while it waits
- [x] Every gate answers in one shared verdict schema, so any adapter can answer any gate holding only the token
- [x] Each asking of a gate gets a durable deferred name unique to that asking, so a recorded answer is never replayed as a new one
- [x] The terminal adapter prints the command that answers the gate and returns
- [x] A gate carries a deadline and a declared branch on expiry, and neither is optional
- [x] The gate record captures who was asked, when, and — once answered — by whom and after how long

## Comments

### What landed

- `contexts/gate/models/` — `Verdict` (one schema for every gate), `Settlement` (the union the
  deadline race resolves to), `GateRequest`, `GateRecord`, `OnExpiry`, `GateUnreachable`.
- `contexts/gate/ports/Gate.ts` — `request` + `describe`. The port is deliberately the *asking* half
  only; the answering half needs no port.
- `contexts/gate/adapters/TerminalGate.ts` and `InMemoryGate.ts`.
- `contexts/gate/services/answerGate.ts` — `answerGate` and `parseToken`.
- `contexts/workflow/services/phase/gate.ts` — the `gate()` primitive, beside `code()`, per the
  design's tree (`services/phase/{agent,code,gate,sandboxed}.ts`).
- `Tracer` gained `gate(record)`, and `InMemoryTracer`'s `RecordedTrace` gained `gates`.

### Deviations

- **`onExpiry` is a discriminated union, not a bare `"reject" | "escalate" | "fail"` string.** Two of
  the three branches are not executable without a value: an auto-reject has to say *which* declared
  choice it stands in for (nothing generic knows that `"reject"` means no in
  `["approve", "reject"]`), and an escalation has to name who it goes to and how long that second
  asking gets. `OnExpiry.fail()`, `OnExpiry.reject({ choice, reason })`,
  `OnExpiry.escalate({ to, deadline })`. The record still stores the bare tag.
- **`escalate` is one further asking, not a chain.** The escalated asking has no expiry branch of its
  own; if it also expires the gate fails with `GateExpired`. A gate can therefore never escalate
  forever, and the implementation stays a flat two-step rather than a recursion.
- **The gate record is written once, when an asking settles** — not at request time and updated
  later. Same reason a phase row is written on exit: an insert-then-update is two half-records, and
  the trace's rule is one wide row per unit of work. A gate that is still waiting is the run's
  *mutable status* and belongs on the run row beside the in-flight phase (adr/trace/0002). Ticket 24
  owns that column.
- **`GateUnreachable` is a new error**, alongside `GateRejected` and `GateExpired`. Those two are
  answers; this one says the requesting half never got out. §6 of the design record does not list it.
- **`gate()` returns a `Verdict` and does not turn a "reject" choice into `GateRejected`.** The
  primitive is generic over its choices, so the author branches on the verdict — which is what §8's
  factory does. `GateRejected` stays the author's (and ticket 09's) error.
- **`DurableClock.sleep` is called with `inMemoryThreshold: Duration.zero`.** The 60-second default
  runs any shorter deadline as an in-memory `Effect.sleep` inside an activity, which holds the fiber
  — and holding the fiber is holding the container. A gate must always take the durable path.

### API findings

- **`raceAll`'s `success` schema must cover every racer.** `Settlement = Schema.Union([Verdict,
  Schema.Literal("expired")])` — a struct against a string literal, so the union stays unambiguous to
  decode. `error: Schema.Never` satisfies the required `error` field for racers that cannot fail.
- **`WorkflowEngine` and `WorkflowInstance` are re-exported as a *namespace* from
  `effect/unstable/workflow`.** `import type { WorkflowEngine }` then `WorkflowEngine` as a type is
  `TS2709: Cannot use namespace as a type`; the service types are
  `WorkflowEngine.WorkflowEngine` and `WorkflowEngine.WorkflowInstance`.
- **`DurableDeferred.TokenParsed.fromString` is a `decodeSync`** — it throws on a malformed token
  rather than failing. `parseToken` wraps `TokenParsed.FromString` in the repo's `decodeUnknown`
  helper so ticket 12's CLI gets a typed failure instead of a stack trace.
- **`TestClock.adjust` over a span that contains two deadlines fires both.** The escalation test
  originally advanced 8 days past a 7-day deadline; the escalated asking's own 1-day clock was
  registered at day 7 and fired inside the *same* adjustment, so the run completed instead of
  suspending. Advancing to exactly the first deadline is the fix, and this is a trap the reviewed
  loop's tests will meet again.
- **Answering from inside the requesting half does not suspend at all.** `InMemoryGate` writes a
  programmed verdict before the run reaches the wait, so `deferredResult` is already `Some` and
  `DurableDeferred.await` returns straight away. Deliberate: a test about what a workflow *decides*
  should not also be a test about durability. `layerMemory`'s `resume` no-ops correctly while the
  run's own fiber is still executing.

### Notes for ticket 09

`GateParams.asking` is the discriminator: it defaults to `Activity.CurrentAttempt` and the reviewed
loop drives it. The failure mode is pinned by
`tests/unit/contexts/gate/gate.test.ts` → *"under one name, replays the first verdict without ever
asking again"*: one human, asked once, and the run believes it asked twice.
