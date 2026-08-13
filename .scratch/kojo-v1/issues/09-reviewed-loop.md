# 09 — The reviewed loop

**What to build:** An author can ask a human the same question repeatedly — reject, revise, ask again — and each asking genuinely suspends. This is the one place Kojo takes control flow away from the author, because a hand-written loop cannot get the deferred naming right.

**Blocked by:** 08

**Status:** done

- [x] A rejected verdict runs the revise step and asks again, and the second asking suspends rather than replaying the first answer
- [x] The loop is bounded and exhausting the bound is a typed failure, not a silent exit
- [x] A test proves the failure mode this exists to prevent: a naive loop replaying one verdict many times without suspending
- [x] The engine's own attempt counter drives the naming; no author-threaded counter is required
- [x] Each asking appears as its own gate record, so the human latency of each round is visible separately

## Comments

### What landed

- `contexts/workflow/services/reviewed.ts` — `reviewed()`, beside `corrections.ts`. The two are the
  same shape of thing: `corrections` is the loop that answers an agent's refusal, `reviewed` is the
  loop that answers a human's.
- `tests/unit/contexts/workflow/services/reviewed.test.ts` — five tests, including the naive loop
  the ticket asked for.

The loop is `Activity.retry`, not `while`. A rejection fails the round with a private `SentBack`
error, the retry advances `Activity.CurrentAttempt`, and ticket 08's `gate()` takes its per-asking
deferred name from that counter by default. The author passes no counter and names no phase per
round.

The same counter pays a second time, and it is the part worth knowing: activity results are keyed
`executionId/name/attempt`, so a revision phase named once gets its own persistence slot on every
round and genuinely re-runs. The test asserts exactly that — two `revise` phase records, attempts 1
and 2, distinct phase ids, from one authored name.

### Deviations

- **`reviewed` takes a `subject` and returns it approved.** §8's snippet reads
  `fix = yield* reviewed({...})` while giving `reviewed` no way to produce `fix` when the *first*
  asking approves and no revision ever runs. Passing the subject in fixes that, and it also makes
  `context` and `revise` read the current subject rather than close over a mutable binding — which
  matters, because the second asking is about the *revised* subject and a captured context would
  show the reviewer the diff they already rejected. §8's snippet is updated.
- **`deadline` and `onExpiry` are required**, as they are on `gate()`. §8's snippet omitted both; a
  run that waits forever is a leak whether it waits once or five times. Each asking gets the
  deadline on its own, not the loop as a whole. §8's snippet is updated.
- **Exhausting the bound fails with `GateRejected`, not a new `ReviewExhausted`.** Same decision as
  `withCorrections`, for the same reason: a run that was never approved failed because a person said
  no, and a wrapper would bury that person's words one level down in every trace row and every catch
  site. How often they said it is a question for the trace, which keeps one gate record per asking.
- **`choices` are fixed at `["approve", "reject"]`** rather than authored. The loop's control flow
  needs a two-valued decision to know whether to revise, and fixing the pair is also what makes an
  unrecognised answer safe: a verdict that says neither is not an approval.
- **The last asking does not revise.** Another turn of an agent after the final rejection produces
  work no human is going to look at, and it costs money.
- **`context` renders into the gate's description.** Ticket 08's `GateRequest` has no `context`
  field, and adding one is ticket 08's decision to revisit, not this ticket's. The record's entries
  are appended to the description as `label: value` lines, so the terminal, the trace, and the
  Console all show them through the one field they already render.

### API findings

- **`Activity.retry`'s counter is a plain local variable** (`Activity.ts`: `let attempt = 1` inside
  an `Effect.suspend`, `provideService(effect, CurrentAttempt, attempt++)`). It restarts at 1 on
  every evaluation, which is what makes it correct under replay rather than in spite of it: a
  resumed run re-walks rounds 1..n, reads each round's recorded verdict and recorded revision back
  instantly, and suspends at the round that was never answered. Verified by the suspend-on-every-
  asking test, which shows two revisions after three askings — the earlier ones replayed.
- **`times: n` means n *retries*** — `buildFromOptions` adds `Schedule.while(({ attempt }) => attempt
  <= times)` — so `limit` askings is `times: limit - 1`. Verified by the bound test: `limit: 2`
  leaves exactly two gate requests.
- **`Effect.catchTag` cannot be used to catch an error the caller's `E` might structurally contain.**
  `ExtractTag<E | SentBack, "SentBack">` widens to `{ readonly _tag: unknown } & E`, which is not
  assignable to `SentBack`, so the handler will not typecheck. `Effect.catch` with one `instanceof`
  handler over the whole channel does, and it is also the more honest statement: the class is
  private, so no author error can be one.
- **A private, non-schema error class is fine inside a workflow** as long as it is raised and caught
  between activity boundaries. `SentBack` never crosses one, so nothing ever encodes it.
- **`DurableDeferred.withActivityAttempt` was not needed.** It appends `/${CurrentAttempt}` to a
  deferred name; ticket 08's `gate()` already builds `gate/${name}/${asking}` from the same counter,
  which additionally says *which* gate the asking belongs to. §3's mention of it stays accurate.

### Notes for tickets 11, 12, 19, 20 and 24

- One gate record per asking, and `GateRecord.latencyMillis` is per round. The test pins three
  askings at 1, 3 and 2 days.
- The trace's `revise` rows differ only by `attempt` and `phaseId`. A Console waterfall that groups
  by phase *name* will collapse them.
- `tests/unit/contexts/workflow/services/reviewed.test.ts` → *"a hand-written loop runs every round
  against one stale verdict, and never suspends again"* is the regression test for the defect. It
  still runs the bug on purpose: five rounds, five revisions, one human, one gate record.
