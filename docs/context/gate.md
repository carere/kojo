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
The half that replies with a gate token and Verdict for the Daemon to record. It does not execute
the Run that will apply the Verdict.
_Avoid_: response, callback

**Asking**:
One occasion on which a gate was put to a human. A gate asked three times by the reviewed loop is
three askings, each with its own token, its own deadline, and its own human latency. It is what a
gate record and the askings list are keyed by, because a gate answered on the third round tells you
nothing about how long the first two waited. Run ID, Gate path, asking number, and escalation stage
identify one Asking.
_Avoid_: attempt, round, instance

**Gate path**:
The stable identity of a Gate inside one Run. It combines the stable sandbox scope name, when
present, with the authored Gate name.
_Avoid_: Gate token, Asking

**Gate token**:
The random, opaque capability that the Daemon gives to one exact Asking. Holding it is what lets a
client answer the Gate.
_Avoid_: gate id, handle

**Recorded**:
A valid Verdict that the Daemon has durably stored but the Run has not yet applied. Delayed
application does not invalidate an answer recorded before its Asking's Deadline.
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
The absolute time before which the Daemon must durably record a Verdict for an Asking. An answer
recorded at or after this time is too late, regardless of when the Run can continue.
_Avoid_: timeout, expiry time

**Expired Asking**:
An Asking that has reached its Deadline without an on-time Recorded Verdict. Its expiry branch can
still be waiting for execution.
_Avoid_: answered Gate, Applied answer

**Expiry branch**:
What the Run does when its Asking expires without an on-time Recorded Verdict — escalate,
auto-reject, or fail. Declared with the Gate, never inferred.
_Avoid_: fallback, default action

**Human latency**:
How long a gate waited between its request and its answer. It is the metric a factory lives or dies
by, and it is meaningful as a distribution across runs, not as a number on one run.
_Avoid_: wait time, delay, lag
