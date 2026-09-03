import { Cause, Clock, Effect, type Schema } from "effect";
import { Activity } from "effect/unstable/workflow";
import { present } from "../../../shared/lib/present.ts";
import { makePhaseId } from "../../../shared/models/PhaseId.ts";
import { InFlightPhase } from "../../../trace/models/InFlightPhase.ts";
import { PhaseRecord } from "../../../trace/models/PhaseRecord.ts";
import { Tracer } from "../../../trace/ports/Tracer.ts";
import {
  ActionRecoveryPolicy,
  type ActionRecoveryPolicy as ActionRecoveryPolicyValue,
} from "../../models/ActionRecoveryPolicy.ts";
import { CurrentRun } from "../CurrentRun.ts";
import { whereItRan } from "./whereItRan.ts";

/**
 * A known invocation — `bun test`, `git commit`, a status transition, a merge.
 *
 * If you can write the command down it is not a judgement call, and paying an agent to rediscover
 * it every run costs money, time, and consistency.
 *
 * The trace write sits **inside** the activity, not around it. Around it, the write is outside the
 * recorded boundary and re-runs on every replay, so a run that suspends three times leaves four
 * records for one phase. Inside, the activity's own memoisation makes "written once" true.
 */
export const code = <Success extends Schema.Top, Error extends Schema.Top, R>(
  options: {
    readonly name: string;
    readonly description: string;
    readonly success: Success;
    /** A code phase's failures travel back to an agent as an envelope, so they must be typed. */
    readonly error: Error;
    /** Evidence contract for recovery after output loss. Arbitrary shell effects stay unresolved. */
    readonly recoveryPolicy?: ActionRecoveryPolicyValue;
  },
  body: Effect.Effect<Success["Type"], Error["Type"], R>,
) =>
  Activity.make({
    name: options.name,
    success: options.success,
    error: options.error,
    execute: Effect.gen(function* () {
      const tracer = yield* Tracer;
      const run = yield* CurrentRun;
      const attempt = yield* Activity.CurrentAttempt;
      const sandboxId = yield* whereItRan;
      const startedAt = yield* Clock.currentTimeMillis;

      // The run's status, stamped before the body runs — adr/trace/0002. Inside the activity for the
      // same reason the record is: outside it, a resumed run would re-stamp a phase whose result came
      // back from the recorded activity and whose body never ran again.
      yield* tracer.phaseEntered(
        run.runId,
        new InFlightPhase({
          phaseId: makePhaseId(run.runId, options.name, attempt),
          name: options.name,
          kind: "code",
          attempt,
          startedAt,
          ...present("sandboxId", sandboxId),
        }),
      );

      return yield* body.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const endedAt = yield* Clock.currentTimeMillis;
            yield* tracer.phase(
              new PhaseRecord({
                runId: run.runId,
                phaseId: makePhaseId(run.runId, options.name, attempt),
                name: options.name,
                description: options.description,
                kind: "code",
                outcome:
                  exit._tag === "Success"
                    ? "succeeded"
                    : Cause.hasInterrupts(exit.cause)
                      ? "interrupted"
                      : "failed",
                attempt,
                startedAt,
                endedAt,
                ...present("sandboxId", sandboxId),
              }),
            );
          }),
        ),
      );
    }),
  }).annotate(ActionRecoveryPolicy, options.recoveryPolicy ?? "unresolved");
