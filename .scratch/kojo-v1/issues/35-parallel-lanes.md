# 35 — Parallel lanes

**What to build:** Two lanes of the same factory run at the same time, in different sandboxes, and the trace makes it obvious which work belonged to which. The constraint that makes this subtle is proven by a test rather than discovered in production.

**Blocked by:** 19

**Status:** done

- [x] Two lanes run concurrently in separate sandboxes with separate branches
- [x] The correlation key crosses into both, so neither lane's agent output joins to the wrong phase
- [x] A test proves the sibling constraint: a gate in one lane waits for a running phase in the other before either sandbox is released
- [ ] The waterfall renders concurrent lanes without the rows overlapping or the axis misleading —
      **not done, and it cannot be: ticket 28 is `ready-for-agent` and there is no waterfall.** What
      the waterfall needs is built and graded instead; see *Carried forward to ticket 28* below.
- [x] Timestamp-based correlation is proven insufficient, so nothing later relies on it

## Comments

### What was built

Almost all of this ticket is measurement. Two `sandboxed` regions entered with `Effect.all` was
already the whole authored API (D1: no Kojo API decides the lanes), and the first job was to find out
what actually happens when a run does it. Three things needed code.

- **`laneOf`** in `src/contexts/shared/models/SandboxId.ts` — the inverse of `makeSandboxId`, reading
  the scope's name back out of an acquisition id. It lives beside the constructor so a format change
  cannot leave a reader behind. This is what makes *"which lane did this phase belong to"* a read of
  one column of the phase row rather than a join against the sandbox rows.
- **A `LANE` column on the phase table** (`src/cli/phaseTable.ts`), printed only when the run used a
  container at all, `host` for the phases that did not. It is the one place the answer is visible to
  a human until ticket 28 lands, and it gives `laneOf` a consumer in `src/` rather than only in tests.
- **A gate's durable name now carries the lane it was asked in** (`src/contexts/workflow/services/
  phase/gate.ts`, `currentLane` in `phase/whereItRan.ts`). This is a **silent-catastrophe fix**, and
  it was found here rather than reasoned about — see below.

### The gate collision, measured before it was fixed

A `DurableDeferred` is keyed `executionId/name`, and so is an activity. Two lanes of one run that
both call `gate({ name: "review" })` therefore wrote the same name. Measured on the unfixed code:

- **one** request reached a human — the second lane's request activity was memoised and returned the
  first lane's `GateRequest`, so nobody was ever asked about the second branch;
- one `approve` came back to **both** lanes (`"approve/one answer+approve/one answer"`);
- the trace kept **one** gate row for two branches.

One human, one click, two branches landed. `gate` now qualifies its durable name with the enclosing
`sandboxed` scope's name — `gate/<lane>/<name>/<asking>` — using the scope's **name** and never its
acquisition id, because the string has to mean the same thing after a rebuild as before one. A gate
asked on the host is unchanged, and two identical host gate names still collide: there is no lane
there, and inventing one would be inventing an identity out of nothing.

**This renamed a string other code spells.** Two places held the old shape and both are updated:
`tests/support/durableLane.ts` rebuilds the token from `gate/lane/review/<asking>`, and
`tests/integration/.../lane.test.ts` asserts the two askings. Anything else that reconstructs a gate
token by name — none exists today; `kojo gate answer` works from the repository's stored tokens — has
to know.

### The finding this ticket did not expect: two open gates cannot be resumed

Fixing the collision makes it possible for one run to have **two gates open at once**, which is the
state two lanes reach naturally: lane A is inside a long phase while lane B asks its question, and
then A asks its own. Answering one of them does not resume the run. The resumed execution's fiber
ends with an interrupts-only cause and `instance.suspended` clear, so `Workflow.intoResult` fails the
fiber instead of recording `Suspended`, and **`Workflow.poll` then dies** — a defect carrying an
empty cause, which is the worst sentence a human can be shown.

Measured, not inferred:

| harness | result |
|---|---|
| `WorkflowEngine.layerMemory`, two gates, no sandbox | dies |
| `WorkflowEngine.layerMemory`, two gates, two `sandboxed` scopes | dies |
| `ClusterWorkflowEngine` over `TestRunner` (`InMemoryClusterEngine`) | dies |
| either engine, answering the *other* one of the two gates | survives — stays `Suspended` |
| two gates that are never open at the same time (one suspension serialises them) | survives |
| a gate in **one** lane, work in the other — the realistic shape | survives, and is covered |

So it is neither the memory engine's nor the sandbox scope's, it is upstream, and it depends on
*which* gate is answered, which makes it a trap rather than a rule. Nothing here works around it. It
is pinned by `lanes.test.ts` › "cannot be resumed one gate at a time, and that is not Kojo's to fix",
recorded as `architecture.md` §8 edge 12, and it wants a ticket of its own — `run.ts`'s `status`
has no error channel, so the defect travels straight through `kojo run`, `kojo watch` and
`kojo gate answer` and kills them with an empty cause. That is a direct contradiction of ticket 39's
contract and I did not fix it, because doing so means adding a run status and touching every surface
that renders one.

### Two lanes rebuilding at once

Asked for by the ticket, and answered by running it rather than by thinking about it.
`parallelLanes.test.ts` › "recovers when both lanes have to rebuild their container at once" arms
ticket 37's `onSandboxReady` deletion **per lane**, so both lanes lose their workspace and both
rebuild concurrently against one repository. It works: four acquisitions, `["failed", "released"]`
for each lane, both lanes on their own branch afterwards, and each row's lane readable from its id.

The thing worth knowing is *why* it is safe, and it is not luck: Sandcastle derives the worktree path
from the repo **and the branch**, so two lanes on two branches never contend for one path. `git
worktree add` does take a repository-wide lock, and two of them did run concurrently here without
either failing. What is **not** covered is two lanes on the *same* branch, which is edge 9's
territory and is a mistake rather than a case.

### Proven, and by which test

Every mutation below was run, and the named test was watched going red.

- **Two lanes, two containers, two branches, alive at the same moment.** `lanes.test.ts` › "enters
  both scopes at once and keeps them apart" (two rows, two ids, two branches, overlapping
  `[acquiredAt, releasedAt]`), and `parallelLanes.test.ts` › "gives each one its own worktree, its
  own branch, and its own correlation" — real Sandcastle, real git, `git rev-parse` asked **inside**
  each lane, two real worktree paths, both branches on the host afterwards.
- **The correlation crosses into both, and names the right one.** `parallelLanes.test.ts` reads
  `printenv KOJO_PHASE_ID` and `printenv KOJO_RUN_ID` from inside each container and asserts each
  equals that lane's own acquisition id and the shared run id. This grades the property itself: the
  far side of the boundary answers, not Kojo's record of what it sent.
- **Which lane a phase belonged to, without a join.** `lanes.test.ts` › "says which lane each phase
  belonged to, from the phase row alone" and `phaseTable.test.ts` › "names the lane each phase ran
  in". Mutation: making `laneOf` return a constant fails both, plus two others — measured.
- **Timestamps cannot answer it.** `lanes.test.ts` › "cannot be told apart by time, which is the
  whole reason the key exists" asks the question a timestamp join asks — *which container was alive
  while this phase ran* — and gets **two** candidates, against **one** from the key. This is the
  criterion stated as an assertion rather than as prose.
- **The sibling constraint.** `lanes.test.ts` › "holds both containers open until the sibling phase
  finishes": the gate is out with a human, and *nothing has been released and the run is not
  suspended*, for an hour of virtual time, until the other lane's phase is let go. Deterministic —
  a latch, not a scheduler guess.
- **What the constraint costs, on the row a human reads.** `lanes.test.ts` › "charges the waiting
  lane for the wait, on its own row": the waiting lane's `lifetimeMillis` is at least the hour.
  Mutation: recording `releasedAt = acquiredAt` in `sandboxed.ts` fails this test and only this one
  — measured.
- **One gate name in two lanes is two questions.** `lanes.test.ts` › "asks it twice, once per lane,
  so one answer cannot settle the other" — two askings, two tokens. Mutation: dropping the qualifier
  from `gate.ts` fails it — measured.
- **Replay re-enters both scopes and re-runs neither phase.** `lanes.test.ts` › "resumes on the
  answer and rebuilds a container for each lane": four acquisitions for two lanes, two phase rows,
  and each phase still naming the container it actually ran in rather than the rebuilt one.

### Argued, not proven

- **The sibling-constraint test grades the engine, not Kojo.** There is no line of Kojo I can mutate
  to make "still running while the sibling works" go green when it should be red — the behaviour is
  `Workflow.wrapActivityResult`'s. What the test *does* grade of Kojo's is the consequence: that the
  scope is still held, and that the holding shows up on the sandbox row. The first half is a
  characterisation test and should be read as one.
- **That the sibling constraint is tolerable.** Nothing measures what it costs a real factory. The
  argument is that the cost is now visible on the row rather than hidden, which is the most a design
  that cannot change the engine can offer.
- **Two lanes rebuilding at once under Docker.** Measured on `no-sandbox` only, for the reasons
  ticket 37 recorded at length: a Docker version of that test is flaky about the thing it pins.

### Carried forward to ticket 28

The waterfall does not exist, so the fourth criterion could not be met. What it needs is here and
graded, and the ticket should start from it rather than re-deriving it:

1. **Rows come from `sandboxId`, and `laneOf` names them.** A phase belongs to exactly one
   acquisition and an acquisition to exactly one row, so rows cannot overlap by construction — there
   is no matching step to get wrong.
2. **The axis must be `max(end) − min(start)`, never a sum of durations.** With concurrent lanes the
   sum exceeds the wall clock; `lanes.test.ts` shows two lanes whose intervals overlap, which is the
   fixture that would catch it.
3. **A held container is a real span, not a gap.** The waiting lane's row genuinely extends across
   the sibling's phase (see "charges the waiting lane"), and drawing it as idle would be wrong: the
   container was up and was being paid for.

### Repository changes worth knowing

- `gate/<name>/<asking>` became `gate/<lane>/<name>/<asking>` **inside a sandbox scope** — flagged
  loudly above.
- `renderPhaseTable` gained a `LANE` column when any phase ran in a container.
  `tests/integration/cli/stampedRun.test.ts`'s `draft` row pattern was widened to read both shapes.
- `architecture.md` §8 gained edges 12 and 13.
- No Moon task, no Vitest project, no dependency, and no shared root file was touched.

### 2026-08-13 — the carried-forward criterion has an owner now

Ticket 28 built the waterfall and **did not pick this up**. Checked at head: every fixture run in
`src/console/fixtures.ts` holds one sandbox at a time (`run-merged`'s two are sequential — the
rebuild a gate forced), so `waterfall.spec.ts` has never been shown two lanes at once. The three
handover points above are now the specification of ticket
[53](53-the-waterfall-must-draw-concurrent-lanes.md).
