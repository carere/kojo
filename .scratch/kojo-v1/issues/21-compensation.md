# 21 — Compensation on a failed run

**What to build:** When a whole run fails, the world is put back: the ticket returns to its previous status, the failure is reported, and the branch is preserved rather than deleted.

**Blocked by:** 20

**Status:** done

- [x] Compensation is registered in the factory body, not inside a lane, because it does not register for nested phases
- [x] The method form is used rather than the module form, so the failure cause stays typed
- [x] A failed run returns the ticket to its previous status and preserves the branch
- [x] Anything a lane must undo is handled by that lane's own scope
- [x] Run-lifetime cleanup that must outlive a suspension is registered separately and proven to survive a multi-day gate

## Comments

### What was built

- `src/contexts/workflow/models/RunFailure.ts` — what a compensation is handed: the run id, the
  **typed** cause, the declared error, its tag, whether the run died or was interrupted, and a
  `report` line that names the branch. Not a `Schema.Class`: a `Cause` is not encodable and this is
  never persisted.
- `src/contexts/workflow/services/compensation.ts` — `compensating(definition, runId)`, which binds
  the definition's own `withCompensation` **method** and gives the factory body `compensated(step,
  undo)`; and `onRunEnd(cleanup)`, a separate export over `Workflow.addFinalizer`.
- `src/contexts/workflow/services/workflow.ts` — the body now takes a second argument, the
  `Compensating` surface. It is handed in because the typed form is a method on the definition
  `workflow()` has just built, and an author has no other way to reach it. Existing bodies that take
  one parameter are unaffected.

The issue tracker is not a Kojo port (architecture.md §5, *Not ports*), so "returns the ticket to its
previous status" is an author's code phase paired with its undo. Both test tiers write that phase
against a tracker of their own — a module object in the unit tier, a JSON file in the integration
one — which is the shape a real factory writes against a real tracker's SDK.

### Proved by test

Unit — `tests/unit/contexts/workflow/services/compensation.test.ts`, on `InMemoryClusterEngine`,
which is the **real** cluster engine:

- a run that fails after a gate puts the ticket back to the status the claim phase *found*, posts the
  failure, and does so exactly once;
- a run that succeeds undoes nothing;
- a run waiting at a gate undoes nothing;
- the same `compensated` call written **inside an activity** never fires, while the one in the
  factory body does — the executable form of criterion 1;
- a lane's own scope releases what it holds at the suspension, and again on the failure, and the
  run's compensation fires once, after it — criterion 4, with the ordering;
- `onRunEnd` is not fired by a two-day gate and fires once when the run ends — criterion 5.

The typed cause (criterion 2) is **not graded by anything**. This was claimed as compiler-graded and
the wave-7 integrator refuted it by mutation: replacing `definition.withCompensation` with
`Workflow.withCompensation` in `compensation.ts` compiles clean (`bun tsc --build --force`, exit 0,
against a harness proved able to report TS2322 on the same file). Two reasons, both measured:

- `compensating` carries an **explicit** return type, `Compensating<Tag, Error["Type"]>`. That
  annotation — not the choice of method over module function — is what puts the declared error in
  front of an undo. The widening the module form does is erased at that boundary.
- The two forms are the **same function**. `Workflow.ts:398` defines the method as
  `withCompensation: ((...args) => (withCompensation as any)(...args))`, so there is no runtime
  difference either.

The property criterion 2 asks for is still true, and an undo really can read `error._tag`. It rests
on the interface annotation and on `RunFailure<Failure>`. Nothing fails if the method form is
swapped out, so keep the method form for what it documents, not for what it enforces.

Integration — `tests/integration/contexts/workflow/services/compensation.test.ts` with
`tests/support/durableCompensation.ts`: a real repository, real worktrees, `SingleNodeEngine` on a
SQLite file, and **two processes**. The process that starts the run exits while the run is suspended,
and a second process answers the gate.

- Nothing fires when the starting process exits: no undo, no run-end line, no comment.
- On rejection the run fails with `NotAccepted`, the ticket goes back to `ready`, the comment names
  the branch, and the log holds exactly one `undo:` and one `end:` line — both stamped with the pid
  of the process that *ended* the run.
- The branch and its commit are still there afterwards and the trunk never moved. Preserving the
  branch is the point.
- On approval nothing is put back, the ticket stays claimed, and the merge lands.

Graded by mutation: replacing `compensated` with a pass-through in the harness turns the integration
test red on `expected 'in progress' to be 'ready'`, then reverted.

### Finding — the two engines do not agree on how often a compensation fires

New, and not in the API audit. A resumed run replays its body and registers the undo again, so the
count is a question about **instance scopes**:

- `ClusterWorkflowEngine` (what `SingleNodeEngine` is) builds a fresh instance *and a fresh scope*
  per execution. Only the last one closes, so the undo fires **once per run** however many times the
  run suspended. Measured: one suspension, two executions of the body, one undo.
- `InMemoryEngine` passes the previous instance's scope into the new instance
  (`effect/unstable/workflow/WorkflowEngine.ts:618-622`), so one run has one scope for its whole life
  and every replay's registration fires when it closes. Measured: the same run leaves two undos and
  two run-end lines.

The unit suite therefore runs on `InMemoryClusterEngine`, and its last block measures the divergence
on purpose rather than leaving it to be rediscovered as a bug. Kojo does not paper over it: a
process-local "already compensated" registry would be a second source of truth about a run.

### Not done

No trace record is written for a compensation. `Tracer` has no method that fits one — `Occurrence` is
explicitly subordinate to a phase — and the run row already says `failed`. Adding a method would have
collided with tickets 24/25.
