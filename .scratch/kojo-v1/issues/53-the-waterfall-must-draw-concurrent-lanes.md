# 53 — The waterfall has never been drawn over two lanes at once

**What to build:** A fixture in which two sandboxes are held **at the same time**, and a browser spec
that grades what the waterfall does with it. Today no fixture in the build has two overlapping
acquisitions, so the one criterion ticket 35 wrote for the Console has never been executed.

## Why this ticket exists

Ticket 35 is done with one box open, and it says why it could not be closed:

> - [ ] The waterfall renders concurrent lanes without the rows overlapping or the axis misleading —
>   **not done, and it cannot be: ticket 28 is `ready-for-agent` and there is no waterfall.** What
>   the waterfall needs is built and graded instead; see *Carried forward to ticket 28* below.

**Ticket 28 built the waterfall and did not pick the criterion up.** Its comments mention lanes only
once, about a `lane.test.ts` timeout. Checked at head:

- every `makeSandboxId` in `src/console/fixtures.ts` belongs to a run with **one** sandbox at a time.
  `run-merged` has two and they are sequential — the rebuild a mid-run gate forced, which is a
  different shape;
- `apps/console/tests/browser/waterfall.spec.ts` therefore grades a staircase, never an overlap.

So the geometry is written and argued, and the case it was argued for is untested.

## What ticket 35 handed over, and what to check it against

Ticket 35's *Carried forward to ticket 28* is the specification. It is still correct, and the
waterfall claims to satisfy all three by construction. Each is a thing to make red by hand:

1. **Rows come from `sandboxId`, and `laneOf` names them.** A phase belongs to exactly one
   acquisition and an acquisition to exactly one row, "so rows cannot overlap by construction — there
   is no matching step to get wrong." Grade the claim, do not repeat it.
2. **The axis must be `max(end) − min(start)`, never a sum of durations.** With concurrent lanes the
   sum exceeds the wall clock. This is the one that a fixture with overlapping intervals would catch
   and nothing else would.
3. **A held container is a real span, not a gap.** The waiting lane's row genuinely extends across
   the sibling's phase — the container was up and was being paid for — so drawing it idle is wrong.

`src/contexts/trace/models/waterfall.ts` is pure geometry over one run document and one instant, so
most of this can be graded without a browser. The break rule (`share`, `floorMillis`) interacts with
an overlap and is worth a fixture of its own: two lanes, one of them long enough to break.

**Blocked by:** 28, 35 — both done.

**Status:** done

- [x] A fixture run holds **two sandboxes at once**, with phases whose intervals genuinely overlap,
      and it is reachable from `kojo ui --fixtures` like every other one
- [x] The waterfall draws one row per acquisition and the rows do not overlap — graded, then made red
      by hand to prove the grading works
- [x] The axis is the wall clock, `max(end) − min(start)`. A fixture whose durations **sum** to more
      than its wall clock is what proves it, and the assertion must fail if the geometry sums
- [x] The waiting lane's row is a span across the sibling's phase, not a gap
- [x] A break inside one lane does not misplace the other lane's spans on the shared axis
- [x] Ticket 35's fourth criterion is ticked with a pointer here

## Comments

**Implemented** on `lane/53-waterfall-concurrent-lanes`. Two files: two runs added to
`packages/kojo/src/console/fixtures.ts`, and five tests added to
`apps/console/tests/browser/waterfall.spec.ts`. **No production code changed**, which is the answer
to the question this ticket really asked — the geometry was right, and nothing had ever asked it.

### Two fixtures, not one, and the reason is the break rule

`run-lanes` holds `api` and `web` together for the whole of its middle. `run-lanes-break` holds
`soak` and `watch` together and puts three hours of `compile` on one of the two. They are separate
runs on purpose: `run-lanes` is arranged so that **nothing** collapses — the longest stretch between
two edges is the four and a half minutes the two lanes share, which is under `floorMillis` — and
`run-lanes-break` is arranged so that exactly one stretch does. One run carrying both would grade the
overlap only through a broken axis, and the two failures the ticket names (an axis that sums, and a
break that drags the sibling's spans with it) would be impossible to tell apart in the report.

**The sum is the fixture's whole design.** `run-lanes` is ten minutes of wall clock carrying 13m 28s
of phase time, and `probe` alone is eight of those ten minutes. So the wall-clock axis draws `probe`
at **80%** of the canvas and a summing axis would draw it at **59%**, and the assertion is written
against that gap rather than against a pixel count. On every fixture that existed before this one the
two readings are the same number, which is precisely why eighty-five green specs could not see the
difference.

### What the ticket asked to be graded rather than repeated

*"Rows cannot overlap by construction"* is now a claim about two boxes: `probe` and `sift` share
time (their horizontal extents intersect) and do not share ground (`sift.y ≥ probe.y + height`). A
staircase satisfies both trivially — nothing overlaps — so the assertion says nothing until it is
shown a run that holds two containers, which is the state of the world this ticket was opened over.

### The measurement worth keeping

**Nothing in the suite graded a released container's band before this.** The mutation `to:
sandbox.releasedAt` → `to: sandbox.acquiredAt` in `rowsOf` — which collapses every acquisition's band
to a two-pixel sliver — reddened **only the two new tests** and nothing else in ninety-six. The band
is what console.md §5 says the row model exists for, and it was drawn and never checked.

### Proven, and by which mutation

Each was applied to `apps/console/src/contexts/trace/models/waterfall.ts`, the Console rebuilt, the
whole browser tier run, and the mutation put back.

| mutation | what went red |
|---|---|
| `spansOfRow`'s filter dropped — every row draws every span | all five new tests, plus 21 others (each span matched three times) |
| `spansOf`: `rowId: line.sandboxId ?? hostRow` → `rowId: hostRow` | *two phases that share time do not share ground* (on `sift.y ≥ probe.y + height`, 254.5 vs 278.5), *one row per acquisition…*, *the waiting lane's row…* — and **not** the two axis tests, which is the split the fixture was designed for |
| `waterfall`: `to` = `from +` the sum of the spans' durations | *the axis is the wall clock, never the sum of what the lanes did* — `probe` fell to **0.5939** of the canvas against a floor of 0.78, the predicted 59% to the fourth decimal |
| `rowsOf`: `to: sandbox.releasedAt` → `to: sandbox.acquiredAt` | *the waiting lane's row is a span…* and *a break inside one lane…* — **and nothing else in the suite** |
| `xOf`: the break branch always returns `wallOffset` | *a break inside one lane leaves the other lane's spans where they belong* (on `report.x`, 719.4 against a wall ending at 807.4), plus `run-stale`'s existing break test |

### Argued, not proven

- **The geometry is still graded only through a browser.** The ticket observes that most of this
  needs no browser, and it is right: `waterfall.ts` is a pure function over one document and one
  instant. There is no unit tier under `apps/console` — no Vitest project, no Moon task — and adding
  one is a tier-shaped change that would have arrived in the same commit as the criteria it was
  meant to grade. So the assertions are pixel measurements over the built page instead. They are
  sharper than they look (the axis mutation was caught to four decimal places), but they are slower
  than they need to be and they cannot be run without a build. A console unit tier is worth its own
  ticket, and `waterfall.ts` is what would populate it on day one.
- **Two lanes with the *same* scope name** — two acquisitions of one scope, alive together — is not
  covered. That is a lane strategy nothing in the engine builds today; `run-merged`'s two `build`
  rows are sequential. If it ever becomes reachable, `acquisition N of M` and the row order are what
  would need a fixture.
