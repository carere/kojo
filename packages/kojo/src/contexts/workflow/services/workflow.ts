import { Cause, Clock, Effect, Schema } from "effect";
import { Activity, Workflow } from "effect/unstable/workflow";
import { present } from "../../shared/lib/present.ts";
import { BuildInfo } from "../../shared/models/BuildInfo.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import { RunRecord } from "../../trace/models/RunRecord.ts";
import { Tracer } from "../../trace/ports/Tracer.ts";
import { CurrentRun } from "./CurrentRun.ts";
import { type Compensating, compensating } from "./compensation.ts";

/**
 * An authored workflow: a program made of phases, identified by a run id that names its branch.
 *
 * Returns the definition and the layer that registers it. The definition carries `execute` and
 * `poll`; the layer carries the body. They are separate because the engine needs the body
 * registered before anything can execute it.
 *
 * The engine's execution id **is** the run id. Nothing generates a second identifier, so the trace,
 * the branch name, and the engine's own persistence all agree by construction rather than by a
 * mapping someone has to maintain.
 *
 * The body is handed the run's **compensation** surface as its second argument, because the typed
 * form of it is a method on the definition this function has just built and an author has no other
 * way to reach it. See `compensating` — including why what it registers only counts when it is
 * registered here, in the factory body.
 */
export const workflow = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
>(
  options: {
    readonly name: Tag;
    readonly payload: Payload;
    readonly success: Success;
    readonly error: Error;
    /** What a run is deduplicated by. Two triggers for one unit of work must not open two runs. */
    readonly idempotencyKey: (payload: Schema.Struct.Type<Payload>) => string;
  },
  body: (
    payload: Schema.Struct.Type<Payload>,
    compensation: Compensating<Tag, Error["Type"]>,
  ) => Effect.Effect<Success["Type"], Error["Type"], R>,
) => {
  const definition = Workflow.make(options.name, {
    payload: options.payload,
    success: options.success,
    error: options.error,
    idempotencyKey: options.idempotencyKey,
  });

  const layer = definition.toLayer((payload, executionId) =>
    Effect.gen(function* () {
      const runId = executionId as RunId;
      const tracer = yield* Tracer;
      // The engine deduplicates on this and never hands it back, so the run row is where it is
      // recorded. Computed from the payload the same way the definition computes it, on the replay
      // too — it is a pure function of a payload the engine restores unchanged.
      const idempotencyKey = options.idempotencyKey(payload);

      // Inside an activity, for the same reason the phase record is: a resumed run replays this
      // body from the top, so a write out here would leave one "run started" per suspension, each
      // stamped with the time of the *resume* rather than of the start.
      yield* Activity.make({
        name: "run/started",
        success: Schema.Void,
        error: Schema.Never,
        execute: Effect.gen(function* () {
          const build = yield* BuildInfo;
          const startedAt = yield* Clock.currentTimeMillis;
          yield* tracer.runStarted(
            new RunRecord({
              runId,
              workflow: options.name,
              idempotencyKey,
              startedAt,
              engineVersion: build.version,
              engineCommit: build.commit,
              configDigest: build.configDigest,
              host: build.host,
              ...present("imageDigest", build.imageDigest),
            }),
          );
        }),
      });

      return yield* body(payload, compensating(definition, runId)).pipe(
        Effect.onExit((exit) =>
          tracer.runFinished(
            runId,
            exit._tag === "Success"
              ? "succeeded"
              : // Suspension **is** an interrupt of this fiber, so the naive reading of the exit
                // calls every run that stopped for a human a failed run — and says so for the
                // whole two days it waits. A run that let go of everything and is waiting is
                // exactly what `suspended` names.
                Cause.hasInterrupts(exit.cause)
                ? "suspended"
                : "failed",
          ),
        ),
        Effect.provideService(CurrentRun, { runId }),
      );
    }),
  );

  return { definition, layer } as const;
};
