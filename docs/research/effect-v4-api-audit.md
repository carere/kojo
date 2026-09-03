# Effect v4 API audit

This record contains the findings that constrain the current Daemon model.

## Workflow suspension

`DurableDeferred.await` suspends the Workflow fiber and unwinds an ordinary local scope. Therefore
a sandbox scope must wrap activities. It must not be acquired inside an activity, because activities
retry interruption.

Workflow finalizers survive suspension. A compensation registered inside an activity does not
survive as a Workflow compensation because that activity uses its own instance scope.

## Runner liveness

`SqlRunnerStorage` stores Runner heartbeats and filters stale rows. The Daemon can query that
storage through its single `SqlClient`. `RunnerHealth.layerNoop` is not evidence of liveness.
No Runner rows is a valid idle state after graceful shutdown.

## Gate clocks

`DurableClock` uses the Effect Clock service. Gate deadlines can use `TestClock`. Tests must let
the Workflow register its sleep before they advance the clock, then advance the retry schedule after
the deferred completes.

## SQLite ownership

Effect cluster tables and Kojo tables can share one SQLite client when they use distinct migration
ledgers. Two independently constructed clients do not share the same write semaphore. Concurrent
migration owners can also disagree about a lock. These findings require one Daemon-owned client and
one migration authority.

## Sandcastle boundary

Sandcastle does not leak Effect through its public declarations. It does bundle a different Effect
runtime, so tracing and FiberRefs do not cross that boundary. Kojo must pass explicit Run identity
through the adapter callbacks and environment.
