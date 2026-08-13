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
  "written once, on exit, on every path", and that guarantee is what makes an *interrupted* phase
  still leave a complete record — which is when a trace matters most.

## Consequences

- The Console draws the in-flight phase as a span that grows to *now*, replaced by the real span
  when the phase exits.
- Occurrences stay the right home for live tool calls, because §9 already sanctions them for genuine
  repetition inside a phase. They are shown only in the phase detail, never on the waterfall, so the
  waterfall stays phase-grained.
