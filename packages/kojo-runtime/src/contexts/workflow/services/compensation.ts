import type { Effect, Exit, Schema, Scope } from "effect";
import { Workflow, type WorkflowEngine } from "effect/unstable/workflow";
import type { RunId } from "../../shared/models/RunId.ts";
import { RunFailure } from "../models/RunFailure.ts";

/**
 * The undo surface of a run, handed to the factory body as its second argument.
 *
 * It is handed in rather than imported because the typed form of compensation is a **method on the
 * workflow definition**, and only `workflow()` holds that definition. `Tag` and `Failure` come from
 * the same definition, so a compensation is bound to the run it can undo and to nothing else.
 */
export interface Compensating<Tag extends string, Failure> {
  /**
   * Register the undo for a step that already succeeded. It fires if the **whole run** fails.
   *
   * @see compensating for where it may be written, and why that is not a style rule.
   */
  readonly compensated: <A, E, R, R2>(
    step: Effect.Effect<A, E, R>,
    undo: (value: A, failure: RunFailure<Failure>) => Effect.Effect<void, never, R2>,
  ) => Effect.Effect<
    A,
    E,
    R | R2 | WorkflowEngine.WorkflowInstance | Workflow.Execution<Tag> | Scope.Scope
  >;
}

/**
 * The inverse of the merge: when a run fails, the world is put back.
 *
 * Ticket 20 built the accepted path — a branch per run, and a merge that hangs on acceptance. This
 * is the other end of it. A run that fails has already changed things outside itself: a ticket was
 * moved to In Progress, a reviewer was told to expect something, a queue was told the work was
 * taken. `compensated` is where each of those is paired with its undo, at the point the step is
 * written, so the undo cannot drift away from the thing it undoes.
 *
 * **What it must not undo is the branch.** A failed run's branch, and the worktree anybody can check
 * it out into, are the whole inspection surface — so nothing here touches git, and `RunFailure`
 * carries the branch name precisely so the report can point at it.
 *
 * **Where it may be written is measured, not stylistic.** A compensation registers on the workflow
 * instance's scope, and only the *top-level* instance has a scope that closes with the run:
 *
 * - On a top-level effect of the factory body — **fires**.
 * - Wrapping a phase, from the factory body — **fires**. This is the shape to write: `compensated`
 *   takes the whole `code(...)` or `agent(...)` and pairs it with its undo.
 * - Registered *inside* an activity body — **never fires**. An activity executes under a throwaway
 *   workflow instance whose scope closes with the activity's own success exit, where the finalizer
 *   no-ops. All three cases were run; the third one is silent, which is the dangerous kind of wrong.
 *
 * So compensation belongs in the factory body, and not inside a lane. **Anything a lane must undo is
 * that lane's own scope's job** — `Effect.addFinalizer` inside the lane's `Effect.scoped`, which is
 * exactly how `sandboxed` gives a container back. A lane's scope also unwinds at a suspension, which
 * a run-level compensation deliberately does not.
 *
 * **A suspended run compensates nothing.** `intoResult` closes the instance scope on a `Complete`
 * result and on a failure, and returns `Effect.void` on `Suspended` — so a run waiting two days at a
 * gate has registered its undos and run none of them. That is what makes it safe to register them
 * before the gate rather than after.
 *
 * **Once per run — on the engine Kojo ships.** A resumed run replays its body, so it registers the
 * undo again, and the count is therefore a question about instance scopes rather than about
 * registrations. `ClusterWorkflowEngine` — what `SingleNodeEngine` is — builds a fresh instance and a
 * fresh scope for each execution, and only the last one closes, so the undo runs once however many
 * times the run suspended. `InMemoryEngine` does not: it hands the previous instance's scope to the
 * new instance (`WorkflowEngine.ts:618-622`), so one run has one scope for its whole life and every
 * replay's registration fires when it closes. Both are measured in
 * `tests/unit/contexts/workflow/services/compensation.test.ts`. Nothing in Kojo papers over it,
 * because process-local bookkeeping would be a second source of truth about a run.
 *
 * Nothing is written to the trace from here. The run row already says `failed`, written by
 * `workflow()` on exit; a second account of the same fact is a second thing to keep true.
 */
export const compensating = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  runId: RunId,
): Compensating<Tag, Error["Type"]> => ({
  compensated: (step, undo) =>
    // The **method**, never the module function. `Workflow.withCompensation` types the cause as
    // `Cause.Cause<unknown>`; this one types it as the workflow's own declared error, which is what
    // lets an undo match on what went wrong instead of guessing.
    definition.withCompensation(step, (value, cause) =>
      undo(value, new RunFailure({ runId, cause })),
    ),
});

/**
 * Cleanup for the whole run, on every terminal path, which **survives a suspension**.
 *
 * The other tool, and deliberately a separate one. Compensation is the failure path and carries the
 * typed cause; this runs on success and failure alike and is handed the raw exit, because it is for
 * the things a run owes whatever became of it — closing a row, releasing a claim, telling a queue
 * the work is no longer taken.
 *
 * **Survives a suspension** is the measured part. The finalizer attaches to the workflow instance's
 * scope, and `intoResult` never closes that scope on a `Suspended` result, so a run that stops for
 * two days at a gate does not fire it on the way out. The replay registers it again on the fresh
 * instance of the resumed execution, and it fires once, when that execution ends the run — even
 * though the process that first registered it is long gone.
 *
 * It is not an activity and it is not replay-protected. Anything it does must be safe to do once per
 * *ended* run, which is once — but a run that fails, is retried, and fails again is two ended runs.
 * It also counts the same way a compensation does, and diverges between the two engines for the same
 * reason. See `compensating`.
 */
/** @public */
export const onRunEnd = <R>(
  cleanup: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R | WorkflowEngine.WorkflowInstance> =>
  Workflow.addFinalizer(cleanup);
