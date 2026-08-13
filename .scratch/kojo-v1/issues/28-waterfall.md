# 28 — The run waterfall

**What to build:** The centre of the product. A run renders as a waterfall: time left to right, one row per scope, a phase as a span on the row of the scope it ran in. A running run's current phase grows to now.

**Blocked by:** 27

**Status:** done

> **Handover from ticket 27, verified by the wave-11 integrator rather than reported.**
>
> - **`now` is genuinely injectable, and the waterfall depends on it entirely.** A component reading
>   the machine clock turns four tests red, and `useNow()` throws with no provider, so a lost
>   provider is a crash rather than silent non-determinism. There is exactly one `Date.now()` in the
>   app, in `browserNow.ts`. Keep it that way — every timestamp you render comes through the port.
> - **The fixture set is not enough for you.** It carries only `RunSummary` and `GateRequest`.
>   Phase, gate and sandbox fixtures still need writing; `InMemoryTraceReader.of` already accepts all
>   three. Include the states a waterfall gets wrong: a 41-hour gate, a correction loop, a permission
>   breach, an interrupted phase, a sandbox acquired twice, and a run with no phases yet.
> - **`@carere/solux` is deliberately not installed yet.** Ticket 27 was right not to — it would have
>   been an unused dependency or a global store. You add it with the waterfall, scoped to that
>   component, doing event programming and never fetching.
> - **The browser tier runs the real shipped CLI** — `kojo ui --fixtures` with
>   `reuseExistingServer: false`, so a stolen port fails loudly rather than grading someone else's
>   server. Add specs to that tier, do not invent a second one.
> - **Mutate both sources when you check a proof.** The no-factory notice has a server value and a
>   client fallback backing each other up, so emptying either alone left all ten specs green. The
>   behaviour is right and the fallback is deliberate, but **no single-source regression in it is
>   detectable**. If you add a fallback, add a test that grades each side on its own.


- [x] Rows are the scope tree — the host at the root, one row per sandbox acquisition — so a rebuild after a gate appears as its own row without a special case
- [x] The time axis breaks: any span or gap that would flatten the rest of the run collapses to a fixed width labelled with its real duration, drawn across every row
- [x] Dead time between phases breaks the same way, so an idle hour cannot hide in a gap
- [x] Wall-clock is available behind a toggle, and a table of the same records behind another
- [x] The in-flight phase renders as a span growing to now and is replaced by the real span on exit
- [x] Phase kind, failure, and permission breach are visually distinct; corrections stay inside their one span
- [x] The widget is read-only: no drag, no resize, no snapping, and scales that go down to seconds

## Comments

**The in-flight phase needed the column ticket 24 deferred, so this ticket wrote it.** Ticket 24
said the in-flight phase on the run row "is a Console need … so it lands as the next migration", and
that is `0002_in_flight`: six nullable columns on `kojo_runs`, a `Tracer.phaseEntered` beside
`Tracer.phase`, and `RunSummary.inFlight`. `phase` now writes the record **and** clears the status in
one `write`, because they are one fact — the phase has ended — and splitting them would let a
Console draw the same phase twice, once finished and once still growing. Rendering a field nothing
fills would have been the fake this build has been caught shipping before; the write path is real and
the round trip is graded on disk.

**The axis rule, stated.** A stretch collapses when it alone would take more than 60 % of the axis,
and never when it is shorter than ten minutes. Applied repeatedly, worst first: collapsing the gate
re-scales everything left, so the six-minute agent phase that looked like nothing beside 41 hours
becomes the longest thing on screen and correctly stays drawn. The floor is what stops a two-phase
run — which is *always* dominated by its longer half — from replacing a readable bar with a label.

**Two refinements the design implies but does not spell out, and both are load-bearing.**

- A break over a stretch **something was running in** keeps a margin at each end, so a three-hour
  phase is a head, a wall and a tail rather than a two-pixel sliver. A break that deleted the span it
  was called in to make readable would be worse than no break.
- **A sandbox band occupies the axis exactly as a phase does.** Without that, the ninety seconds a
  container takes to rebuild after a gate — which has no phase in it — was swallowed into the gate's
  break, and *what the rebuild cost* is one of the two things §5 says the row model exists to make
  visible. It is now its own linear stretch on the second acquisition's row.

**The state boundary.** `?view=timeline|table` is in the URL, per §8 — the URL is what a person
pastes to a colleague. Zoom, hover, selection and the break threshold are Solux, created inside
`RunView` and provided to that subtree only. Solux fetches nothing and there is no global store. One
thing was cut on the way: an event for setting the break share by hand. Nothing dispatched it, so it
was dead code wearing the shape of a feature; the only threshold a person can move is *break or do
not*, and that is the wall-clock toggle.

**Where the padding went.** A span carries no horizontal padding, because a border-box width can
never fall below the padding on it — a padded span has a twelve-pixel floor, and a two-second phase
would then be drawn as wide as a phase four times its length. The padding is on the label, which is
clipped instead. This was found by a test measuring a box, not by looking at the page.

**What is not graded, said plainly.** The `share` field is Solux state that only ever holds its
default, since no control changes it; the wall-clock toggle is what a test exercises. Hover
highlighting has no assertion — `data-selected` and the hover class are rendered but only selection's
own toggle-off rule is unit-visible, and neither is claimed as proved.

**Verified by mutation, not by reading.** Putting every phase on the host row turns three
scope-tree specs red; never collapsing a stretch turns five axis specs red; dropping the in-flight
span turns three red; deleting the correction marks and the breach mark turns two red; and removing
the in-flight clear from `SqliteTracer.phase` turns the new integration test red. Knip was proved to
read `apps/console` by planting an unused export and watching it be reported.

## Integrator's record — wave 12

Merged into `feat/kojo-v1` at `84faf96`, with three specs and one comment fixed on top. Every task
in `moon query tasks` except the three that write rather than grade was run by name with `--force`
before and after the merge. The counts moved the way the work predicts: unit 515 → 516, integration
223 → 224 executed, browser 10 → 33 → **36**.

**Three decisions were implemented but ungraded. Two of them now have a test.**

- **Selection is graded**, because ticket 29's detail panel opens from a click on a span and an
  unenforced click here would have been a hole three tickets deep. `a click marks one span, and
  clicking the same one again lets go`: none selected at rest, exactly one at a time across rows,
  and none after the second click. Making the handler assign instead of toggle turns it red.
- **Hover is graded**, and the span now carries `data-hovered` to make that possible. That is not
  new grammar — it is the rule the component already states, that every element carries the fact it
  is drawing so the tier grades the fact and never the colour. Hard-coding the attribute to `false`
  turns the spec red.
- **The tick step table is graded above `1s`.** One assertion at the second end of it left every
  coarser step free to be deleted silently. `run-breach` is now pinned at `30s` and `run-merged` at
  `2m`; removing either row from the table turns the new spec red.
- **Panning is still untested and still not Solux state.** The implementer kept it as the scroll
  container's own scroll on the grounds that a scroll offset held in a store and written back to the
  DOM is the classic two-panes-out-of-step defect. This integrator agrees and did not change it.
  `share` still only ever holds its default, and the colours are still deliberately not graded — a
  bug that painted every kind the same colour would pass, and that is the accepted price of grading
  attributes and boxes instead of pixels.

**One claim was refuted and the record is fixed.** `InFlightPhase`'s doc comment said the Console
reads the column "only for a run whose status is *executing*". It does not: `spansOf` guards on
*terminal*, so a **suspended** run carrying a stale column would draw a span that grows for ever.
Unreachable today — suspend is a graceful interrupt, and `code` and `agent` both clear the column
from the same `onExit` that writes the interrupted record — so the code is right and the comment was
wrong. The comment now says what the guard is, where the second half of the guarantee lives, and
that a writer able to suspend without running its exit handler would have to tighten both `spansOf`
and the held row `rowsOf` derives from `sandboxId`.

**Three findings this integrator did not fix, carried forward rather than left to be rediscovered.**

1. **`doc.gates` is fetched and read by nothing.** §5's grammar says *gate wait → a break carrying
   its duration*; what is built is *any dead time → a break carrying its duration*. On `run-merged`
   the two coincide because the fixture was written that way, so no test can tell them apart, and a
   crash-and-restart gap renders identically to a forty-one hour human wait. **Ticket 30 owns this**
   and must not discover it. Note that fixing it is not free: a gate band would become axis
   occupancy, which is what the break rule measures.
2. **A run id that does not exist reports an outage.** `/runs/run-nope` answers `404` and the page
   says *"Cannot reach the Console API. Retrying…"* over a permanent *"Loading the run…"*, because
   `fetchJson` throws one undifferentiated `Error` and the query client retries for ever. §10 names
   *the API is unreachable* as its own condition and does not name a missing record at all, so the
   fix is a state the design has not written down. Left for whoever writes it.
3. **`ScopeRow.outcome` and `ScopeRow.branch` are computed and rendered nowhere**, and knip cannot
   see an unused interface field. The visible consequence: `run-merged`'s first `build` acquisition
   was interrupted and its row says nothing about it. Delete them or draw them — but drawing them is
   grammar §5 does not have, so it is a decision rather than a cleanup.

**The thirteenth check, and it is not this branch's.** `moon run kojo:test-integration --force`
failed on the **pre-merge baseline** — `feat/kojo-v1` at `db6f74c`, ticket 28 not merged —
with `tests/integration/contexts/workflow/services/lane.test.ts:208` timing out at 180 s. The same
file passes alone in 51 s and passed in the post-merge tier. The verifier hit it too. So the
integration tier is **not deterministic on a cold container**, a single green run of it is one
observation rather than a proof, and a red CI run on that file is the tier's to answer for. Nothing
in this wave touches `lane.test.ts`.
