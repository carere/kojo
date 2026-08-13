# 30 — Answering a gate from the browser

**What to build:** A human unblocks a run in one click. The Console records the answer and a live runner applies it — and the Console never claims an answer was applied when it was not.

**Blocked by:** 29, 12

**Status:** done

> **Correction inherited from ticket 29 — read this before planning the route.**
>
> console.md §3 used to say *"a gate is a phase of kind `actor`, so its detail panel is the phase
> detail panel, plus the answer form."* **The engine never backed that**, and ticket 29 proved it:
> only `agent.ts` and `code.ts` construct a `PhaseRecord`, nothing writes `kind: "actor"`, and
> `GateRecord` carries **no `phaseId`** — so there is no recorded link between a gate and a phase.
>
> §3 is corrected. **A gate has its own route, `/runs/:runId/gates/:gate/:asking`, and the panel
> gains a third subject** beside a phase and a sandbox acquisition. That is the better answer anyway:
> the gate record is richer than a phase row could be — token, choices, deadline, expiry branch,
> answerer, latency — and an **asking** is the identity it is already keyed by.
>
> Three of the four things this ticket needs are ready, verified rather than reported:
>
> - **`/api/gates` carries what a queue needs** — `runId`, `gate`, `asking`, `description`, `actor`,
>   `choices`, `token`, `requestedAt`, `deadlineAt`, `onExpiry`.
> - **`/api/health` reports runner liveness, better than asked.** `runnerPresence` is read at the
>   moment the answer is written, so the receipt itself resolves *recorded — applying…* against
>   *recorded — nothing is running* with no second round trip. `POST /api/gates/:token/answer`
>   already has its three refusals: unknown token, already answered, undeclared choice.
> - **The gate card does not exist** — console.md §4 specifies one beneath the run header when a run
>   is suspended, and `RunView.tsx` has none. That is your work, along with the `/gates` route.
>
> And four fields console.md §6 asks for that **no trace record carries**, inherited from 29: a
> phase's **parent phase id** and **owner**, and a sandbox acquisition's **image digest** and **which
> hooks ran**. The panel says so rather than inventing them. Closing any of them is a schema change —
> field, migration and writer — not a Console change.


- [x] The run header shows the pending gate, what is being decided, how long it has waited, and the deadline with its expiry branch
- [x] Answering records the verdict, the reason, and who answered; the Console resolves the deferred through the same answering half every other adapter uses
- [x] Three states are distinguished and shown: recorded and applying, applied, and recorded with no runner running
- [x] Applying can take around ten seconds and the UI treats that as normal rather than as failure
- [x] Runner liveness is read from the runner table with its staleness window, never from the health service whose default reports every address alive
- [x] No rows in the runner table reads as nothing running, not as an error
- [x] A queue view shows everything waiting on a human across runs

## Comments

**What was built.** A gate card beneath the run header (`contexts/gate/components/GateCard.tsx`), the
detail panel's third subject on its own route (`GatePanel.tsx`, `routes/runs.$runId.gates.$gate.$asking.tsx`),
and the `/gates` queue (`GateQueue.tsx`, `routes/gates.tsx`). The one mutation goes through
`useAnswerGate`, which posts and nothing else — the Console records; a runner applies.

**The three states, and where each is read from.** `contexts/gate/models/answering.ts` is the whole
rule, in one pure function:

| State | Read from |
|---|---|
| *Applied — the run resumed* | the run document's settled `GateRecord`, keyed by the asking |
| *Recorded — applying…* | a verdict with no such record, and a live runner |
| *Recorded — nothing is running* | a verdict with no such record, and no live runner |

**Why the settled record is the proof.** `phase/gate.ts` writes it inside the `<asking>/record`
activity, which runs after the durable deferred resolves — so the record exists only if the run woke
up. A `200` on the answer proves a verdict was written and nothing more, and a run leaving
`suspended` may have suspended again on a second gate. Only the record is about *this* asking. This
is now graded end to end against a real engine, a real runner and real SQLite in
`tests/integration/console/gateAnswer.test.ts`: no record after the Console answers, one after a
runner picks it up, keyed to the same asking. The assertion was checked by mutation.

**Runner presence** comes from the answer receipt at the moment of writing, then from `/api/health`
polled while — and only while — a verdict is recorded and unapplied, so a watcher killed under an
open card is caught. Both are `RunnerRepository` → `RunnerRegistration.live`, the 35-second window,
never `RunnerHealth`. Unknown presence is read as *nothing is running*: guessing *live* is the error
that lies. `api.test.ts` grades the receipt at 4 s and at 35 001 ms.

**Fixtures.** Askings are now named the way the engine names them (`gate/<name>/<round>`, slashes and
all), which is what makes the route's percent-encoding real rather than theoretical. `busy` gained
`run-recorded` (a verdict with no record) and `run-waiting` (the only asking a browser test may
answer); `run-merged` gained the verdict beside its existing record. A fifth fixture, `watching`, is
`busy` plus one fresh runner registration and differs in nothing else — which is what lets a browser
test prove *applying…* came from reading the runner table. `tests/unit/console/fixtures.test.ts`
states those invariants so a fixture drifting cannot leave the browser tier green and meaningless.

**Two corrections to the design record**, both in `docs/design/console.md`: the route table and §6
now say the panel has three subjects, and §9 gained the section on where *applied* is read from and
why the card outlives the suspension.

**Not graded, said plainly.** No test watches a card cross from *applying…* to *applied* live — that
needs a fixture whose trace changes under a browser, and the fixtures are stated records. The three
renderings are each graded, and the transition between the two underlying facts is graded in the
integration tier; the crossing itself is not.

## What verification found, and what the merge did about it

Merged into `feat/kojo-v1` as `bf8cd70`, with the fixes below committed on top. Seven mutations were
run against the branch before the merge and three more after the fixes; all three new assertions
were confirmed to bite.

**The three-state receipt is honest, and that was attacked rather than accepted.** `answeringState`
reaches `applied` through one door only, and that door reads the run's own settled `GateRecord`.
Collapsing it — returning `applied` from a verdict alone — reddens four browser specs. There is no
path from a `200`, from `outcome !== "suspended"`, or from a live runner to the word *applied*.
Liveness is `RunnerRepository` → `RunnerRegistration.live` with the cluster's 35-second window in
both readers; `RunnerHealth` is imported by no source file in the repository.

### Fixed before this ticket closed

- **An expired gate was drawn as *"Applied — the run resumed."*** `phase/gate.ts` writes the
  `<asking>/record` activity for *both* halves of `DurableDeferred.raceAll`, so a gate that ran out
  of time leaves a `GateRecord` with `outcome: "expired"` and no answerer. `isApplied` compared only
  the asking string, so it read that record as proof somebody had decided — and the panel drew *"a
  runner picked the answer up"* beside its own `data-gate-outcome="expired"`. Reachable, because
  `RecordingGate` never deletes an asking, so an expired one stays in `/api/gates` forever.
  **Fixed:** `SettledAsking` carries `outcome`, only `answered` may be drawn as *applied*, and an
  expiry has its own sixth state with its own sentence and no answer controls. Graded by a new
  fixture (`run-expired`: an asking with no verdict beside a settled `expired` record, on a run that
  survived because it expired on `reject`), one fixture invariant, and two browser specs. Mutating
  the state machine back reproduces the exact lie — `Expected: "expired", Received: "applied"`.
- **`fixtures.test.ts` claimed an invariant it did not hold.** *"two fixtures that differ only in the
  runner table"* checked only the runner tables; giving `watching` a truncated `runs` array and empty
  `phases` left the whole unit tier green. **Fixed:** the test now reads back everything both
  fixtures *serve* — every run, every asking, every run document — through the ports, and compares
  them whole. The drift mutation now fails it.
- **Nothing graded that the answerer is the OS user.** The old assertion was `not.toBe("")`, which
  any constant satisfies; the integration assertion compared the record to whatever the receipt had
  returned, which is a tautology. **Fixed:** `api.test.ts` now posts a body carrying an `answerer`
  field the API does not accept and asserts the recorded answerer equals this process's own
  `USER`/`USERNAME` and is *not* the forged one. Replacing `osUser` with a constant now fails it.

### Recorded, not fixed

- **A single lying liveness source is invisible to the browser tier.** Making the receipt always say
  `live`, or the health document always say `live`, leaves all browser specs green — only both
  together redden one. `GateAnswering` prefers whichever was measured later, so one wrong source is
  corrected within a poll and Playwright's retrying assertion never sees it. Both sources *are*
  graded, at the unit tier (`api.test.ts` at 4 s and 35 001 ms, `FactoryHealth.test.ts` at
  34 999 / 35 001). What is overstated is calling the browser click the grading for *nothing is
  running*; it is not, and the unit tier is.
- **The `/gates` queue never sheds an expired asking.** `waitingRows` filters on
  `answerer === undefined`, and an expiry writes no verdict, so an expired asking sits in *waiting*
  with *"overdue by …"* growing without bound over a question the run has already answered by
  expiry — and the run list's *"N waiting on a human"* count inherits it. The queue reads one list
  across every run and holds no trace, so it cannot know. Closing it properly means telling
  `GateRepository` that an asking settled: a port method, a column, a migration and a writer inside
  the `<asking>/record` activity. **That is its own ticket, not a line in this one.**
- **Two answer forms for one asking.** The card and the panel can both be mounted over the same
  asking and both carry live controls. Clicking either writes the same verdict and the second would
  refuse with `409`, so it is a UX question rather than a correctness one, and every browser
  assertion names which of the two it is about.
- **The ADR's opening sentence was out of date with its own body.** It said `kojo ui` does not hold
  an engine and does not resolve the deferred; it does hold `SingleNodeEngine.layer(…)` and
  `POST /api/gates/:token/answer` does call `DurableDeferred.succeed`. The *decision* is intact and
  graded — the Console registers no runner, appears in no `cluster_runners` row, and executes no
  workflow step — so the ADR's prose was corrected rather than the code. Pre-existing; not a ticket
  30 regression.
- Everything the implementation report listed under *argued, not proven* was confirmed genuinely
  ungraded, and the report was honest about all of it: the live crossing from *applying…* to
  *applied* in one open page, the unknown-presence branch, the terminal-run-with-unapplied-verdict
  branch of the card's visibility rule, and two of the three API refusals from the UI.
