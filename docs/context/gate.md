# Gate

How a human is asked to decide, and how the answer gets back. A gate suspends a run for an unbounded
time, so asking and answering are deliberately two separate halves that may run in different
processes, on different machines, on different days.

## Language

**Gate**:
A human decision point that suspends the run. The run stops, releases everything it holds, and
continues when an answer arrives.
_Avoid_: checkpoint, approval step, validator. In SSSF a "gate" validates an envelope; in Kojo that
is a **check**, which the workflow context owns.

**Verdict**:
The answer to a gate — the choice the human made, and the reason they gave.
_Avoid_: decision, result, approval

**Request**:
The half that asks. It posts a review, prints a command, or sends a message, and then it finishes.
It never waits.
_Avoid_: prompt, notification

**Answer**:
The half that replies. Whatever mechanism was used, it ultimately returns the gate token and a
verdict to the engine.
_Avoid_: response, callback

**Asking**:
One occasion on which a gate was put to a human. A gate asked three times by the reviewed loop is
three askings, each with its own token, its own deadline, and its own human latency. It is what a
gate record and the askings list are keyed by, because a gate answered on the third round tells you
nothing about how long the first two waited.
_Avoid_: attempt, round, instance

**Gate token**:
The value that identifies one exact suspension. Holding the token is what lets any process answer a
gate.
_Avoid_: gate id, handle

**Recorded**:
An answer that is persisted but not yet acted on. A recorded answer is real and will apply, but the
run has not moved.
_Avoid_: pending, queued

**Applied**:
An answer that has resolved the suspension. The run has continued. A surface that shows a recorded
answer as an applied one is lying, and the distinction must always be visible. See
[docs/adr/gate/0001-the-console-answers-by-record-and-apply.md](../adr/gate/0001-the-console-answers-by-record-and-apply.md).
_Avoid_: resolved, done, committed

**Answerer**:
The person a verdict is attributed to. Recorded on the gate record, and the reason a gate is worth
auditing at all.
_Avoid_: reviewer, approver, user

**Deadline**:
The time after which a gate stops waiting. Every gate has one, because a run that waits forever is a
leak.
_Avoid_: timeout, expiry time

**Expiry branch**:
What the run does when a deadline passes — escalate, auto-reject, or fail. Declared with the gate,
never inferred.
_Avoid_: fallback, default action

**Human latency**:
How long a gate waited between its request and its answer. It is the metric a factory lives or dies
by, and it is meaningful as a distribution across runs, not as a number on one run.
_Avoid_: wait time, delay, lag
