import { type Cause, Effect, Exit, Option, type Schema } from "effect";
import type { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import type { RunId } from "../../shared/models/RunId.ts";

/**
 * Where a run is, from the outside.
 *
 * `suspended` is a success, not a hang: it is a run that asked a human something and let go of
 * everything it held. Anything that reports on runs has to be able to say so without waiting.
 */
export type RunStatus = "running" | "suspended" | "succeeded" | "failed";

/**
 * Starts a run and returns its id, immediately.
 *
 * **Never a bare `execute`.** The engine's `execute` is a poll loop that returns only on
 * `Complete`, so a caller awaiting a run that suspends at a two-day gate sits unsettled for two
 * days. `discard` returns the execution id as soon as the run is recorded, and `status` below
 * answers where it got to. Every entry point starts a run this way — the CLI prints where execution
 * stopped and exits, and a test forks and advances the clock.
 *
 * The execution id **is** the run id. Nothing mints a second identifier.
 */
export const start = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  payload: Payload["~type.make.in"],
): Effect.Effect<
  RunId,
  never,
  | WorkflowEngine.WorkflowEngine
  | Payload["EncodingServices"]
  | Success["DecodingServices"]
  | Error["DecodingServices"]
> =>
  Effect.map(definition.execute(payload, { discard: true }), (executionId) => executionId as RunId);

/**
 * Where the run got to, without joining it.
 *
 * A run the engine has no result for is still executing; one it has a `Suspended` result for is
 * waiting on something outside itself. Only a completed run has an exit, and its exit is the
 * difference between the two terminal answers.
 */
export const status = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  runId: RunId,
): Effect.Effect<
  RunStatus,
  never,
  WorkflowEngine.WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  Effect.map(
    definition.poll(runId),
    Option.match({
      onNone: (): RunStatus => "running",
      onSome: (result): RunStatus =>
        result._tag === "Suspended"
          ? "suspended"
          : Exit.isSuccess(result.exit)
            ? "succeeded"
            : "failed",
    }),
  );

/**
 * Why the run failed, in the typed error the workflow declared — nothing when it did not fail.
 *
 * {@link status} answers *whether* a run ended badly and deliberately says no more, because a
 * watcher holds a list of workflows whose error types have nothing in common. This answers *why*,
 * and it is the whole reason the typed error channel is worth declaring: `GreetingRefused`,
 * `AgentInvocationError`, `CheckViolation`, `PermissionBreach`, `NotAccepted` are all persisted
 * against the run and read back as the classes they were, so whatever the error knows — the agent,
 * the check, the breached path, the refusal's own words — is still there to be printed.
 *
 * The error type is erased to `unknown` for the same reason `Runnable` erases its four parameters:
 * the caller is a command holding one workflow chosen at runtime. Nothing is lost, because the
 * reader of a cause is a renderer and never a `catchTag`.
 */
export const failure = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Workflow.Workflow<Tag, Payload, Success, Error>,
  runId: RunId,
): Effect.Effect<
  Option.Option<Cause.Cause<unknown>>,
  never,
  WorkflowEngine.WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
> =>
  Effect.map(
    definition.poll(runId),
    Option.flatMap((result) =>
      result._tag === "Complete" && Exit.isFailure(result.exit)
        ? Option.some<Cause.Cause<unknown>>(result.exit.cause)
        : Option.none(),
    ),
  );
