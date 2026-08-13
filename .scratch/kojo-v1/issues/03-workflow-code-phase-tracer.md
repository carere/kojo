# 03 — workflow(), the code phase, and the in-memory tracer

**What to build:** `kojo run hello` executes a real two-phase workflow and prints a phase table showing what ran, in what order, and how long each phase took. This is the first end-to-end slice: a workflow definition, a phase that does something, and a record of it.

**Blocked by:** 02

**Status:** done

- [x] `kojo run hello` runs a workflow made of two code phases and prints a phase table
- [x] Every phase writes exactly one record, on exit, on every path — including when it fails
- [x] The in-memory tracer is queryable from a test, and a test asserts the phase order
- [x] A failing phase still leaves a complete record and the table still prints
- [x] The run is stamped with the engine version and commit that produced it

## Comments

Done. `kojo run hello --who Kevin` prints a phase table; `--fail` prints the same table with the
second phase marked FAIL and still exits with the typed error tag.

Design calls worth carrying forward:

- **The engine's execution id *is* the run id.** Nothing generates a second identifier, so the
  trace, the branch name, and the engine's persistence agree by construction rather than through a
  mapping someone has to maintain. `workflow()` provides it as `CurrentRun`, so a phase can never
  be told the wrong run.
- **The trace write sits inside the activity.** Around it, the write is outside the recorded
  boundary and replays. There is already a test asserting one record per phase.
- **`interrupted` is its own outcome**, not a flavour of failure. A phase interrupted at a gate did
  nothing wrong and must not read as a fault. Detected with `Cause.hasInterrupts`.
- **`Tracer` writes and `RecordedTrace` reads**, as two services over one piece of state built by a
  single `Layer.effectContext`. Two separate layers would each build their own state and the reader
  would always be empty — a failure that looks exactly like "nothing was traced".

API facts found by building, not by reading:

- **`Activity.CurrentAttempt` counts from 1.** A record showing attempt 1 ran once; it was not
  already retried. Asserted in the tests so the convention cannot drift.
- **`Context.Service`, not `Context.Tag`.** The design record says `Context.Tag`; v4's idiom is
  `class X extends Context.Service<X, Interface>()("id")`. Corrected in the design docs.
- **Schema classes are constructed with `new`**, and there is no `makeUnsafe`. Branded ids get an
  explicit `makePhaseId` helper that casts, because those parts are ours — decoding them would be a
  runtime check of something that cannot be wrong. Ids from outside are still decoded.
- **`Cause.hasInterrupts`**, not a `failures` array.
- **Layer direction matters**: the workflow layer *consumes* the engine and tracer, so it is
  `workflow.layer.pipe(Layer.provideMerge(base))`, not the reverse. The reverse typechecks in some
  arrangements and then fails at runtime with a bare "Service not found".

Deferred to their own tickets, deliberately: the durable engine and suspension (10), the real error
module (04), and the SQLite tracer (24). `code()` already takes a typed `error` schema so ticket 04
supplies types rather than reshaping the signature.
