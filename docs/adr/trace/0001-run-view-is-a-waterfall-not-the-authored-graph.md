# The run view is a waterfall, not the authored graph

[architecture.md §3](../../design/architecture.md) draws a factory as a graph and calls the diagram
"a projection of the trace", which invites the Console to render that picture. It cannot. A workflow
is arbitrary Effect code — `Match`, `while`, `for`, early return — so a run does not produce the
authored graph; it produces one linear walk through it, in which `fix_1`, `retest_1`, `fix_2`, and
`retest_2` are four separate phases rather than a cycle. Drawing the authored graph would require
static analysis of the author's TypeScript, which D1 refuses to own. **The graph is a projection of
the workflow. The run is a walk, and a walk is a waterfall.**

## Considered Options

- **The graph.** Rejected above. It is not derivable from the trace, only from the source.
- **A table of phase rows.** The literal rendering of D9, and it stays available as a toggle over
  the same data. Rejected as the centrepiece because the two costs this design exists to manage —
  how long a human held a gate, and how long a sandbox rebuild took — are durations, and a table
  gives a 2-second phase and a 41-hour wait the same row height.
- **The waterfall.** Chosen. [typescript-effect.md §9](../../design/typescript-effect.md) already
  models a run as spans with real parent and child nesting from `Effect.withSpan`, which is a
  distributed trace. The settled view for a distributed trace is a waterfall.

## Consequences

- **Rows are the scope tree, not concurrency lanes.** The host is the root row, and each sandbox
  acquisition is a child row. The vertical axis therefore means *where this ran*, which no other
  view answers, and a sandbox rebuild after a gate appears as a second row without anyone building a
  rebuild indicator for it.
- **The time axis breaks.** Any span or gap that would flatten the rest of the run collapses to a
  fixed-width break labelled with its real duration. This is more informative than a linear axis,
  not less: a 41-hour bar reads as "long" and cannot be measured, while a break states the number.
- **Corrections stay inside one span.** D9 keeps a corrected phase on one record, so the attempts
  are a detail-panel concern and never a timeline concern.
- **The gantt component is a widget, not the design.** Its editing surface — drag, resize, snap,
  `canDropEvent`, `onEventUpdate`, `addEvent` — has no meaning over immutable history and is not
  ported. Its native day-to-year scales are wrong by three orders of magnitude for phases that last
  seconds, so second, minute, and hour scales are added.
