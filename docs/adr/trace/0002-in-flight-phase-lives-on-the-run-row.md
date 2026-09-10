# The in-flight phase lives on the run record

D9 writes a phase record once, on exit. So while an agent phase runs for four minutes, the trace
holds nothing about it, and a live run has nothing to draw. The run record therefore carries the
in-flight phase — phase id, name, kind, owner, start time, attempt — updated in place and cleared
when the phase record replaces it.

This does not weaken D9. D9 governs **records of completed work**, and the in-flight phase is not
one: it is the run's current status, on a record that is already mutable for exactly that reason
(`suspended`, the open gate, the deadline). No completed unit of work gains a second row, and
nothing is reassembled by a join.

## Considered Options

- **Accept the blind spot.** A live view that shows finished phases and a status word. Rejected:
  live watch is a primary job of the Console, and this reduces it to a progress bar that does not
  move.
- **A `phase_start` occurrence.** Rejected: this is precisely the thin-row pattern
  [§9](../../design/typescript-effect.md) exists to forbid, and it would make the phase's own record
  reassemblable from two places.
- **A provisional phase record, upserted on entry and completed on exit.** Rejected: it breaks
  the completed-record model. A cooperative interruption can still run the finalizer and write
  the record. Process loss can prevent that write; the earlier claim that every interrupted Phase
  leaves a complete record was too strong.

## Consequences

- The Console draws the in-flight phase as a span that grows to *now*, replaced by the real span
  when the phase exits.
- Occurrences stay the right home for live tool calls, because §9 already sanctions them for genuine
  repetition inside a phase. They are shown only in the phase detail, never on the waterfall, so the
  waterfall stays phase-grained.

## Daemon recovery boundary

The in-flight field remains a mutable Trace projection. It can be stale after process loss and
cannot establish that a Phase is still executing, completed, or safe to repeat. Under
[Define Daemon context and port boundaries](https://github.com/carere/kojo/issues/62), authoritative
Run state and recovery evidence belong to `workflow`; Resource leases belong to `project`.
The Console must use those owners' status when execution is uncertain. This qualifies the record's
failure guarantees without changing the Waterfall decision or claiming recovery is implemented.

## Parallel Phase observations (issue #102)

The Run read model carries all active Phase attempts. A single slot loses sibling observations
when Workflows execute Phases concurrently. The Daemon retains each entry with its Run Claim
generation and Runner identity. The read model excludes completed attempts, finished generations,
and observations outside the current Claim. Completing one Phase does not clear a sibling.

This revises the original single-field storage decision. Completed Phase records still arrive
once on exit. Entry observations do not form provisional completed records and do not establish
execution authority. Only an executing Run can display growing Waterfall spans. A fresh Run
snapshot restores the same active observations after a Console reconnect.

## Live invocation observations

Issue #102 adds retained observations below the Phase attempt. Every physical agent call has an
invocation identity. Its ordered observations contain the actual rendered prompt and received
public provider activity. Implementation, review, and correction calls do not overwrite each other.
Completed Phase records remain completed observations.

The private Runner Trace channel stores these observations under the current Run Claim. The Run
read model marks unfinished observations as interrupted when their Claim is no longer current or
the Phase or Run has finished. Retained data remains readable after reconnect. Notifications ask
clients to reload the authoritative snapshot; slow viewers do not control provider execution.

The observer excludes raw transport data and private reasoning. It redacts known credential values
and marks truncation and omission. Prompt fields are bounded. Each invocation retains at most 512
activity events and 262,144 activity characters. Provider output needed for answer decoding is
separate from the bounded, redacted observation.

Usage is reported per invocation. Missing usage and costs remain unavailable. Token input does not
measure current context occupancy. The Run totals include every invocation once and mark missing
measurements as partial. Provider-reported API estimates remain separate from attributable charges.
