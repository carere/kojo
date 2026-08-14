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

**Status:** ready-for-agent

- [ ] A fixture run holds **two sandboxes at once**, with phases whose intervals genuinely overlap,
      and it is reachable from `kojo ui --fixtures` like every other one
- [ ] The waterfall draws one row per acquisition and the rows do not overlap — graded, then made red
      by hand to prove the grading works
- [ ] The axis is the wall clock, `max(end) − min(start)`. A fixture whose durations **sum** to more
      than its wall clock is what proves it, and the assertion must fail if the geometry sums
- [ ] The waiting lane's row is a span across the sibling's phase, not a gap
- [ ] A break inside one lane does not misplace the other lane's spans on the shared axis
- [ ] Ticket 35's fourth criterion is ticked with a pointer here

## Comments

*(none yet)*
