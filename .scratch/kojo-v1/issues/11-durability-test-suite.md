# 11 — The clock helper and the durability test suite

**What to build:** Suspension, resumption, and deadline expiry become ordinary unit tests that run in milliseconds. This is the suite that catches the sharpest edge in the system — a side effect placed outside a phase, which re-fires days later on resume.

**Blocked by:** 09, 10

**Status:** done

- [x] A test helper encapsulates settle, advance, settle, advance; no test advances the clock directly
- [x] A multi-day deadline expires in milliseconds of wall time and takes the declared expiry branch
- [x] A run suspends at every gate, resumes, and every phase is proven to have executed exactly once
- [x] A run that suspends three times leaves exactly one record per phase, not one per replay
- [x] A side effect placed outside a phase is caught by the suite, with a test that fails loudly when someone reintroduces one
- [x] A sandbox-shaped resource acquired around a gate is released at suspension and reacquired on resume

## Comments

**The helper is `tests/support/settleThenAdvance.ts`.** It exports `settle` (a bare zero
adjustment, which `TestClock` implements as one scheduler round) and `settleThenAdvance(duration)`,
which is settle → advance → settle → advance with a closing settle. The last advance is one
millisecond, and it is **subtracted from** the requested duration rather than added to it, so the
helper moves the clock by exactly what it was asked for. That is what lets a test still assert a
human latency to the millisecond after going through it — `reviewed.test.ts` asserts one, three and
two days exactly, and it does.

`TestClock.adjust` no longer appears in any test. Every unit test that moves virtual time —
`gate`, `run`, `reviewed`, `InMemoryClusterEngine`, `trigger` and the new suite — goes through the
helper.

**The suite is `tests/unit/contexts/workflow/services/durability.test.ts`**, nine tests, all on
`InMemoryEngine` with in-memory adapters. Nothing in it reads a wall clock or spawns anything; the
whole file runs in about forty milliseconds, seven-day deadlines included.

The exactly-once proof is built on two independent witnesses, because a counter alone can be read
wrong:

- an array each `code` phase pushes to, asserted element by element; and
- an agent scripted with a **list of one**, which `InMemoryAgentInvoker` exhausts rather than
  recycles. A scout phase that re-ran on replay would be refused as exhausted and fail the run, so
  a succeeded run *is* the assertion. The expensive call is the one that must not re-fire.

The stray-effect test is the sibling that gives those assertions teeth: the same body with one line
moved out of a phase fires four times for three suspensions, next to a phase one `code` away that
fires once.

**The suite found a defect on its first run, in `contexts/workflow/services/workflow.ts`, and it is
fixed here.** Both halves of the run record were outside a phase:

1. `tracer.runStarted` re-ran on every replay. A run with three gates left **four** `RunRecord`s,
   each stamped with the time of a resume rather than of the start (measured: 0, 1, 2 and 3 days).
   It now sits inside a `run/started` activity, so it is written once.
2. `runFinished` read the raw exit, and **suspension is an interrupt** — so every run that stopped
   for a human was recorded as `failed`, and stayed recorded as failed for the whole time it
   waited. `RunOutcome` already had `suspended` in it; nothing emitted it. It now does, via
   `Cause.hasInterrupts`.

This is exactly the class of bug the ticket exists to catch, so the fix is guarded by a test rather
than only reported: `starts once and says it is suspended, not finished, while it waits`. It was
confirmed red against the old `workflow.ts` and green against the new one.

No Moon task and no Vitest project were added; `tests/support/**/*` is already an input of
`kojo:test`.
